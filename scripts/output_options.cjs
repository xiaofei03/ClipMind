const DEFAULT_OUTPUTS = ["markdown", "article_html", "word_docx"];
const VALID_OUTPUTS = new Set(["markdown", "article_html", "markmap", "word_docx", "subtitles"]);
const VALID_ARTICLE_TEMPLATE_MODES = new Set(["cover_markmap_article", "article_only", "print_pdf"]);

function splitList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function normalizeOutputs(input, options = {}) {
  const requested = splitList(input);
  const outputs = new Set(requested.length ? requested : DEFAULT_OUTPUTS);
  if (options.generateMarkmap) outputs.add("markmap");
  const normalized = [...outputs].filter((item) => VALID_OUTPUTS.has(item));
  return normalized.length ? normalized : [...DEFAULT_OUTPUTS];
}

function normalizeArticleTemplateMode(value) {
  const mode = String(value || "cover_markmap_article").trim();
  return VALID_ARTICLE_TEMPLATE_MODES.has(mode) ? mode : "cover_markmap_article";
}

function readOutputOptionsFromEnv(env = process.env) {
  return {
    outputs: normalizeOutputs(env.LEARNING_OUTPUTS || env.OUTPUTS, {
      generateMarkmap: parseBoolean(env.GENERATE_MARKMAP)
    }),
    articleTemplateMode: normalizeArticleTemplateMode(env.ARTICLE_TEMPLATE_MODE || env.LEARNING_ARTICLE_TEMPLATE_MODE)
  };
}

module.exports = {
  DEFAULT_OUTPUTS,
  VALID_OUTPUTS,
  VALID_ARTICLE_TEMPLATE_MODES,
  normalizeOutputs,
  normalizeArticleTemplateMode,
  readOutputOptionsFromEnv
};
