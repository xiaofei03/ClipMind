import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  BookmarkPlus,
  Brain,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  Inbox,
  KeyRound,
  Loader2,
  Play,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import GradientText from "./components/GradientText.jsx";
import Prism from "./components/Prism.jsx";
import SplitText from "./components/SplitText.jsx";
import "./styles.css";

const initialInput = {
  mode: "learning",
  generateHtml: false,
  generateWord: false,
  generateMarkmap: false,
  generateSubtitles: false
};

const HISTORY_KEY = "video-learning-desk-history";
const COLLECTION_KEY = "video-learning-desk-collection";
const MODEL_CONFIG_KEY = "video-learning-desk-model-config";
const OUTPUT_DIR_KEY = "video-learning-desk-output-dir";
const MAX_HISTORY_ITEMS = 12;
const PLATFORM_FILTERS = ["all", "douyin", "bilibili", "youtube", "web", "unknown"];

function App() {
  const [view, setView] = useState("home");
  const [health, setHealth] = useState("checking");
  const [collection, setCollection] = useState(() => loadCollection());
  const [workspaceUrl, setWorkspaceUrl] = useState("");

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(() => setHealth("ready"))
      .catch(() => setHealth("offline"));
  }, []);

  useEffect(() => {
    saveCollection(collection);
  }, [collection]);

  function upsertCollection(input) {
    const url = extractUrl(input.url || input);
    if (!url) return null;
    const now = new Date().toISOString();
    const normalizedUrl = normalizeUrl(url);
    const platform = input.platform || inferPlatform(url);
    const existing = collection.find((item) => item.normalizedUrl === normalizedUrl);
    const nextItem = {
      id: existing?.id || crypto.randomUUID(),
      url,
      normalizedUrl,
      platform,
      title: input.title || existing?.title || makeCardTitle(url, platform),
      note: input.note ?? existing?.note ?? "",
      tags: Array.isArray(input.tags) ? input.tags : existing?.tags || [],
      status: input.status || existing?.status || "saved",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      lastAnalyzedAt: input.lastAnalyzedAt || existing?.lastAnalyzedAt || "",
      result: input.result || existing?.result || null,
      refinement: input.refinement || existing?.refinement || null
    };
    setCollection((items) => [nextItem, ...items.filter((item) => item.id !== nextItem.id && item.normalizedUrl !== normalizedUrl)]);
    return nextItem;
  }

  function updateCollectionItem(id, patch) {
    setCollection((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item))
    );
  }

  function deleteCollectionItem(id) {
    setCollection((items) => items.filter((item) => item.id !== id));
  }

  function openWorkspace(url) {
    setWorkspaceUrl(url || "");
    setView("desk");
  }

  return (
    <div className="app-shell">
      {view === "home" && <Landing health={health} onEnter={() => setView("collection")} />}
      {view === "collection" && (
        <CollectionBox
          health={health}
          items={collection}
          onBack={() => setView("home")}
          onOpenWorkspace={openWorkspace}
          onUpsert={upsertCollection}
          onUpdate={updateCollectionItem}
          onDelete={deleteCollectionItem}
        />
      )}
      {view === "desk" && (
        <Workspace
          health={health}
          initialUrl={workspaceUrl}
          onBack={() => setView("collection")}
          onCollect={upsertCollection}
        />
      )}
    </div>
  );
}

