# ClipMind

ClipMind is a local-first video learning tool. Paste a video link, let the app detect the platform, extract text and visual evidence, and generate structured notes such as illustrated HTML, editable Word documents, mind maps, and subtitle summaries.

> The project is designed for learning, reviewing, and turning long-form videos into reusable knowledge notes.

## Features

- Video inbox: collect links first, classify by platform, add notes, and send selected videos to the workspace.
- Platform routing: supports Douyin, Bilibili, YouTube, direct media links, and generic web video pages.
- Text-first analysis: prefers platform subtitles, automatic subtitles, page text, and danmaku; falls back to Whisper only when a text track is missing.
- Smart frame selection: uses subtitles, scene changes, OCR-like visual screening, and a refinement plan instead of fixed dense sampling.
- Multiple outputs:
  - illustrated HTML notes
  - editable Word `.docx`
  - Markdown notes
  - Markmap mind map
  - subtitle summary with a logical tree
- Local model settings: users can configure DashScope Qwen or OpenAI-compatible endpoints in the web UI.
- Local save path: users can choose where generated files are stored.

## Tech Stack

- Frontend: React + Vite
- Backend: Node.js local HTTP server
- Video tools: yt-dlp, FFmpeg / ffprobe
- Optional browser probing: Playwright / Edge
- Optional model providers: DashScope Qwen, OpenAI-compatible APIs
- Optional document output: Python script for Word generation

## Requirements

- Node.js 18+
- npm
- yt-dlp
- FFmpeg and ffprobe
- Python 3.10+ if you want Word output
- A multimodal model API key if you want HTML / Word / mind map analysis

## Quick Start

```bash
npm install
npm run frontend:build
npm run web
```

Then open:

```text
http://127.0.0.1:8787
```

The app stores generated files locally. By default, it uses a folder under the current user's home directory, and you can change it from the workspace UI.

## API Key

You can configure the model provider directly in the web UI. For local development, you can also create a `.env` file from `.env.example`.

```bash
cp .env.example .env
```

Never commit `.env`, cookies, browser profiles, downloaded videos, or generated notes.

## Useful Scripts

```bash
npm run frontend:build   # build React frontend into web/
npm run web              # start local web app on 127.0.0.1:8787
npm run web:check        # check local web UI health and screenshot generation
npm run article:check    # verify generated article output
npm run media:probe      # diagnose media URLs captured from browser probing
```

## Project Structure

```text
frontend/                 React UI
scripts/                  video analysis, article rendering, verification scripts
src/server.js             core video preparation and model analysis engine
web/                      generated frontend build output, ignored by git
sessions/                 runtime jobs and generated files, ignored by git
```

## Safety Notes

- ClipMind is intended for videos you have the right to access and analyze.
- Some platforms require login, fresh cookies, anti-bot verification, or DRM-protected playback. These cases may fail or require manual authorization.
- The project does not need you to commit API keys. Keep keys in local settings or `.env`.
- Generated files and downloaded media are ignored by git.

## Roadmap

- Better Bilibili and YouTube fallback diagnostics
- Faster long-video subtitle-first pipeline
- Desktop release for non-technical Windows users
- Docker deployment mode
- More editable export formats

## License

MIT
