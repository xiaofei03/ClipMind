from __future__ import annotations

import json
from pathlib import Path

from core import (
    classify_topic,
    fetch_youtube_transcript,
    get_video_info,
    is_probably_bad_page_transcript,
    load_config,
    summarize_note,
    transcribe_audio,
    download_audio,
)
from storage import get_job, patch_job_meta, update_job, utc_now


def build_markdown(
    video_info: dict,
    transcript_source: str,
    topic: str,
    summary_md: str,
    config: dict,
) -> str:
    from datetime import datetime

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
    from core import sanitize_filename

    folder_name = config.get("topic_folders", {}).get(topic, topic)
    target_dir = output_dir / folder_name
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = sanitize_filename(title) + ".md"
    target = target_dir / filename
    target.write_text(markdown, encoding="utf-8")
    return target


def resolve_job_topic(job_id: str, detected_topic: str) -> str:
    job = get_job(job_id)
    meta = dict(job.get("meta") or {})
    preferred_topic = str(meta.get("preferred_topic") or "").strip()
    return preferred_topic or detected_topic


def load_page_capture(job_id: str, url: str) -> tuple[dict | None, str | None, list[dict] | None, str | None]:
    job = get_job(job_id)
    meta = dict(job.get("meta") or {})
    raw_video_info = meta.get("page_video_info")
    video_info = None
    if isinstance(raw_video_info, dict):
        video_info = {
            "title": raw_video_info.get("title") or "",
            "channel": raw_video_info.get("channel") or "Unknown",
            "description": raw_video_info.get("description") or "",
            "webpage_url": raw_video_info.get("webpage_url") or url,
            "upload_date": raw_video_info.get("upload_date"),
            "duration": raw_video_info.get("duration"),
        }
    transcript_text = str(meta.get("page_transcript_text") or "").strip() or None
    transcript_entries = meta.get("page_transcript_entries")
    if not isinstance(transcript_entries, list):
        transcript_entries = None
    transcript_source = str(meta.get("page_transcript_source") or "").strip() or None
    return video_info, transcript_text, transcript_entries, transcript_source


def process_job(job_id: str, url: str) -> dict:
    config = load_config()
    youtube_config = dict(config.get("youtube") or {})
    keep_audio_cache = bool(youtube_config.get("keep_audio_cache", False))
    seeded_video_info, seeded_transcript_text, seeded_transcript_entries, seeded_transcript_source = load_page_capture(job_id, url)

    update_job(job_id, status="running", stage="extracting_metadata", started_at=utc_now())
    video_info = seeded_video_info or get_video_info(url)
    update_job(job_id, title=video_info["title"])

    transcript_text = seeded_transcript_text or ""
    transcript_source = seeded_transcript_source or ""
    transcript_entries = seeded_transcript_entries or []

    if transcript_text and is_probably_bad_page_transcript(transcript_text):
        patch_job_meta(
            job_id,
            page_capture_rejected=True,
            page_capture_reject_reason="detected_non_subtitle_page_text",
            page_capture_original_source=transcript_source or "unknown",
        )
        transcript_text = ""
        transcript_source = ""
        transcript_entries = []

    if transcript_text:
        patch_job_meta(job_id, page_capture_used=True)
    else:
        try:
            update_job(job_id, stage="fetching_transcript")
            transcript_text, transcript_entries, transcript_source = fetch_youtube_transcript(url)
        except Exception as exc:
            patch_job_meta(job_id, transcript_fetch_error=str(exc))
            update_job(job_id, stage="downloading_audio")
            audio_path = download_audio(url)
            patch_job_meta(job_id, audio_path=str(audio_path))
            try:
                update_job(job_id, stage="transcribing_audio")
                transcript_text, transcript_entries, transcript_source = transcribe_audio(audio_path, config)
            finally:
                if not keep_audio_cache:
                    audio_path.unlink(missing_ok=True)
                    patch_job_meta(job_id, audio_deleted=True)

    patch_job_meta(job_id, transcript_source=transcript_source, transcript_length=len(transcript_text))

    update_job(job_id, stage="classifying_note")
    detected_topic = classify_topic(video_info, transcript_text)
    topic = resolve_job_topic(job_id, detected_topic)
    patch_job_meta(job_id, detected_topic=detected_topic)

    update_job(job_id, stage="structuring_note", topic=topic)
    summary_md, summary_source = summarize_note(video_info, transcript_text, topic, config)
    patch_job_meta(job_id, summary_source=summary_source)
    markdown = build_markdown(
        video_info=video_info,
        transcript_source=transcript_source,
        topic=topic,
        summary_md=summary_md,
        config=config,
    )

    update_job(job_id, stage="writing_obsidian")
    output_dir = Path(config["obsidian_output_dir"]).expanduser()
    note_path = save_note(markdown, video_info["title"], output_dir, topic, config)

    return update_job(
        job_id,
        status="done",
        stage="done",
        finished_at=utc_now(),
        output_path=str(note_path),
        topic=topic,
    )