function Landing({ health, onEnter }) {
  return (
    <main className="landing-screen">
      <div className="ambient-grid" />
      <nav className="landing-nav">
        <div className="brand-lockup">
          <span className="brand-symbol">
            <Sparkles size={18} />
          </span>
          <span>Video Learning Desk</span>
        </div>
        <div className={`health-chip ${health}`}>
          <span />
          {health === "ready" ? "Local Ready" : health === "offline" ? "Backend Offline" : "Checking"}
        </div>
      </nav>

      <section className="landing-stage">
        <div className="prism-hero" aria-hidden="true">
          <Prism
            animationType="3drotate"
            timeScale={0.42}
            height={3.2}
            baseWidth={5.3}
            scale={3.65}
            hueShift={-0.82}
            colorFrequency={1.05}
            noise={0.34}
            glow={1.06}
            bloom={1.15}
          />
        </div>

        <div className="landing-copy">
          <div className="release-pill">
            <span>NEW</span>
            <b>Collect, classify, learn</b>
          </div>
          <h1 className="hero-title" aria-label="视频秒变笔记">
            <GradientText
              colors={["#ffffff", "#eaffd0", "#b9ff73", "#79e6ff", "#ff8bc2", "#ffffff"]}
              animationSpeed={6.5}
              direction="diagonal"
              className="hero-gradient-title"
            >
              <SplitText text="视频秒变笔记" delay={220} duration={920} />
            </GradientText>
          </h1>
          <p>先把视频放入收藏盒，再挑值得学习的内容进入工作台，生成图文文章、Markdown 和思维导图。</p>
          <div className="landing-actions centered">
            <button className="hero-button" type="button" onClick={onEnter}>
              进入收藏盒
              <ArrowRight size={19} />
            </button>
          </div>
        </div>

        <div className="hero-dashboard" aria-label="能力概览">
          <Metric label="Collect" value="Inbox" />
          <Metric label="Route" value="Auto" />
          <Metric label="Notes" value="HTML" />
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CollectionBox({ health, items, onBack, onOpenWorkspace, onUpsert, onUpdate, onDelete }) {
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null);
  const [page, setPage] = useState(1);
  const [toast, setToast] = useState("把暂时不总结的视频先放进这里。");
  const pageSize = 8;

  const counts = useMemo(() => platformCounts(items), [items]);
  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      const platformOk = filter === "all" || item.platform === filter;
      const queryOk = !keyword || [item.title, item.url, item.note, ...(item.tags || [])].join(" ").toLowerCase().includes(keyword);
      return platformOk && queryOk;
    });
  }, [items, filter, query]);
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const pageItems = filteredItems.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [filter, query, items.length]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  function addToCollection(goAnalyze = false) {
    const url = extractUrl(draft);
    if (!url) {
      setToast("没有识别到有效链接。");
      return;
    }
    const item = onUpsert({ url, status: goAnalyze ? "queued" : "saved" });
    setToast(item ? `已加入 ${platformLabel(item.platform)} 收藏池。` : "加入失败。");
    setDraft("");
    if (goAnalyze && item) onOpenWorkspace(item.url);
  }

  return (
    <main className="collection-screen">
      <div className="collection-shell">
        <header className="collection-topbar">
          <button className="back-button" type="button" onClick={onBack}>
            <ArrowLeft size={18} />
            返回封面
          </button>
          <div className="collection-title-line">
            <p className="top-kicker">Video Inbox</p>
            <h1>视频收藏盒</h1>
          </div>
          <nav className="app-tabs" aria-label="主导航">
            <button className="active" type="button">
              收藏盒
            </button>
            <button type="button" onClick={() => onOpenWorkspace("")}>
              学习工作台
            </button>
          </nav>
          <div className={`health-chip ${health}`}>
            <span />
            {health === "ready" ? "Local Ready" : health === "offline" ? "Backend Offline" : "Checking"}
          </div>
        </header>

        <section className="collection-hero-panel">
          <div>
            <h2>先收藏，再学习</h2>
            <p>粘贴视频链接后自动归类平台，生成标准卡片。你可以备注、筛选，或把某个视频送进工作台总结。</p>
          </div>
          <div className="collection-input-row">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="粘贴抖音、B站、YouTube 或网页视频链接" />
            <div className="collection-actions">
              <button className="secondary-action" type="button" onClick={() => addToCollection(false)}>
                <BookmarkPlus size={18} />
                加入收藏盒
              </button>
              <button className="primary-action" type="button" onClick={() => addToCollection(true)}>
                <Play size={18} />
                送入工作台
              </button>
            </div>
          </div>
          <p className="collection-toast">{toast}</p>
        </section>

        <section className="collection-toolbar">
          <div className="platform-filters">
            {PLATFORM_FILTERS.map((platform) => (
              <button
                key={platform}
                className={filter === platform ? "active" : ""}
                type="button"
                onClick={() => setFilter(platform)}
              >
                {platformLabel(platform)}
                <span>{platform === "all" ? items.length : counts[platform] || 0}</span>
              </button>
            ))}
          </div>
          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、备注或标签" />
          </label>
        </section>

        <section className="collection-grid" aria-label="收藏视频列表">
          {filteredItems.length ? (
            pageItems.map((item) => (
              <VideoCard
                key={item.id}
                item={item}
                onAnalyze={() => {
                  onUpdate(item.id, { status: "queued" });
                  onOpenWorkspace(item.url);
                }}
                onEdit={() => setEditing(item)}
                onDelete={() => onDelete(item.id)}
              />
            ))
          ) : (
            <div className="collection-empty">
              <Inbox size={34} />
              <strong>收藏盒还是空的</strong>
              <p>先放入几个视频链接，后面就能按平台筛选和逐个总结。</p>
            </div>
          )}
        </section>
        {filteredItems.length > pageSize && (
          <nav className="collection-pagination" aria-label="收藏盒分页">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              上一页
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>
              下一页
            </button>
          </nav>
        )}
      </div>

      {editing && (
        <NoteModal
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            onUpdate(editing.id, patch);
            setEditing(null);
          }}
        />
      )}
    </main>
  );
}

function VideoCard({ item, onAnalyze, onEdit, onDelete }) {
  const status = statusMeta(item.status);
  const summaryFile = primarySummaryFile(item.result);
  return (
    <article className="video-card">
      <div className={`video-platform ${item.platform}`}>{platformLabel(item.platform)}</div>
      <h3>{item.title}</h3>
      <p className="video-url">{item.url}</p>
      {item.note ? <p className="video-note">{item.note}</p> : <p className="video-note muted">还没有备注</p>}
      <div className="video-meta-row">
        <span className={`status-pill ${status.className}`}>{status.label}</span>
        <time>{formatDate(item.updatedAt || item.createdAt)}</time>
      </div>
      <div className="video-card-actions">
        <button className="primary-mini" type="button" onClick={onAnalyze}>
          <Play size={15} />
          总结
        </button>
        <button type="button" onClick={onEdit}>
          <StickyNote size={15} />
          备注
        </button>
        <a href={item.url} target="_blank" rel="noreferrer">
          <ExternalLink size={15} />
          打开视频
        </a>
        {summaryFile && (
          <a href={`/api/file?path=${encodeURIComponent(summaryFile.path)}`} target="_blank" rel="noreferrer">
            <FileText size={15} />
            打开总结
          </a>
        )}
        <button type="button" onClick={onDelete} aria-label="删除收藏">
          <Trash2 size={15} />
        </button>
      </div>
    </article>
  );
}

function primarySummaryFile(result) {
  const files = collectResultFiles(result);
  return (
    files.find((file) => file.primary) ||
    files.find((file) => /HTML|Word|Markdown|总结/.test(file.label)) ||
    files[0] ||
    null
  );
}

