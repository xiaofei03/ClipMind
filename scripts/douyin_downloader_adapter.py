import importlib.util
import json
import re
import sys
from pathlib import Path


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def normalize_url(raw):
    match = re.search(r"https?://[^\s\"'<>，。！？；、）】》]+", raw or "", re.I)
    if not match:
        raise ValueError("input does not contain an http or https URL")
    return re.sub(r"[\),.;!?，。！？；、:：]+$", "", match.group(0))


def load_downloader(repo_dir):
    app_path = Path(repo_dir) / "app.py"
    if not app_path.exists():
        raise FileNotFoundError(f"app.py not found in {repo_dir}")
    spec = importlib.util.spec_from_file_location("ghliuyb_douyin_downloader_app", app_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "logger"):
        module.logger = module.setup_logging()
    return module


def extract_aweme_id(url):
    for pattern in (r"/video/(\d+)", r"aweme_id=(\d+)", r"modal_id=(\d+)", r"(\d{15,})"):
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def main():
    if len(sys.argv) < 4:
        emit({
            "ok": False,
            "category": "usage",
            "error": "Usage: python douyin_downloader_adapter.py <repo-dir> <url-or-share-text> <out-dir> [cookies-file]"
        })
        return 2

    repo_dir = Path(sys.argv[1])
    raw_url = sys.argv[2]
    out_dir = Path(sys.argv[3])
    cookies_file = Path(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else None
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        downloader = load_downloader(repo_dir)
        if cookies_file:
            downloader.COOKIE_FILE = cookies_file

        original_url = normalize_url(raw_url)
        resolved_url = downloader.resolve_share_url(original_url)
        aweme_id = extract_aweme_id(resolved_url) or extract_aweme_id(original_url)
        if not aweme_id:
            emit({
                "ok": False,
                "category": "douyin_id_not_found",
                "originalUrl": original_url,
                "resolvedUrl": resolved_url,
                "error": "Could not extract aweme_id."
            })
            return 1

        video_url = downloader.get_video_detail(aweme_id)
        if not video_url:
            emit({
                "ok": False,
                "category": "douyin_downloader_no_video_url",
                "originalUrl": original_url,
                "resolvedUrl": resolved_url,
                "awemeId": aweme_id,
                "error": "GHLiuyb/douyin_downloader could not get a playable download URL."
            })
            return 1

        video_path = out_dir / f"douyin_{aweme_id}.mp4"
        task_id = f"mcp_{aweme_id}"
        downloader.download_tasks[task_id] = {"status": "downloading", "progress": 0}
        downloaded = downloader.download_file(video_url, str(video_path), task_id)
        if downloaded <= 0 or not video_path.exists() or video_path.stat().st_size <= 0:
            emit({
                "ok": False,
                "category": "douyin_downloader_empty_file",
                "originalUrl": original_url,
                "resolvedUrl": resolved_url,
                "awemeId": aweme_id,
                "videoUrl": video_url,
                "error": "Download produced an empty file."
            })
            return 1

        emit({
            "ok": True,
            "source": "GHLiuyb/douyin_downloader",
            "originalUrl": original_url,
            "resolvedUrl": resolved_url,
            "awemeId": aweme_id,
            "videoUrl": video_url,
            "videoPath": str(video_path),
            "bytes": video_path.stat().st_size
        })
        return 0
    except Exception as error:
        emit({
            "ok": False,
            "category": "douyin_downloader_failed",
            "error": str(error)
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
