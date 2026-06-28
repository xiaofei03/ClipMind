from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "jobs.db"

_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                topic TEXT,
                is_favorited INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                output_path TEXT,
                error_message TEXT,
                meta_json TEXT NOT NULL DEFAULT '{}'
            )
            """
        )
        conn.commit()


def create_job(url: str, is_favorited: bool = False, status: str = "queued", stage: str = "queued") -> dict:
    job_id = str(uuid.uuid4())
    now = utc_now()
    record = {
        "id": job_id,
        "url": url,
        "title": None,
        "status": status,
        "stage": stage,
        "topic": None,
        "is_favorited": 1 if is_favorited else 0,
        "created_at": now,
        "updated_at": now,
        "started_at": None,
        "finished_at": None,
        "output_path": None,
        "error_message": None,
        "meta_json": "{}",
    }
    with _LOCK, get_conn() as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                id, url, title, status, stage, topic, is_favorited, created_at, updated_at,
                started_at, finished_at, output_path, error_message, meta_json
            ) VALUES (
                :id, :url, :title, :status, :stage, :topic, :is_favorited, :created_at, :updated_at,
                :started_at, :finished_at, :output_path, :error_message, :meta_json
            )
            """,
            record,
        )
        conn.commit()
    return get_job(job_id)


def delete_job(job_id: str) -> None:
    with _LOCK, get_conn() as conn:
        cursor = conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        conn.commit()
    if cursor.rowcount == 0:
        raise KeyError(f"Job not found: {job_id}")


def update_job(job_id: str, **fields) -> dict:
    if not fields:
        return get_job(job_id)
    fields["updated_at"] = utc_now()
    assignments = ", ".join(f"{key} = :{key}" for key in fields.keys())
    params = {**fields, "id": job_id}
    with _LOCK, get_conn() as conn:
        conn.execute(f"UPDATE jobs SET {assignments} WHERE id = :id", params)
        conn.commit()
    return get_job(job_id)


def patch_job_meta(job_id: str, **meta_fields) -> dict:
    job = get_job(job_id)
    meta = dict(job.get("meta") or {})
    meta.update(meta_fields)
    return update_job(job_id, meta_json=json.dumps(meta, ensure_ascii=False))


def get_job(job_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise KeyError(f"Job not found: {job_id}")
    data = dict(row)
    data["is_favorited"] = bool(data["is_favorited"])
    data["meta"] = json.loads(data.pop("meta_json") or "{}")
    return data


def list_jobs(limit: int = 100, url: str | None = None) -> list[dict]:
    query = "SELECT * FROM jobs"
    params: list[object] = []
    if url:
        query += " WHERE url = ?"
        params.append(url)
    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    results = []
    for row in rows:
        data = dict(row)
        data["is_favorited"] = bool(data["is_favorited"])
        data["meta"] = json.loads(data.pop("meta_json") or "{}")
        results.append(data)
    return results


def list_unfinished_jobs(limit: int = 100) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM jobs
            WHERE status IN ('queued', 'running')
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    results = []
    for row in rows:
        data = dict(row)
        data["is_favorited"] = bool(data["is_favorited"])
        data["meta"] = json.loads(data.pop("meta_json") or "{}")
        results.append(data)
    return results
