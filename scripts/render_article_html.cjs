const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizeArticleTemplateMode } = require("./output_options.cjs");
const { getArticleThemeCss } = require("./article_theme.cjs");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function inlineImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function stripFrontMatter(markdown) {
  return String(markdown || "").replace(/^---[\s\S]*?---\s*/, "").trim();
}

function stripEvidenceMap(markdown) {
  let text = stripFrontMatter(markdown);
  const marker = "\n---\n\n";
  const first = text.indexOf(marker);
  if (first >= 0) text = text.slice(first + marker.length).trim();
  text = text.replace(/\n---\n\n## 证据文件[\s\S]*$/m, "").trim();
  text = text.replace(/^##\s*关键截图地图[\s\S]*?(?=^##\s+|\n---\n|\s*$)/m, "").trim();
  return text;
}

function cleanPublicText(value) {
  return String(value || "")
    .replace(/证据图号[:：][^。！？\n]*(?:[。！？]|$)/g, "")
    .replace(/(?:截图证据|证据截图|证据帧|证据图|证据)/g, "关键画面")
    .replace(/(?:视频中|视频里|本视频|这个视频|该视频|视频)/g, "内容")
    .replace(/(?:博主|作者|UP主|up主)/g, "")
    .replace(/图\d+验证时需[^。！？\n]*(?:[。！？]|$)/g, "")
    .replace(/因浏览器缓存可能导致旧版\s*JS\s*生效[^。！？\n]*(?:[。！？]|$)/gi, "")
    .replace(/（字幕[:：][^）]*）/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findFigure(evidence, figure) {
  return evidence.find((item) => item.figure === figure);
}

function pickFigures(evidence) {
  const pick = (...figures) => figures.map((figure) => findFigure(evidence, figure)).filter(Boolean);
  return {
    cover: pick("图1", "图2", "图3"),
    tools: evidence.filter((item) => hasCategory(item, "tool")).slice(0, 2),
    step1: evidence.filter((item) => hasAnyCategory(item, ["prompt", "workflow"])).slice(0, 2),
    step2: evidence.filter((item) => hasAnyCategory(item, ["code", "workflow"])).slice(0, 2),
    step3: evidence.filter((item) => hasAnyCategory(item, ["design", "component", "result"])).slice(0, 3),
    prompts: evidence.filter((item) => hasCategory(item, "prompt")).slice(0, 3),
    methods: evidence.filter((item) => hasAnyCategory(item, ["design", "workflow"])).slice(0, 2),
    pitfalls: evidence.filter((item) => hasAnyCategory(item, ["problem", "code"])).slice(0, 2),
    fallback: evidence.slice(0, 2)
  };
}

function hasCategory(item, category) {
  return Array.isArray(item.categories) && item.categories.includes(category);
}

function hasAnyCategory(item, categories) {
  return categories.some((category) => hasCategory(item, category));
}

function sectionBucket(heading) {
  const text = String(heading || "");
  if (/工具链|角色分工|平台|工具/.test(text)) return "tools";
  if (/步骤\s*1|需求|Prompt|提示词/.test(text)) return "step1";
  if (/步骤\s*2|骨架|基础项目|生成|预览/.test(text)) return "step2";
  if (/步骤\s*3|样式|设计|组件|动效|背景|结果/.test(text)) return "step3";
  if (/Prompt|提示词|模板/.test(text)) return "prompts";
  if (/方法论|设计方法|复盘/.test(text)) return "methods";
  if (/避坑|风险|不确定|复核/.test(text)) return "pitfalls";
  return "";
}

function inlineMarkdown(text) {
  return escapeHtml(cleanPublicText(text))
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function figureHtml(item, usedFigures, variant = "compact") {
  if (!item || !item.assetPath || !fs.existsSync(item.assetPath)) return "";
  if (usedFigures.has(item.figure)) return "";
  usedFigures.add(item.figure);
  const src = inlineImage(item.assetPath);
  const title = cleanPublicText(item.title || "关键画面");
  const displayFigure = `图${usedFigures.size}`;
  return [
    `<figure class="figure ${variant}">`,
    `<button class="image-button" type="button" data-full="${src}" aria-label="放大 ${escapeAttr(displayFigure)} ${escapeAttr(item.timeText)}">`,
    `<img src="${src}" alt="${escapeAttr(displayFigure)} ${escapeAttr(item.timeText)} ${escapeAttr(title)}">`,
    "</button>",
    `<figcaption>${escapeHtml(displayFigure)} · ${escapeHtml(item.timeText)}</figcaption>`,
    "</figure>"
  ].join("\n");
}

function figuresHtml(items, usedFigures) {
  const figures = items.map((item) => figureHtml(item, usedFigures)).filter(Boolean);
  if (!figures.length) return "";
  return `<div class="figure-grid">${figures.join("\n")}</div>`;
}

function extractMermaidSummary(codeLines) {
  const labels = [];
  for (const line of codeLines) {
    for (const match of line.matchAll(/\[([^\]]+)]/g)) {
      labels.push(match[1].replace(/<br\s*\/?>/gi, "，").trim());
    }
  }
  const unique = [...new Set(labels)].filter(Boolean).slice(0, 8);
  if (!unique.length) return "";
  return `<div class="flow-summary"><strong>流程概览：</strong>${unique.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`;
}

function markdownToHtml(markdown, evidence) {
  const figures = pickFigures(evidence);
  const usedBuckets = new Set();
  const usedFigures = new Set();
  const lines = stripEvidenceMap(markdown).split(/\r?\n/);
  const out = [];
  let paragraph = [];
  let list = [];
  let table = [];
  let code = null;
  let skippedFirstH1 = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(`<ul>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .filter((line) => !/^\|\s*-+/.test(line))
      .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    if (rows.length) {
      const [head, ...body] = rows;
      out.push('<div class="table-wrap"><table>');
      out.push(`<thead><tr>${head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead>`);
      out.push(`<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`);
      out.push("</table></div>");
    }
    table = [];
  };
  const flushCode = () => {
    if (!code) return;
    if (code.lang === "mermaid") {
      // Flow diagrams are intentionally omitted from the public learning note.
    } else {
      out.push(`<pre class="code"><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
    }
    code = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/证据文件|关键截图地图|结构化证据|逐帧抽取|证据图号/.test(trimmed)) {
      flushAll();
      continue;
    }
    if (code) {
      if (/^```/.test(trimmed)) flushCode();
      else code.lines.push(line);
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushAll();
      code = { lang: trimmed.replace(/^```/, "").trim(), lines: [] };
      continue;
    }
    if (!trimmed) {
      flushAll();
      continue;
    }
    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      flushList();
      table.push(trimmed);
      continue;
    }
    flushTable();
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1].length);
      const text = cleanPublicText(heading[2].replace(/^从零搭建个人作品集网站[:：]\s*/, ""));
      if (level === 1 && !skippedFirstH1) {
        skippedFirstH1 = true;
        continue;
      }
      if (/\u6d41\u7a0b\u56fe|flow|\u5a34\u4f7a\u7a0b\u9358/.test(text)) {
        continue;
      }
      out.push(`<h${level}>${inlineMarkdown(text)}</h${level}>`);
      const bucket = sectionBucket(text);
      if (bucket && !usedBuckets.has(bucket)) {
        usedBuckets.add(bucket);
        out.push(figuresHtml(figures[bucket] || figures.fallback, usedFigures));
      }
      continue;
    }
    const quote = trimmed.match(/^>\s*(.+)$/);
    if (quote) {
      flushAll();
      out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushCode();
  flushAll();
  return out.join("\n");
}

