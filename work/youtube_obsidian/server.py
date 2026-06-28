from __future__ import annotations

import json
import queue
import threading
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from core import (
    add_topic_folder,
    distill_library_folder,
    get_public_config,
    list_model_options,
    list_library_folders,
    test_model_config,
    update_app_config,
    update_model_config,
)
from service import process_job
from storage import create_job, delete_job, get_job, init_db, list_jobs, list_unfinished_jobs, update_job, utc_now


class CreateJobRequest(BaseModel):
    url: str
    is_favorited: bool = Field(default=False)
    process_now: bool = Field(default=True)


class ModelConfigRequest(BaseModel):
    provider: str = Field(default="ollama")
    model: str
    base_url: str
    api_key: str | None = Field(default=None)
    temperature: float = Field(default=0.3)
    timeout: int = Field(default=180)


class TopicFolderRequest(BaseModel):
    topic: str
    folder: str | None = Field(default=None)


class JobTopicRequest(BaseModel):
    topic: str


class AppConfigRequest(BaseModel):
    obsidian_output_dir: str | None = Field(default=None)
    default_tags: list[str] | str | None = Field(default=None)


class BrowserTranscriptEntry(BaseModel):
    start: float = Field(default=0)
    end: float = Field(default=0)
    text: str


class BrowserCaptureRequest(BaseModel):
    url: str
    title: str | None = Field(default=None)
    channel: str | None = Field(default=None)
    description: str | None = Field(default=None)
    upload_date: str | None = Field(default=None)
    duration: int | None = Field(default=None)
    transcript_text: str | None = Field(default=None)
    transcript_source: str | None = Field(default=None)
    transcript_entries: list[BrowserTranscriptEntry] | None = Field(default=None)
    topic: str | None = Field(default=None)
    is_favorited: bool = Field(default=True)
    process_now: bool = Field(default=True)


app = FastAPI(title="YouTube Obsidian Local Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
job_queue: queue.Queue[str] = queue.Queue()
worker_thread: threading.Thread | None = None


def worker() -> None:
    while True:
        job_id = job_queue.get()
        try:
            job = get_job(job_id)
            process_job(job_id, job["url"])
        except Exception as exc:
            update_job(
                job_id,
                status="failed",
                stage="failed",
                error_message=str(exc),
                finished_at=utc_now(),
            )
        finally:
            job_queue.task_done()


def ensure_worker_started() -> None:
    global worker_thread
    if worker_thread and worker_thread.is_alive():
        return
    worker_thread = threading.Thread(target=worker, daemon=True, name="yingji-job-worker")
    worker_thread.start()


def enqueue_job(job_id: str) -> None:
    ensure_worker_started()
    job_queue.put(job_id)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    for job in list_unfinished_jobs():
        if job["status"] == "running":
            update_job(job["id"], status="queued", stage="queued")
        enqueue_job(job["id"])
    ensure_worker_started()


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "worker_alive": bool(worker_thread and worker_thread.is_alive()),
        "queue_size": job_queue.qsize(),
    }


@app.get("/config")
def config_detail() -> dict:
    return get_public_config()