function NoteModal({ item, onClose, onSave }) {
  const [note, setNote] = useState(item.note || "");
  const [tags, setTags] = useState((item.tags || []).join("，"));
  const [title, setTitle] = useState(item.title || "");

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="note-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭备注">
          <X size={18} />
        </button>
        <div className="modal-head">
          <span>{platformLabel(item.platform)}</span>
          <h3>编辑视频卡片</h3>
          <p>{item.url}</p>
        </div>
        <label className="modal-field">
          <span>标题</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="modal-field">
          <span>备注</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="这个视频想学什么？哪里值得复盘？" />
        </label>
        <label className="modal-field">
          <span>标签</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="AI编程，Prompt，前端" />
        </label>
        <button
          className="primary-action modal-save"
          type="button"
          onClick={() =>
            onSave({
              title: title.trim() || item.title,
              note: note.trim(),
              tags: tags.split(/[，,\s]+/).map((tag) => tag.trim()).filter(Boolean)
            })
          }
        >
          保存卡片
        </button>
      </section>
    </div>
  );
}

function ModelSettingsModal({ value, onClose, onSave }) {
  const [draft, setDraft] = useState(() => ({
    provider: value.provider || "dashscope",
    apiKey: value.apiKey || "",
    baseUrl: value.baseUrl || defaultBaseUrl(value.provider || "dashscope"),
    visionModel: value.visionModel || value.model || "qwen3-vl-plus",
    textModel: value.textModel || value.visionModel || value.model || "qwen3-vl-plus",
    saveLocal: value.saveLocal !== false
  }));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  function updateProvider(provider) {
    setDraft((current) => ({
      ...current,
      provider,
      baseUrl: current.baseUrl || defaultBaseUrl(provider),
      visionModel: current.visionModel || defaultVisionModel(provider),
      textModel: current.textModel || current.visionModel || defaultVisionModel(provider)
    }));
    setTestResult(null);
  }

  async function testProvider() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await postJson("/api/provider/probe", { modelConfig: draft });
      setTestResult({ ok: true, message: `连接成功：${result.response || "OK"}` });
    } catch (error) {
      setTestResult({ ok: false, message: error.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="model-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭模型设置">
          <X size={18} />
        </button>
        <div className="modal-head">
          <span>Model Provider</span>
          <h3>配置模型接口</h3>
          <p>支持阿里云百炼和 OpenAI-Compatible 接口。API Key 只会用于本地任务请求。</p>
        </div>
        <div className="model-grid">
          <label className="modal-field">
            <span>API 厂商</span>
            <select value={draft.provider} onChange={(event) => updateProvider(event.target.value)}>
              <option value="dashscope">阿里云百炼 Qwen</option>
              <option value="openai">OpenAI-Compatible</option>
              <option value="openrouter">OpenRouter</option>
              <option value="siliconflow">SiliconFlow</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label className="modal-field">
            <span>视觉模型</span>
            <input value={draft.visionModel} onChange={(event) => setDraft((current) => ({ ...current, visionModel: event.target.value }))} placeholder="qwen3-vl-plus" />
          </label>
        </div>
        <label className="modal-field">
          <span>Base URL</span>
          <input value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
        </label>
        <label className="modal-field">
          <span>API Key</span>
          <input type="password" value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder="sk-..." />
        </label>
        <label className="modal-field">
          <span>文本模型（可选）</span>
          <input value={draft.textModel} onChange={(event) => setDraft((current) => ({ ...current, textModel: event.target.value }))} placeholder="默认同视觉模型" />
        </label>
        <label className="toggle-row modal-toggle">
          <input type="checkbox" checked={draft.saveLocal} onChange={(event) => setDraft((current) => ({ ...current, saveLocal: event.target.checked }))} />
          <span>
            <strong>保存到本机浏览器</strong>
            <small>适合本地单机使用。部署给别人时建议只保存到当前会话。</small>
          </span>
        </label>
        {testResult && <div className={`provider-test ${testResult.ok ? "ok" : "bad"}`}>{testResult.message}</div>}
        <div className="model-modal-actions">
          <button className="secondary-action" type="button" onClick={testProvider} disabled={testing}>
            {testing ? <Loader2 className="spin" size={16} /> : <Radar size={16} />}
            测试连接
          </button>
          <button className="primary-action" type="button" onClick={() => onSave(draft)}>
            保存设置
          </button>
        </div>
      </section>
    </div>
  );
}

function OutputDirModal({ value, onClose, onSave }) {
  const [draft, setDraft] = useState(value || "");

  useEffect(() => {
    if (draft) return;
    fetch("/api/default-output-dir")
      .then((response) => response.json())
      .then((data) => {
        if (data?.outputDir) setDraft(data.outputDir);
      })
      .catch(() => {});
  }, [draft]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="model-modal output-dir-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭保存地址设置">
          <X size={18} />
        </button>
        <div className="modal-head">
          <span>Output Folder</span>
          <h3>设定保存地址</h3>
          <p>生成的 HTML、Word、Markdown、字幕和思维导图会保存到这个目录下。建议使用英文路径或系统用户目录。</p>
        </div>
        <label className="modal-field">
          <span>保存目录</span>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="C:\\Users\\你的用户名\\Video Learning Desk" />
        </label>
        <div className="model-modal-actions">
          <button className="secondary-action" type="button" onClick={() => setDraft("")}>
            使用默认目录
          </button>
          <button className="primary-action" type="button" onClick={() => onSave(draft.trim())}>
            保存地址
          </button>
        </div>
      </section>
    </div>
  );
}

function Workspace({ health, initialUrl, onBack, onCollect }) {
  const [url, setUrl] = useState(initialUrl || "");
  const [settings, setSettings] = useState(initialInput);
  const [modelConfig, setModelConfig] = useState(() => loadModelConfig());
  const [outputDir, setOutputDir] = useState(() => loadOutputDir());
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [showOutputSettings, setShowOutputSettings] = useState(false);
  const [strategy, setStrategy] = useState(null);
  const [job, setJob] = useState(null);
  const [message, setMessage] = useState(initialUrl ? "已从收藏盒带入链接，可以开始分析。" : "准备就绪，粘贴视频链接后开始。");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(() => loadHistory());
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [refining, setRefining] = useState(false);
  const [biliAuth, setBiliAuth] = useState(null);
  const [biliAuthBusy, setBiliAuthBusy] = useState(false);
  const pendingCancelRef = useRef(false);

  useEffect(() => {
    setUrl(initialUrl || "");
    setStrategy(null);
    setMessage(initialUrl ? "已从收藏盒带入链接，可以开始分析。" : "准备就绪，粘贴视频链接后开始。");
  }, [initialUrl]);

  const outputs = useMemo(() => {
    if (settings.generateSubtitles && !settings.generateHtml && !settings.generateWord) {
      const textOnlyOutputs = ["subtitles"];
      if (settings.generateMarkmap) textOnlyOutputs.push("markmap");
      return textOnlyOutputs;
    }
    const items = [];
    if (settings.generateHtml) items.push("article_html");
    if (settings.generateWord) items.push("word_docx");
    if (settings.generateMarkmap) items.push("markmap");
    if (settings.generateSubtitles) items.push("subtitles");
    return items;
  }, [settings.generateHtml, settings.generateMarkmap, settings.generateSubtitles, settings.generateWord]);

  useEffect(() => {
    saveModelConfig(modelConfig);
  }, [modelConfig]);

  useEffect(() => {
    if (outputDir) return;
    fetch("/api/default-output-dir")
      .then((response) => response.json())
      .then((data) => {
        if (data?.outputDir) setOutputDir(data.outputDir);
      })
      .catch(() => {});
  }, [outputDir]);

  useEffect(() => {
    saveOutputDir(outputDir);
  }, [outputDir]);

  const platformLabelValue = useMemo(() => strategy?.platform || inferPlatform(url), [strategy?.platform, url]);
  const isBilibiliInput = platformLabelValue === "bilibili";

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "cancelled"].includes(job.status)) return undefined;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        const data = await readJsonResponse(response);
        if (!response.ok) throw new Error(data.error || "任务状态读取失败");
        setJob(data);
        if (["completed", "failed", "cancelled"].includes(data.status)) {
          setBusy(false);
          clearInterval(timer);
        }
      } catch (error) {
        setBusy(false);
        setMessage(error.message);
        clearInterval(timer);
      }
    }, 1800);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (job?.status !== "completed" || !job.result) return;
    const item = rememberHistoryItem({
      url: job.input?.url || url,
      platform: job.platform?.platform || inferPlatform(job.input?.url || url),
      createdAt: job.createdAt,
      completedAt: job.updatedAt,
      result: job.result,
      refinement: job.result.refinement || null,
      title: shortUrl(job.input?.url || url)
    });
    onCollect({
      ...item,
      status: "completed",
      lastAnalyzedAt: job.updatedAt,
      result: job.result,
      refinement: job.result.refinement || null
    });
  }, [job?.status, job?.result]);

  function rememberHistoryItem(item) {
    const cleanUrl = String(item.url || "").trim();
    if (!cleanUrl) return null;
    const historyItem = {
      id: item.result?.context?.sessionDir || `${Date.now()}`,
      url: cleanUrl,
      platform: item.platform || inferPlatform(cleanUrl),
      createdAt: item.createdAt || new Date().toISOString(),
      completedAt: item.completedAt || new Date().toISOString(),
      title: item.title || shortUrl(cleanUrl),
      result: item.result || null,
      refinement: item.refinement || null
    };
    setHistory((items) => [historyItem, ...items.filter((entry) => entry.id !== historyItem.id && entry.url !== cleanUrl)].slice(0, MAX_HISTORY_ITEMS));
    return historyItem;
  }

  function rememberCurrentUrl(nextStrategy = strategy) {
    const cleanUrl = url.trim();
    if (!cleanUrl) return;
    rememberHistoryItem({
      url: cleanUrl,
      platform: nextStrategy?.platform || inferPlatform(cleanUrl),
      title: shortUrl(cleanUrl)
    });
  }

  async function detectPlatform() {
    if (!url.trim()) {
      setMessage("请先粘贴视频链接。");
      return;
    }
    setBusy(true);
    setMessage("正在检测平台和解析路线...");
    try {
      const data = await postJson("/api/detect", { url });
      setStrategy(data);
      rememberCurrentUrl(data);
      setMessage("平台策略已识别。");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openBilibiliLogin() {
    setBiliAuthBusy(true);
    setMessage("正在打开 B 站登录窗口，请在弹出的浏览器中完成登录。");
    try {
      const data = await postJson("/api/auth/bilibili/open", { url });
      setBiliAuth(data);
      setMessage("B 站登录窗口已打开。登录完成后点击“检测登录态”。");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBiliAuthBusy(false);
    }
  }

  async function checkBilibiliAuth() {
    setBiliAuthBusy(true);
    setMessage("正在检测 B 站登录态和 cookies 可用性。");
    try {
      const data = await postJson("/api/auth/bilibili/status", { url });
      setBiliAuth(data);
      setMessage(data.ok ? "B 站登录态可用，后续会自动使用本地 cookies。" : data.message || "B 站登录态暂不可用。");
    } catch (error) {
      setBiliAuth({ ok: false, message: error.message });
      setMessage(error.message);
    } finally {
      setBiliAuthBusy(false);
    }
  }

  async function startAnalyze() {
    if (!url.trim()) {
      setMessage("请先粘贴视频链接。");
      return;
    }
    if (!outputs.length) {
      setMessage("请选择至少一种输出格式。");
      return;
    }
    pendingCancelRef.current = false;
    setBusy(true);
    rememberCurrentUrl();
    onCollect({ url, status: "queued" });
    setMessage("任务已提交，正在自动规划证据帧。");
    try {
      const data = await postJson("/api/jobs", {
        url,
        mode: "learning",
        autoFrameMode: true,
        targetSpeed: "under_3min",
        forceTextTrack: true,
        enableWhisper: "auto",
        generateMarkmap: settings.generateMarkmap,
        outputs,
        modelConfig,
        outputDir,
        articleTemplateMode: "cover_markmap_article"
      });
      if (pendingCancelRef.current) {
        pendingCancelRef.current = false;
        setJob(data);
        const cancelled = await postJson(`/api/jobs/${data.id}/cancel`, {});
        setJob(cancelled);
        setBusy(false);
        setMessage("分析已暂停，后台进程已终止。");
        return;
      }
      setJob(data);
    } catch (error) {
      setBusy(false);
      setMessage(error.message);
    }
  }

  async function cancelAnalyze() {
    if (!busy) return;
    if (!job?.id) {
      pendingCancelRef.current = true;
      setMessage("正在等待任务创建完成后暂停...");
      return;
    }
    setMessage("正在暂停分析并终止后台进程...");
    try {
      const data = await postJson(`/api/jobs/${job.id}/cancel`, {});
      setJob(data);
      setBusy(false);
      setMessage("分析已暂停，后台进程已终止。");
    } catch (error) {
      setMessage(error.message);
    }
  }

  function handleAnalyzeButton() {
    if (busy) {
      cancelAnalyze();
      return;
    }
    startAnalyze();
  }

  async function runRefinement(target) {
    const sessionDir = target?.result?.context?.sessionDir || target?.context?.sessionDir;
    if (!sessionDir) {
      setMessage("没有找到可二次补帧的 session 目录。");
      return;
    }
    setRefining(true);
    setMessage("正在执行二次补帧并重新生成笔记...");
    try {
      const result = await postJson("/api/refine", { sessionDir, rescore: true });
      setMessage("二次补帧完成。");
      if (job?.result?.context?.sessionDir === sessionDir) {
        setJob((value) => ({ ...value, result: { ...value.result, ...result.result, refinement: result.refinement } }));
      }
      setHistory((items) =>
        items.map((item) =>
          item.result?.context?.sessionDir === sessionDir
            ? { ...item, result: { ...item.result, ...result.result, refinement: result.refinement }, refinement: result.refinement }
            : item
        )
      );
      setSelectedHistory((item) =>
        item && item.result?.context?.sessionDir === sessionDir
          ? { ...item, result: { ...item.result, ...result.result, refinement: result.refinement }, refinement: result.refinement }
          : item
      );
    } catch (error) {
      setMessage(error.message);
    } finally {
      setRefining(false);
    }
  }

  return (
    <main className="workspace-screen">
      <aside className="workspace-sidebar">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          返回收藏盒
        </button>

        <div className="sidebar-title">
          <span className="brand-symbol small">
            <Brain size={16} />
          </span>
          <div>
            <h1>Video Learning Desk</h1>
            <p>从视频链接生成学习型图文笔记</p>
          </div>
        </div>

        <label className="field-block">
          <span>视频链接</span>
          <textarea
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setStrategy(null);
            }}
            placeholder="粘贴抖音、B站、YouTube 或网页视频链接"
          />
        </label>

        <div className="auto-frame-panel compact-auto-panel">
          <div className="auto-frame-icon">
            <Wand2 size={18} />
          </div>
          <div>
            <h3>自动文本轨道 + 智能抽帧</h3>
          </div>
        </div>

        <div className="model-config-panel">
          <div className="model-config-copy">
            <span className="model-config-icon">
              <KeyRound size={17} />
            </span>
            <div>
              <strong>模型接口</strong>
              <small>{modelConfigLabel(modelConfig)}</small>
            </div>
          </div>
          <button className="secondary-action compact-action" type="button" onClick={() => setShowModelSettings(true)}>
            <Settings2 size={16} />
            配置 API
          </button>
        </div>

        <div className="model-config-panel output-dir-panel">
          <div className="model-config-copy">
            <span className="model-config-icon">
              <FolderOpen size={17} />
            </span>
            <div>
              <strong>保存地址</strong>
              <small>{outputDir || "正在读取默认目录"}</small>
            </div>
          </div>
          <button className="secondary-action compact-action" type="button" onClick={() => setShowOutputSettings(true)}>
            <Settings2 size={16} />
            设定保存地址
          </button>
        </div>

        <div className="toggle-panel output-toggle-panel">
          <Toggle checked={settings.generateHtml} label="生成HTML" detail="适合阅读和发布的图文页面" onChange={(generateHtml) => setSettings((value) => ({ ...value, generateHtml }))} />
          <Toggle checked={settings.generateWord} label="生成 Word 图文" detail="输出可编辑 DOCX 讲义" onChange={(generateWord) => setSettings((value) => ({ ...value, generateWord }))} />
          <Toggle checked={settings.generateMarkmap} label="生成思维导图" detail="输出精简结构化导图" onChange={(generateMarkmap) => setSettings((value) => ({ ...value, generateMarkmap }))} />
          <Toggle checked={settings.generateSubtitles} label="生成字幕总结" detail="不抽帧，输出字幕文件和逻辑树总结" onChange={(generateSubtitles) => setSettings((value) => ({ ...value, generateSubtitles }))} />
        </div>

        <div className="sidebar-actions single">
          <button className={`primary-action ${busy ? "cancel-action" : ""}`} type="button" onClick={handleAnalyzeButton} disabled={refining}>
            {busy ? <Square size={18} /> : <Play size={18} />}
            {busy ? "暂停分析" : "开始分析"}
          </button>
        </div>
      </aside>

      <section className="desk-main">
        <header className="desk-topbar">
          <div>
            <p className="top-kicker">Workspace</p>
            <div className="desk-title-row">
              <h2>视频学习工作台</h2>
              <span className={`platform-badge ${platformLabelValue === "待识别" ? "idle" : ""}`}>{platformLabelValue}</span>
            </div>
          </div>
          <div className={`health-chip ${health}`}>
            <span />
            {health === "ready" ? "Local Ready" : health === "offline" ? "Backend Offline" : "Checking"}
          </div>
        </header>

        <div className="status-grid">
          <StatusCard icon={<GitBranch size={18} />} title="平台路线" value={strategy ? `${strategy.platform}: ${(strategy.strategyOrder || []).join(" -> ") || "历史记录"}` : "等待检测"} />
          <StatusCard icon={<Wand2 size={18} />} title="文本与画面" value="自动识别文本主线与关键画面" />
          <StatusCard icon={<CheckCircle2 size={18} />} title="当前阶段" value={job?.stage || job?.status || message} />
        </div>

        <div className="result-layout">
          <section className="timeline-panel">
            <PanelTitle title="最近流程" desc="长任务会持续更新阶段，不需要盯着空白页等。" />
            <Timeline job={job} message={message} />
          </section>

          <section className="output-panel">
            <PanelTitle title="输出文件" desc="完成后优先打开图文 HTML 或 Word，再看思维导图与字幕。" />
            <ResultOutput
              job={job}
              platform={platformLabelValue}
              auth={biliAuth}
              authBusy={biliAuthBusy}
              onOpenBilibiliLogin={openBilibiliLogin}
              onCheckBilibiliAuth={checkBilibiliAuth}
              refining={refining}
              onRefine={() => runRefinement(job)}
              onCollect={() => onCollect({ url, status: "saved", result: job?.result || null, refinement: job?.result?.refinement || null })}
            />
          </section>

          <section className="history-panel">
            <div className="history-head">
              <PanelTitle title="历史记录" desc="点击查看历史文件，也可以加入收藏盒。" />
              {history.length > 0 && (
                <button className="ghost-icon-button" type="button" aria-label="清空历史" onClick={() => setHistory([])}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <HistoryList items={history} onSelect={setSelectedHistory} />
          </section>
        </div>
      </section>

      {selectedHistory && (
        <HistoryModal
          item={selectedHistory}
          refining={refining}
          onClose={() => setSelectedHistory(null)}
          onRefine={() => runRefinement(selectedHistory)}
          onCollect={() => onCollect({ ...selectedHistory, status: selectedHistory.result ? "completed" : "saved" })}
        />
      )}
      {showModelSettings && (
        <ModelSettingsModal
          value={modelConfig}
          onClose={() => setShowModelSettings(false)}
          onSave={(nextConfig) => {
            setModelConfig(nextConfig);
            setShowModelSettings(false);
          }}
        />
      )}
      {showOutputSettings && (
        <OutputDirModal
          value={outputDir}
          onClose={() => setShowOutputSettings(false)}
          onSave={(nextDir) => {
            setOutputDir(nextDir);
            setShowOutputSettings(false);
          }}
        />
      )}
    </main>
  );
}

function ModeButton({ active, icon, title, desc, onClick }) {
  return (
    <button className={`mode-card ${active ? "active" : ""}`} type="button" onClick={onClick}>
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
    </button>
  );
}

function Toggle({ checked, label, detail, onChange }) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function StatusCard({ icon, title, value }) {
  return (
    <article className="status-card">
      <span className="status-icon">{icon}</span>
      <p>{title}</p>
      <strong>{value}</strong>
    </article>
  );
}

function BilibiliAuthPanel({ auth, busy, onOpen, onCheck }) {
  return (
    <div className={`platform-auth-panel ${auth?.ok ? "ready" : ""}`}>
      <div className="model-config-copy">
        <span className="model-config-icon">
          <KeyRound size={17} />
        </span>
        <div>
          <strong>B 站登录助手</strong>
          <small>{auth?.ok ? "登录态可用" : auth?.message || "用于解决 412、登录态和音频拦截"}</small>
        </div>
      </div>
      <div className={`platform-auth-actions ${config.secondary ? "" : "single"}`}>
        <button className="secondary-action compact-action" type="button" onClick={onOpen} disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <ExternalLink size={16} />}
          打开登录
        </button>
        <button className="secondary-action compact-action" type="button" onClick={onCheck} disabled={busy}>
          <Radar size={16} />
          检测登录态
        </button>
      </div>
    </div>
  );
}

