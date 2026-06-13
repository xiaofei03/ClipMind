#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_INFO = {
  name: "clipmind-core",
  version: "0.1.0"
};

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SERVER_DIR, "..");

loadDotEnv(join(PROJECT_DIR, ".env"));

const DEFAULT_WORKDIR =
  process.env.VIDEO_MCP_WORKDIR || join(PROJECT_DIR, "sessions");

const DEFAULT_QWEN_BASE_URL =
  process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";

const DEFAULT_QWEN_MODEL = process.env.QWEN_MODEL || "qwen3-vl-plus";
const YT_DLP_BIN = process.env.YT_DLP_BIN || "yt-dlp";
const WHISPER_BIN = process.env.WHISPER_BIN || "";
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || "python";
const DOUYIN_DOWNLOADER_DIR =
  process.env.DOUYIN_DOWNLOADER_DIR || "";

const TOOLS = [
  {
    name: "check_environment",
    description: "Check whether yt-dlp, ffmpeg, ffprobe, and Qwen API environment variables are available.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "probe_qwen_api",
    description: "Send a tiny multimodal request to the configured Qwen/DashScope OpenAI-compatible endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Model name to probe.",
          default: DEFAULT_QWEN_MODEL
        },
        baseUrl: {
          type: "string",
          description: "OpenAI-compatible base URL.",
          default: DEFAULT_QWEN_BASE_URL
        }
      }
    }
  },
  {
    name: "detect_video_platform",
    description: "Detect video platform and recommended extraction strategy order.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video URL to classify." }
      }
    }
  },
  {
    name: "diagnose_video_link",
    description: "Diagnose why a video link cannot be analyzed: cookies, login, DRM, anti-bot, subtitles, download, or model issues.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video URL to diagnose." },
        cookiesFromBrowser: {
          type: "string",
          description: "Optional browser name for yt-dlp cookies, such as edge, chrome, firefox."
        },
        cookiesFile: {
          type: "string",
          description: "Optional Netscape-format cookies.txt file for yt-dlp."
        },
        probeModel: {
          type: "boolean",
          description: "Also probe the Qwen API/model.",
          default: true
        }
      }
    }
  },
  {
    name: "probe_video_page_with_browser",
    description: "Open a video page with the real Edge profile and extract video element/network media URLs as a fallback when yt-dlp cookies fail.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video page URL to open in Edge." },
        workDir: {
          type: "string",
          description: "Optional output directory for probe.json and screenshot."
        }
      }
    }
  },
  {
    name: "probe_douyin_api",
    description: "Probe Douyin web detail API for a single video and extract best no-watermark play URLs when available.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Douyin video or share URL." },
        cookiesFile: {
          type: "string",
          description: "Optional cookie file. Supports raw Cookie header, Netscape cookies.txt, or Cookie Editor JSON."
        },
        cookieHeader: {
          type: "string",
          description: "Optional raw Cookie header."
        }
      }
    }
  },
  {
    name: "prepare_video_context",
    description: "Download video metadata/subtitles/video via yt-dlp and extract key frames via FFmpeg.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video URL to analyze." },
        frameIntervalSeconds: {
          type: "number",
          description: "Extract one frame every N seconds.",
          default: 15
        },
        maxFrames: {
          type: "integer",
          description: "Maximum extracted frame count.",
          default: 24
        },
        workDir: {
          type: "string",
          description: "Optional session root directory."
        },
        cookiesFromBrowser: {
          type: "string",
          description: "Optional browser name for yt-dlp cookies, such as edge, chrome, firefox."
        },
        cookiesFile: {
          type: "string",
          description: "Optional Netscape-format cookies.txt file for yt-dlp."
        },
        enableBrowserFallback: {
          type: "boolean",
          description: "Automatically fall back to real Edge page probing when yt-dlp cannot access or download the video.",
          default: true
        },
        enableDouyinApiFallback: {
          type: "boolean",
          description: "For Douyin links, try Douyin web detail API before browser fallback.",
          default: true
        },
        enableDouyinDownloaderFallback: {
          type: "boolean",
          description: "For Douyin links, try the local GHLiuyb/douyin_downloader adapter before generic API/browser fallback.",
          default: true
        },
        enableWhisper: {
          anyOf: [{ type: "boolean" }, { type: "string", enum: ["auto"] }],
          description: "Transcribe with local Whisper/faster-whisper. Use auto to run only when no strong text track is available.",
          default: "auto"
        },
        forceTextTrack: {
          type: "boolean",
          description: "Require a text track for summarization. The system first tries platform subtitles/page text and uses Whisper only as fallback.",
          default: true
        },
        skipFrames: {
          type: "boolean",
          description: "Prepare only metadata, text tracks, and transcript. Skip frame extraction for subtitle-only exports.",
          default: false
        },
        frameStrategy: {
          type: "string",
          enum: ["fixed", "smart"],
          description: "Frame sampling strategy. fixed uses a constant interval; smart scouts the video first and densifies important ranges.",
          default: "fixed"
        },
        smartScoutIntervalSeconds: {
          type: "number",
          description: "Smart mode: coarse full-video scan interval before densifying important ranges.",
          default: 10
        },
        smartDenseFps: {
          type: "number",
          description: "Smart mode: dense sampling FPS inside important ranges.",
          default: 1
        },
        smartWindowSeconds: {
          type: "number",
          description: "Smart mode: seconds before/after each important timestamp to densify.",
          default: 4
        }
      }
    }
  },
  {
    name: "summarize_video_link",
    description: "Prepare video context and summarize subtitles plus visual frames using a Qwen3-VL-compatible API.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video URL to summarize." },
        focus: {
          type: "string",
          description: "Specific summary focus.",
          default: "Summarize both subtitles/speech and visual content, especially charts, slides, UI, code, gestures, demonstrations, and information not stated in captions."
        },
        frameIntervalSeconds: { type: "number", default: 15 },
        maxFrames: { type: "integer", default: 16 },
        model: { type: "string", default: DEFAULT_QWEN_MODEL },
        workDir: { type: "string" },
        cookiesFromBrowser: {
          type: "string",
          description: "Optional browser name for yt-dlp cookies, such as edge, chrome, firefox."
        },
        cookiesFile: {
          type: "string",
          description: "Optional Netscape-format cookies.txt file for yt-dlp."
        },
        enableBrowserFallback: {
          type: "boolean",
          description: "Automatically fall back to real Edge page probing when yt-dlp cannot access or download the video.",
          default: true
        },
        enableDouyinApiFallback: {
          type: "boolean",
          description: "For Douyin links, try Douyin web detail API before browser fallback.",
          default: true
        },
        enableDouyinDownloaderFallback: {
          type: "boolean",
          description: "For Douyin links, try the local GHLiuyb/douyin_downloader adapter before generic API/browser fallback.",
          default: true
        },
        enableWhisper: {
          anyOf: [{ type: "boolean" }, { type: "string", enum: ["auto"] }],
          description: "Transcribe with local Whisper/faster-whisper. Use auto to run only when no strong text track is available.",
          default: "auto"
        },
        forceTextTrack: {
          type: "boolean",
          description: "Require a text track for summarization. The system first tries platform subtitles/page text and uses Whisper only as fallback.",
          default: true
        },
        frameStrategy: {
          type: "string",
          enum: ["fixed", "smart"],
          default: "fixed"
        }
      }
    }
  },
  {
    name: "summarize_video_link_for_learning",
    description: "Create a study-oriented actionable summary from a video link by using dense frame sampling, visual OCR, prompt extraction, and Qwen synthesis. Slower but better for learning from tutorials.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Video URL to summarize as actionable learning notes." },
        frameIntervalSeconds: {
          type: "number",
          description: "Dense frame interval for learning mode.",
          default: 5
        },
        maxFrames: {
          type: "integer",
          description: "Maximum frames to analyze in learning mode.",
          default: 80
        },
        workDir: { type: "string" },
        cookiesFromBrowser: {
          type: "string",
          description: "Optional browser name for yt-dlp cookies, such as edge, chrome, firefox."
        },
        cookiesFile: {
          type: "string",
          description: "Optional Netscape-format cookies.txt file for yt-dlp."
        },
        enableBrowserFallback: {
          type: "boolean",
          description: "Automatically fall back to real Edge page probing when yt-dlp cannot access or download the video.",
          default: true
        },
        enableDouyinApiFallback: {
          type: "boolean",
          description: "For Douyin links, try Douyin web detail API before browser fallback.",
          default: true
        },
        enableDouyinDownloaderFallback: {
          type: "boolean",
          description: "For Douyin links, try the local GHLiuyb/douyin_downloader adapter before generic API/browser fallback.",
          default: true
        },
        enableWhisper: {
          anyOf: [{ type: "boolean" }, { type: "string", enum: ["auto"] }],
          description: "Transcribe with local Whisper/faster-whisper. Use auto to run only when no strong text track is available.",
          default: "auto"
        },
        forceTextTrack: {
          type: "boolean",
          description: "Require a text track for summarization. The system first tries platform subtitles/page text and uses Whisper only as fallback.",
          default: true
        },
        frameStrategy: {
          type: "string",
          enum: ["fixed", "smart"],
          description: "Learning mode defaults to smart sampling: coarse full-video scan, then dense frames around text/code/prompt/UI-change intervals.",
          default: "smart"
        },
        smartScoutIntervalSeconds: { type: "number", default: 10 },
        smartDenseFps: { type: "number", default: 1 },
        smartWindowSeconds: { type: "number", default: 4 }
      }
    }
  }
];

