const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const { normalizeOutputs, normalizeArticleTemplateMode } = require("./output_options.cjs");

const projectDir = path.resolve(__dirname, "..");
const webDir = path.join(projectDir, "web");
const serverPath = path.join(projectDir, "src", "server.js");
const port = Number(process.env.VIDEO_LEARNING_WEB_PORT || 8787);
const jobs = new Map();
const jobSecrets = new Map();
const jobProcesses = new Map();
const allowedFileRoots = new Set([path.resolve(projectDir, "sessions")]);
const logDir = path.join(projectDir, "logs");
const logPath = path.join(logDir, "web_server.log");

function runNodeScript(scriptName, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(projectDir, "scripts", scriptName), ...args], {
      cwd: projectDir,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true
    });
    if (typeof options.onChild === "function") {
      options.onChild(child);
    }
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Process may already have exited.
          }
          reject(new Error(`${scriptName} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `${scriptName} exited with code ${code}`));
        return;
      }
      const text = stdout.trim();
      const parsed = parseJsonFromStdout(text);
      resolve(parsed || { stdout: text });
    });
  });
}

function parseJsonFromStdout(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function trimForError(text, maxLength = 900) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function normalizeProviderConfig(config = {}) {
  const provider = String(config.provider || "dashscope").trim() || "dashscope";
  const apiKey = String(config.apiKey || "").trim();
  const defaultBaseUrl = provider === "dashscope"
    ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
    : "";
  const baseUrl = String(config.baseUrl || defaultBaseUrl).trim().replace(/\/$/, "");
  const visionModel = String(config.visionModel || config.model || "").trim();
  const textModel = String(config.textModel || visionModel).trim();
  const env = {};
  if (apiKey) {
    env.DASHSCOPE_API_KEY = apiKey;
    env.QWEN_API_KEY = apiKey;
  }
  if (baseUrl) env.QWEN_BASE_URL = baseUrl;
  if (visionModel) env.QWEN_MODEL = visionModel;
  return {
    publicConfig: {
      provider,
      baseUrl,
      visionModel,
      textModel,
      hasApiKey: Boolean(apiKey)
    },
    env
  };
}

async function probeProviderConfig(config = {}) {
  const normalized = normalizeProviderConfig(config);
  const { baseUrl, visionModel } = normalized.publicConfig;
  const apiKey = String(config.apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "API Key is required.", provider: normalized.publicConfig };
  if (!baseUrl) return { ok: false, error: "Base URL is required.", provider: normalized.publicConfig };
  if (!visionModel) return { ok: false, error: "Model name is required.", provider: normalized.publicConfig };
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [{ role: "user", content: "Reply with OK only." }],
        temperature: 0,
        max_tokens: 12
      })
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        error: trimForError(body),
        provider: normalized.publicConfig
      };
    }
    const data = JSON.parse(body);
    return {
      ok: true,
      provider: normalized.publicConfig,
      response: data?.choices?.[0]?.message?.content,
      usage: data?.usage
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      provider: normalized.publicConfig
    };
  }
}

function logLine(level, message, extra = {}) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const record = {
      at: new Date().toISOString(),
      level,
      message,
      ...extra
    };
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Logging must never be the reason the local web server exits.
  }
}

process.on("uncaughtException", (error) => {
  logLine("fatal", "uncaughtException", { error: error.stack || error.message || String(error) });
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logLine("fatal", "unhandledRejection", { error });
});

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(webDir, pathname));
  if (!filePath.startsWith(webDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": mimeType(filePath) });
  fs.createReadStream(filePath).pipe(res);
}

function mcpCall(toolName, toolArgs, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true
    });
    if (typeof options.onChild === "function") {
      options.onChild(child);
    }
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          fail(new Error(`${toolName} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;
    let buffer = Buffer.alloc(0);
    let stderr = "";
    let nextId = 1;
    const pending = new Map();

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) break;
        const length = Number(match[1]);
        const start = headerEnd + 4;
        const end = start + length;
        if (buffer.length < end) break;
        const message = JSON.parse(buffer.slice(start, end).toString("utf8"));
        buffer = buffer.slice(end);
        const handler = pending.get(message.id);
        if (handler) {
          pending.delete(message.id);
          handler(message);
        }
      }
    });
    function done(value) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(value);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      reject(error);
    }

    child.on("error", fail);

    function send(method, params) {
      const id = nextId++;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
      child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
      child.stdin.write(payload);
      return new Promise((resolveMessage) => pending.set(id, resolveMessage));
    }

    (async () => {
      const init = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "video-learning-web", version: "0.1.0" }
      });
      if (init.error) throw new Error(JSON.stringify(init.error));
      const result = await send("tools/call", { name: toolName, arguments: toolArgs });
      if (result.error) throw new Error(JSON.stringify(result.error));
      child.stdin.end();
      child.kill();
      const text = result.result?.content?.[0]?.text || "";
      try {
        done(JSON.parse(text));
      } catch {
        done({ text });
      }
    })().catch((error) => {
      fail(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

function createJob(input) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const outputs = normalizeOutputs(input.outputs, { generateMarkmap: input.generateMarkmap });
  const articleTemplateMode = normalizeArticleTemplateMode(input.articleTemplateMode);
  const provider = normalizeProviderConfig(input.modelConfig || input.provider || {});
  const outputDir = normalizeOutputDir(input.outputDir);
  allowedFileRoots.add(outputDir);
  jobSecrets.set(id, { providerEnv: provider.env });
  const job = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    input: {
      ...input,
      modelConfig: provider.publicConfig,
      provider: provider.publicConfig,
      outputs,
      articleTemplateMode,
      outputDir,
      generateMarkmap: outputs.includes("markmap")
    },
    stage: "Queued",
    events: [{ at: now, stage: "Queued", message: "任务已创建" }],
    progress: {},
    result: null,
    error: null
  };
  jobs.set(id, job);
  runJob(job);
  return job;
}

function cleanErrorMessage(message) {
  const text = String(message || "");
  if (/blob URL|blob\/session media|Blob URLs/i.test(text)) {
    return [
      "B 站浏览器探测只拿到了 blob/session 媒体地址。",
      "blob 地址只存在于当前浏览器页面进程里，yt-dlp/Node 无法直接下载。",
      "已自动优先尝试 Edge cookies 路线；如果仍失败，通常需要导出 cookies.txt，或等待真实 m4s/m3u8 地址探测成功。",
      trimForError(text)
    ].join("\n");
  }
  if (/Bilibili CDN returned 403|real Bilibili media URL/i.test(text)) {
    return [
      "B 站真实媒体地址已找到，但 CDN 返回 403。",
      "常见原因是反盗链、签名上下文过期、需要浏览器 cookies，或请求头不完整。",
      "建议确认 Edge 已登录 B 站，必要时导出 cookies.txt 后再试。",
      trimForError(text)
    ].join("\n");
  }
  if (text.includes("launchPersistentContext") || text.includes("Target page, context or browser has been closed")) {
    return [
      "浏览器 fallback 启动失败：Edge 探测窗口被关闭或用户目录被占用。",
      "已建议使用隔离探测 profile。请刷新页面后重试；如果仍失败，关闭所有 Edge 进程或改用 cookies.txt。"
    ].join("\n");
  }
  if (text.includes("Fresh cookies") || text.includes("needs_cookies")) {
    return "平台需要 fresh cookies。可以导出 cookies.txt，或让浏览器 fallback 成功拿到页面视频地址。";
  }
  if (text.length > 1200) {
    return `${text.slice(0, 1200)}\n...`;
  }
  return text;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(job.id, job);
}

function addEvent(job, stage, message, extra = {}) {
  const event = {
    at: new Date().toISOString(),
    stage,
    message,
    ...extra
  };
  job.events = [...(job.events || []), event].slice(-80);
  updateJob(job, { stage, events: job.events });
}

function isTerminalJob(job) {
  return ["completed", "failed", "cancelled"].includes(job?.status);
}

function trackJobProcess(job, child) {
  if (!job?.id || !child) return;
  let processes = jobProcesses.get(job.id);
  if (!processes) {
    processes = new Set();
    jobProcesses.set(job.id, processes);
  }
  processes.add(child);
  child.once("close", () => {
    const current = jobProcesses.get(job.id);
    if (!current) return;
    current.delete(child);
    if (!current.size) jobProcesses.delete(job.id);
  });
}

function stopJobProcesses(job) {
  const processes = jobProcesses.get(job.id);
  if (!processes) return;
  for (const child of processes) {
    try {
      if (!child.killed) child.kill();
    } catch {
      // Process may already be gone.
    }
  }
  jobProcesses.delete(job.id);
}

function cancelJob(job) {
  if (!job) return null;
  if (isTerminalJob(job)) return job;
  stopJobProcesses(job);
  updateJob(job, {
    status: "cancelled",
    stage: "Cancelled",
    error: null,
    progress: {
      ...(job.progress || {}),
      phase: "cancelled",
      cancelled: true
    }
  });
  addEvent(job, "Cancelled", "用户已暂停分析，后台进程已终止");
  jobSecrets.delete(job.id);
  return job;
}

function throwIfCancelled(job) {
  if (job?.status === "cancelled") {
    throw new Error("Job was cancelled by user.");
  }
}

async function runJob(job) {
  let stopPrepareMonitor = null;
  try {
    const { url, mode, generateMarkmap } = job.input;
    const providerEnv = jobSecrets.get(job.id)?.providerEnv || {};
    const subtitleOnly = isSubtitleOnlyJob(job);
    updateJob(job, { status: "running", stage: "Detecting platform" });
    addEvent(job, "Detecting platform", "识别视频平台和解析路线");
    const platform = await mcpCall("detect_video_platform", { url }, {
      onChild: (child) => trackJobProcess(job, child)
    });
    throwIfCancelled(job);
    updateJob(job, { platform });
    addEvent(job, "Preparing video", `平台：${platform.platform}，路线：${(platform.strategyOrder || []).join(" -> ")}`);

    const prepareTimeoutMs = getPrepareTimeoutMs(platform, mode, subtitleOnly);
    const platformName = String(platform.platform || "").toLowerCase();
    const autoFrameArgs = mode === "quick"
      ? {
          frameIntervalSeconds: 15,
          maxFrames: 16,
          frameStrategy: "fixed",
          smartDenseFps: 0.5,
          smartScoutIntervalSeconds: 16,
          smartWindowSeconds: 2,
          smartMaxModelCandidates: 6,
          smartSkipSceneDetectionWithSubtitles: true,
          smartSceneDetectionMaxDuration: platformName === "youtube" ? 480 : 720
        }
      : {
          frameIntervalSeconds: 10,
          maxFrames: 22,
          frameStrategy: "smart",
          smartDenseFps: 0.5,
          smartScoutIntervalSeconds: 14,
          smartWindowSeconds: 2,
          smartMaxModelCandidates: 5,
          smartMaxScoutFrames: 12,
          smartSkipSceneDetectionWithSubtitles: true,
          smartSceneDetectionMaxDuration: platformName === "youtube" ? 480 : 720
        };

    const args = {
      url,
      enableWhisper: job.input.enableWhisper ?? "auto",
      forceTextTrack: job.input.forceTextTrack !== false,
      skipFrames: subtitleOnly,
      ...autoFrameArgs,
      generateMarkmap: Boolean(generateMarkmap),
      enableBrowserFallback: true,
      enableDouyinDownloaderFallback: true,
      enableDouyinApiFallback: true
    };

    let result;
    if (mode === "quick" && !subtitleOnly) {
      addEvent(job, "Quick summary", "快速总结模式：准备视频并调用模型");
      result = await mcpCall("summarize_video_link", args, {
        env: providerEnv,
        onChild: (child) => trackJobProcess(job, child)
      });
      throwIfCancelled(job);
    } else {
      const jobWorkDir = path.join(job.input.outputDir || defaultOutputDir(), "web-jobs", job.id);
      fs.mkdirSync(jobWorkDir, { recursive: true });
      args.workDir = jobWorkDir;
      addEvent(job, "Preparing video", "下载/探测视频，抽取页面文字，执行智能抽帧");
      addEvent(job, "Prepare timeout", `Dynamic prepare timeout: ${Math.round(prepareTimeoutMs / 1000)}s`);
      stopPrepareMonitor = startPrepareMonitor(job, jobWorkDir);
      let prepareChild = null;
      const preparePromise = mcpCall("prepare_video_context", args, {
        timeoutMs: prepareTimeoutMs,
        env: providerEnv,
        onChild: (child) => {
          prepareChild = child;
          trackJobProcess(job, child);
        }
      });
      const context = await waitForPreparedContext(jobWorkDir, preparePromise);
      throwIfCancelled(job);
      if (prepareChild && !prepareChild.killed) {
        prepareChild.kill();
      }
      if (stopPrepareMonitor) {
        stopPrepareMonitor();
        stopPrepareMonitor = null;
      }
      updateJob(job, {
        contextPreview: {
          sessionDir: context.sessionDir,
          source: context.source,
          videoPath: context.videoPath,
          frameCount: context.frames?.length || 0,
          frameSampling: context.frameSampling
        },
        progress: {
          phase: "prepared",
          frameCount: context.frames?.length || 0,
          frameSampling: context.frameSampling
        }
      });
      addEvent(
        job,
        "Video prepared",
        `视频已准备完成：${context.source || "unknown"}，抽帧 ${context.frames?.length || 0} 张`
      );
      if (subtitleOnly) {
        addEvent(job, "Exporting subtitles", "仅导出字幕：跳过视觉模型与图文合成");
        result = await runSubtitleExport(job, context);
      } else {
        result = await runLearningExtraction(job, context);
      }
      throwIfCancelled(job);
    }
    updateJob(job, { status: "completed", stage: "Completed", result });
    addEvent(job, "Completed", "分析完成");
  } catch (error) {
    if (job.status === "cancelled") {
      return;
    }
    logLine("error", "job failed", {
      jobId: job.id,
      stage: job.stage,
      error: error.stack || error.message || String(error)
    });
    updateJob(job, { status: "failed", stage: "Failed", error: cleanErrorMessage(error.message || String(error)) });
    addEvent(job, "Failed", "分析失败");
  } finally {
    if (stopPrepareMonitor) {
      stopPrepareMonitor();
    }
    if (isTerminalJob(job)) {
      jobProcesses.delete(job.id);
      jobSecrets.delete(job.id);
    }
  }
}

function isSubtitleOnlyJob(job) {
  const outputs = Array.isArray(job.input?.outputs) ? job.input.outputs : [];
  return outputs.length > 0 && outputs.every((item) => item === "subtitles" || item === "markmap");
}

function getPrepareTimeoutMs(platform, mode, subtitleOnly) {
  if (subtitleOnly) return 180000;
  const name = String(platform?.platform || "").toLowerCase();
  if (mode === "quick") {
    return name === "youtube" ? 300000 : 240000;
  }
  if (name === "youtube") return 720000;
  if (name === "bilibili") return 600000;
  if (name === "douyin") return 420000;
  return 480000;
}

function defaultOutputDir() {
  return path.join(os.homedir(), "Video Learning Desk");
}

function normalizeOutputDir(value) {
  const raw = String(value || "").trim();
  const target = raw ? raw : defaultOutputDir();
  const resolved = path.resolve(target);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function runSubtitleExport(job, context) {
  const providerEnv = jobSecrets.get(job.id)?.providerEnv || {};
  const wantsMarkmap = (job.input.outputs || []).includes("markmap");
  assertSubtitleExportHasText(context);
  const exported = await runNodeScript("summarize_subtitles_tree.cjs", [context.sessionDir], {
    timeoutMs: Number(process.env.SUBTITLE_SUMMARY_TIMEOUT_MS || 120000),
    onChild: (child) => trackJobProcess(job, child),
    env: {
      ...providerEnv,
      LEARNING_OUTPUTS: (job.input.outputs || []).join(","),
      GENERATE_MARKMAP: wantsMarkmap ? "1" : ""
    }
  });
  return {
    summary: exported.preview,
    outputPath: exported.summaryPath || exported.subtitlesMarkdownPath,
    markdownPath: exported.summaryPath || null,
    articlePath: null,
    wordPath: null,
    markmapMarkdownPath: exported.markmapMarkdownPath || null,
    markmapHtmlPath: exported.markmapHtmlPath || null,
    markmapPath: exported.markmapHtmlPath || null,
    subtitlesPath: exported.subtitlesMarkdownPath || exported.summaryPath,
    subtitlesTextPath: exported.subtitlesTextPath,
    subtitleSummaryPath: exported.summaryPath || null,
    outputs: job.input.outputs || [],
    articleTemplateMode: job.input.articleTemplateMode || "cover_markmap_article",
    extractionPath: null,
    evidencePath: null,
    context,
    refinement: {
      suggestRefinement: false,
      reason: "Subtitle-only export skips visual evidence checks."
    }
  };
}

function assertSubtitleExportHasText(context) {
  const subtitleText = String(context?.subtitleText || "").trim();
  const hasSubtitleFile = Array.isArray(context?.subtitles) && context.subtitles.some((file) => /\.(srt|vtt)$/i.test(String(file || "")));
  const hasTranscript = Boolean(context?.transcript?.ok && String(context.transcript.text || "").trim());
  if (hasSubtitleFile || subtitleText.length >= 80 || hasTranscript) return;
  const source = context?.source || "unknown";
  const textSource = context?.textSource || "none";
  const whisperReason = context?.transcript?.reason ? ` Whisper: ${context.transcript.reason}` : "";
  throw new Error(`No usable subtitle text was found. Source=${source}, textSource=${textSource}.${whisperReason}`);
}

function exportSubtitlesFromContext(context) {
  const sessionDir = context.sessionDir;
  const parts = [];
  const title =
    context.metadata?.title ||
    context.metadata?.fulltitle ||
    context.bilibiliApi?.title ||
    context.douyinApi?.title ||
    "Video subtitles";
  parts.push(`# ${title}`);
  parts.push("");
  parts.push(`- Source: ${context.source || "unknown"}`);
  parts.push(`- URL: ${context.url || context.metadata?.webpage_url || ""}`);
  parts.push("");

  const subtitleText = String(context.subtitleText || "").trim();
  const transcriptText = context.transcript?.ok ? String(context.transcript.text || "").trim() : "";
  const fileTexts = [];
  for (const file of context.subtitles || []) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fileTexts.push(`## ${path.basename(file)}\n\n${fs.readFileSync(file, "utf8").trim()}`);
      }
    } catch {
      // Ignore unreadable subtitle sidecars.
    }
  }

  if (fileTexts.length) {
    parts.push("## Subtitle files");
    parts.push("");
    parts.push(fileTexts.join("\n\n"));
  } else if (subtitleText) {
    parts.push("## Text track");
    parts.push("");
    parts.push(subtitleText);
  }

  if (transcriptText) {
    parts.push("");
    parts.push("## Whisper transcript");
    parts.push("");
    parts.push(transcriptText);
  } else if (context.transcript?.reason) {
    parts.push("");
    parts.push("## Transcript status");
    parts.push("");
    parts.push(context.transcript.reason);
  }

  const markdown = `${parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
  const plain = [
    subtitleText,
    transcriptText
  ].filter(Boolean).join("\n\n").trim() || markdown;
  const markdownPath = path.join(sessionDir, "learning_subtitles.md");
  const textPath = path.join(sessionDir, "learning_subtitles.txt");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  fs.writeFileSync(textPath, plain, "utf8");
  return {
    markdownPath,
    textPath,
    preview: markdown.slice(0, 4000)
  };
}

function runLearningExtraction(job, context) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(projectDir, "scripts", "extract_learning_summary.cjs");
    const frameDir = path.join(context.sessionDir, "frames");
    const totalFrames = Array.isArray(context.frames)
      ? context.frames.length
      : fs.existsSync(frameDir)
        ? fs.readdirSync(frameDir).filter((name) => /\.(jpg|jpeg|png)$/i.test(name)).length
        : 0;
    const batchSize = Number(process.env.LEARNING_BATCH_SIZE || 10);
    const totalBatches = Math.max(1, Math.ceil(totalFrames / batchSize));
    const startedAt = Date.now();
    const timeoutMs = Number(process.env.LEARNING_TIMEOUT_MS || 20 * 60 * 1000);
    let synthStartedAt = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let timeout = null;

    addEvent(job, "Evidence frame scoring", `开始给候选截图打学习价值分：${totalFrames} 帧，预计 ${totalBatches} 批`);
    const child = spawn("node", [scriptPath, context.sessionDir, frameDir], {
      cwd: projectDir,
      env: {
        ...process.env,
        ...(jobSecrets.get(job.id)?.providerEnv || {}),
        LEARNING_OUTPUTS: (job.input.outputs || []).join(","),
        ARTICLE_TEMPLATE_MODE: job.input.articleTemplateMode || "cover_markmap_article",
        LEARNING_BATCH_SIZE: process.env.LEARNING_BATCH_SIZE || "12",
        LEARNING_MAX_EVIDENCE_FRAMES: process.env.LEARNING_MAX_EVIDENCE_FRAMES || "10",
        GENERATE_MARKMAP: job.input.generateMarkmap ? "1" : ""
      },
      windowsHide: true
    });
    trackJobProcess(job, child);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      fn(value);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`Learning extraction timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    timer = setInterval(() => {
      const batchCount = fs.existsSync(context.sessionDir)
        ? fs.readdirSync(context.sessionDir).filter((name) => /^learning_extract_batch_\d+\.md$/i.test(name)).length
        : 0;
      const extractionReady = fs.existsSync(path.join(context.sessionDir, "learning_extraction.md"));
      const evidenceReady = fs.existsSync(path.join(context.sessionDir, "learning_evidence.json"));
      const summaryReady = fs.existsSync(path.join(context.sessionDir, "learning_summary.md"));
      const phase = summaryReady
        ? "summary_ready"
        : evidenceReady || extractionReady || batchCount >= totalBatches
          ? "synthesizing"
          : "extracting";
      if (phase === "synthesizing" && synthStartedAt === null) {
        synthStartedAt = Date.now();
      }
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const synthElapsedSeconds = synthStartedAt ? Math.round((Date.now() - synthStartedAt) / 1000) : 0;
      const stage = phase === "synthesizing" ? "Synthesizing illustrated notes" : "Evidence frame scoring";
      updateJob(job, {
        stage,
        progress: {
          phase,
          batchCount,
          totalBatches,
          totalFrames,
          elapsedSeconds,
          synthElapsedSeconds,
          extractionReady,
          evidenceReady,
          summaryReady
        }
      });
      const last = job.events?.[job.events.length - 1];
      const elapsedBucket = Math.floor(elapsedSeconds / 30) * 30;
      const synthBucket = Math.floor(synthElapsedSeconds / 30) * 30;
      const message = phase === "synthesizing"
        ? `关键截图已筛选，正在合成图文学习笔记，已等待约 ${synthBucket} 秒`
        : `Qwen 正在筛选证据帧：第 ${Math.min(batchCount + 1, totalBatches)} / ${totalBatches} 批，已运行约 ${elapsedBucket} 秒`;
      if (!last || last.message !== message) {
        addEvent(job, stage, message);
      }
    }, 2000);

    child.on("error", (error) => {
      finish(reject, error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`Learning extraction failed: ${stderr || stdout}`));
        return;
      }
      const outputPath = path.join(context.sessionDir, "learning_summary.md");
      const articlePath = path.join(context.sessionDir, "learning_article.html");
      const wordPath = path.join(context.sessionDir, "learning_article.docx");
      const markmapMarkdownPath = path.join(context.sessionDir, "learning_mindmap.md");
      const markmapHtmlPath = path.join(context.sessionDir, "learning_mindmap.html");
      const extractionPath = path.join(context.sessionDir, "learning_extraction.md");
      const evidencePath = path.join(context.sessionDir, "learning_evidence.json");
      const summary = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : stdout;
      const resultPayload = {
        summary,
        outputPath,
        markdownPath: fs.existsSync(outputPath) ? outputPath : null,
        articlePath: fs.existsSync(articlePath) ? articlePath : null,
        wordPath: fs.existsSync(wordPath) ? wordPath : null,
        markmapMarkdownPath: fs.existsSync(markmapMarkdownPath) ? markmapMarkdownPath : null,
        markmapHtmlPath: fs.existsSync(markmapHtmlPath) ? markmapHtmlPath : null,
        markmapPath: fs.existsSync(markmapHtmlPath) ? markmapHtmlPath : null,
        outputs: job.input.outputs || [],
        articleTemplateMode: job.input.articleTemplateMode || "cover_markmap_article",
        extractionPath,
        evidencePath: fs.existsSync(evidencePath) ? evidencePath : null,
        context
      };
      runRefinementDiagnostics(context.sessionDir)
        .then((refinement) => finish(resolve, { ...resultPayload, refinement }))
        .catch((error) => {
          logLine("warn", "refinement diagnostics failed", {
            jobId: job.id,
            sessionDir: context.sessionDir,
            error: error.stack || error.message || String(error)
          });
          finish(resolve, {
            ...resultPayload,
            refinement: {
              suggestRefinement: true,
              reason: "二次补帧诊断失败，建议手动检查文章和证据覆盖。",
              error: error.message || String(error)
            }
          });
        });
    });
  });
}