function PlatformLoginRecovery({ platform, auth, busy, onOpenBilibiliLogin, onCheckBilibiliAuth }) {
  const normalized = String(platform || "").toLowerCase();
  const loginTargets = {
    bilibili: {
      title: "B 站登录助手",
      detail: auth?.ok ? "登录态可用，可以重新分析。" : auth?.message || "当前失败可能与 cookies、登录态或 412 拦截有关。",
      primary: "打开登录",
      secondary: "检测登录态",
      onPrimary: onOpenBilibiliLogin,
      onSecondary: onCheckBilibiliAuth
    },
    douyin: {
      title: "抖音登录助手",
      detail: "当前失败可能与登录态、反爬或链接权限有关。请先在浏览器完成登录，再重新分析。",
      primary: "打开抖音",
      onPrimary: () => window.open("https://www.douyin.com/", "_blank", "noreferrer")
    },
    youtube: {
      title: "YouTube 登录助手",
      detail: "当前失败可能与字幕权限、地区限制或 cookies 有关。请先在浏览器完成登录，再重新分析。",
      primary: "打开 YouTube",
      onPrimary: () => window.open("https://www.youtube.com/", "_blank", "noreferrer")
    }
  };
  const config = loginTargets[normalized];
  if (!config) return null;
  return (
    <div className={`platform-auth-panel recovery-auth-panel ${auth?.ok ? "ready" : ""}`}>
      <div className="model-config-copy">
        <span className="model-config-icon">
          <KeyRound size={17} />
        </span>
        <div>
          <strong>{config.title}</strong>
          <small>{config.detail}</small>
        </div>
      </div>
      <div className="platform-auth-actions">
        <button className="secondary-action compact-action" type="button" onClick={config.onPrimary} disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <ExternalLink size={16} />}
          {config.primary}
        </button>
        {config.secondary && (
          <button className="secondary-action compact-action" type="button" onClick={config.onSecondary} disabled={busy}>
            <Radar size={16} />
            {config.secondary}
          </button>
        )}
      </div>
    </div>
  );
}

