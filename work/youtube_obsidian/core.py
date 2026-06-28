from __future__ import annotations

import json
import os
import re
import shutil
import requests
from datetime import datetime
from pathlib import Path
from contextlib import contextmanager

from faster_whisper import WhisperModel
from youtube_transcript_api import YouTubeTranscriptApi
from yt_dlp import YoutubeDL


BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / ".cache"
WORK_DIR.mkdir(exist_ok=True)
CONFIG_PATH = BASE_DIR / "config.json"
DIRECT_SUMMARY_LIMIT = 42000
FAST_TRUNCATE_LIMIT = 52000
FAST_CHUNK_SIZE = 28000
FAST_CHUNK_OVERLAP = 900
MAX_CHUNKS_BEFORE_TRUNCATE = 4
ONLINE_FAST_INPUT_LIMIT = 9000
OPENAI_FAST_MODEL_PREFERENCES = [
    "qwen3.5-non-thinking",
    "qwen3.5",
    "smart/default",
    "claude-haiku-4-5",
    "glm-chat",
    "qwen-chat",
]


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(
            "Missing config.json. Copy config.example.json to config.json and edit it first."
        )
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_config(config: dict) -> dict:
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return config


def get_model_config(config: dict) -> dict:
    model_config = dict(config.get("model") or {})
    if not model_config:
        ollama_config = config.get("ollama", {})
        model_config = {
            "provider": "ollama",
            "model": ollama_config.get("model", "qwen3:14b"),
            "base_url": ollama_config.get("base_url", "http://127.0.0.1:11434"),
            "api_key": "",
            "temperature": 0.3,
            "timeout": 90,
        }
    model_config.setdefault("provider", "ollama")
    model_config.setdefault("model", "qwen3:14b")
    model_config.setdefault("base_url", "http://127.0.0.1:11434")
    model_config.setdefault("api_key", "")
    model_config.setdefault("temperature", 0.3)
    model_config.setdefault("timeout", 90)
    return model_config


def get_public_config() -> dict:
    config = load_config()
    model_config = get_model_config(config)
    api_key = str(model_config.get("api_key") or "")
    public_model = {**model_config, "api_key": "", "has_api_key": bool(api_key)}
    return {
        "obsidian_output_dir": config.get("obsidian_output_dir", ""),
        "default_tags": config.get("default_tags", []),
        "topic_folders": config.get("topic_folders", {}),
        "transcription": config.get("transcription", {}),
        "youtube": config.get("youtube", {}),
        "model": public_model,
    }


def list_library_folders() -> dict:
    config = load_config()
    output_dir = Path(config["obsidian_output_dir"]).expanduser()
    topic_folders = dict(config.get("topic_folders") or {})
    items = []
    for topic, folder_name in topic_folders.items():
        folder_path = output_dir / folder_name
        notes = list_folder_notes(folder_path)
        latest = max((note["updated_at"] for note in notes), default=None)
        summary_path = folder_path / "文件夹知识蒸馏.md"
        items.append(
            {
                "topic": topic,
                "folder": folder_name,
                "path": str(folder_path),
                "note_count": len(notes),
                "updated_at": latest,
                "has_distillation": summary_path.exists(),
                "distillation_path": str(summary_path) if summary_path.exists() else None,
                "notes": notes[:40],
            }
        )
    return {"items": items}


def list_folder_notes(folder_path: Path) -> list[dict]:
    if not folder_path.exists():
        return []
    notes = []
    for path in sorted(folder_path.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True):
        if path.name == "文件夹知识蒸馏.md":
            continue
        stat = path.stat()
        title = path.stem
        preview = ""
        try:
            text = path.read_text(encoding="utf-8")
            preview = re.sub(r"\s+", " ", text[:800]).strip()
        except Exception:
            preview = ""
        notes.append(
            {
                "title": title,
                "path": str(path),
                "updated_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "size": stat.st_size,
                "preview": preview,
            }
        )
    return notes