async function runRefinementDiagnostics(sessionDir) {
  const plan = await runNodeScript("plan_refinement_frames.cjs", [sessionDir], { timeoutMs: 60000 });
  let articleCheck = null;
  try {
    articleCheck = await runNodeScript("verify_article_output.cjs", [sessionDir], { timeoutMs: 60000 });
  } catch (error) {
    articleCheck = {
      ok: false,
      error: error.message || String(error),
      reportPath: path.join(sessionDir, "article_output_check.json")
    };
  }
  const gapCount = Number(plan.gapCount || 0);
  const articleOk = articleCheck?.ok === true;
  const suggestRefinement = gapCount > 0 || !articleOk;
  const reasons = [];
  if (gapCount > 0) reasons.push(`证据缺口 ${gapCount} 项`);
  if (!articleOk) reasons.push("文章输出检查未通过");
  return {
    suggestRefinement,
    reason: reasons.join("；") || "证据自检通过",
    gapCount,
    refinementIntervalCount: Number(plan.refinementIntervalCount || 0),
    planPath: plan.outPath || path.join(sessionDir, "refinement_frame_plan.json"),
    articleCheckOk: articleOk,
    articleCheckPath: articleCheck?.reportPath || path.join(sessionDir, "article_output_check.json")
  };
}

