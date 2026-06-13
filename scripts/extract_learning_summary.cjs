const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { renderArticleHtml } = require("./render_article_html.cjs");
const { renderLearningMarkmap } = require("./render_markmap.cjs");
const { readOutputOptionsFromEnv } = require("./output_options.cjs");

const sessionDir = process.argv[2];
const frameDir = process.argv[3] || path.join(sessionDir || "", "frames");
if (!sessionDir || !fs.existsSync(frameDir)) {
  console.error("Usage: node extract_learning_summary.cjs <session-dir> [frame-dir] [--outputs=markdown,article_html,markmap,word_docx] [--article-template=cover_markmap_article|article_only|print_pdf]");
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

function readCliOption(name) {
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

const cliOutputs = readCliOption("--outputs");
const cliArticleTemplate = readCliOption("--article-template");
if (cliOutputs) process.env.LEARNING_OUTPUTS = cliOutputs;
if (cliArticleTemplate) process.env.ARTICLE_TEMPLATE_MODE = cliArticleTemplate;

const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
const model = process.env.QWEN_MODEL || "qwen3-vl-plus";
const baseUrl = (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const batchSize = Number(process.env.LEARNING_BATCH_SIZE || 10);
const maxEvidenceFrames = Number(process.env.LEARNING_MAX_EVIDENCE_FRAMES || 18);
const outputOptions = readOutputOptionsFromEnv();
const requestedOutputs = new Set(outputOptions.outputs);

if (!apiKey) {
  console.error("Missing DASHSCOPE_API_KEY or QWEN_API_KEY");
  process.exit(3);
}

const contextPath = path.join(sessionDir, "context.json");
const context = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, "utf8")) : {};
const manifestPath = path.join(sessionDir, "frames_manifest.json");
const frameManifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
const manifestByName = new Map(
  Array.isArray(frameManifest)
    ? frameManifest.map((item) => [path.basename(item.file || item.name || ""), item])
    : []
);

const frames = fs.readdirSync(frameDir)
  .filter((name) => /\.(jpg|jpeg|png)$/i.test(name))
  .sort()
  .map((name, index) => {
    const manifestItem = manifestByName.get(name);
    return {
      id: `F${String(index + 1).padStart(3, "0")}`,
      file: path.join(frameDir, name),
      name,
      time: Number.isFinite(Number(manifestItem?.time))
        ? Number(manifestItem.time)
        : index * Number(context.frameIntervalSeconds || 5),
      source: manifestItem?.source || "frames",
      reasons: Array.isArray(manifestItem?.reasons) ? manifestItem.reasons.slice(0, 4) : []
    };
  });

function dataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function resolvePythonBin() {
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (fs.existsSync(bundled)) return bundled;
  return "python";
}

function renderArticleDocx(sessionDir) {
  const scriptPath = path.join(__dirname, "render_article_docx.py");
  const result = spawnSync(resolvePythonBin(), [scriptPath, sessionDir], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`Word export failed: ${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout || "{}");
  return payload.outPath || path.join(sessionDir, "learning_article.docx");
}

function fmtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const min = Math.floor(value / 60);
  const sec = Math.floor(value % 60);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function clampText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text;
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b\d+(?:\.\d+)?\s*复制打开\S*/g, "")
    .replace(/[A-Za-z]@[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[|｜]\s*抖音.*$/i, "")
    .replace(/^[\s:：,，。;；-]+|[\s:：,，。;；-]+$/g, "")
    .trim();
}

function buildNoteTitle() {
  const candidates = [
    context.metadata?.title,
    context.metadata?.fulltitle,
    context.metadata?.description,
    context.url
  ];
  for (const candidate of candidates) {
    const clean = cleanTitle(candidate);
    if (clean && !/^https?:\/\//i.test(clean)) {
      return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean;
    }
  }
  return "视频学习图文笔记";
}

async function callQwen(content, maxTokens = 2400, temperature = 0.08) {
  const payload = {
    model,
    messages: [{ role: "user", content }],
    temperature,
    max_tokens: maxTokens
  };
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });
      const body = await response.text();
      if (!response.ok) throw new Error(body);
      const data = JSON.parse(body);
      const result = data?.choices?.[0]?.message?.content;
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw lastError;
}

function parseJsonBlock(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Qwen did not return valid JSON: ${candidate.slice(0, 600)}`);
  }
}

