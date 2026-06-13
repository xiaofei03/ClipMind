const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node probe_media_url.cjs <browser_probe_summary.json|browser_probe/probe.json> [--json]");
  process.exit(2);
}

const jsonOnly = process.argv.includes("--json");
const timeoutMs = Number(process.env.MEDIA_PROBE_TIMEOUT_MS || 12000);
const inputPath = path.resolve(target);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean)));
}

function safeUrl(raw) {
  try {
    return new URL(String(raw));
  } catch {
    return null;
  }
}

function getPageUrl(probe) {
  return probe.pageUrl || probe.url || probe.pageData?.location || "";
}

function getReferer(pageUrl) {
  const parsed = safeUrl(pageUrl);
  if (!parsed) return "";
  if (/bilibili\.com$/i.test(parsed.hostname) || /(^|\.)bilibili\.com$/i.test(parsed.hostname)) {
    return `${parsed.protocol}//${parsed.hostname}/`;
  }
  return pageUrl;
}

function isBlobLike(url) {
  return /^(blob|data|filesystem|mediasource):/i.test(String(url || ""));
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function isLikelyMediaUrl(url, contentType = "") {
  const text = `${url || ""} ${contentType || ""}`;
  return /video|mpegurl|mp4|m4s|m3u8|webm|mov|flv|bilivideo|douyinvod|byteimg|upos-/i.test(text);
}

function platformFromProbe(probe) {
  const text = `${getPageUrl(probe)} ${unique(probe.videoUrls || []).join(" ")}`;
  if (/bilibili\.com|b23\.tv|bilivideo\.com/i.test(text)) return "bilibili";
  if (/douyin\.com|iesdouyin\.com|douyinvod|byteimg/i.test(text)) return "douyin";
  if (/youtube\.com|youtu\.be|googlevideo\.com/i.test(text)) return "youtube";
  return "unknown";
}

function collectCandidates(probe) {
  const urls = [];
  for (const url of probe.videoUrls || []) urls.push({ url, source: "videoUrls" });
  for (const video of probe.pageData?.videos || []) {
    if (video.src) urls.push({ url: video.src, source: "pageData.videos", readyState: video.readyState, duration: video.duration });
  }
  for (const response of probe.responses || []) {
    if (response.url) urls.push({
      url: response.url,
      source: "responses",
      capturedStatus: response.status,
      capturedContentType: response.contentType,
      capturedContentLength: response.contentLength
    });
  }

  const byUrl = new Map();
  for (const item of urls) {
    const key = String(item.url || "").trim();
    if (!key) continue;
    const existing = byUrl.get(key);
    if (existing) {
      existing.sources = unique([...(existing.sources || [existing.source]), item.source]);
      existing.capturedStatus ??= item.capturedStatus;
      existing.capturedContentType ??= item.capturedContentType;
      existing.capturedContentLength ??= item.capturedContentLength;
      continue;
    }
    byUrl.set(key, { ...item, sources: [item.source] });
  }
  return Array.from(byUrl.values());
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

function headersForProbe(pageUrl) {
  const referer = getReferer(pageUrl);
  const originUrl = safeUrl(referer || pageUrl);
  const headers = {
    "User-Agent": process.env.MEDIA_PROBE_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36 Edg/125",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Range": "bytes=0-1023"
  };
  if (referer) headers.Referer = referer;
  if (originUrl) headers.Origin = `${originUrl.protocol}//${originUrl.hostname}`;
  if (process.env.MEDIA_PROBE_COOKIE) headers.Cookie = process.env.MEDIA_PROBE_COOKIE;
  return headers;
}

function classifyHttpStatus(status, candidate, platform) {
  if (status === 200 || status === 206) return "downloadable";
  if (status === 401) return "needs_cookie";
  if (status === 403) {
    if (platform === "bilibili" || /bilivideo\.com|upos-/i.test(candidate.url)) {
      return "real_media_403";
    }
    return "forbidden_403";
  }
  if (status >= 300 && status < 400) return "redirect_needs_followup";
  if (status === 404 || status === 410) return "expired_or_not_found";
  if (status >= 500) return "remote_server_error";
  return "http_unexpected_status";
}

function categoryMessage(category, status) {
  const messages = {
    blob_url: "浏览器本地 blob URL，只能在当前页面进程内播放，yt-dlp/Node 无法直接下载。",
    unsupported_scheme: "不是 http/https 媒体地址，不能直接下载。",
    not_media_url: "URL 不像视频媒体资源，暂不作为下载候选。",
    downloadable: "真实媒体地址可访问，可进入下载或抽帧。",
    needs_cookie: "服务端返回 401，需要登录态 cookie 或授权信息。",
    real_media_403: "真实媒体地址存在，但 CDN 返回 403。B 站常见原因是反盗链、签名上下文失效、需要浏览器 cookie 或必须在页面会话内拉流。",
    forbidden_403: "真实地址返回 403，通常是反盗链、登录权限或请求头不足。",
    redirect_needs_followup: "返回重定向，需要继续跟踪跳转后再判断。",
    expired_or_not_found: "地址已过期或资源不存在。",
    remote_server_error: "远端服务器错误。",
    http_unexpected_status: `HTTP 状态异常：${status}`,
    probe_failed: "请求探测失败，可能是网络、TLS、超时或 URL 已失效。"
  };
  return messages[category] || category;
}

async function probeCandidate(candidate, probe, platform) {
  const url = candidate.url;
  if (isBlobLike(url)) {
    return { ...candidate, category: "blob_url", downloadable: false, message: categoryMessage("blob_url") };
  }
  if (!isHttpUrl(url)) {
    return { ...candidate, category: "unsupported_scheme", downloadable: false, message: categoryMessage("unsupported_scheme") };
  }
  if (!isLikelyMediaUrl(url, candidate.capturedContentType)) {
    return { ...candidate, category: "not_media_url", downloadable: false, message: categoryMessage("not_media_url") };
  }

  const pageUrl = getPageUrl(probe);
  const headers = headersForProbe(pageUrl);
  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers });
    const status = response.status;
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = responseHeaders["content-type"] || "";
    const contentRange = responseHeaders["content-range"] || "";
    const contentLength = responseHeaders["content-length"] || "";
    const category = classifyHttpStatus(status, candidate, platform);
    try {
      await response.arrayBuffer();
    } catch {
      // The status and headers are enough for this diagnostic.
    }
    return {
      ...candidate,
      category,
      downloadable: category === "downloadable",
      status,
      contentType,
      contentRange,
      contentLength,
      usedHeaders: {
        referer: headers.Referer || "",
        origin: headers.Origin || "",
        range: headers.Range
      },
      message: categoryMessage(category, status)
    };
  } catch (error) {
    return {
      ...candidate,
      category: "probe_failed",
      downloadable: false,
      error: error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (error?.message || String(error)),
      message: categoryMessage("probe_failed")
    };
  }
}