if (process.argv.includes("--check")) {
  const result = await checkEnvironment();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
  process.stdin.destroy();
}

if (process.argv.includes("--probe")) {
  const result = await probeQwenApi({});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
  process.stdin.destroy();
}

const diagnoseIndex = process.argv.indexOf("--diagnose");
if (diagnoseIndex !== -1) {
  const result = await diagnoseVideoLink({
    url: process.argv[diagnoseIndex + 1],
    cookiesFromBrowser: readCliValue("--cookies-from-browser"),
    cookiesFile: readCliValue("--cookies-file")
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
  process.stdin.destroy();
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readCliValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      resolvePromise({ ok: false, code: -1, stdout: "", stderr: error.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolvePromise({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function checkEnvironment() {
  const checks = {};
  for (const [name, command, args] of [
    ["ytDlp", YT_DLP_BIN, ["--version"]],
    ["ffmpeg", "ffmpeg", ["-version"]],
    ["ffprobe", "ffprobe", ["-version"]]
  ]) {
    const result = await runCommand(command, args);
    checks[name] = {
      ok: result.ok,
      detail: result.ok ? firstLine(result.stdout || result.stderr) : result.stderr
    };
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  checks.qwenApiKey = {
    ok: Boolean(apiKey),
    detail: apiKey ? "API key is set." : "Set DASHSCOPE_API_KEY or QWEN_API_KEY."
  };

  if (WHISPER_BIN) {
    const whisperResult = await runCommand(WHISPER_BIN, ["--help"]);
    checks.whisper = {
      ok: whisperResult.ok,
      detail: whisperResult.ok ? "WHISPER_BIN is executable." : trimForError(whisperResult.stderr)
    };
  } else {
    checks.whisper = {
      ok: false,
      optional: true,
      detail: "Optional. Set WHISPER_BIN or install faster-whisper support to enable audio transcription."
    };
  }

  const ok = Object.values(checks).every((item) => item.ok);
  const requiredOk = Object.values(checks).every((item) => item.optional || item.ok);
  return {
    ok: requiredOk,
    checks,
    defaultWorkDir: DEFAULT_WORKDIR,
    defaultModel: DEFAULT_QWEN_MODEL,
    strategy: {
      douyin: ["yt-dlp", "douyin_downloader", "douyin_api", "browser_fallback"],
      bilibili: ["yt-dlp", "bilibili_api", "browser_fallback_if_enabled"],
      youtube: ["yt-dlp"],
      direct_media: ["direct_download"],
      generic_web: ["yt-dlp", "browser_fallback_if_enabled"]
    }
  };
}

async function probeQwenApi(input) {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  const model = input.model || DEFAULT_QWEN_MODEL;
  const baseUrl = input.baseUrl || DEFAULT_QWEN_BASE_URL;

  if (!apiKey) {
    return {
      ok: false,
      model,
      baseUrl,
      error: "Set DASHSCOPE_API_KEY or QWEN_API_KEY before probing Qwen API."
    };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "请只回复 OK，用于连通性测试。" },
              {
                type: "image_url",
                image_url: {
                  url: "https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg"
                }
              }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 16
      })
    });

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        model,
        baseUrl,
        httpStatus: response.status,
        error: trimForError(body)
      };
    }

    const data = JSON.parse(body);
    return {
      ok: true,
      model,
      baseUrl,
      response: data?.choices?.[0]?.message?.content,
      usage: data?.usage
    };
  } catch (error) {
    return {
      ok: false,
      model,
      baseUrl,
      error: error.message || String(error)
    };
  }
}

async function prepareVideoContext(input) {
  const url = normalizeVideoUrl(input.url, "url");
  const platform = detectVideoPlatform({ url });
  const frameIntervalSeconds = clampNumber(input.frameIntervalSeconds ?? 15, 1, 3600);
  const maxFrames = clampInteger(input.maxFrames ?? 24, 1, 80);
  const root = resolve(input.workDir || DEFAULT_WORKDIR);
  const sessionDir = join(root, `${timestamp()}-${safeName(url).slice(0, 40)}`);
  const subtitleDir = join(sessionDir, "subtitles");
  const frameDir = join(sessionDir, "frames");

  await mkdir(subtitleDir, { recursive: true });
  await mkdir(frameDir, { recursive: true });

  const ytDlpAccessArgs = buildYtDlpAccessArgs({ ...input, url });
  const metadataResult = await runCommand(YT_DLP_BIN, [
    ...ytDlpAccessArgs,
    "--dump-single-json",
    "--no-playlist",
    url
  ]);

  if (!metadataResult.ok) {
    if (input.enableDouyinDownloaderFallback !== false && isDouyinUrl(url)) {
      const downloaderContext = await tryPrepareVideoContextFromDouyinDownloader(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(metadataResult),
        originalError: metadataResult.stderr
      });
      if (downloaderContext) {
        return downloaderContext;
      }
    }
    if (input.enableDouyinApiFallback !== false && isDouyinUrl(url)) {
      const douyinContext = await tryPrepareVideoContextFromDouyinApi(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(metadataResult),
        originalError: metadataResult.stderr
      });
      if (douyinContext) {
        return douyinContext;
      }
    }
    if (isBilibiliUrl(url)) {
      const bilibiliContext = await tryPrepareVideoContextFromBilibiliApi(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(metadataResult),
        originalError: metadataResult.stderr
      });
      if (bilibiliContext) {
        return bilibiliContext;
      }
    }
    if (input.enableBrowserFallback !== false) {
      return prepareVideoContextFromBrowserFallback(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(metadataResult),
        originalError: metadataResult.stderr
      });
    }
    throw new Error(`yt-dlp metadata extraction failed: ${trimForError(metadataResult.stderr)}`);
  }

  const metadata = parseMetadata(metadataResult);
  await writeFile(join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

  await runCommand(YT_DLP_BIN, [
    ...ytDlpAccessArgs,
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "zh.*,en.*,ja.*,ko.*",
    "--sub-format",
    "vtt/srt/best",
    "-o",
    join(subtitleDir, "%(title).80s.%(ext)s"),
    url
  ]);

  const videoPathTemplate = join(sessionDir, "video.%(ext)s");
  const videoResult = await runCommand(YT_DLP_BIN, [
    ...ytDlpAccessArgs,
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "-o",
    videoPathTemplate,
    url
  ]);

  if (!videoResult.ok) {
    if (input.enableDouyinDownloaderFallback !== false && isDouyinUrl(url)) {
      const downloaderContext = await tryPrepareVideoContextFromDouyinDownloader(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(videoResult),
        originalError: videoResult.stderr
      });
      if (downloaderContext) {
        return downloaderContext;
      }
    }
    if (input.enableDouyinApiFallback !== false && isDouyinUrl(url)) {
      const douyinContext = await tryPrepareVideoContextFromDouyinApi(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(videoResult),
        originalError: videoResult.stderr
      });
      if (douyinContext) {
        return douyinContext;
      }
    }
    if (isBilibiliUrl(url)) {
      const bilibiliContext = await tryPrepareVideoContextFromBilibiliApi(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(videoResult),
        originalError: videoResult.stderr
      });
      if (bilibiliContext) {
        return bilibiliContext;
      }
    }
    if (input.enableBrowserFallback !== false) {
      return prepareVideoContextFromBrowserFallback(input, {
        sessionDir,
        subtitleDir,
        frameDir,
        frameIntervalSeconds,
        maxFrames,
        fallbackReason: classifyYtDlpResult(videoResult),
        originalError: videoResult.stderr
      });
    }
    throw new Error(`yt-dlp video download failed: ${trimForError(videoResult.stderr)}`);
  }

  const videoPath = await findLargestVideoFile(sessionDir);
  const subtitles = await listFiles(subtitleDir, [".vtt", ".srt"]);
  const subtitleAnchors = await extractSubtitleAnchors(subtitles);
  const frameResult = await extractFramesForContext(videoPath, frameDir, {
    input,
    sessionDir,
    metadata,
    frameIntervalSeconds,
    maxFrames,
    subtitleAnchors
  });
  const frames = frameResult.frames;
  const subtitleText = await readSubtitlePreview(subtitles);

  const context = {
    sessionDir,
    url,
    videoPath,
    metadata: pickMetadata(metadata),
    subtitles,
    frames,
    subtitleText,
    transcript: await maybeTranscribeVideo(videoPath, sessionDir, input, { subtitleText, subtitles }),
    frameIntervalSeconds,
    maxFrames,
    frameStrategy: frameResult.strategy,
    frameSampling: frameResult.sampling,
    frameManifest: frameResult.manifest,
    subtitleAnchors,
    source: "yt-dlp",
    platform
  };

  await writeFile(join(sessionDir, "context.json"), JSON.stringify(context, null, 2), "utf8");
  return context;
}

