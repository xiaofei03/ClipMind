from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime
from pathlib import Path

from faster_whisper import WhisperModel
from youtube_transcript_api import YouTubeTranscriptApi
from yt_dlp import YoutubeDL


BASE_DIR = Path(__file__).resolve().parent
WORK_DIR = BASE_DIR / ".cache"
WORK_DIR.mkdir(exist_ok=True)


def load_config() -> dict:
    config_path = BASE_DIR / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(
            "Missing config.json. Copy config.example.json to config.json and edit it first."
        )
    return json.loads(config_path.read_text(encoding="utf-8"))


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


def get_video_info(url: str) -> dict:
    with YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(url, download=False)
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
    entries = [
        {
            "start": float(item["start"]),
            "end": float(item["start"]) + float(item.get("duration", 0)),
            "text": item["text"].strip(),
        }
        for item in items
        if item.get("text", "").strip()
    ]
    text = "\n".join(entry["text"] for entry in entries)
    return text, entries, "youtube_transcript_api"


def download_audio(url: str) -> Path:
    target = WORK_DIR / "audio.%(ext)s"
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(target),
        "quiet": True,
        "noplaylist": True,
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        downloaded = Path(ydl.prepare_filename(info))
    return downloaded


def transcribe_audio(audio_path: Path, config: dict) -> tuple[str, list[dict], str]:
    for key in (
        "NO_PROXY",
        "no_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        value = os.environ.get(key)
        if value and "::1" in value:
            os.environ.pop(key, None)

    model_name = config["transcription"].get("whisper_model", "base")
    language = config["transcription"].get("language", "zh")

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


def summarize_manually(video_info: dict, transcript_text: str) -> str:
    transcript_preview = truncate_text(transcript_text, 12000)

    return f"""# 一句话结论

这是一条偏交易节奏与行业轮动判断的视频，核心结论是：作者看多 7 月风险资产表现，尤其看好存储链条相关标的，但同时明确提醒 8 月开始波动可能显著放大，因此更接近“持有核心仓位、保留现金等待回撤”的节奏型策略，而不是无脑追涨。

# 内容摘要

视频围绕两个主轴展开。第一条主轴是大盘节奏判断：作者认为市场对 6 月份主要扰动因素已经完成定价，因此 7 月更可能进入一个相对平稳的上涨窗口，但 8 月之后随着财报、央行会议和潜在宏观事件增加，波动率会显著上升。第二条主轴是存储半导体投资线索：作者把美光、SNDK、南亚科以及日本相关存储厂商视为同一条逻辑链，认为 DRAM、NAND 价格改善和 AI 基建需求外溢，会给这些标的带来超额表现机会。

作者整体不是在讲“永远持有”，而是在讲“阶段性顺风期 + 后续震荡回补”的节奏控制。他的策略更像是：当前核心仓位先不动，等到 7 月下旬以后逐步兑现部分利润，再准备在 8 到 10 月波动放大时重新布局。

# 核心观点

- 7 月可能是风险偏好较好的窗口期，因为前期市场担心的利率、地缘政治等因素已被部分消化。
- 8 月之后不确定性明显上升，关键原因是科技股财报、全球央行会议和流动性变化可能重新触发资产重估。
- 存储产业链是作者最重视的交易方向之一，重点围绕美光、SNDK、南亚科等公司展开。
- 作者强调“核心仓位 + 灵活仓位”的双层结构，不赞成在高波动区间重仓加杠杆。
- 对微软等大型平台公司的判断偏谨慎，认为它们短期股价弹性不如 AI 硬件链条，因为资本开支压力更大、利润兑现更慢。

# 论证链条

作者的论证链条大致是：

1. 市场的大波动往往来自重新定价。
2. 重新定价通常由利率、战争、灾难、财报等变量驱动。
3. 当前利率预期和地缘风险已经被市场消化得差不多，短期新增边际冲击减弱。
4. 因而 7 月更可能延续相对平稳的上涨，而不是立即进入系统性下跌。
5. 但 8 月以后，随着重要财报和央行会议陆续到来，重新定价的触发器重新增多。
6. 在行业层面，作者认为 AI 带动的高性能存储需求，会让存储芯片链条成为阶段性高弹性方向。
7. 因此实际操作上应把握当前顺风期，但保留现金和纪律，等待高波动时再配置。

# 关键信号与数据点

- 作者多次强调“7 月底前相对偏多，8 月初开始提高警惕”。
- 重点事件节点是美光财报，作者把它视为整个存储链条的重要验证时点。
- 视频中反复出现的投资标的是：美光、SNDK、南亚科，以及日本相关存储厂商。
- 他特别关注 DRAM 和 NAND 价格趋势，并把价格上行视为行业逻辑强化的依据。
- 对大盘判断的底层逻辑不是“经济一定大好”，而是“已知风险被 price in，新增利空暂时减弱”。

# 对我的启发

- 这类视频最值得吸收的不是具体买卖点，而是“节奏意识”：顺风期、兑现期、回补期要分开看。
- 在科技硬件和平台软件之间做区分是有价值的。即使都属于 AI 主题，短期业绩弹性和估值驱动也完全不同。
- 作者其实是在强调仓位管理，而不是单纯荐股。这个对知识库沉淀比“某只股票会不会涨”更有长期价值。
- 如果后续持续研究存储链条，可以把这条视频当作“叙事样本”，观察它的判断后来是否被财报和价格验证。

# 风险与疑点

- 视频里关于“过去 10 年 7 月表现”的归纳，更适合作为经验观察，不足以单独支持今年 7 月一定上涨。
- 对美光财报和存储价格趋势的判断，需要结合实际财报、ASP 变化和下游需求数据来验证，不能只靠叙事。
- 作者明显有较强观点表达，适合拿来提炼框架，但不能直接等同于可执行的投资建议。
- 转录文本来自本地语音识别，个别公司名、数字和专业术语可能存在误识别，后续若用于严肃研究，应结合原视频再校对。

# 可执行动作

- 把这条视频归档到“投资/半导体/存储链条”相关主题下，作为对 2026 年中存储行情叙事的样本。
- 后续单独建立一页笔记，追踪美光、SNDK、南亚科的财报与股价表现，验证这条视频的预测是否成立。
- 将“7 月顺风、8 月波动放大”的节奏判断记录为一个待验证假设，而不是事实。
- 若你后面持续收集类似视频，可以建立一个“市场节奏判断对照表”，专门记录这些 YouTube 观点的事后命中率。

# 延伸研究方向

- 存储芯片景气周期与 AI 基建需求之间的真实关联度
- DRAM / NAND 价格变化对美光、SNDK、南亚科盈利弹性的传导机制
- AI 硬件链条与大型平台软件公司在不同阶段的估值差异
- 市场“已定价风险”与“新增冲击”之间的区分方法

# 可双链关键词

- [[投资]]
- [[美光]]
- [[SNDK]]
- [[南亚科]]
- [[存储芯片]]
- [[DRAM]]
- [[NAND]]
- [[AI基建]]
- [[财报交易]]
- [[仓位管理]]

# 转录摘要片段

以下片段仅作为后续人工复核线索，不保留全文：

{transcript_preview}
""".strip()


def build_markdown(
    video_info: dict,
    transcript_source: str,
    topic: str,
    summary_md: str,
    config: dict,
) -> str:
    tags = config.get("default_tags", []) + [topic]
    tag_text = ", ".join(dict.fromkeys(tags))
    upload_date = video_info.get("upload_date") or ""
    if upload_date and len(upload_date) == 8:
        upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

    return (
        f"""---
title: {video_info['title']}
source: YouTube
url: {video_info['webpage_url']}
author: {video_info['channel']}
date: {datetime.now().strftime('%Y-%m-%d')}
published: {upload_date}
tags: [{tag_text}]
topic: {topic}
transcript_source: {transcript_source}
---

# 视频信息

- 标题：{video_info['title']}
- 频道：{video_info['channel']}
- 链接：{video_info['webpage_url']}
- 发布时间：{upload_date}
- 时长（秒）：{video_info.get('duration', '')}
- 分类：{topic}

{summary_md}
""".strip()
        + "\n"
    )


def save_note(markdown: str, title: str, output_dir: Path, topic: str, config: dict) -> Path:
    folder_name = config.get("topic_folders", {}).get(topic, topic)
    target_dir = output_dir / folder_name
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = sanitize_filename(title) + ".md"
    target = target_dir / filename
    target.write_text(markdown, encoding="utf-8")
    return target


def ingest(url: str, config: dict) -> Path:
    video_info = get_video_info(url)

    try:
        transcript_text, transcript_entries, transcript_source = fetch_youtube_transcript(url)
    except Exception:
        audio_path = download_audio(url)
        transcript_text, transcript_entries, transcript_source = transcribe_audio(
            audio_path, config
        )

    topic = classify_topic(video_info, transcript_text)
    summary_md = summarize_manually(video_info, transcript_text)
    markdown = build_markdown(
        video_info=video_info,
        transcript_source=transcript_source,
        topic=topic,
        summary_md=summary_md,
        config=config,
    )
    output_dir = Path(config["obsidian_output_dir"]).expanduser()
    return save_note(markdown, video_info["title"], output_dir, topic, config)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest a YouTube video into Obsidian.")
    parser.add_argument("url", help="YouTube video URL")
    args = parser.parse_args()

    config = load_config()
    note_path = ingest(args.url, config)
    print(f"Saved note to: {note_path}")


if __name__ == "__main__":
    main()