function PanelTitle({ title, desc }) {
  return (
    <div className="panel-title">
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}

function Timeline({ job, message }) {
  const events = job?.events || [];
  if (!events.length) return <div className="empty-state">{message}</div>;
  return (
    <div className="timeline-list">
      {[...events].reverse().map((event, index) => (
        <div className="timeline-item" key={`${event.at}-${index}`}>
          <time>{formatTime(event.at)}</time>
          <div>
            <strong>{event.stage}</strong>
            <p>{event.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultOutput({
  job,
  platform,
  auth,
  authBusy,
  onOpenBilibiliLogin,
  onCheckBilibiliAuth,
  refining,
  onRefine,
  onCollect
}) {
  if (!job) return <div className="empty-state">提交任务后，这里会显示图文 HTML、Word、思维导图和字幕文件。</div>;
  if (job.status === "failed") {
    return (
      <div className="result-stack">
        <div className="error-box">
          <strong>分析失败</strong>
          <p>{job.error || "未知错误"}</p>
        </div>
        {shouldShowLoginRecovery(job.error) && (
          <PlatformLoginRecovery
            platform={platform}
            auth={auth}
            busy={authBusy}
            onOpenBilibiliLogin={onOpenBilibiliLogin}
            onCheckBilibiliAuth={onCheckBilibiliAuth}
          />
        )}
        <button className="secondary-action" type="button" onClick={onCollect}>
          <BookmarkPlus size={16} />
          加入收藏盒
        </button>
      </div>
    );
  }
  if (job.status !== "completed") return <div className="empty-state">正在处理：{job.stage || job.status}</div>;
  const files = collectResultFiles(job.result);
  const suggestRefine = job.result?.refinement?.suggest;
  return (
    <div className="result-stack">
      {suggestRefine && <RefineCard refinement={job.result.refinement} refining={refining} onRefine={onRefine} />}
      <button className="secondary-action collect-result-button" type="button" onClick={onCollect}>
        <BookmarkPlus size={16} />
        加入收藏盒
      </button>
      <div className="file-grid output-files" aria-label="生成文件列表">
        {files.map((file) => (
          <ResultFileCard key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}

function ResultFileCard({ file }) {
  const Icon = file.icon || FileText;
  return (
    <a
      className={`file-card ${file.primary ? "primary-file" : ""}`}
      href={`/api/file?path=${encodeURIComponent(file.path)}`}
      target="_blank"
      rel="noreferrer"
    >
      <div className="file-card-icon">
        <Icon size={18} />
      </div>
      <div className="file-card-copy">
        <span>{file.label}</span>
        <small>{file.hint}</small>
        <code>{file.path}</code>
      </div>
      <div className="file-open-chip">
        打开
        <ExternalLink size={14} />
      </div>
    </a>
  );
}

function RefineCard({ refinement, refining, onRefine }) {
  const gaps = refinement?.plan?.gaps || refinement?.articleCheck?.gaps || [];
  return (
    <div className="refine-card">
      <div>
        <strong>建议二次补帧</strong>
        <p>{gaps.length ? `检测到 ${gaps.length} 个证据缺口，建议补抓关键截图后重算。` : "文章自检发现证据不足，建议补帧优化。"}</p>
      </div>
      <button type="button" onClick={onRefine} disabled={refining}>
        {refining ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
        二次补帧并重算
      </button>
    </div>
  );
}

function HistoryList({ items, onSelect }) {
  if (!items.length) return <div className="empty-state">暂无历史记录。</div>;
  return (
    <div className="history-list">
      {items.map((item) => (
        <button className="history-item" type="button" key={item.id} onClick={() => onSelect(item)}>
          <span>{item.platform}</span>
          <strong>{item.title}</strong>
          <small>{formatDate(item.completedAt || item.createdAt)}</small>
        </button>
      ))}
    </div>
  );
}

function HistoryModal({ item, refining, onClose, onRefine, onCollect }) {
  const files = collectResultFiles(item.result);
  const suggestRefine = item.refinement?.suggest || item.result?.refinement?.suggest;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="history-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭历史文件">
          <X size={18} />
        </button>
        <div className="modal-head">
          <span>{item.platform}</span>
          <h3>{item.title}</h3>
          <p>{item.url}</p>
        </div>
        {suggestRefine && <RefineCard refinement={item.refinement || item.result?.refinement} refining={refining} onRefine={onRefine} />}
        <button className="secondary-action collect-result-button" type="button" onClick={onCollect}>
          <BookmarkPlus size={16} />
          加入收藏盒
        </button>
        <div className="file-grid output-files">
          {files.length ? (
            files.map((file) => (
              <ResultFileCard key={file.path} file={file} />
            ))
          ) : (
            <div className="empty-state">这个历史项只有链接，还没有生成文件。</div>
          )}
        </div>
      </section>
    </div>
  );
}

function collectResultFiles(result) {
  if (!result) return [];
  const files = [];
  if (result.subtitleSummaryPath) files.push({ label: "字幕逻辑树总结", hint: "不抽帧的快速内容总结", path: result.subtitleSummaryPath, icon: GitBranch, primary: !result.articlePath });
  if (result.subtitlesTextPath) files.push({ label: "字幕 TXT", hint: "纯文本字幕，便于复制", path: result.subtitlesTextPath, icon: FileText });
  if (result.articlePath) files.push({ label: "图文 HTML", hint: "推荐先看，图文排版版", path: result.articlePath, icon: FileText, primary: true });
  if (result.wordPath) files.push({ label: "Word 笔记", hint: "可编辑 DOCX，适合继续改写", path: result.wordPath, icon: FileText });
  if (result.markmapPath) files.push({ label: "思维导图 HTML", hint: "精简结构版总结", path: result.markmapPath, icon: GitBranch });
  if (result.context?.sessionDir) files.push({ label: "Session 目录", hint: "证据帧和中间文件", path: result.context.sessionDir, icon: FolderOpen });
  return files;
}

function shouldShowLoginRecovery(error) {
  const text = String(error || "").toLowerCase();
  return /cookie|cookies|login|登录|412|403|forbidden|precondition|anti-bot|captcha|verify|验证|权限|unauthorized/.test(text);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_ITEMS) : [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY_ITEMS)));
  } catch {
    // localStorage can be disabled in hardened browsers.
  }
}

function loadCollection() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLECTION_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCollection(items) {
  try {
    localStorage.setItem(COLLECTION_KEY, JSON.stringify(items));
  } catch {
    // localStorage can be disabled in hardened browsers.
  }
}

function loadModelConfig() {
  const fallback = {
    provider: "dashscope",
    apiKey: "",
    baseUrl: defaultBaseUrl("dashscope"),
    visionModel: "qwen3-vl-plus",
    textModel: "qwen3-vl-plus",
    saveLocal: true
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_CONFIG_KEY) || "{}");
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function saveModelConfig(config) {
  try {
    if (config?.saveLocal === false) {
      localStorage.removeItem(MODEL_CONFIG_KEY);
      return;
    }
    localStorage.setItem(MODEL_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // localStorage can be disabled in hardened browsers.
  }
}

function loadOutputDir() {
  try {
    return localStorage.getItem(OUTPUT_DIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveOutputDir(value) {
  try {
    const dir = String(value || "").trim();
    if (dir) localStorage.setItem(OUTPUT_DIR_KEY, dir);
    else localStorage.removeItem(OUTPUT_DIR_KEY);
  } catch {
    // localStorage can be disabled in hardened browsers.
  }
}

function defaultBaseUrl(provider) {
  return {
    dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    openrouter: "https://openrouter.ai/api/v1",
    siliconflow: "https://api.siliconflow.cn/v1",
    openai: "https://api.openai.com/v1",
    custom: ""
  }[provider] || "";
}

function defaultVisionModel(provider) {
  return {
    dashscope: "qwen3-vl-plus",
    openrouter: "",
    siliconflow: "Qwen/Qwen2.5-VL-72B-Instruct",
    openai: "",
    custom: ""
  }[provider] || "";
}

function modelConfigLabel(config) {
  const provider = config?.provider || "dashscope";
  const model = config?.visionModel || config?.model || "qwen3-vl-plus";
  const keyState = config?.apiKey ? "已填写 Key" : "未填写 Key";
  return `${provider} · ${model || "未选择模型"} · ${keyState}`;
}

function extractUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s"'<>，。！？；、）】]+/i);
  return match ? match[0] : "";
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/$/, "");
}

function inferPlatform(value) {
  const text = String(value || "").toLowerCase();
  if (!text.trim()) return "待识别";
  if (text.includes("douyin.com")) return "douyin";
  if (text.includes("bilibili.com") || text.includes("b23.tv")) return "bilibili";
  if (text.includes("youtube.com") || text.includes("youtu.be")) return "youtube";
  if (/https?:\/\//.test(text)) return "web";
  return "unknown";
}

function platformLabel(platform) {
  return {
    all: "全部",
    douyin: "抖音",
    bilibili: "B站",
    youtube: "YouTube",
    web: "网页视频",
    unknown: "其他",
    "待识别": "待识别"
  }[platform] || platform || "其他";
}

function platformCounts(items) {
  return items.reduce((acc, item) => {
    acc[item.platform] = (acc[item.platform] || 0) + 1;
    return acc;
  }, {});
}

function makeCardTitle(url, platform) {
  return `${platformLabel(platform)}视频 · ${formatDate(new Date().toISOString())}`;
}

function statusMeta(status) {
  return {
    saved: { label: "未总结", className: "saved" },
    queued: { label: "已排队", className: "queued" },
    analyzing: { label: "分析中", className: "analyzing" },
    completed: { label: "已总结", className: "completed" },
    failed: { label: "失败", className: "failed" }
  }[status] || { label: "未总结", className: "saved" };
}

function shortUrl(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 38 ? `${text.slice(0, 38)}...` : text || "未命名任务";
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

createRoot(document.getElementById("root")).render(<App />);