function detectVideoPlatform(input) {
  const url = normalizeVideoUrl(input.url, "url");
  const lower = url.toLowerCase();
  let platform = "generic_web";
  if (/v\.douyin\.com|douyin\.com/i.test(lower)) {
    platform = "douyin";
  } else if (/bilibili\.com|b23\.tv/i.test(lower)) {
    platform = "bilibili";
  } else if (/youtube\.com|youtu\.be/i.test(lower)) {
    platform = "youtube";
  } else if (/\.(mp4|m3u8|webm|mov|mkv)(\?|#|$)/i.test(lower)) {
    platform = "direct_media";
  }

  const strategies = {
    douyin: ["yt-dlp", "douyin_downloader", "douyin_api", "browser_fallback"],
    bilibili: ["yt-dlp", "bilibili_api", "browser_fallback_if_enabled"],
    youtube: ["yt-dlp"],
    direct_media: ["direct_download"],
    generic_web: ["yt-dlp", "browser_fallback_if_enabled"]
  };

  return {
    platform,
    strategyOrder: strategies[platform],
    url
  };
}

async function tryPrepareVideoContextFromDouyinApi(input, options) {
  const probe = await probeDouyinApi(input).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
  await writeFile(join(options.sessionDir, "douyin_api_probe.json"), JSON.stringify(probe, null, 2), "utf8");
  if (!probe.ok || !probe.videoUrls?.length) {
    return null;
  }

  const videoUrl = selectBrowserVideoUrl(probe);
  const videoResult = await runCommand(YT_DLP_BIN, [
    "--no-warnings",
    "-o",
    join(options.sessionDir, "video.%(ext)s"),
    videoUrl
  ]);
  if (!videoResult.ok) {
    return null;
  }

  await writeFile(join(options.subtitleDir, "douyin_description.txt"), probe.description || "", "utf8");
  const videoPath = await findLargestVideoFile(options.sessionDir);
  const frameResult = await extractFramesForContext(videoPath, options.frameDir, {
    input,
    sessionDir: options.sessionDir,
    metadata: { duration: probe.duration },
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames
  });
  const frames = frameResult.frames;
  const transcript = await maybeTranscribeVideo(videoPath, options.sessionDir, input, {
    subtitleText: probe.description,
    subtitles: [join(options.subtitleDir, "douyin_description.txt")]
  });
  const context = {
    sessionDir: options.sessionDir,
    url: input.url,
    videoPath,
    metadata: {
      title: probe.title,
      uploader: probe.author,
      duration: probe.duration,
      thumbnail: probe.coverUrl,
      webpage_url: probe.webpageUrl || input.url,
      description: probe.description,
      upload_date: probe.createTime,
      subtitles: [],
      automatic_captions: []
    },
    subtitles: [join(options.subtitleDir, "douyin_description.txt")],
    frames,
    subtitleText: String(probe.description || "").slice(0, 32000),
    transcript,
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames,
    frameStrategy: frameResult.strategy,
    frameSampling: frameResult.sampling,
    frameManifest: frameResult.manifest,
    source: "douyin_api_fallback",
    fallbackReason: options.fallbackReason,
    douyinApiVideoUrl: videoUrl,
    platform: detectVideoPlatform({ url: input.url })
  };
  await writeFile(join(options.sessionDir, "context.json"), JSON.stringify(context, null, 2), "utf8");
  return context;
}

async function tryPrepareVideoContextFromBilibiliApi(input, options) {
  const probe = await probeBilibiliApi(input).catch((error) => ({
    ok: false,
    error: error.message || String(error)
  }));
  await writeFile(join(options.sessionDir, "bilibili_api_probe.json"), JSON.stringify(probe, null, 2), "utf8");
  if (!probe.ok || !probe.videoUrl) {
    return null;
  }

  const videoResult = await runCommand(YT_DLP_BIN, [
    "--no-warnings",
    "--add-header",
    "Referer:https://www.bilibili.com/",
    "--add-header",
    "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 Edg/125",
    "-o",
    join(options.sessionDir, "video.%(ext)s"),
    probe.videoUrl
  ]);
  if (!videoResult.ok) {
    await writeFile(join(options.sessionDir, "bilibili_api_download_error.txt"), videoResult.stderr || videoResult.stdout || "", "utf8");
    return null;
  }

  const metadataText = [
    probe.title ? `Title: ${probe.title}` : "",
    probe.owner ? `Owner: ${probe.owner}` : "",
    probe.description ? `Description:\n${probe.description}` : ""
  ].filter(Boolean).join("\n\n");
  await writeFile(join(options.sessionDir, "bilibili_metadata.txt"), metadataText, "utf8");

  const bilibiliSubtitles = await downloadBilibiliSubtitles(probe, options.subtitleDir);
  const subtitleAnchors = await extractSubtitleAnchors(bilibiliSubtitles);
  const subtitleText = await readSubtitlePreview(bilibiliSubtitles);

  const videoPath = await findLargestVideoFile(options.sessionDir);
  const frameResult = await extractFramesForContext(videoPath, options.frameDir, {
    input,
    sessionDir: options.sessionDir,
    metadata: { duration: probe.duration },
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames,
    subtitleAnchors
  });
  const transcript = await maybeTranscribeVideo(videoPath, options.sessionDir, input, {
    subtitleText,
    subtitles: bilibiliSubtitles
  });
  const context = {
    sessionDir: options.sessionDir,
    url: normalizeVideoUrl(input.url, "url"),
    videoPath,
    metadata: {
      title: probe.title,
      uploader: probe.owner,
      duration: probe.duration,
      thumbnail: probe.coverUrl,
      webpage_url: probe.webpageUrl || normalizeVideoUrl(input.url, "url"),
      description: probe.description,
      upload_date: probe.pubdate,
      subtitles: probe.subtitles || [],
      automatic_captions: []
    },
    subtitles: bilibiliSubtitles,
    frames: frameResult.frames,
    subtitleText,
    metadataText: metadataText.slice(0, 32000),
    transcript,
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames,
    frameStrategy: frameResult.strategy,
    frameSampling: frameResult.sampling,
    frameManifest: frameResult.manifest,
    subtitleAnchors,
    textSource: bilibiliSubtitles.length ? "bilibili_platform_subtitles" : (transcript?.ok ? "whisper" : "metadata_only"),
    source: "bilibili_api_fallback",
    fallbackReason: options.fallbackReason,
    bilibiliApi: probe,
    platform: detectVideoPlatform({ url: input.url })
  };
  await writeFile(join(options.sessionDir, "context.json"), JSON.stringify(context, null, 2), "utf8");
  return context;
}

async function tryPrepareVideoContextFromDouyinDownloader(input, options) {
  const adapterPath = join(PROJECT_DIR, "scripts", "douyin_downloader_adapter.py");
  if (!existsSync(adapterPath) || !existsSync(DOUYIN_DOWNLOADER_DIR)) {
    return null;
  }
  const outDir = join(options.sessionDir, "douyin_downloader");
  await mkdir(outDir, { recursive: true });
  const args = [
    adapterPath,
    DOUYIN_DOWNLOADER_DIR,
    normalizeVideoUrl(input.url, "url"),
    outDir
  ];
  if (input.cookiesFile) {
    args.push(String(input.cookiesFile));
  }
  const result = await runCommand("python", args);
  const stdout = String(result.stdout || "").trim();
  let probe = {
    ok: false,
    stdoutPreview: trimForError(result.stdout),
    stderrPreview: trimForError(result.stderr)
  };
  try {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    probe = JSON.parse(lines[lines.length - 1] || "{}");
  } catch {
    probe.error = "Could not parse douyin_downloader adapter output.";
  }
  await writeFile(join(options.sessionDir, "douyin_downloader_probe.json"), JSON.stringify(probe, null, 2), "utf8");
  if (!result.ok || !probe.ok || !probe.videoPath || !existsSync(probe.videoPath)) {
    return null;
  }

  await writeFile(join(options.subtitleDir, "douyin_downloader_info.txt"), JSON.stringify({
    awemeId: probe.awemeId,
    originalUrl: probe.originalUrl,
    resolvedUrl: probe.resolvedUrl,
    source: probe.source
  }, null, 2), "utf8");

  const videoPath = probe.videoPath;
  const frameResult = await extractFramesForContext(videoPath, options.frameDir, {
    input,
    sessionDir: options.sessionDir,
    metadata: {},
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames
  });
  const transcript = await maybeTranscribeVideo(videoPath, options.sessionDir, input, { subtitleText: "" });
  const context = {
    sessionDir: options.sessionDir,
    url: normalizeVideoUrl(input.url, "url"),
    videoPath,
    metadata: {
      title: probe.awemeId ? `douyin_${probe.awemeId}` : "douyin_video",
      webpage_url: probe.resolvedUrl || normalizeVideoUrl(input.url, "url"),
      description: "",
      subtitles: [],
      automatic_captions: []
    },
    subtitles: [join(options.subtitleDir, "douyin_downloader_info.txt")],
    frames: frameResult.frames,
    subtitleText: "",
    transcript,
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames,
    frameStrategy: frameResult.strategy,
    frameSampling: frameResult.sampling,
    frameManifest: frameResult.manifest,
    source: "douyin_downloader_fallback",
    fallbackReason: options.fallbackReason,
    douyinDownloader: probe,
    platform: detectVideoPlatform({ url: input.url })
  };
  await writeFile(join(options.sessionDir, "context.json"), JSON.stringify(context, null, 2), "utf8");
  return context;
}

async function prepareVideoContextFromBrowserFallback(input, options) {
  const url = normalizeVideoUrl(input.url, "url");
  const probeDir = join(options.sessionDir, "browser_probe");
  const probeResult = await probeVideoPageWithBrowser({ url, workDir: probeDir });
  if (!probeResult.ok || !probeResult.probe?.videoUrls?.length) {
    throw new Error(
      `Browser fallback failed after yt-dlp failed with ${options.fallbackReason.category}: ${trimForError(
        probeResult.stderrPreview || probeResult.stdoutPreview || options.originalError
      )}`
    );
  }

  const probe = probeResult.probe;
  const videoUrl = selectBrowserVideoUrl(probe);
  await writeFile(join(options.sessionDir, "browser_probe_summary.json"), JSON.stringify({
    fallbackReason: options.fallbackReason,
    pageTitle: probe.pageData?.title,
    pageUrl: probe.pageData?.location,
    videoUrls: probe.videoUrls,
    responses: probe.responses,
    screenshot: probe.screenshot
  }, null, 2), "utf8");
  const mediaProbe = await probeBrowserMediaUrls(join(options.sessionDir, "browser_probe_summary.json"));
  if (!videoUrl) {
    const verdict = mediaProbe?.summary?.verdict || "no_downloadable_media";
    if (isBilibiliUrl(url)) {
      throw new Error(
        `Bilibili browser fallback only found blob/session media URLs (${verdict}). ` +
        `Blob URLs live inside the browser process and cannot be downloaded by yt-dlp. ` +
        `Use yt-dlp with Edge cookies/cookies.txt, or open a real downloadable m4s/m3u8 URL captured from the page. ` +
        `Media probe report: ${mediaProbe?.reportPath || join(options.sessionDir, "media_url_probe.json")}`
      );
    }
    throw new Error(
      `Browser fallback did not find an external downloadable media URL. ` +
      `Media probe verdict: ${verdict}.`
    );
  }

  await writeFile(join(options.subtitleDir, "page_text.txt"), probe.pageData?.text || "", "utf8");
  const referer = new URL(probe.pageData?.location || url).origin + "/";
  const videoResult = await runCommand(YT_DLP_BIN, [
    "--no-warnings",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "--add-header",
    `Referer:${referer}`,
    "-o",
    join(options.sessionDir, "video.%(ext)s"),
    videoUrl
  ]);
  if (!videoResult.ok) {
    const mediaProbeText = mediaProbe?.summary?.verdict
      ? ` Media probe verdict: ${mediaProbe.summary.verdict}.`
      : "";
    if (isBilibiliUrl(url) && /403|Forbidden/i.test(`${videoResult.stderr} ${videoResult.stdout}`)) {
      throw new Error(
        `Browser fallback found a real Bilibili media URL, but Bilibili CDN returned 403 Forbidden. ` +
        `This usually means the media URL requires browser cookies, a valid signed request context, or anti-hotlink headers. ` +
        `${mediaProbeText} Original error: ${trimForError(videoResult.stderr)}`
      );
    }
    throw new Error(`Browser fallback found a video URL but download failed.${mediaProbeText} ${trimForError(videoResult.stderr)}`);
  }

  const videoPath = await findLargestVideoFile(options.sessionDir);
  const firstVideo = probe.pageData?.videos?.[0] || {};
  const frameResult = await extractFramesForContext(videoPath, options.frameDir, {
    input,
    sessionDir: options.sessionDir,
    metadata: { duration: Number.isFinite(firstVideo.duration) ? firstVideo.duration : undefined },
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames
  });

  const frames = frameResult.frames;
  const pageText = probe.pageData?.text || "";
  const transcript = await maybeTranscribeVideo(videoPath, options.sessionDir, input, {
    subtitleText: pageText,
    subtitles: [join(options.subtitleDir, "page_text.txt")]
  });
  const context = {
    sessionDir: options.sessionDir,
    url,
    videoPath,
    metadata: {
      title: probe.pageData?.title,
      uploader: undefined,
      duration: Number.isFinite(firstVideo.duration) ? firstVideo.duration : undefined,
      webpage_url: probe.pageData?.location || url,
      description: pageText ? pageText.slice(0, 2000) : undefined,
      upload_date: undefined,
      subtitles: [],
      automatic_captions: []
    },
    subtitles: [join(options.subtitleDir, "page_text.txt")],
    frames,
    subtitleText: pageText.slice(0, 32000),
    transcript,
    frameIntervalSeconds: options.frameIntervalSeconds,
    maxFrames: options.maxFrames,
    frameStrategy: frameResult.strategy,
    frameSampling: frameResult.sampling,
    frameManifest: frameResult.manifest,
    source: "browser_fallback",
    fallbackReason: options.fallbackReason,
    browserProbeDir: probeDir,
    browserVideoUrl: videoUrl,
    platform: detectVideoPlatform({ url })
  };

  await writeFile(join(options.sessionDir, "context.json"), JSON.stringify(context, null, 2), "utf8");
  return context;
}

function selectBrowserVideoUrl(probe) {
  const playableVideos = (probe.pageData?.videos || [])
    .filter((video) => isDownloadableMediaUrl(video.src))
    .map((video) => ({
      url: video.src,
      score:
        (Number(video.duration) > 10 ? 100000 : 0) +
        (Number(video.width) || 0) * 10 +
        (Number(video.height) || 0) -
        (/douyin-pc-web\/uuu_/i.test(video.src) ? 1000000 : 0)
    }))
    .sort((a, b) => b.score - a.score);
  if (playableVideos.length && playableVideos[0].score > -1000) {
    return playableVideos[0].url;
  }

  const responseVideos = (probe.responses || [])
    .filter((item) => isDownloadableMediaUrl(item.url) && /video|mpegurl|mp4|m3u8|m4s|bilivideo/i.test(`${item.contentType || ""} ${item.url}`))
    .map((item) => ({
      url: item.url,
      score:
        Number(item.contentLength || 0) +
        (/douyinvod\.com/i.test(item.url) ? 1000000 : 0) -
        (/douyin-pc-web\/uuu_/i.test(item.url) ? 1000000 : 0)
    }))
    .sort((a, b) => b.score - a.score);
  if (responseVideos.length) {
    return responseVideos[0].url;
  }

  const urls = probe.videoUrls || [];
  return urls.find((url) => isDownloadableMediaUrl(url)) || null;
}

function isDownloadableMediaUrl(url) {
  const text = String(url || "");
  if (!/^https?:\/\//i.test(text)) return false;
  if (/^blob:|^data:|^mediasource:/i.test(text)) return false;
  if (/douyin-pc-web\/uuu_/i.test(text)) return false;
  return /video|mpegurl|mp4|m3u8|m4s|bilivideo|douyinvod|byteimg/i.test(text);
}

function isBilibiliUrl(url) {
  return /bilibili\.com|b23\.tv|bilivideo\.com/i.test(String(url || ""));
}

async function extractFramesForContext(videoPath, frameDir, options) {
  if (options.input?.skipFrames) {
    const manifest = [];
    await writeFrameManifest(options.sessionDir, manifest);
    return {
      strategy: "skipped",
      frames: [],
      manifest,
      sampling: {
        strategy: "skipped",
        reason: "skipFrames was requested",
        frameCount: 0
      }
    };
  }

  const strategy = String(options.input.frameStrategy || options.input.frameSamplingMode || "fixed").toLowerCase();
  if (strategy === "smart") {
    try {
      return await extractSmartFrames(videoPath, frameDir, options);
    } catch (error) {
      const fallbackDir = join(options.sessionDir, "smart_frame_fallback");
      await mkdir(fallbackDir, { recursive: true });
      await writeFile(join(fallbackDir, "error.txt"), error.stack || error.message || String(error), "utf8");
    }
  }

  await extractFrames(videoPath, frameDir, options.frameIntervalSeconds, options.maxFrames);
  const frames = await listFiles(frameDir, [".jpg", ".jpeg", ".png"]);
  const manifest = frames.map((file, index) => ({
    file,
    name: basename(file),
    time: index * options.frameIntervalSeconds,
    source: "fixed_interval"
  }));
  await writeFrameManifest(options.sessionDir, manifest);
  return {
    strategy: "fixed",
    frames,
    manifest,
    sampling: {
      strategy: "fixed",
      frameIntervalSeconds: options.frameIntervalSeconds,
      maxFrames: options.maxFrames,
      frameCount: frames.length
    }
  };
}

async function extractSmartFrames(videoPath, frameDir, options) {
  const input = options.input || {};
  const duration =
    Number(options.metadata?.duration) > 0
      ? Number(options.metadata.duration)
      : await probeVideoDuration(videoPath);
  const scoutIntervalSeconds = clampNumber(
    input.smartScoutIntervalSeconds ?? Math.max(8, options.frameIntervalSeconds * 2),
    2,
    180
  );
  const denseFps = clampNumber(input.smartDenseFps ?? 1, 0.25, 4);
  const windowSeconds = clampNumber(input.smartWindowSeconds ?? 4, 1, 20);
  const maxScoutFrames = clampInteger(input.smartMaxScoutFrames ?? 48, 4, 160);
  const sceneThreshold = clampNumber(input.smartSceneThreshold ?? 0.16, 0.04, 0.6);
  const sceneDetectionMaxDuration = clampNumber(input.smartSceneDetectionMaxDuration ?? 600, 0, 7200);
  const hasSubtitleAnchors = (options.subtitleAnchors || []).length > 0;
  const skipSceneDetection =
    Boolean(input.smartSkipSceneDetection) ||
    (Boolean(input.smartSkipSceneDetectionWithSubtitles) &&
      hasSubtitleAnchors &&
      duration > sceneDetectionMaxDuration);
  const scoutDir = join(options.sessionDir, "smart_scout");
  await mkdir(scoutDir, { recursive: true });

  const scoutFrames = await extractScoutFrames(videoPath, scoutDir, scoutIntervalSeconds, maxScoutFrames);
  const sceneTimes = skipSceneDetection ? [] : await detectSceneChangeTimes(videoPath, sceneThreshold, duration);
  const modelScout = await scoutImportantFramesWithQwen(scoutFrames, {
    scoutIntervalSeconds,
    duration,
    maxCandidates: clampInteger(input.smartMaxModelCandidates ?? 18, 1, 80)
  });

  const seedEvents = [
    { time: 0, reason: "video_start", source: "baseline" },
    ...(options.subtitleAnchors || []).map((anchor) => ({
      time: anchor.time,
      reason: `subtitle:${anchor.keyword}`,
      source: "subtitle"
    })),
    ...sceneTimes.map((time) => ({ time, reason: "scene_change", source: "ffmpeg_scene" })),
    ...modelScout.candidates
  ]
    .filter((event) => Number.isFinite(event.time))
    .map((event) => ({
      ...event,
      time: clampNumber(event.time, 0, Math.max(0, duration || event.time || 0))
    }));

  if (duration > 0) {
    seedEvents.push({ time: Math.max(0, duration - 1), reason: "video_end", source: "baseline" });
  }

  const intervals = mergeIntervals(
    seedEvents.map((event) => ({
      start: Math.max(0, event.time - windowSeconds),
      end: duration > 0 ? Math.min(duration, event.time + windowSeconds) : event.time + windowSeconds,
      reasons: [event.reason],
      sources: [event.source]
    }))
  );

  let times = intervalsToTimes(intervals, denseFps);
  if (times.length < Math.min(options.maxFrames, 8) && scoutFrames.length) {
    times = uniqueSortedNumbers([
      ...times,
      ...scoutFrames.map((frame) => frame.time)
    ]);
  }
  times = limitTimes(times, options.maxFrames);

  const manifest = [];
  for (let index = 0; index < times.length; index++) {
    const time = times[index];
    const name = `frame_t${String(Math.round(time * 1000)).padStart(9, "0")}_${String(index + 1).padStart(4, "0")}.jpg`;
    const file = join(frameDir, name);
    await extractFrameAtTime(videoPath, time, file);
    manifest.push({
      file,
      name,
      time,
      source: "smart",
      reasons: reasonsForTime(time, intervals)
    });
  }

  const frames = await listFiles(frameDir, [".jpg", ".jpeg", ".png"]);
  await writeFrameManifest(options.sessionDir, manifest);
  await writeFile(
    join(options.sessionDir, "smart_frame_plan.json"),
    JSON.stringify(
      {
        strategy: "smart",
        duration,
        scoutIntervalSeconds,
        denseFps,
        windowSeconds,
        maxFrames: options.maxFrames,
        sceneThreshold,
        sceneDetectionMaxDuration,
        sceneDetectionSkipped: skipSceneDetection,
        scoutFrameCount: scoutFrames.length,
        subtitleAnchorCount: (options.subtitleAnchors || []).length,
        subtitleAnchors: options.subtitleAnchors || [],
        sceneChangeCount: sceneTimes.length,
        modelScout,
        seedEvents,
        intervals,
        selectedFrameCount: manifest.length
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    strategy: "smart",
    frames,
    manifest,
    sampling: {
      strategy: "smart",
      duration,
      scoutIntervalSeconds,
      denseFps,
      windowSeconds,
      maxFrames: options.maxFrames,
      sceneThreshold,
      sceneDetectionMaxDuration,
      sceneDetectionSkipped: skipSceneDetection,
      scoutFrameCount: scoutFrames.length,
      subtitleAnchorCount: (options.subtitleAnchors || []).length,
      sceneChangeCount: sceneTimes.length,
      modelScoutOk: modelScout.ok,
      modelCandidateCount: modelScout.candidates.length,
      frameCount: frames.length
    }
  };
}

async function extractFrames(videoPath, frameDir, frameIntervalSeconds, maxFrames) {
  const framePattern = join(frameDir, "frame_%04d.jpg");
  const vf = `fps=1/${frameIntervalSeconds},scale='min(1280,iw)':-2`;
  const frameResult = await runCommand("ffmpeg", [
    "-hide_banner",
    "-y",
    "-i",
    videoPath,
    "-vf",
    vf,
    "-frames:v",
    String(maxFrames),
    "-q:v",
    "3",
    framePattern
  ]);

  if (!frameResult.ok) {
    throw new Error(`ffmpeg frame extraction failed: ${trimForError(frameResult.stderr)}`);
  }
}

async function extractScoutFrames(videoPath, scoutDir, scoutIntervalSeconds, maxScoutFrames) {
  const framePattern = join(scoutDir, "scout_%04d.jpg");
  const vf = `fps=1/${scoutIntervalSeconds},scale='min(960,iw)':-2`;
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-y",
    "-i",
    videoPath,
    "-vf",
    vf,
    "-frames:v",
    String(maxScoutFrames),
    "-q:v",
    "5",
    framePattern
  ]);
  if (!result.ok) {
    throw new Error(`ffmpeg scout frame extraction failed: ${trimForError(result.stderr)}`);
  }
  const files = await listFiles(scoutDir, [".jpg", ".jpeg", ".png"]);
  return files.map((file, index) => ({
    file,
    name: basename(file),
    time: index * scoutIntervalSeconds
  }));
}

async function detectSceneChangeTimes(videoPath, threshold, duration) {
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-i",
    videoPath,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-an",
    "-f",
    "null",
    "-"
  ]);
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  const times = [];
  for (const match of text.matchAll(/pts_time:([0-9.]+)/g)) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time >= 0 && (!duration || time <= duration)) {
      times.push(time);
    }
  }
  return limitTimes(uniqueSortedNumbers(times), 80);
}