async function repairJsonOutput(raw, batch) {
  const ids = batch.map((frame) => frame.id).join(", ");
  const prompt = [
    "下面是一段模型输出，目标格式应该是 JSON，但可能存在未转义引号、尾逗号或 Markdown 包裹问题。",
    "请只修复为合法 JSON，不要增删事实，不要输出 Markdown，不要解释。",
    `本批允许的 frameId：${ids}`,
    '目标格式必须是：{"frames":[{"frameId":"F001","keep":true,"score":80,"categories":["prompt"],"title":"","whyImportant":"","visibleText":"","promptText":"","toolNames":[],"actions":[],"confidence":"high|medium|low","missingOrUnclear":""}]}',
    "",
    raw
  ].join("\n");
  return callQwen([{ type: "text", text: prompt }], 3200, 0);
}

function normalizeEvidence(item, frame) {
  const score = Math.max(0, Math.min(100, Number(item.score || 0)));
  const categories = Array.isArray(item.categories) ? item.categories.map(String).map((text) => text.trim()).filter(Boolean) : [];
  const normalized = {
    frameId: frame.id,
    file: frame.file,
    name: frame.name,
    time: frame.time,
    timeText: fmtTime(frame.time),
    score,
    keep: Boolean(item.keep) || score >= 70,
    categories,
    title: String(item.title || "").trim(),
    whyImportant: String(item.whyImportant || "").trim(),
    visibleText: String(item.visibleText || "").trim(),
    promptText: String(item.promptText || "").trim(),
    toolNames: Array.isArray(item.toolNames) ? item.toolNames.map(String) : [],
    actions: Array.isArray(item.actions) ? item.actions.map(String) : [],
    confidence: String(item.confidence || "").trim() || "medium",
    missingOrUnclear: String(item.missingOrUnclear || "").trim()
  };
  return sanitizeEvidenceItem(normalized);
}

function sanitizeEvidenceItem(item) {
  const normalizeText = (value) => String(value || "")
    .replace(/\bCodeX\b/g, "Codex")
    .replace(/AI编程平台\/工具名[：:]\s*xiaoY/gi, "站点 logo/品牌名：xiaoY")
    .replace(/xiaoY（前端生成工具）/gi, "xiaoY（站点 logo/品牌名）");
  const cleanTools = item.toolNames
    .map((name) => String(name || "").replace(/^CodeX$/i, "Codex").trim())
    .filter((name) => name && !/^xiaoY$/i.test(name))
    .filter((name, index, arr) => arr.indexOf(name) === index);
  return {
    ...item,
    title: normalizeText(item.title),
    whyImportant: normalizeText(item.whyImportant),
    visibleText: normalizeText(item.visibleText),
    promptText: normalizeText(item.promptText),
    toolNames: cleanTools
  };
}

function chooseEvidenceFrames(allEvidence) {
  const kept = allEvidence
    .filter((item) => item.keep && item.score >= 55)
    .sort((a, b) => b.score - a.score);
  const requiredCategories = ["prompt", "tool", "workflow", "code", "design", "component", "problem", "result"];
  const selected = [];
  const addIfUseful = (item, minGapSeconds = 4) => {
    if (!item || selected.some((chosen) => chosen.name === item.name)) return;
    const sameMoment = selected.some((chosen) => Math.abs(chosen.time - item.time) < minGapSeconds);
    if (!sameMoment || selected.length < 6) selected.push(item);
  };

  for (const category of requiredCategories) {
    addIfUseful(kept.find((item) => item.categories.includes(category)), 3);
  }
  for (const item of kept) {
    if (selected.length >= maxEvidenceFrames) break;
    addIfUseful(item, 5);
  }
  return selected
    .sort((a, b) => a.time - b.time)
    .map((item, index) => ({ ...item, figure: `图${index + 1}` }));
}

function copyEvidenceAssets(evidence) {
  const assetDir = path.join(sessionDir, "note_assets");
  fs.mkdirSync(assetDir, { recursive: true });
  return evidence.map((item, index) => {
    const ext = path.extname(item.file).toLowerCase() || ".jpg";
    const assetName = `evidence_${String(index + 1).padStart(2, "0")}_${item.timeText.replace(":", "-")}${ext}`;
    const dest = path.join(assetDir, assetName);
    fs.copyFileSync(item.file, dest);
    const relPath = `note_assets/${assetName}`.replace(/\\/g, "/");
    return {
      ...item,
      assetPath: dest,
      markdownPath: relPath,
      imageMarkdown: `![${item.figure} ${item.timeText} ${item.title || "关键画面"}](${relPath})`
    };
  });
}