def distill_library_folder(topic: str) -> dict:
    config = load_config()
    output_dir = Path(config["obsidian_output_dir"]).expanduser()
    topic_folders = dict(config.get("topic_folders") or {})
    if topic not in topic_folders:
        raise ValueError(f"Unknown topic: {topic}")
    folder_path = output_dir / topic_folders[topic]
    notes = list_folder_notes(folder_path)
    if not notes:
        raise ValueError("No markdown notes found in this folder")

    note_bundles = []
    for note in notes[:20]:
        path = Path(note["path"])
        try:
            content = truncate_text(path.read_text(encoding="utf-8"), 4500)
        except Exception:
            content = note.get("preview", "")
        note_bundles.append(f"## {note['title']}\n{content}")

    prompt = f"""你是一个中文知识库整理助手。请阅读同一个 Obsidian 文件夹下的多篇视频笔记，生成这个文件夹的知识蒸馏总结。

要求：
- 不要输出 <think>、思考过程。
- 不要复述原文，必须综合归纳。
- 输出 Markdown。
- 保留这些一级标题：
  # 文件夹总览
  # 本文件夹学到的核心知识
  # 反复出现的观点与模式
  # 关键概念索引
  # 可验证的问题
  # 下一步学习与研究建议

文件夹主题：{topic}
笔记数量：{len(notes)}

笔记内容：
{chr(10).join(note_bundles)}
"""
    summary = call_model_prompt(prompt, get_model_config(config), min_length=300)
    summary_path = folder_path / "文件夹知识蒸馏.md"
    summary_path.write_text(
        f"""---
title: {topic} 文件夹知识蒸馏
source: ClipMind
topic: {topic}
date: {datetime.now().strftime('%Y-%m-%d')}
note_count: {len(notes)}
---

{summary.strip()}
""",
        encoding="utf-8",
    )
    return {
        "topic": topic,
        "path": str(summary_path),
        "note_count": len(notes),
        "summary": summary,
    }


def update_model_config(patch: dict) -> dict:
    config = load_config()
    current = get_model_config(config)
    incoming = {key: value for key, value in patch.items() if value is not None}
    if incoming.get("api_key") == "":
        incoming.pop("api_key", None)
    if incoming.get("provider") == "openai_compatible" or current.get("provider") == "openai_compatible":
        incoming["base_url"] = normalize_openai_base_url(str(incoming.get("base_url") or current.get("base_url") or ""))
    config["model"] = {**current, **incoming}
    if config["model"].get("provider") == "ollama":
        config["ollama"] = {
            "model": config["model"].get("model", "qwen3:14b"),
            "base_url": config["model"].get("base_url", "http://127.0.0.1:11434"),
        }
    save_config(config)
    return get_public_config()


def update_app_config(patch: dict) -> dict:
    config = load_config()
    if "obsidian_output_dir" in patch and patch["obsidian_output_dir"] is not None:
        output_dir = str(patch["obsidian_output_dir"]).strip()
        if not output_dir:
            raise ValueError("obsidian_output_dir is required")
        config["obsidian_output_dir"] = output_dir
    if "default_tags" in patch and patch["default_tags"] is not None:
        tags = patch["default_tags"]
        if isinstance(tags, str):
            tags = [item.strip() for item in tags.split(",") if item.strip()]
        config["default_tags"] = list(dict.fromkeys(str(item).strip() for item in tags if str(item).strip()))
    save_config(config)
    return get_public_config()


def add_topic_folder(topic: str, folder: str | None = None) -> dict:
    clean_topic = topic.strip()
    clean_folder = (folder or topic).strip()
    if not clean_topic:
        raise ValueError("Topic name is required")
    if not clean_folder:
        raise ValueError("Folder name is required")
    config = load_config()
    topic_folders = dict(config.get("topic_folders") or {})
    topic_folders[clean_topic] = clean_folder
    config["topic_folders"] = topic_folders
    save_config(config)
    return get_public_config()