async function executeRefinement(sessionDir, options = {}) {
  const args = [sessionDir];
  if (options.rescore !== false) args.push("--rescore");
  const executed = await runNodeScript("execute_refinement_frames.cjs", args, {
    timeoutMs: Number(process.env.REFINEMENT_TIMEOUT_MS || 30 * 60 * 1000)
  });
  const refinement = await runRefinementDiagnostics(sessionDir);
  const outputPath = path.join(sessionDir, "learning_summary.md");
  const articlePath = path.join(sessionDir, "learning_article.html");
  const wordPath = path.join(sessionDir, "learning_article.docx");
  const markmapMarkdownPath = path.join(sessionDir, "learning_mindmap.md");
  const markmapHtmlPath = path.join(sessionDir, "learning_mindmap.html");
  const evidencePath = path.join(sessionDir, "learning_evidence.json");
  const contextPath = path.join(sessionDir, "context.json");
  const context = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, "utf8")) : { sessionDir };
  const summary = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  return {
    ok: true,
    executed,
    refinement: {
      ...refinement,
      extractReportPath: executed.reportPath || path.join(sessionDir, "refinement_extract_report.json"),
      refinedManifestPath: executed.refinedManifestPath || path.join(sessionDir, "frames_manifest_refined.json")
    },
    result: {
      summary,
      outputPath: fs.existsSync(outputPath) ? outputPath : null,
      markdownPath: fs.existsSync(outputPath) ? outputPath : null,
      articlePath: fs.existsSync(articlePath) ? articlePath : null,
      wordPath: fs.existsSync(wordPath) ? wordPath : null,
      markmapMarkdownPath: fs.existsSync(markmapMarkdownPath) ? markmapMarkdownPath : null,
      markmapHtmlPath: fs.existsSync(markmapHtmlPath) ? markmapHtmlPath : null,
      markmapPath: fs.existsSync(markmapHtmlPath) ? markmapHtmlPath : null,
      evidencePath: fs.existsSync(evidencePath) ? evidencePath : null,
      context
    }
  };
}