async function scoutImportantFramesWithQwen(scoutFrames, options) {
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  if (!apiKey || !scoutFrames.length) {
    return {
      ok: false,
      skipped: true,
      reason: apiKey ? "No scout frames." : "No Qwen API key.",
      candidates: []
    };
  }

  try {
    const limitedFrames = scoutFrames.slice(0, 48);
    const content = [{
      type: "text",
      text: [
        "你是视频智能抽帧的粗筛器。",
        "下面是低密度扫全片得到的帧。请找出值得加密抽帧的时间点，尤其是：",
        "1. 画面中出现大段文字、代码、Prompt、命令、配置、文件名、网页 UI；",
        "2. 界面布局明显变化、从讲解切到演示、从成品切到编辑器；",
        "3. 屏幕上可能有一闪而过但对学习很重要的信息。",
        "只输出 JSON，不要 Markdown。格式：",
        "{\"candidates\":[{\"time\":12,\"reason\":\"visible prompt/code/ui change\",\"confidence\":0.8}]}",
        `低密度间隔：${options.scoutIntervalSeconds} 秒。最多返回 ${options.maxCandidates} 个候选。`
      ].join("\n")
    }];
    for (const frame of limitedFrames) {
      content.push({ type: "text", text: `frame=${frame.name}; time=${Math.round(frame.time)}s` });
      content.push({ type: "image_url", image_url: { url: await imageToDataUrl(frame.file) } });
    }

    const response = await fetch(`${DEFAULT_QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: DEFAULT_QWEN_MODEL,
        messages: [{ role: "user", content }],
        temperature: 0,
        max_tokens: 1200
      })
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, error: trimForError(body), candidates: [] };
    }
    const data = JSON.parse(body);
    const text = data?.choices?.[0]?.message?.content || "";
    const parsed = parseJsonFromText(text);
    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    return {
      ok: true,
      usage: data?.usage,
      raw: text,
      candidates: candidates
        .map((item) => ({
          time: Number(item.time),
          reason: String(item.reason || "model_scout"),
          confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
          source: "qwen_scout"
        }))
        .filter((item) => Number.isFinite(item.time))
        .slice(0, options.maxCandidates)
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      candidates: []
    };
  }
}

async function probeVideoDuration(videoPath) {
  const result = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath
  ]);
  const duration = Number(String(result.stdout || "").trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

async function extractFrameAtTime(videoPath, time, outputPath) {
  const result = await runCommand("ffmpeg", [
    "-hide_banner",
    "-y",
    "-ss",
    String(Math.max(0, time)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-vf",
    "scale='min(1280,iw)':-2",
    outputPath
  ]);
  if (!result.ok) {
    throw new Error(`ffmpeg frame extraction at ${time}s failed: ${trimForError(result.stderr)}`);
  }
}

async function writeFrameManifest(sessionDir, manifest) {
  await writeFile(join(sessionDir, "frames_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function intervalsToTimes(intervals, denseFps) {
  const step = 1 / denseFps;
  const times = [];
  for (const interval of intervals) {
    for (let time = interval.start; time <= interval.end + 0.001; time += step) {
      times.push(Number(time.toFixed(3)));
    }
  }
  return uniqueSortedNumbers(times);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end + 0.5) {
      merged.push({
        start: Number(interval.start.toFixed(3)),
        end: Number(interval.end.toFixed(3)),
        reasons: [...new Set(interval.reasons || [])],
        sources: [...new Set(interval.sources || [])]
      });
    } else {
      last.end = Math.max(last.end, interval.end);
      last.reasons = [...new Set([...last.reasons, ...(interval.reasons || [])])];
      last.sources = [...new Set([...last.sources, ...(interval.sources || [])])];
    }
  }
  return merged;
}

function reasonsForTime(time, intervals) {
  const hit = intervals.find((interval) => time >= interval.start - 0.001 && time <= interval.end + 0.001);
  return hit ? hit.reasons : [];
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
}

function limitTimes(times, maxCount) {
  if (times.length <= maxCount) {
    return times;
  }
  if (maxCount <= 1) {
    return times.slice(0, 1);
  }
  const selected = [];
  const step = (times.length - 1) / (maxCount - 1);
  for (let index = 0; index < maxCount; index++) {
    selected.push(times[Math.round(index * step)]);
  }
  return uniqueSortedNumbers(selected).slice(0, maxCount);
}

function parseJsonFromText(text) {
  const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function maybeTranscribeVideo(videoPath, sessionDir, input, textTrack = {}) {
  const policy = String(input.enableWhisper ?? "auto").toLowerCase();
  const forceTextTrack = input.forceTextTrack !== false || policy === "auto";
  const textLength = meaningfulTextLength(textTrack.subtitleText || textTrack.pageText || "");
  const hasRealSubtitleFiles = Array.isArray(textTrack.subtitles) && textTrack.subtitles.some((file) => /\.(vtt|srt)$/i.test(String(file || "")));
  const hasStrongTextTrack = hasRealSubtitleFiles || textLength >= 600;

  if (policy !== "true" && hasStrongTextTrack) {
    return {
      ok: false,
      skipped: true,
      source: hasRealSubtitleFiles ? "platform_subtitles" : "page_or_description_text",
      textLength,
      reason: "Text track is already available; Whisper was skipped."
    };
  }

  if (policy !== "true" && !forceTextTrack) {
    return {
      ok: false,
      skipped: true,
      textLength,
      reason: "Whisper policy is disabled."
    };
  }

  if (!WHISPER_BIN) {
    return {
      ok: false,
      skipped: true,
      textLength,
      reason: forceTextTrack
        ? "Text track is required, but no strong text track was found and WHISPER_BIN is not set."
        : "WHISPER_BIN is not set. Install/configure Whisper or faster-whisper first."
    };
  }

  const audioPath = join(sessionDir, "audio.wav");
  const audioResult = await runCommand("ffmpeg", [
    "-hide_banner",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    audioPath
  ]);
  if (!audioResult.ok) {
    return {
      ok: false,
      skipped: false,
      reason: `Audio extraction failed: ${trimForError(audioResult.stderr)}`
    };
  }

  const whisperResult = await runCommand(WHISPER_BIN, [
    audioPath,
    "--model",
    input.whisperModel || process.env.WHISPER_MODEL || "base",
    "--language",
    input.whisperLanguage || "zh",
    "--output_format",
    "txt",
    "--output_dir",
    sessionDir
  ]);
  if (!whisperResult.ok) {
    return {
      ok: false,
      skipped: false,
      reason: `Whisper failed: ${trimForError(whisperResult.stderr || whisperResult.stdout)}`
    };
  }

  const transcriptPath = join(sessionDir, "audio.txt");
  const text = existsSync(transcriptPath) ? await readFile(transcriptPath, "utf8") : whisperResult.stdout;
  await writeFile(join(sessionDir, "transcript.txt"), text, "utf8");
  return {
    ok: true,
    transcriptPath: join(sessionDir, "transcript.txt"),
    source: "whisper",
    text: text.slice(0, 64000)
  };
}

function meaningfulTextLength(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .replace(/[{}[\]":,._\-\\/]+/g, "")
    .length;
}

function buildYtDlpAccessArgs(input) {
  const args = [];
  if (input.cookiesFile) {
    args.push("--cookies", String(input.cookiesFile));
  }
  if (input.cookiesFromBrowser) {
    args.push("--cookies-from-browser", String(input.cookiesFromBrowser));
  } else if (isBilibiliUrl(input.url)) {
    args.push("--cookies-from-browser", "edge");
  }
  return args;
}

async function probeBrowserMediaUrls(summaryPath) {
  const scriptPath = join(PROJECT_DIR, "scripts", "probe_media_url.cjs");
  if (!existsSync(scriptPath) || !existsSync(summaryPath)) {
    return null;
  }
  const result = await runCommand("node", [scriptPath, summaryPath, "--json"]);
  const reportPath = join(dirname(summaryPath), "media_url_probe.json");
  if (existsSync(reportPath)) {
    try {
      return JSON.parse(await readFile(reportPath, "utf8"));
    } catch {
      // Fall through to stdout parsing.
    }
  }
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function diagnoseVideoLink(input) {
  const url = normalizeVideoUrl(input.url, "url");
  const ytDlpAccessArgs = buildYtDlpAccessArgs(input);
  const metadataResult = await runCommand(YT_DLP_BIN, [
    ...ytDlpAccessArgs,
    "--dump-single-json",
    "--no-playlist",
    url
  ]);

  const diagnosis = classifyYtDlpResult(metadataResult);
  const result = {
    ok: metadataResult.ok,
    url,
    stage: metadataResult.ok ? "metadata" : "link_access",
    diagnosis,
    ytDlp: {
      exitCode: metadataResult.code,
      stdoutPreview: trimForError(metadataResult.stdout),
      stderrPreview: trimForError(metadataResult.stderr)
    }
  };

  if (metadataResult.ok) {
    const metadata = parseMetadata(metadataResult);
    const picked = pickMetadata(metadata);
    const subtitles = [
      ...(picked.subtitles || []),
      ...(picked.automatic_captions || [])
    ];
    result.metadata = picked;
    result.subtitleDiagnosis = subtitles.length
      ? { ok: true, category: "subtitles_available", languages: subtitles }
      : {
          ok: false,
          category: "no_subtitles",
          message: "No manual or automatic subtitles were reported by yt-dlp metadata."
        };
  }

  if (input.probeModel !== false) {
    const modelProbe = await probeQwenApi({});
    result.modelDiagnosis = modelProbe.ok
      ? { ok: true, category: "model_available", model: modelProbe.model, baseUrl: modelProbe.baseUrl }
      : {
          ok: false,
          category: "model_failed",
          model: modelProbe.model,
          baseUrl: modelProbe.baseUrl,
          error: modelProbe.error || modelProbe.httpStatus
        };
  }

  return result;
}

async function probeVideoPageWithBrowser(input) {
  const url = normalizeVideoUrl(input.url, "url");
  const outDir =
    input.workDir ||
    join(resolve(DEFAULT_WORKDIR), `${timestamp()}-${safeName(url).slice(0, 40)}-browser-probe`);
  await mkdir(outDir, { recursive: true });
  const scriptPath = join(PROJECT_DIR, "scripts", "probe_browser_video.cjs");
  const result = await runCommand("node", [scriptPath, url, outDir]);
  const probePath = join(outDir, "probe.json");
  let probe = null;
  if (existsSync(probePath)) {
    probe = JSON.parse(await readFile(probePath, "utf8"));
  }
  return {
    ok: result.ok && Boolean(probe?.videoUrls?.length),
    outDir,
    stdoutPreview: trimForError(result.stdout),
    stderrPreview: trimForError(result.stderr),
    probe
  };
}

async function probeBilibiliApi(input) {
  const originalUrl = normalizeVideoUrl(input.url, "url");
  const bvid = extractBilibiliBvid(originalUrl);
  if (!bvid) {
    return {
      ok: false,
      category: "bilibili_bvid_not_found",
      originalUrl
    };
  }

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 Edg/125",
    "Referer": "https://www.bilibili.com/",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
  };
  const viewResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { headers });
  const viewText = await viewResponse.text();
  if (!viewResponse.ok) {
    return {
      ok: false,
      category: "bilibili_view_http_failed",
      httpStatus: viewResponse.status,
      stderrPreview: trimForError(viewText),
      bvid,
      originalUrl
    };
  }
  const view = JSON.parse(viewText);
  if (view.code !== 0 || !view.data?.cid) {
    return {
      ok: false,
      category: "bilibili_view_failed",
      code: view.code,
      message: view.message,
      bvid,
      originalUrl
    };
  }

  const cid = view.data.cid;
  const subtitles = await fetchBilibiliSubtitleList({ bvid, cid, headers });
  const playUrl = new URL("https://api.bilibili.com/x/player/playurl");
  playUrl.searchParams.set("bvid", bvid);
  playUrl.searchParams.set("cid", String(cid));
  playUrl.searchParams.set("qn", "16");
  playUrl.searchParams.set("fnval", "0");
  playUrl.searchParams.set("fourk", "0");
  const playResponse = await fetch(playUrl, { headers });
  const playText = await playResponse.text();
  if (!playResponse.ok) {
    return {
      ok: false,
      category: "bilibili_playurl_http_failed",
      httpStatus: playResponse.status,
      stderrPreview: trimForError(playText),
      bvid,
      cid,
      originalUrl
    };
  }
  const play = JSON.parse(playText);
  const durl = play.data?.durl?.find((item) => item?.url);
  if (play.code !== 0 || !durl?.url) {
    return {
      ok: false,
      category: "bilibili_playurl_failed",
      code: play.code,
      message: play.message,
      bvid,
      cid,
      originalUrl
    };
  }

  return {
    ok: true,
    category: "ok",
    originalUrl,
    webpageUrl: `https://www.bilibili.com/video/${bvid}/`,
    bvid,
    aid: view.data.aid,
    cid,
    title: view.data.title,
    owner: view.data.owner?.name,
    duration: view.data.duration,
    pubdate: view.data.pubdate,
    description: view.data.desc,
    coverUrl: view.data.pic,
    subtitles,
    videoUrl: durl.url,
    size: durl.size,
    acceptDescription: play.data?.accept_description || []
  };
}

async function fetchBilibiliSubtitleList({ bvid, cid, headers }) {
  const endpoints = [
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`,
    `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers });
      if (!response.ok) continue;
      const data = JSON.parse(await response.text());
      const subtitles = data?.data?.subtitle?.subtitles || [];
      if (Array.isArray(subtitles) && subtitles.length) {
        return subtitles
          .filter((item) => item?.subtitle_url || item?.body_url)
          .map((item) => ({
            lan: item.lan || "",
            lanDoc: item.lan_doc || item.lanDoc || "",
            source: item.ai_status ? "auto" : "manual",
            url: normalizeBilibiliSubtitleUrl(item.subtitle_url || item.body_url)
          }));
      }
    } catch {
      // Try the next endpoint.
    }
  }
  return [];
}