def extract_video_id(url: str) -> str:
    patterns = [
        r"v=([A-Za-z0-9_-]{11})",
        r"youtu\.be/([A-Za-z0-9_-]{11})",
        r"shorts/([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    raise ValueError(f"Could not extract video id from URL: {url}")


def sanitize_filename(value: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "_", value).strip() or "youtube-note"


def truncate_text(text: str, limit: int = 24000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n\n[内容过长，已截断]"


def compress_transcript_for_fast_summary(text: str, limit: int = ONLINE_FAST_INPUT_LIMIT) -> str:
    clean = re.sub(r"\s+", " ", (text or "")).strip()
    if len(clean) <= limit:
        return clean

    sentences = re.split(r"(?<=[。！？.!?])\s*", clean)
    sentences = [sentence.strip() for sentence in sentences if len(sentence.strip()) > 8]
    if not sentences:
        return truncate_text(clean, limit)

    head = sentences[:10]
    middle_start = max(0, len(sentences) // 2 - 5)
    middle = sentences[middle_start : middle_start + 10]
    tail = sentences[-10:]
    selected: list[str] = []
    seen: set[str] = set()
    for sentence in head + middle + tail:
        if sentence in seen:
            continue
        seen.add(sentence)
        selected.append(sentence)

    compressed = "\n".join(selected)
    return truncate_text(compressed, limit)


def is_probably_bad_page_transcript(text: str) -> bool:
    clean = re.sub(r"\s+", " ", (text or "")).strip()
    if len(clean) < 40:
        return True

    bad_markers = [
        "观看完整版视频",
        "播放列表",
        "万次观看",
        "次观看",
        "天前直播",
        "个月前直播",
        "小时前直播",
        "信息 购物",
        "查看完整版本视频",
        "相关视频",
        "推荐视频",
    ]
    bad_hits = sum(1 for marker in bad_markers if marker in clean)
    if bad_hits >= 2:
        return True

    short_lines = 0
    for line in [item.strip() for item in text.splitlines() if item.strip()]:
        if len(line) <= 2:
            short_lines += 1
    if short_lines >= 8:
        return True

    return False


def split_text(text: str, chunk_size: int = FAST_CHUNK_SIZE, overlap: int = FAST_CHUNK_OVERLAP) -> list[str]:
    clean = text.strip()
    if not clean:
        return []
    chunks: list[str] = []
    start = 0
    length = len(clean)
    while start < length:
        end = min(length, start + chunk_size)
        if end < length:
            newline = clean.rfind("\n", start, end)
            if newline > start + int(chunk_size * 0.65):
                end = newline
        chunk = clean[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= length:
            break
        start = max(0, end - overlap)
    return chunks

def remove_think_blocks(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"```(?:markdown|md)?", "", text, flags=re.IGNORECASE)
    return text.replace("```", "").strip()


@contextmanager
def sanitized_network_env():
    keys = [
        "NO_PROXY",
        "no_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]
    previous = {key: os.environ.get(key) for key in keys}
    try:
        for key in keys:
            value = previous.get(key)
            if value and ("::1" in value or "127.0.0.1" in value or "localhost" in value):
                os.environ.pop(key, None)
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def youtube_dl_base_opts() -> dict:
    config = load_config()
    youtube_config = dict(config.get("youtube") or {})
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 25,
        "retries": 2,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"],
            }
        },
    }
    node_path = shutil.which("node")
    if node_path:
        opts["js_runtimes"] = {"node": {"path": node_path}}
    cookies_from_browser = str(youtube_config.get("cookies_from_browser") or "").strip()
    cookies_file = str(youtube_config.get("cookies_file") or "").strip()
    if cookies_from_browser:
        browser_name, _, profile_name = cookies_from_browser.partition(":")
        browser_name = browser_name.strip()
        profile_name = profile_name.strip() or None
        if browser_name:
            opts["cookiesfrombrowser"] = (browser_name, profile_name, None, None)
    elif cookies_file:
        opts["cookiefile"] = cookies_file
    return opts


def basic_video_info(url: str) -> dict:
    video_id = extract_video_id(url)
    return {
        "title": video_id,
        "channel": "Unknown",
        "description": "",
        "webpage_url": url,
        "upload_date": None,
        "duration": None,
    }


def get_video_info_via_oembed(url: str) -> dict:
    response = requests.get(
        "https://www.youtube.com/oembed",
        params={"url": url, "format": "json"},
        timeout=15,
    )
    response.raise_for_status()
    data = response.json()
    return {
        "title": data.get("title") or extract_video_id(url),
        "channel": data.get("author_name") or "Unknown",
        "description": "",
        "webpage_url": url,
        "upload_date": None,
        "duration": None,
    }


def get_video_info(url: str) -> dict:
    info = None
    with sanitized_network_env():
        try:
            with YoutubeDL({**youtube_dl_base_opts(), "skip_download": True}) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:
            try:
                return get_video_info_via_oembed(url)
            except Exception:
                return basic_video_info(url)

    return {
        "title": info.get("title") or "Untitled",
        "channel": info.get("channel") or info.get("uploader") or "Unknown",
        "description": info.get("description") or "",
        "webpage_url": info.get("webpage_url") or url,
        "upload_date": info.get("upload_date"),
        "duration": info.get("duration"),
    }


def fetch_youtube_transcript(url: str) -> tuple[str, list[dict], str]:
    video_id = extract_video_id(url)
    transcript_list = YouTubeTranscriptApi().list(video_id)

    transcript = None
    for lang in ("zh-Hans", "zh-Hant", "zh", "en"):
        try:
            transcript = transcript_list.find_transcript([lang])
            break
        except Exception:
            continue

    if transcript is None:
        try:
            transcript = transcript_list.find_generated_transcript(
                ["zh-Hans", "zh-Hant", "zh", "en"]
            )
        except Exception as exc:
            raise RuntimeError("No YouTube transcript available") from exc

    items = transcript.fetch()
    entries = []
    for item in items:
        if isinstance(item, dict):
            start = float(item.get("start", 0))
            duration = float(item.get("duration", 0))
            text = str(item.get("text", "")).strip()
        else:
            start = float(getattr(item, "start", 0))
            duration = float(getattr(item, "duration", 0))
            text = str(getattr(item, "text", "")).strip()
        if not text:
            continue
        entries.append({"start": start, "end": start + duration, "text": text})
    text = "\n".join(entry["text"] for entry in entries)
    return text, entries, "youtube_transcript_api"


def download_audio(url: str) -> Path:
    video_id = extract_video_id(url)
    for old_file in WORK_DIR.glob(f"audio-{video_id}.*"):
        old_file.unlink(missing_ok=True)
    target = WORK_DIR / f"audio-{video_id}.%(ext)s"
    format_candidates = [
        "bestaudio/best",
        "ba",
        "worstaudio/best",
        "best",
    ]
    errors: list[str] = []
    with sanitized_network_env():
        for format_selector in format_candidates:
            try:
                opts = {
                    **youtube_dl_base_opts(),
                    "format": format_selector,
                    "outtmpl": str(target),
                }
                with YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    downloaded = Path(ydl.prepare_filename(info))
                if downloaded.exists():
                    return downloaded
            except Exception as exc:
                errors.append(f"{format_selector}: {exc}")
                for old_file in WORK_DIR.glob(f"audio-{video_id}.*"):
                    old_file.unlink(missing_ok=True)
                continue
    raise RuntimeError("Audio download failed after trying multiple format fallbacks: " + " | ".join(errors[:3]))


def transcribe_audio(audio_path: Path, config: dict) -> tuple[str, list[dict], str]:
    model_name = config["transcription"].get("whisper_model", "base")
    language = config["transcription"].get("language", "zh")

    with sanitized_network_env():
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(str(audio_path), language=language, vad_filter=True)

    entries = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        entries.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": text,
            }
        )

    if not entries:
        raise RuntimeError("Whisper transcription returned no usable text")

    text = "\n".join(entry["text"] for entry in entries)
    return text, entries, "faster_whisper"