function startPrepareMonitor(job, workDir) {
  const seen = new Set();
  const tick = () => {
    const state = inspectPrepareWorkDir(workDir);
    if (!state.sessionDir) {
      return;
    }
    updateJob(job, {
      progress: {
        ...(job.progress || {}),
        phase: "preparing",
        prepare: state
      }
    });
    for (const event of state.events) {
      const key = `${event.stage}:${event.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        addEvent(job, event.stage, event.message);
      }
    }
  };
  tick();
  const timer = setInterval(tick, 2000);
  return () => clearInterval(timer);
}

function inspectPrepareWorkDir(workDir) {
  const contextFiles = findFiles(workDir, "context.json");
  const sessionDir = contextFiles.length
    ? path.dirname(contextFiles.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a))[0])
    : newestDirectory(workDir);
  if (!sessionDir) {
    return { sessionDir: null, events: [] };
  }

  const events = [];
  const add = (stage, message) => events.push({ stage, message });
  const has = (relativePath) => fs.existsSync(path.join(sessionDir, relativePath));
  const size = (relativePath) => {
    const target = path.join(sessionDir, relativePath);
    if (!fs.existsSync(target)) return 0;
    const stat = safeStat(target);
    return stat ? stat.size : 0;
  };
  const countFiles = (relativePath, pattern) => {
    const target = path.join(sessionDir, relativePath);
    if (!fs.existsSync(target)) return 0;
    try {
      return fs.readdirSync(target).filter((name) => pattern.test(name)).length;
    } catch (error) {
      logLine("warn", "failed to count files", { target, error: error.message || String(error) });
      return 0;
    }
  };

  if (has("douyin_downloader_probe.json")) add("Douyin downloader", "已尝试 GHLiuyb/douyin_downloader 路线");
  if (has("douyin_api_probe.json")) add("Douyin API", "已尝试抖音 Web API 路线");
  if (has(path.join("browser_probe", "probe.json"))) add("Browser fallback", "浏览器探测已完成，正在选择真实视频源");
  if (size("video.mp4") > 0) add("Downloading video", `视频文件已写入，大小 ${formatBytes(size("video.mp4"))}`);
  const scoutCount = countFiles("smart_scout", /\.(jpg|jpeg|png)$/i);
  if (scoutCount > 0) add("Smart scout", `低密度粗扫已生成 ${scoutCount} 张 scout frame`);
  if (has("smart_frame_plan.json")) add("Smart frame plan", "智能抽帧计划已生成");
  const frameCount = countFiles("frames", /\.(jpg|jpeg|png)$/i);
  if (frameCount > 0) add("Extracting frames", `已抽帧 ${frameCount} 张`);
  if (has("context.json")) add("Context ready", "视频上下文已准备完成，即将进入 Qwen 画面理解");

  return {
    sessionDir,
    videoBytes: size("video.mp4"),
    scoutCount,
    frameCount,
    contextReady: has("context.json"),
    events
  };
}

async function waitForPreparedContext(workDir, preparePromise) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn(value);
    };

    const timer = setInterval(() => {
      const contextPath = newestContextPath(workDir);
      if (!contextPath) return;
      try {
        const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
        if (context && context.sessionDir && Array.isArray(context.frames)) {
          finish(resolve, context);
        }
      } catch {
        // File may still be in the middle of a write.
      }
    }, 1000);

    preparePromise
      .then((context) => finish(resolve, context))
      .catch((error) => finish(reject, error));
  });
}

function newestContextPath(workDir) {
  const files = findFiles(workDir, "context.json");
  if (!files.length) return null;
  return files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a))[0];
}

function newestDirectory(root) {
  if (!fs.existsSync(root)) return null;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    logLine("warn", "failed to read directory", { root, error: error.message || String(error) });
    return null;
  }
  const dirs = names
    .map((name) => path.join(root, name))
    .filter((item) => {
      const stat = safeStat(item);
      return stat && stat.isDirectory();
    })
    .sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
  return dirs[0] || null;
}

function findFiles(root, filename) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "edge-profile",
    "Default",
    "Cache",
    "Code Cache",
    "GPUCache",
    "Service Worker",
    "Session Storage",
    "Local Storage",
    "IndexedDB",
    "blob_storage"
  ]);
  const visit = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      logLine("warn", "failed to scan directory", { dir, error: error.message || String(error) });
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = safeStat(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (skipDirs.has(name)) continue;
        visit(full);
      } else if (name === filename) {
        results.push(full);
      }
    }
  };
  visit(root);
  return results;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    logLine("warn", "failed to stat path", { filePath, error: error.message || String(error) });
    return null;
  }
}

function fileMtimeMs(filePath) {
  const stat = safeStat(filePath);
  return stat ? stat.mtimeMs : 0;
}

function isAllowedFilePath(filePath) {
  const resolved = path.resolve(filePath);
  for (const root of allowedFileRoots) {
    const allowedRoot = path.resolve(root);
    if (resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      port,
      pid: process.pid,
      time: new Date().toISOString()
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/default-output-dir") {
    const outputDir = defaultOutputDir();
    fs.mkdirSync(outputDir, { recursive: true });
    allowedFileRoots.add(outputDir);
    sendJson(res, 200, { outputDir });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    const filePath = path.resolve(url.searchParams.get("path") || "");
    if (!isAllowedFilePath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      sendJson(res, 404, { error: "file not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(filePath) });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/detect") {
    const body = await readBody(req);
    const result = await mcpCall("detect_video_platform", { url: body.url });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/provider/probe") {
    const body = await readBody(req);
    const result = await probeProviderConfig(body.modelConfig || body.provider || body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const body = await readBody(req);
    if (!body.url) {
      sendJson(res, 400, { error: "url is required" });
      return;
    }
    const job = createJob({
      url: body.url,
      mode: body.mode || "learning",
      frameIntervalSeconds: body.frameIntervalSeconds,
      maxFrames: body.maxFrames,
      enableWhisper: body.enableWhisper ?? "auto",
      forceTextTrack: body.forceTextTrack !== false,
      generateMarkmap: body.generateMarkmap,
      outputs: body.outputs,
      outputDir: body.outputDir,
      modelConfig: body.modelConfig,
      articleTemplateMode: body.articleTemplateMode,
      frameStrategy: body.frameStrategy,
      smartDenseFps: body.smartDenseFps
    });
    sendJson(res, 202, job);
    return;
  }
  const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelJobMatch) {
    const job = jobs.get(cancelJobMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "job not found" });
      return;
    }
    sendJson(res, 200, cancelJob(job));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/refine") {
    const body = await readBody(req);
    const sessionDir = path.resolve(body.sessionDir || "");
    const allowedRoot = path.resolve(projectDir, "sessions");
    if (!sessionDir.startsWith(allowedRoot) || !fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) {
      sendJson(res, 400, { error: "sessionDir is invalid" });
      return;
    }
    const result = await executeRefinement(sessionDir, { rescore: body.rescore !== false });
    sendJson(res, 200, result);
    return;
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "job not found" });
      return;
    }
    sendJson(res, 200, job);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      logLine("error", "api request failed", {
        url: req.url,
        error: error.stack || error.message || String(error)
      });
      sendJson(res, 500, { error: error.message || String(error) });
    });
  } else {
    serveStatic(req, res);
  }
});

server.listen(port, "127.0.0.1", () => {
  logLine("info", "web server started", { port, pid: process.pid });
  console.log(`Video Learning Desk running at http://127.0.0.1:${port}`);
});