async function downloadBilibiliSubtitles(probe, subtitleDir) {
  const subtitleItems = Array.isArray(probe.subtitles) ? probe.subtitles : [];
  const written = [];
  for (const [index, item] of subtitleItems.entries()) {
    if (!item?.url) continue;
    try {
      const response = await fetch(item.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": probe.webpageUrl || "https://www.bilibili.com/"
        }
      });
      if (!response.ok) continue;
      const data = JSON.parse(await response.text());
      const srt = bilibiliSubtitleJsonToSrt(data);
      if (!srt.trim()) continue;
      const lang = safeName(item.lan || item.lanDoc || `subtitle-${index + 1}`).slice(0, 24) || `subtitle-${index + 1}`;
      const filePath = join(subtitleDir, `bilibili-${lang}.srt`);
      await writeFile(filePath, srt, "utf8");
      written.push(filePath);
    } catch {
      // Ignore a single subtitle track failure and continue with other languages.
    }
  }
  return written;
}

function normalizeBilibiliSubtitleUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.bilibili.com${value}`;
  return value;
}

function bilibiliSubtitleJsonToSrt(data) {
  const body = Array.isArray(data?.body) ? data.body : [];
  return body
    .map((item, index) => {
      const from = Number(item.from ?? item.start ?? 0);
      const to = Number(item.to ?? item.end ?? from + 2);
      const content = String(item.content || item.text || "")
        .replace(/\r?\n/g, " ")
        .trim();
      if (!content) return "";
      return [
        String(index + 1),
        `${formatSrtTime(from)} --> ${formatSrtTime(Math.max(to, from + 0.1))}`,
        content
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatSrtTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

async function probeDouyinApi(input) {
  const originalUrl = normalizeVideoUrl(input.url, "url");
  const resolvedUrl = await resolveDouyinUrl(originalUrl);
  const awemeId = extractDouyinAwemeId(resolvedUrl) || extractDouyinAwemeId(originalUrl);
  if (!awemeId) {
    return {
      ok: false,
      category: "douyin_id_not_found",
      originalUrl,
      resolvedUrl,
      error: "Could not extract Douyin aweme_id from URL."
    };
  }

  const cookieHeader =
    input.cookieHeader ||
    process.env.DOUYIN_COOKIE ||
    (input.cookiesFile ? await loadCookieHeaderFromFile(input.cookiesFile) : "");
  const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?${new URLSearchParams({
    aweme_id: awemeId,
    aid: "6383",
    device_platform: "webapp"
  }).toString()}`;

  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.douyin.com/",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  });

  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      category: "douyin_api_http_failed",
      awemeId,
      originalUrl,
      resolvedUrl,
      httpStatus: response.status,
      error: trimForError(body)
    };
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return {
      ok: false,
      category: "douyin_api_non_json",
      awemeId,
      originalUrl,
      resolvedUrl,
      error: trimForError(body)
    };
  }

  const detail = data.aweme_detail || {};
  const video = detail.video || {};
  const videoUrls = extractDouyinVideoUrls(video);
  return {
    ok: videoUrls.length > 0,
    category: videoUrls.length > 0 ? "ok" : "douyin_api_no_video_url",
    awemeId,
    originalUrl,
    resolvedUrl,
    webpageUrl: `https://www.douyin.com/video/${awemeId}`,
    title: detail.desc || "",
    description: detail.desc || "",
    author: detail.author?.nickname,
    duration: video.duration ? video.duration / 1000 : undefined,
    coverUrl: video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || video.dynamic_cover?.url_list?.[0],
    createTime: detail.create_time ? new Date(detail.create_time * 1000).toISOString() : undefined,
    videoUrls,
    rawStatusCode: data.status_code,
    rawStatusMsg: data.status_msg
  };
}

