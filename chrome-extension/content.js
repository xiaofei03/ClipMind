const SIDEBAR_HOST_ID = "yingji-sidebar-host";
const ACTIVE_CLASS = "yingji-active";
const MINIMIZED_CLASS = "yingji-minimized";
const STORAGE_KEY_LAST_OPEN = "yingji.sidebar.autoOpen";
const STORAGE_KEY_FAB_POSITION = "yingji.sidebar.fabPosition";
const STORAGE_KEY_PANEL_POSITION = "yingji.sidebar.panelPosition";
const STAGE_ORDER = [
  "queued",
  "fetching_transcript",
  "classifying_note",
  "structuring_note",
  "writing_obsidian",
  "done",
];

let currentSnapshot = null;
let sidebarHost = null;
let fabDragState = null;
let panelDragState = null;
const DRAG_THRESHOLD_PX = 8;

function isExtensionContextInvalid(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("Extension context invalidated");
}

function hasRuntimeContext() {
  return Boolean(globalThis.chrome?.runtime?.id);
}

async function safeSendRuntimeMessage(payload) {
  if (!hasRuntimeContext()) {
    return { ok: false, error: "插件已更新，请刷新当前页面后重试。" };
  }
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch (error) {
    if (isExtensionContextInvalid(error)) {
      return { ok: false, error: "插件已更新，请刷新当前页面后重试。" };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function safeStorageSet(data) {
  if (!hasRuntimeContext()) return;
  try {
    chrome.storage.local.set(data, () => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError && !isExtensionContextInvalid(runtimeError.message)) {
        console.warn("[影记] storage.set failed:", runtimeError.message);
      }
    });
  } catch (error) {
    if (!isExtensionContextInvalid(error)) {
      console.warn("[影记] storage.set failed:", error);
    }
  }
}

function safeStorageGet(keys, callback) {
  if (!hasRuntimeContext()) {
    callback({});
    return;
  }
  try {
    chrome.storage.local.get(keys, (result) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        if (!isExtensionContextInvalid(runtimeError.message)) {
          console.warn("[影记] storage.get failed:", runtimeError.message);
        }
        callback({});
        return;
      }
      callback(result || {});
    });
  } catch (error) {
    if (!isExtensionContextInvalid(error)) {
      console.warn("[影记] storage.get failed:", error);
    }
    callback({});
  }
}

function decodeRuns(runs) {
  if (!Array.isArray(runs)) return "";
  return runs.map((item) => item?.text || "").join("").trim();
}

