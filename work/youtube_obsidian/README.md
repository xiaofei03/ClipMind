# YouTube -> Obsidian Workflow

本地工作流原型：

1. 输入 YouTube 链接
2. 优先抓官方字幕/转录稿
3. 如果没有字幕，则下载音频并本地转录
4. 用本地 Ollama 模型做总结分析
5. 生成 Markdown 并保存到指定 Obsidian 文件夹

## 入口

```bash
cd /Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian
/Users/xiaofei/Documents/Codex/2026-06-26/mu/work/.venv/bin/python ingest_youtube.py "https://www.youtube.com/watch?v=..."
```

## 本地后台服务

当前已经有第一版本地服务骨架，核心接口：

- `GET /health`
- `GET /jobs`
- `GET /jobs/{id}`
- `POST /jobs`

本地启动命令：

```bash
cd /Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian
PYTHONPATH=/Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian \
/Users/xiaofei/Documents/Codex/2026-06-26/mu/work/.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8765
```

如果当前环境不允许绑定本地端口，可以先跑接口自测：

```bash
cd /Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian
PYTHONPATH=/Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian \
/Users/xiaofei/Documents/Codex/2026-06-26/mu/work/.venv/bin/python test_server.py
```

## 需要的本地依赖

- `yt-dlp`
- `ffmpeg`
- `faster-whisper`
- `ollama`

## 配置

复制 `config.example.json` 为 `config.json`，并修改：

- `obsidian_output_dir`
- `ollama.model`
- `transcription.language`
- `transcription.whisper_model`

例如：

```bash
cd /Users/xiaofei/Documents/Codex/2026-06-26/mu/work/youtube_obsidian
cp config.example.json config.json
```

然后把 `obsidian_output_dir` 改成你的 Obsidian Vault 里的目标目录。

## 工作流

1. 先用 `youtube-transcript-api` 尝试抓官方字幕/转录稿
2. 抓不到时，用 `yt-dlp` 下载音频
3. 用 `faster-whisper` 本地转录
4. 调用本地 `ollama` 模型做总结分析
5. 生成 Markdown，写入 Obsidian 指定目录

## 当前输出特点

- 自动清洗模型中的 `<think>` / `</think>` 等脏输出
- 默认不再写入完整原始转录
- 输出更丰富的中文知识卡片结构
- 会基于内容自动分类到不同 Obsidian 子文件夹

## 当前实现状态

- 已完成第一阶段 CLI 原型
- 已支持：
  - 官方字幕/转录优先
  - 无字幕时下载音频并本地转录
  - 本地 Ollama 总结
  - 输出 Markdown 到 Obsidian

## 备注

- 第一次使用 `faster-whisper` 时，可能会额外下载模型文件
- 若视频可直接获取 YouTube 转录稿，速度会明显更快