function extractBilibiliBvid(url) {
  const text = String(url || "");
  const match = text.match(/BV[0-9A-Za-z]{10,}/);
  return match ? match[0] : "";
}

async function resolveDouyinUrl(url) {
  if (!/v\.douyin\.com/i.test(url)) {
    return url;
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    return response.url || url;
  } catch {
    return url;
  }
}

function extractDouyinAwemeId(url) {
  const text = String(url || "");
  const videoMatch = text.match(/\/video\/(\d+)/);
  if (videoMatch) {
    return videoMatch[1];
  }
  const modalMatch = text.match(/[?&]modal_id=(\d+)/);
  if (modalMatch) {
    return modalMatch[1];
  }
  const anyLongId = text.match(/\b(\d{16,22})\b/);
  return anyLongId ? anyLongId[1] : null;
}

function extractDouyinVideoUrls(video) {
  const candidates = [];
  const addUrls = (container, score = 0) => {
    const urlList = container?.url_list || [];
    for (const url of urlList) {
      if (url) {
        candidates.push({ url, score });
      }
    }
  };

  for (const item of video.bit_rate || []) {
    addUrls(item.play_addr, Number(item.bit_rate || 0));
  }
  addUrls(video.play_addr, 1);
  addUrls(video.download_addr, 0);

  return candidates
    .filter((item) => !/playwm/i.test(item.url))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.url)
    .filter((url, index, all) => all.indexOf(url) === index);
}