function summarize(results) {
  const downloadable = results.filter((item) => item.downloadable);
  const byCategory = results.reduce((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});
  let verdict = "no_downloadable_media";
  if (downloadable.length) verdict = "downloadable";
  else if (byCategory.real_media_403) verdict = "real_media_but_403";
  else if (byCategory.needs_cookie) verdict = "needs_cookie";
  else if (byCategory.blob_url && Object.keys(byCategory).length === 1) verdict = "blob_only";
  else if (byCategory.expired_or_not_found) verdict = "expired_or_not_found";
  else if (byCategory.probe_failed) verdict = "probe_failed";
  return { verdict, downloadableCount: downloadable.length, byCategory };
}

(async () => {
  const probe = readJson(inputPath);
  const platform = platformFromProbe(probe);
  const candidates = collectCandidates(probe);
  const results = [];
  for (const candidate of candidates) {
    results.push(await probeCandidate(candidate, probe, platform));
  }
  const summary = summarize(results);
  const report = {
    ok: summary.verdict === "downloadable",
    checkedAt: new Date().toISOString(),
    inputPath,
    platform,
    pageUrl: getPageUrl(probe),
    pageTitle: probe.pageTitle || probe.pageData?.title || "",
    summary,
    candidates: results
  };
  const reportPath = path.join(path.dirname(inputPath), "media_url_probe.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify({
      ok: report.ok,
      verdict: summary.verdict,
      platform,
      reportPath,
      byCategory: summary.byCategory,
      firstDownloadable: results.find((item) => item.downloadable)?.url || ""
    }, null, 2));
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