def classify_topic(video_info: dict, transcript_text: str) -> str:
    haystack = f"{video_info['title']}\n{video_info['channel']}\n{transcript_text[:8000]}".lower()

    investment_keywords = [
        "投资",
        "股市",
        "美股",
        "台股",
        "财报",
        "仓位",
        "美光",
        "南亚科",
        "snp",
        "sandisk",
        "sndk",
        "nvidia",
        "ai基建",
        "定投",
        "杠杆",
    ]
    ai_keywords = ["大模型", "openai", "anthropic", "模型", "prompt", "agent", "llm", "ai"]
    business_keywords = ["商业", "公司战略", "管理", "营销", "创业", "业务"]
    tech_keywords = ["芯片", "半导体", "数据中心", "软件", "硬件", "云计算", "科技"]

    if any(keyword in haystack for keyword in investment_keywords):
        return "投资"
    if any(keyword in haystack for keyword in ai_keywords):
        return "AI"
    if any(keyword in haystack for keyword in business_keywords):
        return "商业"
    if any(keyword in haystack for keyword in tech_keywords):
        return "科技"
    return "其他"


def build_summary_prompt(video_info: dict, transcript_text: str, topic: str) -> str:
    return f"""你是一个中文知识管理助手。请基于当前视频的真实字幕生成 Obsidian 知识卡片。

要求：
- 只分析下面这条视频，不要复用任何历史视频内容。
- 不要输出 <think>、思考过程、原始转录全文。
- 内容要丰富，适合长期放入 Obsidian。
- 如果视频是投资内容，要区分事实、观点、假设和风险，不构成投资建议。
- 使用 Markdown，保留这些一级标题：
  # 一句话结论
  # 内容摘要
  # 核心观点
  # 论证链条
  # 关键信号与数据点
  # 对我的启发
  # 风险与疑点
  # 可执行动作
  # 延伸研究方向
  # 可双链关键词

视频标题：{video_info.get("title", "")}
频道：{video_info.get("channel", "")}
主题分类：{topic}

字幕：
{transcript_text}
"""