async function loadCookieHeaderFromFile(filePath) {
  const content = await readFile(filePath, "utf8");
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("[")) {
    const cookies = JSON.parse(trimmed);
    return cookies
      .map((item) => item?.name && `${item.name}=${item.value || ""}`)
      .filter(Boolean)
      .join("; ");
  }
  if (trimmed.startsWith("#") || trimmed.includes("\t")) {
    const pairs = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const parts = line.trim().split("\t");
      if (parts.length >= 7 && parts[5]) {
        pairs.push(`${parts[5]}=${parts[6] || ""}`);
      }
    }
    return pairs.join("; ");
  }
  return trimmed;
}

function isDouyinUrl(url) {
  return /(^|\.)douyin\.com\//i.test(String(url || ""));
}

function classifyYtDlpResult(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  if (result.ok) {
    return {
      category: "ok",
      message: "yt-dlp can access metadata for this link."
    };
  }
  if (text.includes("could not copy chrome cookie database")) {
    return {
      category: "browser_cookie_unreadable",
      message: "yt-dlp could not read browser cookies. Close the browser fully or provide an exported cookies.txt file."
    };
  }
  if (text.includes("failed to decrypt with dpapi")) {
    return {
      category: "browser_cookie_decrypt_failed",
      message: "yt-dlp could read the browser cookie database, but Windows DPAPI decryption failed. Try a newer yt-dlp build or an exported cookies.txt file."
    };
  }
  if (text.includes("fresh cookies") || text.includes("cookies are needed")) {
    return {
      category: "needs_cookies",
      message: "The platform requires fresh cookies or a logged-in browser session."
    };
  }
  if (text.includes("login") || text.includes("sign in") || text.includes("not logged in")) {
    return {
      category: "login_required",
      message: "The link appears to require login."
    };
  }
  if (text.includes("drm") || text.includes("encrypted") || text.includes("widevine")) {
    return {
      category: "drm",
      message: "The video appears to be protected by DRM/encryption and cannot be downloaded by yt-dlp."
    };
  }
  if (
    text.includes("captcha") ||
    text.includes("verify") ||
    text.includes("forbidden") ||
    text.includes("403") ||
    text.includes("blocked")
  ) {
    return {
      category: "anti_bot",
      message: "The platform likely blocked automated access or requires verification."
    };
  }
  if (text.includes("no video formats") || text.includes("unsupported url")) {
    return {
      category: "download_failed",
      message: "yt-dlp could not find a downloadable video format for this URL."
    };
  }
  return {
    category: "metadata_failed",
    message: "yt-dlp failed before usable metadata was available. Inspect stderrPreview for platform-specific details."
  };
}