function evidenceMapMarkdown(evidence) {
  const lines = [
    "## 关键截图地图",
    "",
    "| 图 | 时间 | 为什么保留 | 截图 |",
    "|---|---:|---|---|"
  ];
  for (const item of evidence) {
    const reason = item.whyImportant || item.title || "关键证据帧";
    lines.push(`| ${item.figure} | ${item.timeText} | ${escapeTable(reason)} | ${item.imageMarkdown} |`);
  }
  return lines.join("\n");
}

function postProcessMarkdown(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/证据图号[:：][^。！？\n]*(?:[。！？]|$)/g, "")
    .replace(/图\d+验证时需[^。！？\n]*(?:[。！？]|$)/g, "")
    .replace(/因浏览器缓存可能导致旧版\s*JS\s*生效[^。！？\n]*(?:[。！？]|$)/gi, "")
    .replace(/（字幕[:：][^）]*）/g, "")
    .replace(/\n{4,}/g, "\n\n\n");
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function buildExtractionMarkdown(evidence) {
  const lines = [
    "# 逐帧结构化证据",
    "",
    "本文件是模型对候选帧的结构化识别结果。`score` 越高，越适合作为学习笔记证据图。",
    ""
  ];
  for (const item of evidence) {
    lines.push(`## ${item.frameId} ${item.timeText} ${item.title || item.name}`);
    lines.push(`- score: ${item.score}`);
    lines.push(`- categories: ${item.categories.join(", ") || "unknown"}`);
    lines.push(`- why: ${item.whyImportant || "未说明"}`);
    if (item.toolNames.length) lines.push(`- tools: ${item.toolNames.join(", ")}`);
    if (item.actions.length) lines.push(`- actions: ${item.actions.join("；")}`);
    if (item.promptText) lines.push(`- prompt: ${item.promptText}`);
    if (item.visibleText) lines.push(`- visible text: ${item.visibleText}`);
    if (item.missingOrUnclear) lines.push(`- unclear: ${item.missingOrUnclear}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function scoreFrameBatches() {
  const batches = [];
  for (let i = 0; i < frames.length; i += batchSize) batches.push(frames.slice(i, i + batchSize));

  const allEvidence = [];
  const batchTexts = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchFile = path.join(sessionDir, `learning_extract_batch_${String(batchIndex + 1).padStart(2, "0")}.md`);
    let output = "";
    let parsed = null;
    if (fs.existsSync(batchFile)) {
      const cached = fs.readFileSync(batchFile, "utf8");
      try {
        const cachedJson = parseJsonBlock(cached);
        const ids = new Set(batch.map((frame) => frame.id));
        const cachedItems = Array.isArray(cachedJson.frames) ? cachedJson.frames : [];
        if (cachedItems.some((item) => ids.has(item.frameId))) {
          output = cached;
          parsed = cachedJson;
        }
      } catch {
        try {
          output = await repairJsonOutput(cached, batch);
          parsed = parseJsonBlock(output);
          fs.writeFileSync(batchFile, output, "utf8");
        } catch {
          // Old non-JSON batch files are ignored and regenerated.
        }
      }
    }
    const content = [{
      type: "text",
      text: [
        "你是视频学习笔记的证据筛选器。下面是一组按时间排序的视频截图。",
        "你的任务不是写总结，而是判断每张图是否值得进入最终学习笔记。",
        "请特别关注：AI 编程平台名称或界面、完整/半完整 Prompt、代码、命令、配置、文件名、网页 UI、组件库、作者的实操步骤、错误与修正、最终作品效果。",
        "如果看不清，必须写“看不清”或“不完整”，不要猜。",
        "只返回 JSON，不要返回 Markdown。格式：",
        '{"frames":[{"frameId":"F001","keep":true,"score":0-100,"categories":["prompt|tool|workflow|code|design|component|problem|result"],"title":"短标题","whyImportant":"为什么值得放入笔记","visibleText":"画面可见文字/OCR","promptText":"可复原的 Prompt，若无则空字符串","toolNames":["工具名"],"actions":["作者动作"],"confidence":"high|medium|low","missingOrUnclear":"不清楚之处"}]}',
        "",
        `本批时间范围：${fmtTime(batch[0].time)} - ${fmtTime(batch[batch.length - 1].time)}`
      ].join("\n")
    }];
    for (const frame of batch) {
      content.push({
        type: "text",
        text: `${frame.id} | ${frame.name} | 估计时间 ${fmtTime(frame.time)} | 抽帧原因：${frame.reasons.join("；")}`
      });
      content.push({ type: "image_url", image_url: { url: dataUrl(frame.file) } });
    }
    if (!parsed) {
      output = await callQwen(content, 3200, 0.05);
      try {
        parsed = parseJsonBlock(output);
      } catch {
        output = await repairJsonOutput(output, batch);
        parsed = parseJsonBlock(output);
      }
      fs.writeFileSync(batchFile, output, "utf8");
    }
    batchTexts.push(`# ${path.basename(batchFile)}\n\n${output}`);
    const items = Array.isArray(parsed.frames) ? parsed.frames : [];
    for (const item of items) {
      const frame = batch.find((candidate) => candidate.id === item.frameId);
      if (frame) allEvidence.push(normalizeEvidence(item, frame));
    }
  }
  return { batches, allEvidence, batchTexts };
}

function buildSourceText() {
  return [
    "页面标题：",
    clampText(context.metadata?.title || "", 1000),
    "",
    "页面/字幕/章节文字：",
    clampText(context.subtitleText || context.metadata?.description || "", 18000),
    "",
    "语音转写：",
    clampText(context.transcript?.text || "", 18000)
  ].join("\n");
}

function buildFinalPrompt(selectedEvidence) {
  const evidenceForPrompt = selectedEvidence.map((item) => ({
    figure: item.figure,
    time: item.timeText,
    imageMarkdown: item.imageMarkdown,
    title: item.title,
    categories: item.categories,
    score: item.score,
    whyImportant: item.whyImportant,
    visibleText: item.visibleText,
    promptText: item.promptText,
    toolNames: item.toolNames,
    actions: item.actions,
    confidence: item.confidence,
    missingOrUnclear: item.missingOrUnclear
  }));

  return [
    "????????????????????????????????",
    "????????????????????????????????????????????",
    "????????????????????????????????????",
    "???????????????????????????Prompt????????????",
    "??????????????????????????????????",
    "?????????????????????????????????????????????",
    "???????????????????????????/??/UP?/??/???/????/??/??/??/??/????/???????????",
    "????????????1????2???????????????????????????????",
    "????? Markdown????? <br>??????????????????????",
    "",
    "???????????????",
    "1. ????",
    "2. ????",
    "3. ???? / ???? / ????",
    "4. ?????????",
    "5. ?????",
    "6. ?????????",
    "7. ????",
    "",
    "???? JSON ??????????????????",
    JSON.stringify(evidenceForPrompt, null, 2),
    "",
    buildSourceText()
  ].join("\n");
}

(async () => {
  const { batches, allEvidence, batchTexts } = await scoreFrameBatches();
  const selectedEvidence = copyEvidenceAssets(chooseEvidenceFrames(allEvidence));

  fs.writeFileSync(path.join(sessionDir, "learning_extraction.md"), buildExtractionMarkdown(allEvidence), "utf8");
  fs.writeFileSync(path.join(sessionDir, "learning_raw_batches.md"), batchTexts.join("\n\n---\n\n"), "utf8");
  fs.writeFileSync(path.join(sessionDir, "learning_evidence.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    model,
    frameCount: frames.length,
    evidenceCount: allEvidence.length,
    selectedCount: selectedEvidence.length,
    selectedEvidence,
    allEvidence
  }, null, 2), "utf8");

  const modelSummary = postProcessMarkdown(await callQwen([{ type: "text", text: buildFinalPrompt(selectedEvidence) }], 7000, 0.1));
  const outPath = path.join(sessionDir, "learning_summary.md");
  const noteTitle = buildNoteTitle();
  const finalMarkdown = [
    `# ${noteTitle}`,
    "",
    modelSummary.trim(),
  ].join("\n");
  fs.writeFileSync(outPath, finalMarkdown, "utf8");

  const markmap = requestedOutputs.has("markmap") ? await renderLearningMarkmap(sessionDir) : null;
  const articlePath = requestedOutputs.has("article_html")
    ? renderArticleHtml(sessionDir, { templateMode: outputOptions.articleTemplateMode })
    : null;
  const wordPath = requestedOutputs.has("word_docx") ? renderArticleDocx(sessionDir) : null;

  console.log(JSON.stringify({
    ok: true,
    outPath,
    articlePath,
    wordPath,
    markmapMarkdownPath: markmap?.markdownPath || null,
    markmapHtmlPath: markmap?.htmlPath || null,
    outputs: outputOptions.outputs,
    articleTemplateMode: outputOptions.articleTemplateMode,
    selectedCount: selectedEvidence.length,
    batchCount: batches.length
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