def build_fast_summary_prompt(video_info: dict, transcript_text: str, topic: str) -> str:
    return f"""你是一个中文视频知识卡片助手。请基于下面这份已经压缩过的字幕材料，快速产出一版高质量 Obsidian 笔记。

要求：
- 只输出 Markdown 正文，不要输出思考过程。
- 不要复述过长原句，要归纳提炼。
- 重点保留：结论、核心观点、论证链条、关键数据、风险提示、可执行动作。
- 如果是投资内容，明确区分事实、观点、假设、风险，不构成投资建议。
- 保留这些一级标题：
  # 一句话结论
  # 内容摘要
  # 核心观点
  # 论证链条
  # 关键信号与数据点
  # 对我的启发
  # 风险与疑点
  # 可执行动作
  # 延伸研究方向
  # 可双链关键词

视频标题：{video_info.get("title", "")}
频道：{video_info.get("channel", "")}
主题分类：{topic}

压缩字幕材料：
{transcript_text}
"""


def build_chunk_summary_prompt(
    video_info: dict,
    chunk_text: str,
    topic: str,
    index: int,
    total: int,
) -> str:
    return f"""你正在为一个长视频做分段笔记。请只总结当前字幕片段，不要补充片段外信息。

输出要求：
- 使用 Markdown。
- 不要输出 <think>、思考过程、原始转录全文。
- 保留作者的核心判断、论据、数字、公司名、人物名和风险提示。
- 如果是投资内容，明确区分事实、观点、假设、风险。
- 输出 6-10 条高密度要点，并附上“本段可提炼的关键词”。

视频标题：{video_info.get("title", "")}
频道：{video_info.get("channel", "")}
主题分类：{topic}
片段：{index}/{total}

当前字幕片段：
{chunk_text}
"""


def build_synthesis_prompt(video_info: dict, chunk_summaries: list[str], topic: str) -> str:
    joined = "\n\n".join(
        f"## 片段 {index}\n{summary}"
        for index, summary in enumerate(chunk_summaries, start=1)
    )
    return f"""你是一个中文知识管理助手。下面是同一个 YouTube 视频的分段摘要，请合成为一篇可长期保存到 Obsidian 的知识卡片。

要求：
- 只基于这些分段摘要，不要复用任何历史视频内容。
- 不要输出 <think>、思考过程、原始转录全文。
- 内容要丰富，要有归纳、结构和复盘价值，不要只是罗列。
- 如果视频是投资内容，要区分事实、观点、假设和风险，不构成投资建议。
- 使用 Markdown，保留这些一级标题：
  # 一句话结论
  # 内容摘要
  # 核心观点
  # 论证链条
  # 关键信号与数据点
  # 对我的启发
  # 风险与疑点
  # 可执行动作
  # 延伸研究方向
  # 可双链关键词

视频标题：{video_info.get("title", "")}
频道：{video_info.get("channel", "")}
主题分类：{topic}

分段摘要：
{joined}
"""


def optimize_model_config_for_summary(model_config: dict) -> dict:
    optimized = dict(model_config)
    if optimized.get("provider") != "openai_compatible":
        return optimized

    current_model = str(optimized.get("model") or "").strip()
    fallback_map = {
        "qwen-chat": "qwen3.5-non-thinking",
        "qwen3.5-thinking": "qwen3.5-non-thinking",
        "smart/reasoning": "smart/default",
        "glm-reasoner": "glm-chat",
    }
    optimized["model"] = fallback_map.get(current_model, current_model)
    return optimized


def prepare_fast_summary_input(video_info: dict, transcript_text: str, topic: str) -> str:
    compact = compress_transcript_for_fast_summary(transcript_text, ONLINE_FAST_INPUT_LIMIT)
    title = video_info.get("title", "")
    channel = video_info.get("channel", "")
    source = f"标题：{title}\n频道：{channel}\n主题：{topic}\n精简字幕：\n{compact}"
    return truncate_text(source, ONLINE_FAST_INPUT_LIMIT)


