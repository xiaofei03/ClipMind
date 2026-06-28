const API_BASE = "http://127.0.0.1:8765";
const WEBUI_URL = "http://127.0.0.1:4173/";
const POLL_INTERVAL_MS = 2000;
const SESSION_KEY = "yingji.sessions.v1";
const STAGE_LABELS = {
  saved: "仅收藏",
  queued: "等待处理",
  extracting_metadata: "获取视频信息",
  fetching_transcript: "抓取字幕",
  downloading_audio: "下载音频",
  transcribing_audio: "语音转录",
  classifying_note: "主题分类",
  structuring_note: "生成总结",
  writing_obsidian: "写入 Obsidian",
  done: "已完成",
  failed: "执行失败",
};

const runtimeState = {
  sessionsByVideoId: {},
  timersByJobId: {},
  libraryTopics: [],
  pendingCreatesByVideoId: {},
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get("v") || url.pathname.split("/").pop() || rawUrl;
  } catch {
    return rawUrl;
  }
}

function getSession(videoId) {
  return runtimeState.sessionsByVideoId[videoId] || null;
}

function setSession(videoId, session) {
  runtimeState.sessionsByVideoId[videoId] = session;
  persistSessions();
}

function removeSession(videoId) {
  delete runtimeState.sessionsByVideoId[videoId];
  persistSessions();
}

function getPendingCreate(videoId) {
  return runtimeState.pendingCreatesByVideoId[videoId] || null;
}

function setPendingCreate(videoId, value) {
  if (value) {
    runtimeState.pendingCreatesByVideoId[videoId] = value;
  } else {
    delete runtimeState.pendingCreatesByVideoId[videoId];
  }
}

function buildIdleSnapshot(videoId, previous = {}, message = "当前任务已中止。") {
  return {
    jobId: null,
    videoId,
    url: previous.url || null,
    title: previous.title || "",
    status: "saved",
    stage: "saved",
    topic: previous.topic || null,
    lastKnownTopic: previous.lastKnownTopic || previous.topic || null,
    updatedAt: new Date().toISOString(),
    outputPath: null,
    errorMessage: null,
    message,
    availableTopics: runtimeState.libraryTopics.length ? runtimeState.libraryTopics : ["投资"],
    pendingAction: null,
  };
}

function persistSessions() {
  chrome.storage.local.set({
    [SESSION_KEY]: runtimeState.sessionsByVideoId,
  });
}

async function restoreSessions() {
  const stored = await chrome.storage.local.get([SESSION_KEY]);
  runtimeState.sessionsByVideoId = stored?.[SESSION_KEY] || {};
  try {
    const folders = await apiRequest("/library/folders");
    runtimeState.libraryTopics = (folders.items || []).map((item) => item.topic).filter(Boolean);
  } catch {
    runtimeState.libraryTopics = ["投资"];
  }
  for (const [videoId, session] of Object.entries(runtimeState.sessionsByVideoId)) {
    if (session?.status === "queued" || session?.status === "running") {
      startPolling(videoId, session.jobId);
    }
  }
}

async function apiRequest(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.detail || text || `请求失败：${response.status}`);
  }
  return data;
}

async function ensureBackendHealthy() {
  try {
    await apiRequest("/health");
    return true;
  } catch {
    return false;
  }
}

async function fetchJobsByUrl(url) {
  const encoded = encodeURIComponent(url);
  const data = await apiRequest(`/jobs?url=${encoded}&limit=20`);
  return data.items || [];
}

async function fetchJob(jobId) {
  return apiRequest(`/jobs/${jobId}`);
}

async function createCapture(payload, processNow) {
  return apiRequest("/captures/youtube", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      process_now: processNow,
      is_favorited: true,
    }),
  });
}

async function processSavedJob(jobId) {
  return apiRequest(`/jobs/${jobId}/process`, { method: "POST" });
}

async function retryJob(jobId) {
  return apiRequest(`/jobs/${jobId}/retry`, { method: "POST" });
}

async function deleteJob(jobId) {
  return apiRequest(`/jobs/${jobId}`, { method: "DELETE" });
}

async function updateJobTopic(jobId, topic) {
  return apiRequest(`/jobs/${jobId}/topic`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topic }),
  });
}