function extractJsonAfter(text, marker) {
  const index = text.indexOf(marker);
  if (index < 0) return null;
  const start = text.indexOf("{", index + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function fetchPageHtml() {
  const response = await fetch(window.location.href, { credentials: "include" });
  return response.text();
}

function parsePlayerResponseFromHtml(html) {
  const jsonText =
    extractJsonAfter(html, "var ytInitialPlayerResponse = ") ||
    extractJsonAfter(html, "ytInitialPlayerResponse = ") ||
    extractJsonAfter(html, "window[\"ytInitialPlayerResponse\"] = ");
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function pickCaptionTrack(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const preferred = ["zh-Hans", "zh-Hant", "zh", "en"];
  for (const lang of preferred) {
    const found = tracks.find((track) => track?.languageCode === lang);
    if (found) return found;
  }
  return tracks[0] || null;
}

function parseXmlTranscript(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "text/xml");
  const nodes = [...xml.getElementsByTagName("text")];
  const entries = nodes
    .map((node) => {
      const start = Number(node.getAttribute("start") || 0);
      const duration = Number(node.getAttribute("dur") || 0);
      const text = (node.textContent || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return null;
      return {
        start,
        end: start + duration,
        text,
      };
    })
    .filter(Boolean);
  const transcriptText = entries.map((entry) => entry.text).join("\n").trim();
  return transcriptText ? { transcriptText, entries } : null;
}

async function fetchTranscriptFromTrack(track) {
  if (!track?.baseUrl) return null;
  const jsonUrl = track.baseUrl.includes("fmt=") ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
  try {
    const jsonResponse = await fetch(jsonUrl, { credentials: "include" });
    const data = await jsonResponse.json();
    const entries = [];
    for (const event of data?.events || []) {
      const text = decodeRuns(event?.segs);
      if (!text) continue;
      const start = Number(event?.tStartMs || 0) / 1000;
      const duration = Number(event?.dDurationMs || 0) / 1000;
      entries.push({
        start,
        end: start + duration,
        text,
      });
    }
    const transcriptText = entries.map((entry) => entry.text).join("\n").trim();
    if (transcriptText) {
      return {
        transcript_text: transcriptText,
        transcript_entries: entries,
        transcript_source: "youtube_page_caption_track",
      };
    }
  } catch {}

  try {
    const xmlResponse = await fetch(track.baseUrl, { credentials: "include" });
    const xmlText = await xmlResponse.text();
    const parsed = parseXmlTranscript(xmlText);
    if (parsed) {
      return {
        transcript_text: parsed.transcriptText,
        transcript_entries: parsed.entries,
        transcript_source: "youtube_page_caption_track",
      };
    }
  } catch {}

  return null;
}

function collectVisibleCaptionText() {
  const lines = [
    ...document.querySelectorAll(".html5-video-player .captions-text .ytp-caption-segment"),
    ...document.querySelectorAll(".html5-video-player .captions-text .caption-visual-line span"),
  ]
    .map((element) => element.textContent?.trim() || "")
    .filter(Boolean);
  if (!lines.length) return null;
  const unique = [...new Set(lines)];
  const transcriptText = unique.join("\n").trim();
  if (!transcriptText || transcriptText.length < 24) return null;
  return {
    transcript_text: transcriptText,
    transcript_entries: [],
    transcript_source: "youtube_player_caption_overlay",
  };
}

function collectMeta() {
  const title =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
    document.querySelector("h1.title yt-formatted-string")?.textContent?.trim() ||
    document.title.replace(/\s*-\s*YouTube$/, "").trim();
  const channel =
    document.querySelector("ytd-channel-name a")?.textContent?.trim() ||
    document.querySelector("#channel-name a")?.textContent?.trim() ||
    "";
  const description =
    document.querySelector("#description-inline-expander")?.textContent?.trim() ||
    document.querySelector("#description")?.textContent?.trim() ||
    "";

  return {
    url: window.location.href,
    videoId: new URL(window.location.href).searchParams.get("v") || "",
    title,
    channel,
    description,
    upload_date: null,
    duration: null,
  };
}

async function collectPayload() {
  const meta = collectMeta();
  const html = await fetchPageHtml();
  const playerResponse = parsePlayerResponseFromHtml(html);
  const track = pickCaptionTrack(playerResponse);
  let transcriptPayload = await fetchTranscriptFromTrack(track);
  if (!transcriptPayload) transcriptPayload = collectVisibleCaptionText();
  return {
    ...meta,
    ...(transcriptPayload || {
      transcript_text: "",
      transcript_entries: [],
      transcript_source: "browser_extension_no_transcript",
    }),
  };
}

function stageLabel(stage) {
  const map = {
    saved: "仅收藏",
    queued: "排队中",
    extracting_metadata: "读取信息",
    fetching_transcript: "抓取字幕",
    downloading_audio: "下载音频",
    transcribing_audio: "语音转录",
    classifying_note: "分类主题",
    structuring_note: "生成总结",
    writing_obsidian: "写入笔记",
    done: "已完成",
    failed: "执行失败",
  };
  return map[stage] || stage;
}

function statusLabel(status) {
  const map = {
    saved: "已收藏",
    queued: "排队中",
    running: "处理中",
    done: "已完成",
    failed: "失败",
  };
  return map[status] || "待处理";
}

function formatTime(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`;
}

function readCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function createSidebarSkeleton() {
  const host = document.createElement("aside");
  host.id = SIDEBAR_HOST_ID;
  host.innerHTML = `
    <button class="yingji-fab" type="button" aria-label="打开影记">
      <span class="yingji-fab__glow"></span>
      <span class="yingji-fab__icon">影</span>
      <span class="yingji-fab__copy">
        <span class="yingji-fab__label">影记</span>
        <span class="yingji-fab__hint">当前视频工作台</span>
      </span>
    </button>
    <button class="yingji-mini" type="button" aria-label="恢复影记工作台">
      <span class="yingji-mini__mark">影</span>
      <span class="yingji-mini__body">
        <span class="yingji-mini__status">待处理</span>
        <span class="yingji-mini__title">返回工作台</span>
        <span class="yingji-mini__stage">点击继续查看</span>
      </span>
      <span class="yingji-mini__enter">展开</span>
    </button>
    <div class="yingji-sidebar">
      <div class="yingji-sidebar__panel">
        <header class="yingji-panel__top yingji-panel__drag" data-drag-handle="panel">
          <div class="yingji-panel__brand">
            <div class="yingji-panel__logo">影</div>
            <div class="yingji-panel__titles">
              <strong>影记</strong>
              <span>当前视频工作台</span>
            </div>
          </div>
          <div class="yingji-panel__tools">
            <button class="yingji-icon-btn" type="button" data-action="minimize" title="最小化">-</button>
            <button class="yingji-icon-btn" type="button" data-action="close" title="关闭">×</button>
          </div>
        </header>

        <section class="yingji-video-card">
          <div class="yingji-video-card__head">
            <div class="yingji-status-pill">待处理</div>
            <div class="yingji-video-card__utility">
              <button class="yingji-link-btn" type="button" data-action="copy-job-id">复制 ID</button>
              <button class="yingji-link-btn" type="button" data-action="open-webui">网页端</button>
            </div>
          </div>
          <h2 class="yingji-video__title">正在读取视频信息...</h2>
          <p class="yingji-video__meta">请稍候</p>
        </section>

        <section class="yingji-command-grid">
          <button type="button" class="yingji-btn yingji-btn--primary" data-action="collect-process">抓取并处理</button>
          <button type="button" class="yingji-btn yingji-btn--secondary" data-action="collect-save">仅收藏</button>
          <button type="button" class="yingji-btn yingji-btn--secondary" data-action="retry">重新总结</button>
          <button type="button" class="yingji-btn yingji-btn--ghost" data-action="open-note">笔记路径</button>
        </section>

        <section class="yingji-status-card">
          <div class="yingji-card__head">
            <strong>处理状态</strong>
            <span class="yingji-time" data-field="updatedAt">刚刚</span>
          </div>
          <p class="yingji-status-copy">点击“抓取并处理”开始。</p>
          <div class="yingji-inline-error is-hidden" data-field="inlineError"></div>
          <div class="yingji-stage-track"></div>
        </section>

        <section class="yingji-bottom-grid">
          <div class="yingji-info-card">
            <div class="yingji-card__head">
              <strong>结果输出</strong>
              <span class="yingji-inline-note">写入后可直接回看</span>
            </div>
            <p class="yingji-output-path" data-field="outputPath">任务完成后会显示 Obsidian 笔记路径</p>
          </div>

          <div class="yingji-topic-card">
            <div class="yingji-card__head">
              <strong>主题</strong>
              <span data-field="topicBadge">未分类</span>
            </div>
            <label class="yingji-select-wrap">
              <span>切换文件夹</span>
              <select id="yingji-topic-select" class="yingji-topic-select"></select>
            </label>
          </div>
        </section>

        <section class="yingji-utility-row">
          <button type="button" class="yingji-chip-btn is-hidden" data-action="toggle-error" data-role="show-error">查看错误详情</button>
        </section>

        <section class="yingji-error-card is-hidden">
          <div class="yingji-card__head">
            <strong>错误提示</strong>
            <button type="button" class="yingji-link-btn" data-action="hide-error">收起</button>
          </div>
          <pre class="yingji-error__text"></pre>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(host);
  return host;
}

function injectStyles() {
  if (document.getElementById("yingji-sidebar-style")) return;
  const style = document.createElement("style");
  style.id = "yingji-sidebar-style";
  style.textContent = `
    #${SIDEBAR_HOST_ID} {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483646;
      font-family: "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
      color: #eef7fb;
      --yingji-bg: color-mix(in srgb, ${readCssVariable("--yt-spec-base-background") || "#0f1821"} 78%, #051018);
      --yingji-surface: rgba(15, 24, 33, 0.96);
      --yingji-surface-soft: rgba(24, 36, 47, 0.92);
      --yingji-border: rgba(143, 196, 219, 0.16);
      --yingji-border-strong: rgba(155, 217, 239, 0.32);
      --yingji-accent: #8fd9f0;
      --yingji-accent-strong: #c6edf8;
      --yingji-action: linear-gradient(135deg, #9fd9ef 0%, #77bfcf 100%);
      --yingji-text-soft: #95aaba;
      --yingji-shadow: 0 18px 40px rgba(3, 10, 16, 0.28);
      --yingji-radius-xl: 18px;
      --yingji-radius-lg: 14px;
      --yingji-radius-md: 12px;
      --yingji-ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    #${SIDEBAR_HOST_ID} * {
      box-sizing: border-box;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab,
    #${SIDEBAR_HOST_ID} .yingji-mini {
      position: fixed;
      top: 124px;
      right: 20px;
      border: 0;
      cursor: pointer;
      user-select: none;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab,
    #${SIDEBAR_HOST_ID} .yingji-mini,
    #${SIDEBAR_HOST_ID} .yingji-panel__drag {
      touch-action: none;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      min-height: 60px;
      padding: 10px 18px 10px 10px;
      border-radius: 20px;
      color: #09202a;
      background:
        linear-gradient(180deg, rgba(244, 250, 252, 0.96), rgba(229, 240, 245, 0.9));
      box-shadow: 0 18px 36px rgba(7, 21, 29, 0.24);
      transition: transform 180ms var(--yingji-ease), box-shadow 180ms var(--yingji-ease), opacity 180ms ease;
      backdrop-filter: blur(18px);
    }
    #${SIDEBAR_HOST_ID} .yingji-fab:hover {
      transform: translateY(-1px);
      box-shadow: 0 22px 42px rgba(7, 21, 29, 0.28);
    }
    #${SIDEBAR_HOST_ID}.${ACTIVE_CLASS} .yingji-fab {
      opacity: 0;
      pointer-events: none;
    }
    #${SIDEBAR_HOST_ID}.${MINIMIZED_CLASS} .yingji-fab {
      opacity: 0;
      pointer-events: none;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__glow {
      position: absolute;
      inset: 1px;
      border-radius: 17px;
      background:
        radial-gradient(circle at top left, rgba(255, 255, 255, 0.92), transparent 40%),
        linear-gradient(135deg, rgba(123, 196, 214, 0.32), rgba(70, 109, 125, 0.1));
      z-index: 0;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__icon,
    #${SIDEBAR_HOST_ID} .yingji-fab__label {
      position: relative;
      z-index: 1;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__icon {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: 14px;
      background: linear-gradient(160deg, #15303b, #416272);
      color: #edf8fd;
      font-size: 18px;
      font-weight: 800;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        0 8px 16px rgba(16, 37, 48, 0.18);
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__copy {
      display: grid;
      gap: 1px;
      text-align: left;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__label {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    #${SIDEBAR_HOST_ID} .yingji-fab__hint {
      position: relative;
      z-index: 1;
      font-size: 11px;
      color: rgba(23, 44, 55, 0.72);
      line-height: 1.2;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-width: 208px;
      max-width: 240px;
      padding: 10px 12px;
      border-radius: 18px;
      background: rgba(10, 19, 27, 0.96);
      border: 1px solid var(--yingji-border-strong);
      box-shadow: var(--yingji-shadow);
      color: #eff8fc;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.96);
      transition: transform 180ms var(--yingji-ease), opacity 180ms ease;
    }
    #${SIDEBAR_HOST_ID}.${MINIMIZED_CLASS} .yingji-mini {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1);
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__status {
      color: var(--yingji-accent);
      font-size: 11px;
      font-weight: 700;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__mark {
      width: 40px;
      height: 40px;
      border-radius: 13px;
      display: grid;
      place-items: center;
      background: linear-gradient(160deg, rgba(153, 217, 237, 0.18), rgba(92, 151, 171, 0.32));
      color: #dff6fd;
      font-weight: 800;
      font-size: 17px;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__body {
      display: grid;
      min-width: 0;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__title {
      font-size: 13px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__stage {
      color: var(--yingji-text-soft);
      font-size: 11px;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${SIDEBAR_HOST_ID} .yingji-mini__enter {
      padding: 0 10px;
      min-height: 30px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.06);
      color: #d9f2fa;
      font-size: 11px;
      font-weight: 700;
    }
    #${SIDEBAR_HOST_ID} .yingji-sidebar {
      position: fixed;
      inset: 0;
      display: flex;
      justify-content: flex-end;
      pointer-events: none;
    }
    #${SIDEBAR_HOST_ID} .yingji-sidebar__panel {
      position: fixed;
      top: 16px;
      right: 16px;
      width: min(392px, calc(100vw - 32px));
      height: min(602px, calc(100vh - 32px));
      display: grid;
      grid-template-rows: auto auto auto auto auto auto auto;
      gap: 8px;
      padding: 12px;
      border-radius: 22px;
      border: 1px solid var(--yingji-border);
      background:
        radial-gradient(circle at top left, rgba(114, 175, 196, 0.14), transparent 34%),
        linear-gradient(180deg, rgba(11, 19, 27, 0.98), rgba(15, 24, 33, 0.98));
      box-shadow: 0 28px 60px rgba(3, 10, 16, 0.38);
      backdrop-filter: blur(18px);
      transform: translateX(calc(100% + 24px));
      transition: transform 220ms var(--yingji-ease), opacity 180ms ease;
      overflow: hidden;
      pointer-events: auto;
    }
    #${SIDEBAR_HOST_ID}.${ACTIVE_CLASS} .yingji-sidebar__panel {
      transform: translateX(0);
    }
    #${SIDEBAR_HOST_ID}.${MINIMIZED_CLASS} .yingji-sidebar__panel {
      transform: translateX(calc(100% + 24px));
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__top,
    #${SIDEBAR_HOST_ID} .yingji-panel__brand,
    #${SIDEBAR_HOST_ID} .yingji-panel__tools,
    #${SIDEBAR_HOST_ID} .yingji-video-card__head,
    #${SIDEBAR_HOST_ID} .yingji-card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__drag {
      cursor: grab;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__drag.is-dragging {
      cursor: grabbing;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__brand {
      gap: 10px;
      justify-content: flex-start;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__logo {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: linear-gradient(160deg, #dbeef5 0%, #92c4d4 100%);
      color: #0f2530;
      font-size: 18px;
      font-weight: 800;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__titles {
      display: grid;
      gap: 1px;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__titles strong {
      font-size: 15px;
      line-height: 1.1;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__titles span,
    #${SIDEBAR_HOST_ID} .yingji-video__meta,
    #${SIDEBAR_HOST_ID} .yingji-status-copy,
    #${SIDEBAR_HOST_ID} .yingji-output-path,
    #${SIDEBAR_HOST_ID} .yingji-select-wrap span,
    #${SIDEBAR_HOST_ID} .yingji-time {
      color: var(--yingji-text-soft);
      font-size: 12px;
      line-height: 1.45;
      margin: 0;
    }
    #${SIDEBAR_HOST_ID} .yingji-status-copy {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    #${SIDEBAR_HOST_ID} .yingji-panel__tools {
      gap: 8px;
    }
    #${SIDEBAR_HOST_ID} .yingji-video-card,
    #${SIDEBAR_HOST_ID} .yingji-status-card,
    #${SIDEBAR_HOST_ID} .yingji-info-card,
    #${SIDEBAR_HOST_ID} .yingji-topic-card,
    #${SIDEBAR_HOST_ID} .yingji-error-card {
      padding: 11px;
      border-radius: var(--yingji-radius-xl);
      border: 1px solid var(--yingji-border);
      background: rgba(22, 33, 43, 0.92);
      min-height: 0;
    }
    #${SIDEBAR_HOST_ID} .yingji-video-card {
      display: grid;
      gap: 7px;
      background:
        linear-gradient(180deg, rgba(24, 36, 47, 0.95), rgba(17, 28, 39, 0.92));
    }
    #${SIDEBAR_HOST_ID} .yingji-video__title {
      margin: 0;
      font-size: 15px;
      line-height: 1.32;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-wrap: balance;
    }
    #${SIDEBAR_HOST_ID} .yingji-video-card__utility {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    #${SIDEBAR_HOST_ID} .yingji-status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      padding: 0 12px;
      border-radius: 999px;
      background: rgba(149, 217, 241, 0.14);
      color: #caeffa;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid rgba(149, 217, 241, 0.16);
    }
    #${SIDEBAR_HOST_ID} .yingji-command-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    #${SIDEBAR_HOST_ID} .yingji-btn,
    #${SIDEBAR_HOST_ID} .yingji-link-btn,
    #${SIDEBAR_HOST_ID} .yingji-icon-btn,
    #${SIDEBAR_HOST_ID} .yingji-topic-select {
      font: inherit;
    }
    #${SIDEBAR_HOST_ID} .yingji-btn {
      min-height: 40px;
      padding: 0 12px;
      border-radius: 12px;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      transition: transform 160ms var(--yingji-ease), border-color 160ms ease, background-color 160ms ease, opacity 160ms ease;
    }
    #${SIDEBAR_HOST_ID} .yingji-btn:hover,
    #${SIDEBAR_HOST_ID} .yingji-link-btn:hover,
    #${SIDEBAR_HOST_ID} .yingji-icon-btn:hover {
      transform: translateY(-1px);
    }
    #${SIDEBAR_HOST_ID} .yingji-btn:disabled,
    #${SIDEBAR_HOST_ID} .yingji-chip-btn:disabled,
    #${SIDEBAR_HOST_ID} .yingji-topic-select:disabled {
      opacity: 0.46;
      cursor: not-allowed;
      transform: none !important;
    }
    #${SIDEBAR_HOST_ID} .yingji-btn--primary {
      background: var(--yingji-action);
      color: #0e2530;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3);
    }
    #${SIDEBAR_HOST_ID} .yingji-btn--secondary,
    #${SIDEBAR_HOST_ID} .yingji-btn--ghost {
      border-color: var(--yingji-border);
      background: rgba(255, 255, 255, 0.03);
      color: #edf8fc;
    }
    #${SIDEBAR_HOST_ID} .yingji-btn--ghost {
      background: rgba(143, 217, 240, 0.08);
    }
    #${SIDEBAR_HOST_ID} .yingji-link-btn,
    #${SIDEBAR_HOST_ID} .yingji-icon-btn {
      border: none;
      background: transparent;
      color: var(--yingji-accent);
      cursor: pointer;
    }
    #${SIDEBAR_HOST_ID} .yingji-icon-btn {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.05);
      color: #d7eff8;
      font-size: 13px;
    }
    #${SIDEBAR_HOST_ID} .yingji-status-card {
      display: grid;
      gap: 8px;
    }
    #${SIDEBAR_HOST_ID} .yingji-inline-error {
      padding: 9px 11px;
      border-radius: 12px;
      border: 1px solid rgba(225, 136, 142, 0.24);
      background: rgba(78, 34, 40, 0.36);
      color: #ffd9dd;
      font-size: 12px;
      line-height: 1.45;
      word-break: break-word;
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-track {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-item {
      min-height: 46px;
      padding: 7px 8px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: rgba(255, 255, 255, 0.03);
      display: flex;
      align-items: center;
      gap: 5px;
      color: var(--yingji-text-soft);
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-item strong {
      font-size: 11px;
      line-height: 1.25;
      color: inherit;
      font-weight: 600;
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-item.is-active {
      color: #ecf8fd;
      border-color: rgba(149, 217, 241, 0.24);
      background: rgba(149, 217, 241, 0.08);
    }
    #${SIDEBAR_HOST_ID} .yingji-stage-item.is-done {
      color: #c6ebdb;
      background: rgba(121, 190, 161, 0.12);
    }
    #${SIDEBAR_HOST_ID} .yingji-bottom-grid {
      display: grid;
      grid-template-columns: 1fr 0.9fr;
      gap: 8px;
      min-height: 0;
      align-items: start;
    }
    #${SIDEBAR_HOST_ID} .yingji-info-card,
    #${SIDEBAR_HOST_ID} .yingji-topic-card,
    #${SIDEBAR_HOST_ID} .yingji-error-card {
      display: grid;
      gap: 7px;
    }
    #${SIDEBAR_HOST_ID} .yingji-card__head strong {
      font-size: 13px;
      font-weight: 700;
    }
    #${SIDEBAR_HOST_ID} .yingji-inline-note {
      color: var(--yingji-text-soft);
      font-size: 11px;
    }
    #${SIDEBAR_HOST_ID} [data-field="topicBadge"] {
      color: var(--yingji-accent-strong);
      font-size: 12px;
    }
    #${SIDEBAR_HOST_ID} .yingji-output-path {
      margin: 0;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }
    #${SIDEBAR_HOST_ID} .yingji-select-wrap {
      display: grid;
      gap: 6px;
    }
    #${SIDEBAR_HOST_ID} .yingji-utility-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    #${SIDEBAR_HOST_ID} .yingji-chip-btn {
      min-height: 34px;
      padding: 0 12px;
      border: 1px solid var(--yingji-border);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.03);
      color: #dceef5;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: transform 160ms var(--yingji-ease), border-color 160ms ease, background-color 160ms ease;
    }
    #${SIDEBAR_HOST_ID} .yingji-chip-btn:hover {
      transform: translateY(-1px);
      border-color: var(--yingji-border-strong);
    }
    #${SIDEBAR_HOST_ID} .yingji-topic-select {
      min-height: 38px;
      border-radius: 12px;
      border: 1px solid var(--yingji-border);
      background: rgba(255, 255, 255, 0.04);
      color: #eff7fb;
      padding: 0 12px;
      outline: none;
    }
    #${SIDEBAR_HOST_ID} .yingji-topic-select:focus,
    #${SIDEBAR_HOST_ID} .yingji-btn:focus-visible,
    #${SIDEBAR_HOST_ID} .yingji-link-btn:focus-visible,
    #${SIDEBAR_HOST_ID} .yingji-icon-btn:focus-visible,
    #${SIDEBAR_HOST_ID} .yingji-chip-btn:focus-visible,
    #${SIDEBAR_HOST_ID} .yingji-fab:focus-visible,
    #${SIDEBAR_HOST_ID} .yingji-mini:focus-visible {
      outline: 2px solid rgba(181, 232, 247, 0.82);
      outline-offset: 2px;
    }
    #${SIDEBAR_HOST_ID} .yingji-error-card {
      background: rgba(49, 26, 30, 0.8);
      border-color: rgba(225, 136, 142, 0.2);
    }
    #${SIDEBAR_HOST_ID} .yingji-error__text {
      margin: 0;
      color: #ffd5d8;
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 132px;
      overflow: auto;
    }
    #${SIDEBAR_HOST_ID} .is-hidden {
      display: none !important;
    }
    @media (max-width: 980px) {
      #${SIDEBAR_HOST_ID} .yingji-sidebar__panel {
        width: min(382px, calc(100vw - 20px));
        height: min(592px, calc(100vh - 20px));
        top: 10px;
        right: 10px;
      }
    }
    @media (max-width: 720px) {
      #${SIDEBAR_HOST_ID} .yingji-sidebar__panel {
        width: calc(100vw - 16px);
        height: calc(100vh - 16px);
        top: 8px;
        right: 8px;
        left: 8px;
      }
      #${SIDEBAR_HOST_ID} .yingji-stage-track,
      #${SIDEBAR_HOST_ID} .yingji-bottom-grid,
      #${SIDEBAR_HOST_ID} .yingji-command-grid {
        grid-template-columns: 1fr;
      }
      #${SIDEBAR_HOST_ID} .yingji-mini {
        max-width: min(240px, calc(100vw - 24px));
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #${SIDEBAR_HOST_ID} .yingji-fab,
      #${SIDEBAR_HOST_ID} .yingji-mini,
      #${SIDEBAR_HOST_ID} .yingji-sidebar__panel,
      #${SIDEBAR_HOST_ID} .yingji-btn,
      #${SIDEBAR_HOST_ID} .yingji-link-btn,
      #${SIDEBAR_HOST_ID} .yingji-icon-btn,
      #${SIDEBAR_HOST_ID} .yingji-chip-btn {
        transition: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function ensureSidebar() {
  if (sidebarHost?.isConnected) return sidebarHost;
  injectStyles();
  sidebarHost = createSidebarSkeleton();
  bindSidebarEvents(sidebarHost);
  hydrateVideoInfo();
  restoreFabPosition();
  return sidebarHost;
}

function hydrateVideoInfo() {
  const host = ensureSidebar();
  const meta = collectMeta();
  host.querySelector(".yingji-video__title").textContent = meta.title || "未识别视频标题";
  host.querySelector(".yingji-video__meta").textContent = meta.channel || "YouTube 当前页面";
}

function setOpenState(open) {
  const host = ensureSidebar();
  if (open) {
    host.classList.add(ACTIVE_CLASS);
    host.classList.remove(MINIMIZED_CLASS);
  } else {
    host.classList.remove(ACTIVE_CLASS);
    host.classList.remove(MINIMIZED_CLASS);
  }
  safeStorageSet({ [STORAGE_KEY_LAST_OPEN]: open });
}

function setMinimizedState(minimized) {
  const host = ensureSidebar();
  if (minimized) {
    host.classList.add(MINIMIZED_CLASS);
    host.classList.remove(ACTIVE_CLASS);
  } else {
    host.classList.remove(MINIMIZED_CLASS);
    host.classList.add(ACTIVE_CLASS);
  }
  safeStorageSet({ [STORAGE_KEY_LAST_OPEN]: !minimized });
}

function updateStatusCopy(text) {
  ensureSidebar().querySelector(".yingji-status-copy").textContent = text;
}

function renderError(text) {
  const host = ensureSidebar();
  const section = host.querySelector(".yingji-error-card");
  section.classList.remove("is-hidden");
  section.querySelector(".yingji-error__text").textContent = text;
}

function clearError() {
  const host = ensureSidebar();
  const section = host.querySelector(".yingji-error-card");
  section.classList.add("is-hidden");
  section.querySelector(".yingji-error__text").textContent = "";
  const inline = host.querySelector('[data-field="inlineError"]');
  inline.classList.add("is-hidden");
  inline.textContent = "";
  host.querySelector('[data-role="show-error"]')?.classList.add("is-hidden");
}

function renderStageTrack(currentStatus, currentStage) {
  const container = ensureSidebar().querySelector(".yingji-stage-track");
  container.innerHTML = "";
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  STAGE_ORDER.forEach((stage, index) => {
    const item = document.createElement("div");
    const done = currentStatus === "done" || (currentIndex >= 0 && index < currentIndex);
    const active = currentStatus !== "done" && stage === currentStage;
    item.className = `yingji-stage-item${done ? " is-done" : ""}${active ? " is-active" : ""}`;
    item.innerHTML = `<span class="yingji-stage-dot"></span><strong>${stageLabel(stage)}</strong>`;
    container.appendChild(item);
  });
}

function renderTopicOptions(topics, currentTopic) {
  const select = ensureSidebar().querySelector("#yingji-topic-select");
  const items = topics.length ? topics : ["投资"];
  select.innerHTML = items
    .map((topic) => `<option value="${topic}" ${topic === currentTopic ? "selected" : ""}>${topic}</option>`)
    .join("");
}

function renderSnapshot(snapshot = {}) {
  currentSnapshot = snapshot;
  const host = ensureSidebar();
  hydrateVideoInfo();
  clearError();
  host.querySelector(".yingji-status-pill").textContent = statusLabel(snapshot.status);
  host.querySelector(".yingji-mini__status").textContent = statusLabel(snapshot.status);
  host.querySelector(".yingji-mini__title").textContent =
    snapshot.title?.slice(0, 28) || "返回当前视频工作台";
  host.querySelector(".yingji-mini__stage").textContent =
    snapshot.message || stageLabel(snapshot.stage || snapshot.status || "queued");
  host.querySelector(".yingji-time").textContent = formatTime(snapshot.updatedAt);
  host.querySelector(".yingji-status-copy").textContent =
    snapshot.message || snapshot.errorMessage || "点击“抓取并处理”开始。";
  const inlineError = host.querySelector('[data-field="inlineError"]');
  const showErrorBtn = host.querySelector('[data-role="show-error"]');
  if (snapshot.errorMessage) {
    inlineError.textContent =
      snapshot.errorMessage.length > 120 ? `${snapshot.errorMessage.slice(0, 120)}...` : snapshot.errorMessage;
    inlineError.classList.remove("is-hidden");
    showErrorBtn?.classList.remove("is-hidden");
  }
  host.querySelector('[data-field="topicBadge"]').textContent =
    snapshot.lastKnownTopic || snapshot.topic || "未分类";
  host.querySelector('[data-field="outputPath"]').textContent =
    snapshot.outputPath || "任务完成后会显示 Obsidian 笔记路径";
  renderTopicOptions(snapshot.availableTopics || [], snapshot.lastKnownTopic || snapshot.topic || "");
  renderStageTrack(snapshot.status || "saved", snapshot.stage || "queued");
  updateActionAvailability(snapshot);
}

function updateActionAvailability(snapshot = {}) {
  const host = ensureSidebar();
  const processBtn = host.querySelector('[data-action="collect-process"]');
  const saveBtn = host.querySelector('[data-action="collect-save"]');
  const retryBtn = host.querySelector('[data-action="retry"]');
  const openNoteBtn = host.querySelector('[data-action="open-note"]');

  const isWorking =
    snapshot.pendingAction === "collect-process" ||
    snapshot.pendingAction === "collect-save" ||
    snapshot.status === "queued" ||
    snapshot.status === "running";

  processBtn.disabled = false;
  processBtn.dataset.action = isWorking ? "stop-job" : "collect-process";
  saveBtn.disabled = isWorking;
  retryBtn.disabled = !snapshot.jobId || isWorking;
  openNoteBtn.disabled = !snapshot.outputPath;

  if (isWorking) {
    processBtn.textContent = "中止任务";
  } else {
    processBtn.textContent = "抓取并处理";
  }
  saveBtn.textContent = snapshot.pendingAction === "collect-save" ? "收藏中..." : "仅收藏";
}

async function requestStatusSync() {
  const response = await safeSendRuntimeMessage({
    type: "YINGJI_SIDEBAR_SYNC",
    url: window.location.href,
  });
  if (response?.snapshot) renderSnapshot(response.snapshot);
  if (response?.error) renderError(response.error);
}

function persistFabPosition(top, right) {
  safeStorageSet({
    [STORAGE_KEY_FAB_POSITION]: {
      top,
      right,
    },
  });
}

function applyFabPosition(top, right) {
  const host = ensureSidebar();
  const fab = host.querySelector(".yingji-fab");
  const mini = host.querySelector(".yingji-mini");
  fab.style.top = `${top}px`;
  fab.style.right = `${right}px`;
  mini.style.top = `${top}px`;
  mini.style.right = `${right}px`;
}

function clampFabPosition(top, right, width, height) {
  const margin = 12;
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  const maxRight = Math.max(margin, window.innerWidth - width - margin);
  return {
    top: Math.min(Math.max(margin, top), maxTop),
    right: Math.min(Math.max(margin, right), maxRight),
  };
}

function persistPanelPosition(top, left) {
  safeStorageSet({
    [STORAGE_KEY_PANEL_POSITION]: {
      top,
      left,
    },
  });
}

function applyPanelPosition(top, left) {
  const panel = ensureSidebar().querySelector(".yingji-sidebar__panel");
  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
  panel.style.right = "auto";
}

function clampPanelPosition(top, left, width, height) {
  const margin = 8;
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  return {
    top: Math.min(Math.max(margin, top), maxTop),
    left: Math.min(Math.max(margin, left), maxLeft),
  };
}

function restorePanelPosition() {
  safeStorageGet([STORAGE_KEY_PANEL_POSITION], (result) => {
    const saved = result?.[STORAGE_KEY_PANEL_POSITION];
    if (!saved) return;
    const panel = ensureSidebar().querySelector(".yingji-sidebar__panel");
    const rect = panel.getBoundingClientRect();
    const position = clampPanelPosition(saved.top, saved.left, rect.width, rect.height);
    applyPanelPosition(position.top, position.left);
  });
}

function restoreFabPosition() {
  safeStorageGet([STORAGE_KEY_FAB_POSITION], (result) => {
    const saved = result?.[STORAGE_KEY_FAB_POSITION];
    if (!saved) return;
    const width = 170;
    const height = 60;
    const position = clampFabPosition(saved.top, saved.right, width, height);
    applyFabPosition(position.top, position.right);
  });
}

function beginFabDrag(event) {
  if (event.button !== 2) return false;
  const host = ensureSidebar();
  const fab = host.querySelector(".yingji-fab");
  const rect = fab.getBoundingClientRect();
  fabDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    moved: false,
    startX: event.clientX,
    startY: event.clientY,
    activated: false,
    width: rect.width,
    height: rect.height,
  };
  fab.setPointerCapture(event.pointerId);
  event.preventDefault();
  return true;
}

function moveFab(event) {
  if (!fabDragState) return;
  if (!fabDragState.activated) {
    const dx = event.clientX - fabDragState.startX;
    const dy = event.clientY - fabDragState.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    fabDragState.activated = true;
  }
  const nextTop = event.clientY - fabDragState.offsetY;
  const nextLeft = event.clientX - fabDragState.offsetX;
  const right = window.innerWidth - nextLeft - fabDragState.width;
  const position = clampFabPosition(nextTop, right, fabDragState.width, fabDragState.height);
  applyFabPosition(position.top, position.right);
  fabDragState.moved = true;
}

function endFabDrag(event) {
  if (!fabDragState) return false;
  const moved = fabDragState.moved;
  const host = ensureSidebar();
  const fab = host.querySelector(".yingji-fab");
  const top = parseFloat(fab.style.top || "124");
  const right = parseFloat(fab.style.right || "20");
  persistFabPosition(top, right);
  try {
    fab.releasePointerCapture(event.pointerId);
  } catch {}
  fabDragState = null;
  return moved;
}

function beginPanelDrag(event) {
  if (event.button !== 2) return false;
  const panel = ensureSidebar().querySelector(".yingji-sidebar__panel");
  const rect = panel.getBoundingClientRect();
  panelDragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    moved: false,
    startX: event.clientX,
    startY: event.clientY,
    activated: false,
    width: rect.width,
    height: rect.height,
  };
  panel.setPointerCapture(event.pointerId);
  event.preventDefault();
  return true;
}

function movePanel(event) {
  if (!panelDragState) return;
  if (!panelDragState.activated) {
    const dx = event.clientX - panelDragState.startX;
    const dy = event.clientY - panelDragState.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    panelDragState.activated = true;
    ensureSidebar().querySelector(".yingji-panel__drag")?.classList.add("is-dragging");
  }
  const position = clampPanelPosition(
    event.clientY - panelDragState.offsetY,
    event.clientX - panelDragState.offsetX,
    panelDragState.width,
    panelDragState.height,
  );
  applyPanelPosition(position.top, position.left);
  panelDragState.moved = true;
}

function endPanelDrag(event) {
  if (!panelDragState) return false;
  const panel = ensureSidebar().querySelector(".yingji-sidebar__panel");
  const rect = panel.getBoundingClientRect();
  persistPanelPosition(rect.top, rect.left);
  try {
    panel.releasePointerCapture(event.pointerId);
  } catch {}
  ensureSidebar().querySelector(".yingji-panel__drag")?.classList.remove("is-dragging");
  const moved = panelDragState.moved;
  panelDragState = null;
  return moved;
}

function bindSidebarEvents(host) {
  const fab = host.querySelector(".yingji-fab");
  const mini = host.querySelector(".yingji-mini");
  const panelHandle = host.querySelector('[data-drag-handle="panel"]');

  fab.addEventListener("contextmenu", (event) => event.preventDefault());
  fab.addEventListener("pointerdown", (event) => {
    beginFabDrag(event);
  });
  fab.addEventListener("pointermove", moveFab);
  fab.addEventListener("pointerup", (event) => {
    if (event.button === 2) {
      endFabDrag(event);
      return;
    }
    const moved = endFabDrag(event);
    if (!moved) {
      setOpenState(true);
      void requestStatusSync();
    }
  });
  fab.addEventListener("pointercancel", endFabDrag);

  mini.addEventListener("contextmenu", (event) => event.preventDefault());
  mini.addEventListener("pointerdown", (event) => {
    beginFabDrag(event);
  });
  mini.addEventListener("pointermove", moveFab);
  mini.addEventListener("pointerup", (event) => {
    if (event.button === 2) {
      endFabDrag(event);
      return;
    }
    const moved = endFabDrag(event);
    if (!moved) {
      setMinimizedState(false);
      void requestStatusSync();
    }
  });
  mini.addEventListener("pointercancel", endFabDrag);

  panelHandle?.addEventListener("contextmenu", (event) => event.preventDefault());
  panelHandle?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, select, input, a")) return;
    beginPanelDrag(event);
  });
  panelHandle?.addEventListener("pointermove", movePanel);
  panelHandle?.addEventListener("pointerup", endPanelDrag);
  panelHandle?.addEventListener("pointercancel", endPanelDrag);

  host.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.getAttribute("data-action");
    if (action === "close") {
      setOpenState(false);
      return;
    }
    if (action === "minimize") {
      setMinimizedState(true);
      return;
    }
    if (action === "toggle-error") {
      host.querySelector(".yingji-error-card")?.classList.remove("is-hidden");
      return;
    }
    if (action === "hide-error") {
      host.querySelector(".yingji-error-card")?.classList.add("is-hidden");
      return;
    }
    if (action === "copy-job-id") {
      if (!currentSnapshot?.jobId) {
        renderError("当前没有任务 ID");
        return;
      }
      try {
        await navigator.clipboard.writeText(currentSnapshot.jobId);
        updateStatusCopy(`任务 ID 已复制：${currentSnapshot.jobId}`);
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (action === "open-note") {
      if (!currentSnapshot?.outputPath) {
        renderError("当前任务尚未生成笔记");
        return;
      }
      try {
        await navigator.clipboard.writeText(currentSnapshot.outputPath);
        updateStatusCopy("笔记路径已复制，可粘贴到 Finder、终端或 Obsidian。");
      } catch (error) {
        renderError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const response = await safeSendRuntimeMessage({
      type: "YINGJI_SIDEBAR_ACTION",
      action,
      url: window.location.href,
    });
    if (response?.snapshot) renderSnapshot(response.snapshot);
    if (response?.message) updateStatusCopy(response.message);
    if (response?.error) renderError(response.error);
  });

  host.querySelector("#yingji-topic-select")?.addEventListener("change", async (event) => {
    const topic = event.target.value;
    const response = await safeSendRuntimeMessage({
      type: "YINGJI_SIDEBAR_ACTION",
      action: "update-topic",
      url: window.location.href,
      topic,
    });
    if (response?.snapshot) renderSnapshot(response.snapshot);
    if (response?.message) updateStatusCopy(response.message);
    if (response?.error) renderError(response.error);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "YINGJI_COLLECT_PAGE") {
    collectPayload()
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message?.type === "YINGJI_RENDER_SNAPSHOT") {
    renderSnapshot(message.snapshot || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "YINGJI_TOGGLE_SIDEBAR") {
    const host = ensureSidebar();
    host.classList.add(ACTIVE_CLASS);
    host.classList.remove(MINIMIZED_CLASS);
    safeStorageSet({ [STORAGE_KEY_LAST_OPEN]: true });
    void requestStatusSync();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function bootstrap() {
  const host = ensureSidebar();
  safeStorageGet([STORAGE_KEY_LAST_OPEN], (result) => {
    if (result?.[STORAGE_KEY_LAST_OPEN]) {
      host.classList.add(ACTIVE_CLASS);
      void requestStatusSync();
    }
  });
  window.addEventListener("resize", () => {
    const fab = host.querySelector(".yingji-fab");
    const rect = fab.getBoundingClientRect();
    const position = clampFabPosition(rect.top, window.innerWidth - rect.right, rect.width, rect.height);
    applyFabPosition(position.top, position.right);
    const panel = host.querySelector(".yingji-sidebar__panel");
    const panelRect = panel.getBoundingClientRect();
    const panelPosition = clampPanelPosition(panelRect.top, panelRect.left, panelRect.width, panelRect.height);
    applyPanelPosition(panelPosition.top, panelPosition.left);
  });
  restorePanelPosition();
  void requestStatusSync();
}

bootstrap();