def summarize_with_model(video_info: dict, transcript_text: str, topic: str, config: dict) -> tuple[str, str]:
    model_config = get_model_config(config)
    model_config = optimize_model_config_for_summary(model_config)
    label = model_source_label(model_config)
    fast_transcript_text = prepare_fast_summary_input(video_info, transcript_text, topic)

    if model_config.get("provider") == "openai_compatible":
        prompt = build_fast_summary_prompt(video_info, fast_transcript_text, topic)
        return call_model_prompt(prompt, model_config, min_length=320), f"{label}:fast_online"

    if len(transcript_text) <= DIRECT_SUMMARY_LIMIT:
        prompt = build_summary_prompt(video_info, transcript_text, topic)
        try:
            return call_model_prompt(prompt, model_config, min_length=400), f"{label}:direct"
        except Exception as exc:
            if not should_retry_with_chunks(exc):
                raise

    chunks = split_text(transcript_text)
    if len(chunks) > MAX_CHUNKS_BEFORE_TRUNCATE:
        prompt = build_summary_prompt(video_info, truncate_text(transcript_text, FAST_TRUNCATE_LIMIT), topic)
        try:
            return call_model_prompt(prompt, model_config, min_length=400), f"{label}:direct_truncated"
        except Exception as exc:
            if not should_retry_with_chunks(exc):
                raise
        chunks = split_text(truncate_text(transcript_text, FAST_TRUNCATE_LIMIT))

    if len(chunks) <= 1:
        prompt = build_summary_prompt(video_info, truncate_text(transcript_text, FAST_TRUNCATE_LIMIT), topic)
        return call_model_prompt(prompt, model_config, min_length=400), f"{label}:direct_truncated"

    chunk_summaries = []
    for index, chunk in enumerate(chunks, start=1):
        prompt = build_chunk_summary_prompt(video_info, chunk, topic, index, len(chunks))
        chunk_summaries.append(call_model_prompt(prompt, model_config, min_length=120))

    final_prompt = build_synthesis_prompt(video_info, chunk_summaries, topic)
    final_summary = call_model_prompt(final_prompt, model_config, min_length=500)
    return final_summary, f"{label}:chunked:{len(chunks)}"


def should_retry_with_chunks(error: Exception) -> bool:
    lowered = str(error).lower()
    retry_markers = [
        "context",
        "token",
        "too long",
        "maximum",
        "length",
        "timed out",
        "timeout",
        "503",
        "502",
        "504",
    ]
    return any(marker in lowered for marker in retry_markers)


def model_source_label(model_config: dict) -> str:
    provider = model_config.get("provider", "ollama")
    return f"{provider}:{model_config.get('model')}"


def call_model_prompt(prompt: str, model_config: dict, min_length: int = 0) -> str:
    provider = model_config.get("provider", "ollama")
    if provider == "ollama":
        return summarize_with_ollama(prompt, model_config, min_length=min_length)
    if provider == "openai_compatible":
        return summarize_with_openai_compatible(prompt, model_config, min_length=min_length)
    raise RuntimeError(f"Unsupported model provider: {provider}")


def summarize_with_ollama(prompt: str, model_config: dict, min_length: int = 0) -> str:
    base_url = str(model_config.get("base_url", "http://127.0.0.1:11434")).rstrip("/")
    model = model_config.get("model", "qwen3:14b")
    timeout = max(30, min(int(model_config.get("timeout", 90)), 600))
    response = requests.post(
        f"{base_url}/api/generate",
        json={"model": model, "prompt": prompt, "stream": False},
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    summary = remove_think_blocks(str(data.get("response", "")))
    if len(summary) < min_length:
        raise RuntimeError("Ollama returned an unexpectedly short summary")
    return summary


def summarize_with_openai_compatible(prompt: str, model_config: dict, min_length: int = 0) -> str:
    base_url = normalize_openai_base_url(str(model_config.get("base_url", "")))
    if not base_url:
        raise RuntimeError("OpenAI-compatible base_url is required")
    model = model_config.get("model", "")
    if not model:
        raise RuntimeError("OpenAI-compatible model is required")
    api_key = str(model_config.get("api_key") or "")
    timeout = max(30, min(int(model_config.get("timeout", 90)), 600))
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        response = requests.post(
            openai_compatible_url(base_url, "chat/completions"),
            headers=headers,
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是严谨的中文知识管理助手。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": float(model_config.get("temperature", 0.3)),
                "stream": False,
            },
            timeout=(15, timeout),
        )
    except (requests.RequestException, OSError) as exc:
        raise RuntimeError(f"OpenAI-compatible request failed: {exc}") from exc
    raise_for_status_with_detail(response)
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    summary = remove_think_blocks(str(content))
    if len(summary) < min_length:
        raise RuntimeError("OpenAI-compatible API returned an unexpectedly short summary")
    return summary


def normalize_openai_base_url(base_url: str) -> str:
    cleaned = base_url.strip().rstrip("/")
    if not cleaned:
        return ""
    if cleaned.endswith("/chat/completions"):
        return cleaned[: -len("/chat/completions")]
    if cleaned.endswith("/models"):
        return cleaned[: -len("/models")]
    if re.search(r"/v\d+$", cleaned):
        return cleaned
    return f"{cleaned}/v1"