function snapshotFromJob(job, previous = {}) {
  return {
    jobId: job.id,
    videoId: parseVideoId(job.url),
    url: job.url,
    title: job.title || previous.title || "",
    status: job.status,
    stage: job.stage,
    topic: job.topic,
    lastKnownTopic: job.topic || previous.lastKnownTopic || null,
    updatedAt: job.updated_at,
    outputPath: job.output_path,
    errorMessage: job.error_message,
    message: buildStatusMessage(job),
    availableTopics: runtimeState.libraryTopics.length ? runtimeState.libraryTopics : ["投资"],
    pendingAction: null,
  };
}

function buildPendingSnapshot({ videoId, url, title, processNow, previous = {} }) {
  return {
    jobId: previous.jobId || null,
    videoId,
    url,
    title: title || previous.title || "",
    status: processNow ? "queued" : "saved",
    stage: processNow ? "queued" : "saved",
    topic: previous.topic || null,
    lastKnownTopic: previous.lastKnownTopic || previous.topic || null,
    updatedAt: new Date().toISOString(),
    outputPath: previous.outputPath || null,
    errorMessage: null,
    message: processNow ? "正在创建任务，请不要重复点击。" : "正在收藏当前视频，请稍候。",
    availableTopics: runtimeState.libraryTopics.length ? runtimeState.libraryTopics : ["投资"],
    pendingAction: processNow ? "collect-process" : "collect-save",
  };
}

function buildStatusMessage(job) {
  if (job.status === "done") return "处理完成，已写入 Obsidian。";
  if (job.status === "failed") return "任务失败，请查看错误详情或点击重新总结。";
  if (job.status === "saved") return "已收藏，可随时开始处理。";
  return `${STAGE_LABELS[job.stage] || job.stage}中，请稍候...`;
}

async function pushSnapshotToVideo(videoId, snapshot) {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/watch*"] });
  await Promise.all(
    tabs
      .filter((tab) => parseVideoId(tab.url || "") === videoId)
      .map((tab) =>
        chrome.tabs
          .sendMessage(tab.id, {
            type: "YINGJI_RENDER_SNAPSHOT",
            snapshot,
          })
          .catch(() => null),
      ),
  );
}

function stopPolling(jobId) {
  const timer = runtimeState.timersByJobId[jobId];
  if (timer) {
    clearTimeout(timer);
    delete runtimeState.timersByJobId[jobId];
  }
}

function schedulePoll(videoId, jobId) {
  stopPolling(jobId);
  runtimeState.timersByJobId[jobId] = setTimeout(() => {
    void syncJob(videoId, jobId);
  }, POLL_INTERVAL_MS);
}

function startPolling(videoId, jobId) {
  stopPolling(jobId);
  void syncJob(videoId, jobId);
}

async function syncJob(videoId, jobId) {
  try {
    const job = await fetchJob(jobId);
    const current = getSession(videoId) || {};
    const snapshot = snapshotFromJob(job, current);
    setSession(videoId, snapshot);
    await pushSnapshotToVideo(videoId, snapshot);
    if (job.status === "queued" || job.status === "running") {
      schedulePoll(videoId, jobId);
    } else {
      stopPolling(jobId);
    }
  } catch (error) {
    const current = getSession(videoId) || {};
    const snapshot = {
      ...current,
      status: current.status || "failed",
      stage: current.stage || "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      message: "状态同步中断，可手动刷新或重新打开网页。",
    };
    setSession(videoId, snapshot);
    await pushSnapshotToVideo(videoId, snapshot);
  }
}

function isMissingReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist");
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  await wait(300);
}