@app.put("/config/model")
def update_model(payload: ModelConfigRequest) -> dict:
    try:
        return update_model_config(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/config/app")
def update_app(payload: AppConfigRequest) -> dict:
    try:
        return update_app_config(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/config/topic-folders")
def add_topic_folder_endpoint(payload: TopicFolderRequest) -> dict:
    try:
        return add_topic_folder(payload.topic, payload.folder)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/config/model/test")
def test_model(payload: ModelConfigRequest) -> dict:
    try:
        return test_model_config(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/config/model/models")
def list_models(payload: ModelConfigRequest) -> dict:
    try:
        return list_model_options(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/jobs")
def jobs(
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    url: str | None = None,
) -> dict:
    return {"items": list_jobs(limit=limit, url=url)}


@app.get("/library/folders")
def library_folders() -> dict:
    try:
        return list_library_folders()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/library/folders/{topic}/distill")
def distill_folder_endpoint(topic: str) -> dict:
    try:
        return distill_library_folder(topic)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/jobs/{job_id}")
def job_detail(job_id: str) -> dict:
    try:
        return get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/jobs")
def create_job_endpoint(payload: CreateJobRequest) -> dict:
    status = "queued" if payload.process_now else "saved"
    job = create_job(payload.url, payload.is_favorited, status=status, stage=status)
    if payload.process_now:
        enqueue_job(job["id"])
    return job


@app.post("/captures/youtube")
def create_browser_capture_job_endpoint(payload: BrowserCaptureRequest) -> dict:
    status = "queued" if payload.process_now else "saved"
    job = create_job(payload.url, payload.is_favorited, status=status, stage=status)
    meta: dict[str, object] = {}
    if payload.topic and payload.topic.strip():
        meta["preferred_topic"] = payload.topic.strip()
    transcript_text = (payload.transcript_text or "").strip()
    if transcript_text:
        meta["page_transcript_text"] = transcript_text
        meta["page_transcript_source"] = (payload.transcript_source or "browser_extension").strip() or "browser_extension"
    if payload.transcript_entries:
        meta["page_transcript_entries"] = [entry.model_dump() for entry in payload.transcript_entries]
    meta["page_video_info"] = {
        "title": (payload.title or "").strip() or None,
        "channel": (payload.channel or "").strip() or None,
        "description": payload.description or "",
        "webpage_url": payload.url,
        "upload_date": payload.upload_date,
        "duration": payload.duration,
    }
    updated = update_job(
        job["id"],
        title=(payload.title or "").strip() or None,
        topic=(payload.topic or "").strip() or None,
        meta_json=json.dumps(meta, ensure_ascii=False),
    )
    if payload.process_now:
        enqueue_job(updated["id"])
    return updated


@app.post("/jobs/{job_id}/process")
def process_saved_job_endpoint(job_id: str) -> dict:
    try:
        job = get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if job["status"] in {"queued", "running"}:
        return job

    updated = update_job(
        job_id,
        status="queued",
        stage="queued",
        error_message=None,
        started_at=None,
        finished_at=None,
    )
    enqueue_job(job_id)
    return updated


@app.put("/jobs/{job_id}/topic")
def update_job_topic_endpoint(job_id: str, payload: JobTopicRequest) -> dict:
    try:
        job = get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    topic = payload.topic.strip()
    if not topic:
        raise HTTPException(status_code=400, detail="Topic is required")
    meta = dict(job.get("meta") or {})
    meta["preferred_topic"] = topic
    return update_job(
        job_id,
        topic=topic,
        meta_json=json.dumps(meta, ensure_ascii=False),
    )


@app.post("/jobs/{job_id}/retry")
def retry_job_endpoint(job_id: str) -> dict:
    try:
        job = get_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    meta = dict(job.get("meta") or {})
    if meta.get("summary_source"):
        meta["previous_summary_source"] = meta.get("summary_source")
    meta.pop("summary_source", None)
    meta.pop("transcript_fetch_error", None)
    meta.pop("audio_path", None)
    meta.pop("audio_deleted", None)
    meta.pop("page_capture_used", None)
    meta.pop("page_capture_rejected", None)
    meta.pop("page_capture_reject_reason", None)
    meta.pop("page_capture_original_source", None)
    meta.pop("page_transcript_rejected", None)
    meta.pop("page_transcript_reject_reason", None)
    meta.pop("page_transcript_preview", None)
    meta["retry_requested_at"] = utc_now()
    updated = update_job(
        job_id,
        status="queued",
        stage="queued",
        error_message=None,
        started_at=None,
        finished_at=None,
        output_path=None,
        meta_json=json.dumps(meta, ensure_ascii=False),
    )
    enqueue_job(job_id)
    return updated


@app.delete("/jobs/{job_id}")
def delete_job_endpoint(job_id: str) -> dict:
    try:
        delete_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
