const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

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

function stripMarkdownNoise(markdown) {
  return String(markdown || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\|.*\|/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstHeading(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "视频学习精简思维导图";
}

async function callQwen(content, maxTokens = 2200) {
  const projectDir = path.resolve(__dirname, "..");
  loadDotEnv(path.join(projectDir, ".env"));
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  if (!apiKey) throw new Error("Missing DASHSCOPE_API_KEY or QWEN_API_KEY");
  const model = process.env.QWEN_MODEL || "qwen3-vl-plus";
  const baseUrl = (process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0.08,
      max_tokens: maxTokens
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(body);
  const data = JSON.parse(body);
  return data?.choices?.[0]?.message?.content || "";
}

function cleanMindmapMarkdown(markdown, title) {
  let text = String(markdown || "").trim();
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  text = text
    .replace(/\r/g, "")
    .replace(/^---[\s\S]*?---\n?/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!/^#\s+/.test(text)) {
    text = `# ${title}\n\n${text}`;
  }
  return cleanPublicMindmap(text);
}

function cleanPublicMindmap(markdown) {
  return String(markdown || "")
    .replace(/截图证据|证据截图|实操证据|证据帧|证据图|证据/g, "关键画面")
    .replace(/本视频|这个视频|该视频|视频中|视频里|视频/g, "课程")
    .replace(/博主|作者|UP主|up主/g, "讲解者")
    .replace(/^#+\s*截图证据.*$/gm, "## 关键画面")
    .replace(/^#+\s*待复核.*$/gm, "## 注意事项")
    .replace(/待复核/g, "注意事项")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackMindmap(summary, evidence) {
  const title = firstHeading(summary);
  const tools = new Set();
  for (const item of evidence) {
    for (const tool of item.toolNames || []) tools.add(tool);
  }
  const promptFrames = evidence.filter((item) => (item.categories || []).includes("prompt")).slice(0, 4);
  const workflowFrames = evidence.filter((item) => (item.categories || []).includes("workflow")).slice(0, 5);
  const resultFrames = evidence.filter((item) => (item.categories || []).includes("result")).slice(0, 4);
  const lines = [
    `# ${title}`,
    "## 核心结论",
    "- 围绕视频真实主题提炼可执行步骤",
    "- 关键不是套用模板，而是依据字幕、页面文字和关键画面复盘",
    "## 工具链",
    ...[...tools].slice(0, 8).map((tool) => `- ${tool}`),
    "## 操作流程",
    "- 明确视频目标和输入材料",
    "- 识别作者使用的工具或平台",
    "- 提取关键操作、Prompt 或配置",
    "- 记录输出结果和验证方式",
    "- 标注风险、限制和待复核信息",
    "## 关键 Prompt",
    ...promptFrames.map((item) => `- ${item.timeText} ${item.title}`),
    "## 关键画面",
    ...workflowFrames.map((item) => `- ${item.timeText} ${item.title}`),
    "## 成品效果",
    ...resultFrames.map((item) => `- ${item.timeText} ${item.title}`),
    "## 避坑",
    "- 不要只写“高级网站”",
    "- 不要把站点 logo 误认为工具",
    "- 看不清的画面文字必须人工复核"
  ];
  return lines.join("\n");
}

async function generateMindmapMarkdown(sessionDir) {
  const summaryPath = path.join(sessionDir, "learning_summary.md");
  const evidencePath = path.join(sessionDir, "learning_evidence.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`Missing ${summaryPath}`);
  if (!fs.existsSync(evidencePath)) throw new Error(`Missing ${evidencePath}`);
  const summary = fs.readFileSync(summaryPath, "utf8");
  const evidenceJson = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const evidence = Array.isArray(evidenceJson.selectedEvidence) ? evidenceJson.selectedEvidence : [];
  const title = firstHeading(summary).replace(/^视频学习图文笔记$/, "视频学习精简思维导图");
  const evidenceBrief = evidence.map((item) => ({
    figure: item.figure,
    time: item.timeText,
    title: item.title,
    categories: item.categories,
    tools: item.toolNames,
    prompt: item.promptText,
    why: item.whyImportant
  }));
  const prompt = [
    "请把下面的学习笔记压缩成 markmap 可用的精简 Markdown 思维导图。",
    "要求：",
    "1. 只输出 Markdown，不要解释。",
    "2. 第一行必须是一级标题。",
    "3. 层级控制在 3 到 4 层，不要写长段落。",
    "4. 每个节点尽量短，适合在思维导图中阅读。",
    "5. 必须包含：核心结论、工具链或平台、操作流程、关键 Prompt/命令/设置、关键画面、避坑、注意事项。",
    "6. 不要放图片，不要放表格。",
    "",
    "关键画面摘要：",
    JSON.stringify(evidenceBrief, null, 2),
    "",
    "完整笔记摘要：",
    stripMarkdownNoise(summary).slice(0, 20000)
  ].join("\n");
  try {
    const modelOutput = await callQwen([{ type: "text", text: prompt }], 2600);
    return cleanMindmapMarkdown(modelOutput, title);
  } catch (error) {
    return fallbackMindmap(summary, evidence);
  }
}

function findMarkmapCommand() {
  const candidates = [
    process.env.MARKMAP_CLI,
    "D:\\Tools\\node-tools\\markmap-cli\\node_modules\\.bin\\markmap.cmd",
    path.resolve(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "markmap.cmd" : "markmap")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: candidate, argsPrefix: [] };
  }
  return { command: "npx", argsPrefix: ["--yes", "markmap-cli"] };
}

function renderMarkmapHtml(markdownPath, htmlPath) {
  const markmap = findMarkmapCommand();
  const args = [
    ...markmap.argsPrefix,
    "--offline",
    "--no-open",
    "--output",
    htmlPath,
    markdownPath
  ];
  const command = process.platform === "win32" && /\.cmd$/i.test(markmap.command)
    ? "cmd.exe"
    : markmap.command;
  const commandArgs = process.platform === "win32" && /\.cmd$/i.test(markmap.command)
    ? ["/d", "/c", markmap.command, ...args]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: path.dirname(markdownPath),
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`markmap failed: ${result.stderr || result.stdout}`);
  }
}

async function renderLearningMarkmap(sessionDir) {
  const markdown = cleanPublicMindmap(await generateMindmapMarkdown(sessionDir));
  const markdownPath = path.join(sessionDir, "learning_mindmap.md");
  const htmlPath = path.join(sessionDir, "learning_mindmap.html");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  renderMarkmapHtml(markdownPath, htmlPath);
  return { markdownPath, htmlPath };
}

if (require.main === module) {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error("Usage: node render_markmap.cjs <session-dir>");
    process.exit(2);
  }
  renderLearningMarkmap(sessionDir)
    .then((result) => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
    .catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exit(1);
    });
}

module.exports = { renderLearningMarkmap };