def openai_base_url_candidates(base_url: str) -> list[str]:
    cleaned = base_url.strip().rstrip("/")
    if not cleaned:
        return []
    if cleaned.endswith("/chat/completions"):
        cleaned = cleaned[: -len("/chat/completions")]
    if cleaned.endswith("/models"):
        cleaned = cleaned[: -len("/models")]
    if re.search(r"/v\d+$", cleaned):
        return [cleaned]
    return [f"{cleaned}/v1", cleaned]


def openai_compatible_url(base_url: str, endpoint: str) -> str:
    return f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"


def raise_for_status_with_detail(response: requests.Response) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        detail = response.text.strip()
        if len(detail) > 800:
            detail = f"{detail[:800]}..."
        url = response.url
        raise RuntimeError(f"{response.status_code} {response.reason}: {detail or 'empty response'} ({url})") from exc


def list_model_options(model_config: dict) -> dict:
    saved = get_model_config(load_config())
    incoming = {key: value for key, value in model_config.items() if value is not None}
    if incoming.get("api_key") == "":
        incoming.pop("api_key", None)
    merged = {**saved, **incoming}
    provider = merged.get("provider", "ollama")
    if provider == "ollama":
        return list_ollama_models(merged)
    if provider == "openai_compatible":
        return list_openai_compatible_models(merged)
    raise RuntimeError(f"Unsupported model provider: {provider}")


def list_ollama_models(model_config: dict) -> dict:
    base_url = str(model_config.get("base_url", "http://127.0.0.1:11434")).rstrip("/")
    response = requests.get(f"{base_url}/api/tags", timeout=int(model_config.get("timeout", 30)))
    raise_for_status_with_detail(response)
    data = response.json()
    models = [
        {"id": item.get("name", ""), "name": item.get("name", ""), "owned_by": "local"}
        for item in data.get("models", [])
        if item.get("name")
    ]
    return {"ok": True, "base_url": base_url, "items": models}


def list_openai_compatible_models(model_config: dict) -> dict:
    candidates = openai_base_url_candidates(str(model_config.get("base_url", "")))
    if not candidates:
        raise RuntimeError("OpenAI-compatible base_url is required")
    headers = {"Accept": "application/json"}
    api_key = str(model_config.get("api_key") or "")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    last_error: Exception | None = None
    data = None
    base_url = candidates[0]
    for candidate in candidates:
        try:
            response = requests.get(
                openai_compatible_url(candidate, "models"),
                headers=headers,
                timeout=int(model_config.get("timeout", 30)),
            )
            raise_for_status_with_detail(response)
            data = response.json()
            base_url = candidate
            break
        except Exception as exc:
            last_error = exc
    if data is None:
        raise RuntimeError(str(last_error) if last_error else "Failed to fetch model list")
    raw_models = data.get("data") if isinstance(data, dict) else data
    if not isinstance(raw_models, list):
        raise RuntimeError("Models endpoint returned an unsupported format")
    models = []
    for item in raw_models:
        if isinstance(item, str):
            models.append({"id": item, "name": item, "owned_by": ""})
        elif isinstance(item, dict) and item.get("id"):
            models.append(
                {
                    "id": str(item.get("id")),
                    "name": str(item.get("id")),
                    "owned_by": str(item.get("owned_by") or ""),
                }
            )
    return {"ok": True, "base_url": base_url, "items": models}


def test_model_config(model_config: dict) -> dict:
    saved = get_model_config(load_config())
    incoming = {key: value for key, value in model_config.items() if value is not None}
    if incoming.get("api_key") == "":
        incoming.pop("api_key", None)
    merged = {**saved, **incoming}
    prompt = "请只回复：连接成功"
    if merged.get("provider") == "ollama":
        text = summarize_with_ollama(prompt, merged)
    elif merged.get("provider") == "openai_compatible":
        text = summarize_with_openai_compatible(prompt, merged)
    else:
        raise RuntimeError(f"Unsupported model provider: {merged.get('provider')}")
    return {"ok": True, "message": text[:120], "base_url": normalize_openai_base_url(str(merged.get("base_url", ""))) if merged.get("provider") == "openai_compatible" else merged.get("base_url", "")}


def friendly_model_error(error: Exception | str) -> str:
    message = str(error)
    lowered = message.lower()
    if "broken pipe" in lowered:
        return "模型连接被远端意外中断，通常是上游服务提前断开了长请求。系统已改用本地提炼摘要兜底。"
    if "read timed out" in lowered or "timed out" in lowered or "timeout" in lowered:
        return "模型调用超时。连接测试只发送极短提示词，而本次视频字幕较长，远程接口没有在限定时间内返回。"
    if "remote end closed connection" in lowered or "connection reset" in lowered or "ssl" in lowered:
        return "模型接口在返回过程中中断了连接，通常是网关或上游模型服务不稳定。"
    if "401" in message or "unauthorized" in lowered:
        return "模型接口鉴权失败，请检查 API Key。"
    if "404" in message or "not found" in lowered:
        return "模型接口或模型名称不可用，请检查 Base URL 和 Model。"
    if "429" in message or "rate limit" in lowered:
        return "模型接口触发限流，请稍后重试或更换模型。"
    if "connection" in lowered:
        return "模型接口连接失败，请检查网络、代理或 Base URL。"
    return f"模型调用失败：{message}"


