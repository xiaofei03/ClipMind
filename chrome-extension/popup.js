const titleEl = document.getElementById("recent-title");
const copyEl = document.getElementById("recent-copy");
const pillEl = document.getElementById("status-pill");

function setSnapshot(snapshot, fallbackMessage = "进入 YouTube 视频页后，点击页面中的“影记”按钮即可开始。") {
  if (!snapshot) {
    titleEl.textContent = "暂无任务";
    copyEl.textContent = fallbackMessage;
    pillEl.textContent = "等待操作";
    return;
  }
  titleEl.textContent = snapshot.title || "当前视频任务";
  copyEl.textContent = snapshot.message || snapshot.errorMessage || "已同步最近任务状态。";
  const labelMap = {
    saved: "已收藏",
    queued: "排队中",
    running: "处理中",
    done: "已完成",
    failed: "失败",
  };
  pillEl.textContent = labelMap[snapshot.status] || "等待操作";
}

async function sendPopupAction(action) {
  const response = await chrome.runtime.sendMessage({
    type: "YINGJI_POPUP_ACTION",
    action,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "执行失败");
  }
  if (response.snapshot) setSnapshot(response.snapshot);
  if (response.message) copyEl.textContent = response.message;
  return response;
}

document.getElementById("open-sidebar").addEventListener("click", async () => {
  try {
    await sendPopupAction("open-sidebar");
  } catch (error) {
    setSnapshot(null, error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("open-webui").addEventListener("click", async () => {
  try {
    await sendPopupAction("open-webui");
  } catch (error) {
    setSnapshot(null, error instanceof Error ? error.message : String(error));
  }
});

void sendPopupAction("status").catch(() => {
  setSnapshot(null);
});
