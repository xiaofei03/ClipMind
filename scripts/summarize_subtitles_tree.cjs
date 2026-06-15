const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const sessionDir = process.argv[2];
if (!sessionDir || !fs.existsSync(sessionDir)) {
  console.error("Usage: node summarize_subtitles_tree.cjs <session-dir>");
  process.exit(2);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(__dirname, "..", ".env"));

const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const model = process.env.QWEN_MODEL || "qwen3-vl-plus";
const baseUrl = (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");

if (!apiKey) {
  console.error("Missing DASHSCOPE_API_KEY or QWEN_API_KEY");
  process.exit(3);
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function stripVtt(text) {
  return String(text || "")
    .replace(/^\uFEFF?WEBVTT.*$/gmi, "")
    .replace(/^\d+$/gm, "")
    .replace(/^\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampText(text, maxLength) {
  const value = String(text || "");
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
}

function collectSubtitleText(context) {
  const chunks = [];
  for (const file of context.subtitles || []) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        chunks.push(stripVtt(fs.readFileSync(file, "utf8")));
      }
    } catch {
      // Ignore unreadable subtitle sidecars.
    }
  }
  if (context.subtitleText) chunks.push(stripVtt(context.subtitleText));
  if (context.transcript?.ok && context.transcript.text) chunks.push(stripVtt(context.transcript.text));
  return chunks
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function callModel(prompt, maxTokens = 5200) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.08,
          max_tokens: maxTokens
        })
      });
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      const data = JSON.parse(body);
      return String(data?.choices?.[0]?.message?.content || "").trim();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  throw lastError;
}

function cleanSummary(text, title) {
  let output = String(text || "").trim()
    .replace(/```(?:markdown)?/gi, "")
    .replace(/```/g, "")
    .replace(/(?:作者|博主|UP主|up主|讲者|主播)(?:认为|指出|提到|表示|说|讲到|分享)/g, "")
    .replace(/(?:这个|本|该)?视频(?:中|里)?(?:提到|讲到|介绍|分享|讨论|认为)?/g, "")
    .replace(/(?:字幕|画面|截图|证据|素材)(?:中|里)?(?:显示|提到|可见)?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!/^#\s+/m.test(output)) {
    output = `# ${title}\n\n${output}`;
  }
  return `${output}\n`;
}

function renderMarkmap(markdownPath, htmlPath) {
  const candidates = [
    process.env.MARKMAP_CLI,
    "D:\\Tools\\node-tools\\markmap-cli\\node_modules\\.bin\\markmap.cmd",
    path.resolve(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "markmap.cmd" : "markmap")
  ].filter(Boolean);
  const localCmd = candidates.find((candidate) => fs.existsSync(candidate));
  const rawCommand = localCmd || "npx";
  const args = localCmd
    ? ["--offline", "--no-open", "--output", htmlPath, markdownPath]
    : ["--yes", "markmap-cli", "--offline", "--no-open", "--output", htmlPath, markdownPath];
  const command = process.platform === "win32" && /\.cmd$/i.test(rawCommand) ? "cmd.exe" : rawCommand;
  const finalArgs = command === "cmd.exe" ? ["/c", rawCommand, ...args] : args;
  const result = spawnSync(command, finalArgs, {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Markmap render failed: ${result.stderr || result.stdout || result.error?.message || result.status}`);
  }
}

function resolvePythonBin() {
  const bundled = path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (bundled && fs.existsSync(bundled)) return bundled;
  return "python";
}

function renderSubtitleDocx(sessionDir) {
  const scriptPath = path.join(__dirname, "render_subtitle_docx.py");
  const result = spawnSync(resolvePythonBin(), [scriptPath, sessionDir], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    const payload = JSON.parse(result.stdout || "{}");
    return payload.outPath || path.join(sessionDir, "subtitle_tree_summary.docx");
  } catch {
    return path.join(sessionDir, "subtitle_tree_summary.docx");
  }
}

(async () => {
  const context = readJson(path.join(sessionDir, "context.json"), {});
  const title = context.metadata?.title || context.metadata?.fulltitle || "字幕逻辑树总结";
  const subtitleText = collectSubtitleText(context);
  if (!subtitleText) throw new Error("No subtitle or transcript text was available for subtitle summary.");

  const subtitlesTextPath = path.join(sessionDir, "learning_subtitles.txt");
  fs.writeFileSync(subtitlesTextPath, `${subtitleText}\n`, "utf8");

  const prompt = [
    "请根据下面的文本轨道生成一份中文“内容逻辑树总结”。",
    "",
    "核心要求：",
    "1. 不要写“作者/博主/视频/字幕/画面/证据/本期内容”等来源呼应词，只呈现内容本身。",
    "2. 不预设内容类型；先理解文本自身的结构，再选择最合适的逻辑树形态。",
    "3. 如果是观点论证，整理核心判断、理由、推论、争议点。",
    "4. 如果是教程流程，整理目标、步骤、关键参数、注意事项、可复用清单。",
    "5. 如果是知识讲解，整理概念、原理、关系、例子、易混点。",
    "6. 如果混合多种形态，按实际内容组织，不要强行套模板。",
    "7. 输出 Markdown，层级清晰，适合继续生成思维导图。",
    "8. 不要编造文本中没有的信息；不确定的内容不要写成结论。",
    "",
    "推荐结构，可按内容自由调整：",
    `# ${title}`,
    "## 核心结论",
    "## 逻辑树",
    "### 一级主题",
    "#### 关键点",
    "## 关键概念 / 关键步骤 / 关键判断",
    "## 可复用收获",
    "",
    "文本轨道：",
    clampText(subtitleText, 50000)
  ].join("\n");

  const summary = cleanSummary(await callModel(prompt), title);
  const summaryPath = path.join(sessionDir, "subtitle_tree_summary.md");
  const subtitlesMarkdownPath = path.join(sessionDir, "learning_subtitles.md");
  fs.writeFileSync(summaryPath, summary, "utf8");
  fs.writeFileSync(
    subtitlesMarkdownPath,
    [`# ${title}`, "", "## 字幕逻辑树总结", "", summary, "", "## 字幕全文", "", subtitleText].join("\n").replace(/\n{4,}/g, "\n\n\n"),
    "utf8"
  );

  let markmapMarkdownPath = null;
  let markmapHtmlPath = null;
  if (process.env.GENERATE_MARKMAP === "1" || /(^|,)markmap(,|$)/.test(process.env.LEARNING_OUTPUTS || "")) {
    markmapMarkdownPath = path.join(sessionDir, "subtitle_tree_markmap.md");
    markmapHtmlPath = path.join(sessionDir, "subtitle_tree_markmap.html");
    fs.writeFileSync(markmapMarkdownPath, summary, "utf8");
    renderMarkmap(markmapMarkdownPath, markmapHtmlPath);
  }
  const wordPath = /(^|,)word_docx(,|$)/.test(process.env.LEARNING_OUTPUTS || "")
    ? renderSubtitleDocx(sessionDir)
    : null;

  process.stdout.write(JSON.stringify({
    summaryPath,
    subtitlesMarkdownPath,
    subtitlesTextPath,
    wordPath,
    markmapMarkdownPath,
    markmapHtmlPath,
    preview: summary.slice(0, 4000)
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
