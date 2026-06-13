const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node verify_article_output.cjs <session-dir-or-learning_article.html>");
  process.exit(2);
}

const resolved = path.resolve(target);
const sessionDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
  ? resolved
  : path.dirname(resolved);
const articlePath = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
  ? resolved
  : path.join(sessionDir, "learning_article.html");
const markmapPath = path.join(sessionDir, "learning_mindmap.html");

function hasMojibake(text) {
  return /锟|鐠|閹|鐟|闁|缁|閺|閸|鐎|閻|泑||�/.test(String(text || ""));
}

function check(name, ok, detail = "") {
  return { name, ok: Boolean(ok), detail };
}

const checks = [];
const articleExists = fs.existsSync(articlePath);
const markmapExists = fs.existsSync(markmapPath);
checks.push(check("article:exists", articleExists, articlePath));
checks.push(check("markmap:exists", markmapExists, markmapPath));

let html = "";
if (articleExists) {
  html = fs.readFileSync(articlePath, "utf8");
  checks.push(check("article:no_mojibake", !hasMojibake(html), "scan article HTML"));
  checks.push(check("article:has_cover", /class="[^"]*\bcover\b[^"]*"/.test(html), "cover section"));
  checks.push(check("article:has_content", /class="[^"]*\bcontent\b[^"]*"/.test(html), "content section"));
  checks.push(check("article:has_lightbox", /id="lightbox"/.test(html), "image lightbox"));
  checks.push(check("article:has_figures", /class="figure/.test(html), "at least one figure"));
  checks.push(check("article:template_mode", /data-template-mode="cover_markmap_article"/.test(html), "cover + markmap + article"));
  checks.push(check("article:has_a4_sheets", /class="cover sheet"/.test(html) && /class="mindmap-page sheet"/.test(html), "A4 sheet layout"));
  checks.push(check("article:no_internal_evidence_wording", !/证据图号|截图证据|证据文件|结构化证据|逐帧抽取|博主|作者|UP主|up主|本视频|这个视频|该视频|视频中|视频里/.test(html), "clean public article wording"));
  checks.push(check("article:has_dynamic_pagination", /paginateContent\(\)/.test(html), "content is split into A4 sheets in the browser"));
  checks.push(check("article:no_generic_cover_title", !/\u6559\u6750\u5f0f\u5b66\u4e60\u8bb2\u4e49|\u5b66\u4e60\u56fe\u6587\u7b14\u8bb0/.test(html), "cover should use the video title"));
  checks.push(check("article:no_flowchart_section", !/\u64cd\u4f5c\u6d41\u7a0b\u56fe|flowchart/.test(html), "flowchart section should be omitted"));
  checks.push(check("article:has_static_cover", /article_cover\.jpg|封面画面|cover-media/.test(html), "cover image area"));

  if (markmapExists) {
    checks.push(check("article:has_mindmap_image", /class="mindmap-image"/.test(html) || /class="mindmap-frame"/.test(html), ".mindmap-image fallback"));
    checks.push(check("article:prefers_static_mindmap", !/class="mindmap-frame"/.test(html), "static mindmap image"));
    checks.push(check("article:no_mindmap_empty", !/<div class="mindmap-empty"/.test(html), "should not show empty state when markmap exists"));
  }
}

const ok = checks.every((item) => item.ok);
const report = {
  ok,
  checkedAt: new Date().toISOString(),
  sessionDir,
  articlePath,
  markmapPath,
  checks
};
const reportPath = path.join(sessionDir, "article_output_check.json");
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({
  ok,
  reportPath,
  failed: checks.filter((item) => !item.ok)
}, null, 2));
process.exit(ok ? 0 : 1);
