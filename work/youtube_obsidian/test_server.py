from __future__ import annotations

from fastapi.testclient import TestClient

from server import app
from storage import init_db


def main() -> None:
    init_db()
    client = TestClient(app)

    health = client.get("/health")
    print("GET /health ->", health.status_code, health.json())

    jobs = client.get("/jobs")
    print("GET /jobs ->", jobs.status_code, jobs.json())

    created = client.post(
        "/jobs",
        json={
            "url": "https://www.youtube.com/watch?v=hOFCVc1qOY8",
            "is_favorited": True,
        },
    )
    print("POST /jobs ->", created.status_code)
    print(created.json())

    job_id = created.json()["id"]
    detail = client.get(f"/jobs/{job_id}")
    print(f"GET /jobs/{job_id} ->", detail.status_code)
    print(detail.json())

    filtered = client.get(
        "/jobs",
        params={"url": "https://www.youtube.com/watch?v=hOFCVc1qOY8"},
    )
    print("GET /jobs?url=... ->", filtered.status_code, filtered.json())


if __name__ == "__main__":
    main()