async function summarizeVideoLink(input) {
  const context = await prepareVideoContext({
    ...input,
    enableWhisper: input.enableWhisper ?? "auto",
    forceTextTrack: input.forceTextTrack !== false
  });
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  if (!apiKey) {
    return {
      warning: "Video context was prepared, but no Qwen API key was set. Set DASHSCOPE_API_KEY or QWEN_API_KEY, then run again.",
      context
    };
  }

  const model = input.model || DEFAULT_QWEN_MODEL;
  const focus =
    input.focus ||
    "Summarize both subtitles/speech and visual content, especially information visible in the video but absent from captions.";
  const summary = await callQwenVision({ context, focus, model, apiKey });
  const outputPath = join(context.sessionDir, "summary.md");
  await writeFile(outputPath, summary, "utf8");
  return { summary, outputPath, context };
}

async function summarizeVideoLinkForLearning(input) {
  const context = await prepareVideoContext({
    ...input,
    frameIntervalSeconds: input.frameIntervalSeconds ?? 5,
    maxFrames: input.maxFrames ?? 80,
    frameStrategy: input.frameStrategy || "smart",
    enableWhisper: input.enableWhisper ?? "auto",
    forceTextTrack: input.forceTextTrack !== false,
    enableBrowserFallback: input.enableBrowserFallback !== false
  });

  const scriptPath = join(PROJECT_DIR, "scripts", "extract_learning_summary.cjs");
  const result = await runCommand("node", [scriptPath, context.sessionDir, join(context.sessionDir, "frames")]);
  if (!result.ok) {
    throw new Error(`Learning summary extraction failed: ${trimForError(result.stderr || result.stdout)}`);
  }

  const outputPath = join(context.sessionDir, "learning_summary.md");
  const extractionPath = join(context.sessionDir, "learning_extraction.md");
  const summary = existsSync(outputPath) ? await readFile(outputPath, "utf8") : result.stdout;
  return {
    summary,
    outputPath,
    extractionPath,
    context
  };
}

async function callQwenVision({ context, focus, model, apiKey }) {
  const imageBlocks = [];
  for (const frame of context.frames.slice(0, 24)) {
    imageBlocks.push({
      type: "image_url",
      image_url: { url: await imageToDataUrl(frame) }
    });
  }

  const prompt = [
    "You are analyzing a video from sampled key frames plus subtitles/metadata.",
    "Produce a comprehensive Chinese summary.",
    "Separate what is supported by subtitles from what is visible in frames.",
    "Mention likely time ranges based on frame order and frame interval.",
    "Avoid inventing details that are not visible or stated.",
    "",
    `Focus: ${focus}`,
    "",
    "Metadata:",
    JSON.stringify(context.metadata, null, 2),
    "",
    "Subtitles or transcript preview:",
    [
      context.subtitleText || "(No subtitles/page text found.)",
      context.transcript?.ok ? `\nSpeech transcript:\n${context.transcript.text}` : ""
    ].join("\n")
  ].join("\n");

  const response = await fetch(`${DEFAULT_QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }, ...imageBlocks]
        }
      ],
      temperature: 0.2
    })
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen API failed with HTTP ${response.status}: ${trimForError(body)}`);
  }

  const data = JSON.parse(body);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content, null, 2);
}

async function imageToDataUrl(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const chunks = [];
  await new Promise((resolvePromise, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject)
      .on("end", resolvePromise);
  });
  return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
}

function parseMetadata(result) {
  if (!result.ok) {
    return { error: trimForError(result.stderr) };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { raw: result.stdout.slice(0, 2000) };
  }
}

function pickMetadata(metadata) {
  return {
    title: metadata.title,
    fulltitle: metadata.fulltitle,
    uploader: metadata.uploader || metadata.channel,
    duration: metadata.duration,
    thumbnail: metadata.thumbnail,
    webpage_url: metadata.webpage_url,
    description: metadata.description ? metadata.description.slice(0, 2000) : undefined,
    upload_date: metadata.upload_date,
    subtitles: metadata.subtitles ? Object.keys(metadata.subtitles) : undefined,
    automatic_captions: metadata.automatic_captions ? Object.keys(metadata.automatic_captions) : undefined
  };
}

async function findLargestVideoFile(dir) {
  const files = await listFiles(dir, [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".m4s"]);
  if (files.length === 0) {
    throw new Error(`No downloaded video file found in ${dir}`);
  }
  let largest = files[0];
  let largestSize = 0;
  for (const file of files) {
    const info = await stat(file);
    if (info.size > largestSize) {
      largest = file;
      largestSize = info.size;
    }
  }
  return largest;
}

async function listFiles(dir, extensions) {
  if (!existsSync(dir)) {
    return [];
  }
  const names = await readdir(dir);
  return names
    .filter((name) => extensions.includes(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .sort();
}

async function readSubtitlePreview(files) {
  const pieces = [];
  for (const file of files.slice(0, 4)) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim()) {
      pieces.push(`## ${basename(file)}\n${text.slice(0, 12000)}`);
    }
  }
  return pieces.join("\n\n").slice(0, 32000);
}

async function extractSubtitleAnchors(files) {
  const anchors = [];
  for (const file of files.slice(0, 4)) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text.trim()) continue;
    anchors.push(...parseSubtitleAnchors(text, basename(file)));
  }
  return limitSubtitleAnchors(anchors, 18);
}

function parseSubtitleAnchors(text, source) {
  const blocks = String(text || "").split(/\n\s*\n/g);
  const anchors = [];
  const keywordRules = [
    ["prompt", /prompt|提示词|指令|复制|输入|发送/i],
    ["code", /code|codex|react|vite|npm|node|css|html|github|render|命令|代码|文件|路径/i],
    ["tool", /ai|工具|平台|浏览器|powerpoint|ppt|notion|cursor|trae|通义|qwen|deepseek/i],
    ["step", /步骤|首先|然后|接下来|开始|完成|检查|优化|部署|预览|生成/i],
    ["result", /效果|结果|页面|网站|作品集|成品|展示|成功/i]
  ];

  for (const block of blocks) {
    const timeMatch = block.match(/(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[,.](\d{1,3}))?\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[,.](\d{1,3}))?/);
    if (!timeMatch) continue;
    const body = block
      .replace(/WEBVTT|Kind:.*|Language:.*/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(timeMatch[0], "")
      .replace(/^\d+$/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    const matched = keywordRules.find(([, rule]) => rule.test(body));
    if (!matched) continue;
    const start = subtitleTimestampToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const end = subtitleTimestampToSeconds(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
    anchors.push({
      time: Number(((start + end) / 2).toFixed(2)),
      start,
      end,
      keyword: matched[0],
      text: body.slice(0, 160),
      source
    });
  }
  return anchors;
}

function subtitleTimestampToSeconds(hour, minute, second, millisecond) {
  return (
    Number(hour || 0) * 3600 +
    Number(minute || 0) * 60 +
    Number(second || 0) +
    Number((millisecond || "0").padEnd(3, "0")) / 1000
  );
}

function limitSubtitleAnchors(anchors, maxCount) {
  const sorted = anchors
    .filter((item) => Number.isFinite(item.time))
    .sort((a, b) => a.time - b.time);
  const selected = [];
  for (const anchor of sorted) {
    if (selected.some((item) => Math.abs(item.time - anchor.time) < 6 && item.keyword === anchor.keyword)) continue;
    selected.push(anchor);
    if (selected.length >= maxCount) break;
  }
  return selected;
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find(Boolean) || "";
}

function trimForError(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 1200);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function requireString(value, name) {
  if (!value || typeof value !== "string") {
    throw new Error(`${name} is required and must be a string.`);
  }
  return value;
}

function normalizeVideoUrl(value, name = "url") {
  const raw = requireString(value, name).trim();
  const match = raw.match(/https?:\/\/[^\s"'<>，。！？；、）】》]+/i);
  if (!match) {
    throw new Error(`${name} must contain an http or https URL.`);
  }
  return match[0]
    .replace(/[),.;!?，。！？；、:：]+$/g, "")
    .trim();
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, min, max) {
  return Math.trunc(clampNumber(value, min, max));
}

function contentText(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function callTool(name, args) {
  if (name === "check_environment") {
    return contentText(await checkEnvironment());
  }
  if (name === "probe_qwen_api") {
    return contentText(await probeQwenApi(args || {}));
  }
  if (name === "detect_video_platform") {
    return contentText(detectVideoPlatform(args || {}));
  }
  if (name === "diagnose_video_link") {
    return contentText(await diagnoseVideoLink(args || {}));
  }
  if (name === "probe_video_page_with_browser") {
    return contentText(await probeVideoPageWithBrowser(args || {}));
  }
  if (name === "probe_douyin_api") {
    return contentText(await probeDouyinApi(args || {}));
  }
  if (name === "prepare_video_context") {
    return contentText(await prepareVideoContext(args || {}));
  }
  if (name === "summarize_video_link") {
    return contentText(await summarizeVideoLink(args || {}));
  }
  if (name === "summarize_video_link_for_learning") {
    return contentText(await summarizeVideoLinkForLearning(args || {}));
  }
  throw new Error(`Unknown tool: ${name}`);
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", async (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  await processMessages();
});

async function processMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      inputBuffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (inputBuffer.length < bodyEnd) {
      return;
    }

    const raw = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(bodyEnd);
    await handleMessage(JSON.parse(raw));
  }
}

async function handleMessage(message) {
  if (!message.id && message.method?.startsWith("notifications/")) {
    return;
  }

  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        }
      });
      return;
    }

    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      return;
    }

    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    sendError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    sendError(message.id, -32000, error.message || String(error));
  }
}

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendError(id, code, message) {
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  });
}