async function sendTabMessage(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    if (!isMissingReceiverError(error)) throw error;
    await injectContentScript(tabId);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function ensurePagePayload(tabId) {
  return sendTabMessage(tabId, { type: "YINGJI_COLLECT_PAGE" });
}

async function ensureSidebarVisible(tabId) {
  await sendTabMessage(tabId, { type: "YINGJI_TOGGLE_SIDEBAR", collapsed: false }).catch(() => null);
}

async function resolveExistingJob(url) {
  const jobs = await fetchJobsByUrl(url);
  const active = jobs.find((job) => job.status === "queued" || job.status === "running");
  if (active) return { kind: "active", job: active };
  const saved = jobs.find((job) => job.status === "saved");
  if (saved) return { kind: "saved", job: saved };
  const latest = jobs[0] || null;
  return latest ? { kind: "latest", job: latest } : null;
}

async function handleCreateOrResume({ tabId, url, processNow }) {
  const healthy = await ensureBackendHealthy();
  if (!healthy) {
    throw new Error("本地后台服务未启动，请先启动 8765 服务后再试");
  }
  const videoId = parseVideoId(url);
  const pending = getPendingCreate(videoId);
  if (pending) {
    const snapshot = getSession(videoId) || pending.snapshot;
    return {
      ok: true,
      snapshot,
      message: pending.processNow ? "正在创建任务，点击“中止任务”可取消。" : "这个视频正在收藏中，请稍候。",
    };
  }
  const existing = await resolveExistingJob(url);
  if (existing?.kind === "active") {
    const snapshot = snapshotFromJob(existing.job, getSession(videoId) || {});
    snapshot.message = "该视频已有进行中任务，已为你恢复进度。";
    setSession(videoId, snapshot);
    await pushSnapshotToVideo(videoId, snapshot);
    startPolling(videoId, existing.job.id);
    await ensureSidebarVisible(tabId);
    return { ok: true, snapshot, message: snapshot.message };
  }

  if (existing?.kind === "saved" && processNow) {
    const updated = await processSavedJob(existing.job.id);
    const snapshot = snapshotFromJob(updated, getSession(videoId) || {});
    snapshot.message = "已继续处理此前收藏的任务。";
    setSession(videoId, snapshot);
    startPolling(videoId, updated.id);
    await pushSnapshotToVideo(videoId, snapshot);
    await ensureSidebarVisible(tabId);
    return { ok: true, snapshot, message: snapshot.message };
  }

  if (existing?.kind === "latest" && !processNow && existing.job.status === "saved") {
    const snapshot = snapshotFromJob(existing.job, getSession(videoId) || {});
    snapshot.message = "该视频已存在收藏任务，已为你恢复。";
    setSession(videoId, snapshot);
    await pushSnapshotToVideo(videoId, snapshot);
    await ensureSidebarVisible(tabId);
    return { ok: true, snapshot, message: snapshot.message };
  }

  const payloadResponse = await ensurePagePayload(tabId);
  if (!payloadResponse?.ok) {
    throw new Error(payloadResponse?.error || "页面抓取失败");
  }
  const optimistic = buildPendingSnapshot({
    videoId,
    url,
    title: payloadResponse.payload?.title,
    processNow,
    previous: getSession(videoId) || {},
  });
  setSession(videoId, optimistic);
  setPendingCreate(videoId, { processNow, snapshot: optimistic, createdAt: Date.now() });
  await pushSnapshotToVideo(videoId, optimistic);
  await ensureSidebarVisible(tabId);
  try {
    const created = await createCapture(payloadResponse.payload, processNow);
    const currentPending = getPendingCreate(videoId);
    if (currentPending?.cancelRequested) {
      try {
        await deleteJob(created.id);
      } catch {}
      const stoppedSnapshot = buildIdleSnapshot(videoId, optimistic, "已中止当前任务。");
      setSession(videoId, stoppedSnapshot);
      await pushSnapshotToVideo(videoId, stoppedSnapshot);
      return { ok: true, snapshot: stoppedSnapshot, message: stoppedSnapshot.message };
    }
    const snapshot = snapshotFromJob(created, getSession(videoId) || {});
    snapshot.message = processNow ? "已创建任务，正在同步实时进度..." : "已收藏到影记，可稍后继续处理。";
    setSession(videoId, snapshot);
    await pushSnapshotToVideo(videoId, snapshot);
    if (processNow && (created.status === "queued" || created.status === "running")) {
      startPolling(videoId, created.id);
    }
    return { ok: true, snapshot, message: snapshot.message };
  } finally {
    setPendingCreate(videoId, null);
  }
}

async function handleSidebarAction(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) throw new Error("无法定位当前标签页");
  const url = message.url || sender.tab?.url;
  if (!url) throw new Error("无法识别当前视频链接");
  const videoId = parseVideoId(url);
  const session = getSession(videoId);

  switch (message.action) {
    case "collect-process":
      return handleCreateOrResume({ tabId, url, processNow: true });
    case "collect-save":
      return handleCreateOrResume({ tabId, url, processNow: false });
    case "retry": {
      if (!session?.jobId) throw new Error("当前没有可重试的任务");
      const updated = await retryJob(session.jobId);
      const snapshot = snapshotFromJob(updated, session);
      snapshot.message = "已重新加入队列，正在再次总结。";
      setSession(videoId, snapshot);
      await pushSnapshotToVideo(videoId, snapshot);
      startPolling(videoId, updated.id);
      return { ok: true, snapshot, message: snapshot.message };
    }
    case "stop-job": {
      const pending = getPendingCreate(videoId);
      if (pending) {
        pending.cancelRequested = true;
        setPendingCreate(videoId, pending);
        const snapshot = buildIdleSnapshot(videoId, session || pending.snapshot, "正在中止创建中的任务...");
        setSession(videoId, snapshot);
        await pushSnapshotToVideo(videoId, snapshot);
        return { ok: true, snapshot, message: snapshot.message };
      }
      if (!session?.jobId) throw new Error("当前没有可中止的任务");
      await deleteJob(session.jobId);
      stopPolling(session.jobId);
      removeSession(videoId);
      const snapshot = buildIdleSnapshot(videoId, session, "当前任务已中止。");
      await pushSnapshotToVideo(videoId, snapshot);
      return { ok: true, snapshot, message: snapshot.message };
    }
    case "delete-job": {
      if (!session?.jobId) throw new Error("当前没有可删除的任务");
      await deleteJob(session.jobId);
      stopPolling(session.jobId);
      removeSession(videoId);
      const snapshot = {
        videoId,
        title: session.title,
        status: "saved",
        stage: "saved",
        message: "当前任务已删除。",
        outputPath: null,
        errorMessage: null,
        lastKnownTopic: session.lastKnownTopic || null,
      };
      await pushSnapshotToVideo(videoId, snapshot);
      return { ok: true, snapshot, message: snapshot.message };
    }
    case "open-webui":
      await chrome.tabs.create({ url: WEBUI_URL });
      return { ok: true, message: "已打开影记网页。" };
    case "open-note": {
      if (!session?.outputPath) throw new Error("当前任务尚未生成笔记");
      return { ok: true, message: `笔记路径：${session.outputPath}` };
    }
    case "update-topic": {
      const healthy = await ensureBackendHealthy();
      if (!healthy) throw new Error("本地后台服务未启动，请先启动 8765 服务后再试");
      if (!session?.jobId) throw new Error("当前没有可更新主题的任务");
      const topic = (message.topic || "").trim();
      if (!topic) throw new Error("请选择主题");
      const updated = await updateJobTopic(session.jobId, topic);
      const snapshot = snapshotFromJob(updated, session);
      snapshot.message = `主题已切换为“${topic}”。`;
      setSession(videoId, snapshot);
      await pushSnapshotToVideo(videoId, snapshot);
      return { ok: true, snapshot, message: snapshot.message };
    }
    default:
      throw new Error("未支持的操作");
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreSessions();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreSessions();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YINGJI_SIDEBAR_ACTION") {
    handleSidebarAction(message, sender)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message?.type === "YINGJI_SIDEBAR_SYNC") {
    const videoId = parseVideoId(message.url || sender.tab?.url || "");
    const snapshot = getSession(videoId);
    ensureBackendHealthy()
      .catch(() => false)
      .then((healthy) => {
        if (!healthy && !snapshot) {
          sendResponse({
            ok: false,
            error: "本地后台服务未连接，请先启动 8765 服务",
          });
          return;
        }
        if (snapshot?.jobId && (snapshot.status === "queued" || snapshot.status === "running")) {
          startPolling(videoId, snapshot.jobId);
        }
        sendResponse({ ok: true, snapshot });
      });
    return true;
  }

  if (message?.type === "YINGJI_POPUP_ACTION") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      const url = tab?.url || "";
      const videoId = parseVideoId(url);
      try {
        if (message.action === "open-sidebar") {
          if (!tab?.id || !url.includes("youtube.com/watch")) {
            throw new Error("请先打开一个 YouTube 视频页面");
          }
          await ensureSidebarVisible(tab.id);
          const snapshot = getSession(videoId);
          sendResponse({ ok: true, snapshot, message: "已唤起当前页工作台，请在页面中的“影记”侧栏继续操作。" });
          return;
        }
        if (message.action === "open-webui") {
          await chrome.tabs.create({ url: WEBUI_URL });
          sendResponse({ ok: true, message: "已打开影记网页。" });
          return;
        }
        if (message.action === "status") {
          const snapshot = getSession(videoId);
          sendResponse({ ok: true, snapshot });
          return;
        }
        const snapshot = getSession(videoId);
        sendResponse({ ok: true, snapshot });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return true;
  }

  return false;
});

void restoreSessions();