def summarize_extractively(video_info: dict, transcript_text: str, topic: str, reason: str | None = None) -> str:
    clean = re.sub(r"\s+", " ", transcript_text).strip()
    sentences = re.split(r"(?<=[。！？.!?])\s*", clean)
    sentences = [sentence.strip() for sentence in sentences if len(sentence.strip()) > 8]
    if not sentences:
        sentences = [clean[i : i + 120] for i in range(0, min(len(clean), 1200), 120)]

    head = sentences[:6]
    middle_start = max(0, len(sentences) // 2 - 3)
    middle = sentences[middle_start : middle_start + 6]
    tail = sentences[-6:]
    selected = []
    seen = set()
    for sentence in head + middle + tail:
        if sentence in seen:
            continue
        seen.add(sentence)
        selected.append(sentence)

    keywords = extract_keywords(video_info, transcript_text)
    bullets = "\n".join(f"- {sentence}" for sentence in selected[:10])
    keyword_links = "\n".join(f"- [[{keyword}]]" for keyword in keywords[:12])
    reason_text = reason or "模型分析没有完成。"

    return f"""# 一句话结论

这条视频的主题是“{video_info.get('title', '未命名视频')}”。本次模型分析未完成，系统已先基于字幕生成临时结构化摘要。

> 处理提示：{reason_text}

# 内容摘要

{bullets}

# 核心观点

{bullets}

# 论证链条

1. 视频围绕“{topic}”展开，主要信息来自标题、频道和字幕内容。
2. 开头部分给出议题和主要判断。
3. 中段展开理由、案例或数据。
4. 结尾通常包含行动建议、提醒或下一步观察点。

# 关键信号与数据点

{keyword_links or "- 暂未提取到稳定关键词"}

# 对我的启发

- 这条内容值得先进入知识库，再结合原视频复核重点段落。
- 如果这是观点类视频，应把作者判断拆成“事实、假设、风险、待验证信号”。

# 风险与疑点

- 当前版本是临时兜底摘要，表达质量和归纳深度有限。
- 字幕或本地转录可能存在人名、公司名、数字误识别。

# 可执行动作

- 将本笔记作为初版材料保存。
- 后续在模型服务恢复后重新运行分析。
- 对涉及决策的关键观点回看原视频确认。

# 延伸研究方向

- {topic} 相关的连续视频对比
- 同一作者观点的事后验证
- 关键概念、公司或人物的主题索引

# 可双链关键词

{keyword_links or "- [[视频笔记]]"}
""".strip()


def extract_keywords(video_info: dict, transcript_text: str) -> list[str]:
    text = f"{video_info.get('title', '')} {transcript_text[:5000]}"
    candidates = re.findall(r"[\u4e00-\u9fffA-Za-z0-9_-]{2,24}", text)
    stopwords = {
        "这个",
        "就是",
        "我们",
        "他们",
        "大家",
        "所以",
        "然后",
        "因为",
        "但是",
        "如果",
        "视频",
    }
    counts: dict[str, int] = {}
    for item in candidates:
        key = item.strip()
        if key.lower() in stopwords or key in stopwords:
            continue
        counts[key] = counts.get(key, 0) + 1
    return [key for key, _count in sorted(counts.items(), key=lambda pair: pair[1], reverse=True)]


def summarize_note(video_info: dict, transcript_text: str, topic: str, config: dict) -> tuple[str, str]:
    try:
        return summarize_with_model(video_info, transcript_text, topic, config)
    except Exception as exc:
        reason = friendly_model_error(exc)
        return summarize_extractively(video_info, transcript_text, topic, reason), f"extractive_fallback: {reason}"

#+#+#+#+functions.exec_command to=functions.exec_command 鲁夜夜啪o՞ւjson  天天买彩票assistant to=functions.exec_command კომენტary ,超碰width constraints? We need continue maybe enough. Need now install deps result. Use write_stdin. Also need maybe no escalations now because approved. Let's poll session 74455. Then build service files. Need maybe use apply_patch to add api.py, jobs.py, models maybe. Also adjust requirements. Let's poll.