function inlineMindmap(sessionDir) {
  const htmlPath = path.join(sessionDir, "learning_mindmap.html");
  if (!fs.existsSync(htmlPath)) {
    return '<div class="mindmap-empty">未生成思维导图。勾选“生成思维导图”后会显示在这里。</div>';
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  return `<iframe class="mindmap-frame" title="Markmap 思维导图" sandbox="allow-scripts" srcdoc="${escapeAttr(html)}"></iframe>`;
}

function inlineMindmapImage(sessionDir) {
  const imagePath = path.join(sessionDir, "learning_mindmap.png");
  if (!fs.existsSync(imagePath)) {
    return inlineMindmap(sessionDir);
  }
  return `<img class="mindmap-image" src="${inlineImage(imagePath)}" alt="精简思维导图">`;
}

function renderMindmapImage(sessionDir) {
  const htmlPath = path.join(sessionDir, "learning_mindmap.html");
  const imagePath = path.join(sessionDir, "learning_mindmap.png");
  if (!fs.existsSync(htmlPath)) return null;
  if (fs.existsSync(imagePath) && fs.statSync(imagePath).mtimeMs >= fs.statSync(htmlPath).mtimeMs) {
    return imagePath;
  }
  const script = `
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    (async () => {
      const htmlPath = process.argv[1];
      const imagePath = process.argv[2];
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 1.5 });
        await page.goto('file:///' + htmlPath.replace(/\\\\/g, '/'), { waitUntil: 'networkidle', timeout: 30000 });
        await page.addStyleTag({ content: '.mm-toolbar,.markmap-toolbar,.toolbar{display:none!important} body{margin:0!important;background:#fff!important;overflow:hidden!important} svg{max-width:100%!important;max-height:100%!important}' });
        await page.waitForTimeout(1200);
        await page.screenshot({ path: imagePath, fullPage: false });
      } finally {
        await browser.close();
      }
    })().catch((error) => { console.error(error.stack || error.message || String(error)); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ["-e", script, htmlPath, imagePath], {
    cwd: sessionDir,
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && fs.existsSync(imagePath) ? imagePath : null;
}

function extractVideoCover(sessionDir) {
  const context = readJsonIfExists(path.join(sessionDir, "context.json"));
  const videoPath = context?.videoPath;
  if (!videoPath || !fs.existsSync(videoPath)) return null;
  const outPath = path.join(sessionDir, "article_cover.jpg");
  const videoStat = fs.statSync(videoPath);
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= videoStat.mtimeMs) {
    return outPath;
  }
  const result = spawnSync("ffmpeg", [
    "-y",
    "-ss",
    "0.5",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outPath
  ], {
    cwd: sessionDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0 || !fs.existsSync(outPath)) {
    return null;
  }
  return outPath;
}

function downloadRemoteImage(url, outPath) {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) return outPath;
  const script = `
    (async () => {
      const fs = require('fs');
      const url = process.argv[1];
      const outPath = process.argv[2];
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
          'Referer': 'https://www.bilibili.com/'
        }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(outPath, buffer);
    })().catch((error) => { console.error(error.stack || error.message || String(error)); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ["-e", script, url, outPath], {
    cwd: path.dirname(outPath),
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && fs.existsSync(outPath) ? outPath : null;
}

function remoteCoverCandidates(sessionDir) {
  const context = readJsonIfExists(path.join(sessionDir, "context.json")) || {};
  const metadata = readJsonIfExists(path.join(sessionDir, "metadata.json")) || {};
  return [
    context.metadata?.thumbnail,
    context.bilibiliApi?.coverUrl,
    context.douyinApi?.coverUrl,
    metadata.thumbnail,
    metadata.thumbnails?.find((item) => item?.url)?.url
  ].filter(Boolean);
}

function resolveCoverImage(sessionDir, evidence) {
  const remoteUrl = remoteCoverCandidates(sessionDir)[0];
  const remoteExt = /\.png(?:[?#]|$)/i.test(remoteUrl || "") ? ".png" : ".jpg";
  const remoteCover = remoteUrl
    ? downloadRemoteImage(remoteUrl, path.join(sessionDir, `article_thumbnail${remoteExt}`))
    : null;
  if (remoteCover) return inlineImage(remoteCover);
  const extracted = extractVideoCover(sessionDir);
  if (extracted) return inlineImage(extracted);
  const first = evidence.find((item) => item.assetPath && fs.existsSync(item.assetPath));
  return first ? inlineImage(first.assetPath) : "";
}

function displayTitle(title) {
  let text = cleanPublicText(title)
    .replace(/^\u3010[^\u3011]{1,24}\u3011\s*/, "")
    .replace(/^\u300a(.{1,40})\u300b\s*/, "$1 ")
    .replace(/[|\uff5c].*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || "\u5b66\u4e60\u56fe\u6587\u7b14\u8bb0";
}

function titleClass(title) {
  const length = String(title || "").length;
  if (length > 42) return "cover-title extra-long";
  if (length > 28) return "cover-title long";
  if (length > 18) return "cover-title medium";
  return "cover-title";
}

function splitContentPages(articleBody) {
  return '<section class="content-sheet sheet content-source-sheet"><main class="content content-flow">' + articleBody + '</main></section>';
}

function resolveArticleTitle(sessionDir, markdownTitle) {
  const context = readJsonIfExists(path.join(sessionDir, "context.json")) || {};
  const metadata = readJsonIfExists(path.join(sessionDir, "metadata.json")) || {};
  return displayTitle(
    context.metadata?.title ||
    context.metadata?.fulltitle ||
    context.bilibiliApi?.title ||
    context.douyinApi?.title ||
    metadata.title ||
    metadata.fulltitle ||
    markdownTitle
  );
}

function buildArticleHtml({ title, markdown, evidence, sessionDir, templateMode = "cover_markmap_article" }) {
  const mode = normalizeArticleTemplateMode(templateMode);
  const coverTitle = resolveArticleTitle(sessionDir, title);
  const coverImage = resolveCoverImage(sessionDir, evidence);
  const articleBody = markdownToHtml(markdown, evidence);
  const includeCover = mode !== "article_only";
  const includeMindmap = mode === "cover_markmap_article";
  const printClass = mode === "print_pdf" ? " print-pdf" : "";
  const contentPages = splitContentPages(articleBody);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(coverTitle)}</title>
  <style>
    ${getArticleThemeCss()}
  </style>
</head>
<body>
  <article class="page${printClass}" data-template-mode="${escapeAttr(mode)}">
    ${includeCover ? `
    <section class="cover sheet">
      <div>
        <h1 class="${titleClass(coverTitle)}">${escapeHtml(coverTitle)}</h1>
        <p class="dek">\u56f4\u7ed5\u6838\u5fc3\u6982\u5ff5\u3001\u64cd\u4f5c\u6b65\u9aa4\u3001\u5173\u952e\u8bbe\u7f6e\u4e0e\u53ef\u590d\u7528\u6e05\u5355\u6574\u7406\uff0c\u9002\u5408\u590d\u4e60\u3001\u4fee\u6539\u548c\u4e8c\u6b21\u53d1\u5e03\u3002</p>
      </div>
      <div class="cover-media">
        ${coverImage ? `<img src="${coverImage}" alt="封面画面">` : ""}
      </div>
    </section>` : ""}
    ${includeMindmap ? `
    <section class="mindmap-page sheet">
      <h2>精简思维导图</h2>
      ${inlineMindmapImage(sessionDir)}
    </section>` : ""}
    ${contentPages}
  </article>
  <div class="lightbox" id="lightbox" aria-hidden="true">
    <button type="button" id="lightboxClose">关闭</button>
    <img id="lightboxImage" alt="放大截图">
  </div>
  <script>
    function paginateContent() {
      const sourceSheet = document.querySelector(".content-source-sheet");
      const source = document.querySelector(".content-flow");
      if (!source || !sourceSheet) return;
      const parent = sourceSheet.parentNode;
      const nodes = Array.from(source.children);
      sourceSheet.remove();
      let sheet = null;
      let main = null;
      function newSheet() {
        sheet = document.createElement("section");
        sheet.className = "content-sheet sheet";
        main = document.createElement("main");
        main.className = "content";
        sheet.appendChild(main);
        parent.appendChild(sheet);
      }
      newSheet();
      for (const node of nodes) {
        main.appendChild(node);
        const overflow = main.scrollHeight > main.clientHeight + 2;
        if (overflow && main.children.length > 1) {
          main.removeChild(node);
          newSheet();
          main.appendChild(node);
        }
        if (main.scrollHeight > main.clientHeight + 2 && main.children.length === 1) {
          main.classList.add("allow-large-block");
        }
      }
    }
    paginateContent();

    const lightbox = document.getElementById("lightbox");
    const lightboxImage = document.getElementById("lightboxImage");
    const closeButton = document.getElementById("lightboxClose");
    document.querySelectorAll(".image-button").forEach((button) => {
      button.addEventListener("click", () => {
        lightboxImage.src = button.dataset.full;
        lightbox.classList.add("open");
        lightbox.setAttribute("aria-hidden", "false");
      });
    });
    function closeLightbox() {
      lightbox.classList.remove("open");
      lightbox.setAttribute("aria-hidden", "true");
      lightboxImage.removeAttribute("src");
    }
    closeButton.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLightbox();
    });
  </script>
</body>
</html>`;
}

function renderArticleHtml(sessionDir, options = {}) {
  const summaryPath = path.join(sessionDir, "learning_summary.md");
  const evidencePath = path.join(sessionDir, "learning_evidence.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`Missing ${summaryPath}`);
  if (!fs.existsSync(evidencePath)) throw new Error(`Missing ${evidencePath}`);
  const markdown = fs.readFileSync(summaryPath, "utf8");
  const evidenceJson = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const evidence = Array.isArray(evidenceJson.selectedEvidence) ? evidenceJson.selectedEvidence : [];
  const titleMatch = stripEvidenceMap(markdown).match(/^#s+(.+)$/m);
  const title = titleMatch ? cleanPublicText(titleMatch[1].trim()) : "学习图文笔记";
  const templateMode = normalizeArticleTemplateMode(options.templateMode);
  renderMindmapImage(sessionDir);
  const html = buildArticleHtml({ title, markdown, evidence, sessionDir, templateMode });
  const outPath = path.join(sessionDir, "learning_article.html");
  fs.writeFileSync(outPath, html, "utf8");
  return outPath;
}

if (require.main === module) {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error("Usage: node render_article_html.cjs <session-dir> [--template=cover_markmap_article|article_only|print_pdf]");
    process.exit(2);
  }
  const templateArg = process.argv.find((arg) => arg.startsWith("--template="));
  const templateMode = normalizeArticleTemplateMode(
    templateArg ? templateArg.slice("--template=".length) : process.env.ARTICLE_TEMPLATE_MODE
  );
  const outPath = renderArticleHtml(sessionDir, { templateMode });
  console.log(JSON.stringify({ ok: true, outPath, templateMode }, null, 2));
}

module.exports = { renderArticleHtml };
