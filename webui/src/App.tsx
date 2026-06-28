import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowRight,
  Archive,
  CheckCircle2,
  Clock3,
  Trash2,
  ExternalLink,
  FolderOpen,
  Inbox,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  addTopicFolder,
  createJob,
  deleteJob,
  discoverModelOptions,
  distillLibraryFolder,
  fetchConfig,
  fetchHealth,
  fetchJob,
  fetchJobs,
  fetchLibraryFolders,
  processJob,
  retryJob,
  stageLabels,
  testModelConfig,
  updateJobTopic,
  updateAppConfig,
  updateModelConfig,
} from "./api";
import GradientText from "./components/GradientText";
import Prism from "./components/Prism";
import SplitText from "./components/SplitText";
import type { AppConfig, LibraryFolder, Job, JobStage, JobStatus, ModelConfig, ModelOption } from "./types";

type ViewKey = "collection" | "workspace" | "library" | "settings";

const navItems: Array<{
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { key: "collection", label: "收藏页", icon: Inbox },
  { key: "workspace", label: "工作台", icon: Activity },
  { key: "library", label: "沉淀池", icon: Archive },
  { key: "settings", label: "设置", icon: Settings2 },
];

const emptyJobs: Job[] = [];
const emptyLibraryFolders: LibraryFolder[] = [];
const preferredModelOrder = [
  "qwen3.5-non-thinking",
  "qwen3.5",
  "smart/default",
  "claude-haiku-4-5",
  "glm-chat",
  "qwen3.6-chat",
  "deepseek-v4-flash-ascend",
  "qwen-chat",
];

type ThemeMode = "深色研究工作台" | "低对比夜间模式" | "明亮知识库模式";

function applyTheme(theme: string) {
  const root = document.documentElement;
  root.dataset.theme = theme;
}

function pickPreferredModel(models: ModelOption[], currentModel: string) {
  const ids = new Set(models.map((model) => model.id));
  for (const preferred of preferredModelOrder) {
    if (ids.has(preferred)) return preferred;
  }
  if (currentModel && ids.has(currentModel)) return currentModel;
  return models[0]?.id || currentModel;
}

async function findFirstWorkingModel(baseDraft: ModelConfig, models: ModelOption[]) {
  const orderedIds = [
    ...preferredModelOrder.filter((id) => models.some((model) => model.id === id)),
    ...models.map((model) => model.id),
  ].filter((id, index, array) => array.indexOf(id) === index);

  const failures: string[] = [];
  for (const modelId of orderedIds.slice(0, 6)) {
    try {
      await testModelConfig({
        ...baseDraft,
        model: modelId,
        timeout: Math.min(baseDraft.timeout || 60, 60),
      });
      return { model: modelId, failures };
    } catch (error) {
      failures.push(`${modelId}: ${error instanceof Error ? error.message : "测试失败"}`);
    }
  }

  return { model: "", failures };
}

function LoadingDot() {
  return <span className="loading-dot" aria-hidden="true" />;
}

function App() {
  const queryClient = useQueryClient();
  useEffect(() => {
    applyTheme(localStorage.getItem("clipmind.theme") || "深色研究工作台");
  }, []);
  const [showLanding, setShowLanding] = useState(true);
  const [view, setView] = useState<ViewKey>("collection");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [filter, setFilter] = useState<"all" | JobStatus>("all");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");

  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: fetchJobs,
    refetchInterval: 3_000,
  });

  const selectedJobQuery = useQuery({
    queryKey: ["job", selectedJobId],
    queryFn: () => fetchJob(selectedJobId!),
    enabled: Boolean(selectedJobId),
    refetchInterval: selectedJobId ? 3_000 : false,
  });

  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: fetchConfig,
  });

  const jobs = jobsQuery.data ?? emptyJobs;
  const selectedJob = selectedJobQuery.data ?? jobs.find((job) => job.id === selectedJobId) ?? null;
  const runningJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const completedJobs = jobs.filter((job) => job.status === "done");

  const filteredJobs = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return jobs.filter((job) => {
      const statusOk = filter === "all" || job.status === filter;
      const queryOk =
        !keyword ||
        [job.title, job.url, job.topic, job.output_path].filter(Boolean).join(" ").toLowerCase().includes(keyword);
      return statusOk && queryOk;
    });
  }, [filter, jobs, query]);

  const createMutation = useMutation({
    mutationFn: ({ url, processNow }: { url: string; processNow: boolean }) => createJob(url, true, processNow),
    onSuccess: async (job, variables) => {
      setUrlDraft("");
      setMessage(variables.processNow ? "已加入工作台" : "已收藏到 Inbox");
      setSelectedJobId(job.id);
      setView(variables.processNow ? "workspace" : "collection");
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "创建任务失败");
    },
  });

  function submitUrl(event: React.FormEvent<HTMLFormElement>, processNow = true) {
    event.preventDefault();
    createFromDraft(processNow);
  }

  function createFromDraft(processNow: boolean) {
    const url = urlDraft.trim();
    if (!url) {
      setMessage("请输入视频链接");
      return;
    }
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes("youtube.com") && !parsed.hostname.includes("youtu.be")) {
        setMessage("当前先支持 YouTube 链接");
        return;
      }
    } catch {
      setMessage("链接格式不正确");
      return;
    }
    setMessage("");
    createMutation.mutate({ url, processNow });
  }

  function goHome() {
    setShowLanding(true);
  }

  if (showLanding) {
    return <LandingPage ok={Boolean(healthQuery.data?.ok)} onEnter={() => setShowLanding(false)} />;
  }

  return (
    <div className="app-shell notranslate" translate="no">
      <aside className="sidebar">
        <button type="button" className="brand-row brand-home-button" onClick={goHome}>
          <div className="brand-mark">
            <img src="/yingji-logo.png" alt="影记 logo" />
          </div>
          <div className="brand-copy">
            <img className="brand-wordmark" src="/branding/yingji-wordmark-dark-240.png" alt="影记" />
            <span>视频知识库</span>
          </div>
        </button>

        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className={`nav-button ${view === item.key ? "active" : ""}`}
                onClick={() => setView(item.key)}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <RuntimeBadge ok={Boolean(healthQuery.data?.ok)} />
          <div className="mini-stat">
            <span>队列</span>
            <strong>{runningJobs.length}</strong>
          </div>
          <div className="mini-stat">
            <span>沉淀</span>
            <strong>{completedJobs.length}</strong>
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div>
            <span className="section-kicker">{viewTitle(view).kicker}</span>
            <h1>{viewTitle(view).title}</h1>
          </div>
          <div className="topbar-actions">
            <RuntimeBadge ok={Boolean(healthQuery.data?.ok)} compact />
            <button
              type="button"
              className="icon-text-button"
              onClick={() => {
                void healthQuery.refetch();
                void jobsQuery.refetch();
                if (selectedJobId) void selectedJobQuery.refetch();
              }}
            >
              <RefreshCw size={16} />
              刷新
            </button>
          </div>
        </header>

        {view === "collection" && (
          <CapturePanel
            urlDraft={urlDraft}
            setUrlDraft={setUrlDraft}
            submitUrl={submitUrl}
            createFromDraft={createFromDraft}
            pending={createMutation.isPending}
            message={message}
          />
        )}

        {view === "collection" && (
          <motion.section className="surface collection-view" {...fadeIn}>
            <Toolbar filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} />
            <JobCardGrid jobs={filteredJobs} onSelect={setSelectedJobId} setView={setView} />
          </motion.section>
        )}

        {view === "workspace" && (
          <motion.section className="workspace-view" {...fadeIn}>
            <section className="surface job-rail">
              <Toolbar filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} compact />
              <JobList jobs={filteredJobs} onSelect={setSelectedJobId} selectedId={selectedJobId} empty="没有匹配任务" />
            </section>
            <JobDetail job={selectedJob} loading={selectedJobQuery.isLoading} config={configQuery.data ?? null} />
          </motion.section>
        )}

        {view === "library" && (
          <LibraryView config={configQuery.data ?? null} />
        )}

        {view === "settings" && (
          <motion.section className="settings-page" {...fadeIn}>
            <div className="settings-stack">
              <PreferenceSettings />
              <ObsidianSettings config={configQuery.data ?? null} />
            </div>
            <ModelSettings />
          </motion.section>
        )}
      </main>
    </div>
  );
}

const fadeIn = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, ease: "easeOut" },
} as const;

function CapturePanel({
  urlDraft,
  setUrlDraft,
  submitUrl,
  createFromDraft,
  pending,
  message,
}: {
  urlDraft: string;
  setUrlDraft: (value: string) => void;
  submitUrl: (event: React.FormEvent<HTMLFormElement>, processNow?: boolean) => void;
  createFromDraft: (processNow: boolean) => void;
  pending: boolean;
  message: string;
}) {
  return (
    <section className="capture-panel">
      <form onSubmit={(event) => submitUrl(event, true)} className="capture-form">
        <label className="url-field">
          <Link2 size={17} />
          <input
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            placeholder="粘贴 YouTube 视频链接"
            aria-label="YouTube 视频链接"
          />
        </label>
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? <LoadingDot /> : <Plus size={17} />}
          收藏并处理
        </button>
        <button className="secondary-button save-only-button" type="button" disabled={pending} onClick={() => createFromDraft(false)}>
          <Inbox size={17} />
          仅收藏
        </button>
      </form>
      <span className="capture-message">{message || "仅收藏会进入 Inbox，收藏并处理会立即生成 Obsidian 笔记。"}</span>
    </section>
  );
}

function LandingPage({ ok, onEnter }: { ok: boolean; onEnter: () => void }) {
  return (
    <main className="landing-screen">
      <div className="ambient-grid" />
      <nav className="landing-nav">
        <button
          type="button"
          className="brand-lockup brand-home-button landing-brand-button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <span className="brand-symbol">
            <img src="/yingji-logo.png" alt="影记 logo" />
          </span>
          <img className="landing-wordmark" src="/branding/yingji-wordmark-dark-320.png" alt="影记" />
        </button>
        <div className={`health-chip ${ok ? "ready" : "offline"}`}>
          <span />
          {ok ? "Local Ready" : "Backend Offline"}
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
            <b>Collect, summarize, remember</b>
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
          <p>收藏 YouTube 视频，提取字幕，生成结构化总结，并写入你的 Obsidian 知识库。</p>
          <div className="landing-actions centered">
            <button className="hero-button" type="button" onClick={onEnter}>
              开始使用
              <ArrowRight size={19} />
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function RuntimeBadge({ ok, compact = false }: { ok: boolean; compact?: boolean }) {
  return (
    <span className={`runtime-badge ${ok ? "online" : "offline"} ${compact ? "compact" : ""}`}>
      {ok ? <Wifi size={14} /> : <WifiOff size={14} />}
      {ok ? "Backend Online" : "Backend Offline"}
    </span>
  );
}

function PanelHeader({ title, count }: { title: string; count?: number }) {
  return (
    <header className="panel-header">
      <h2>{title}</h2>
      {typeof count === "number" && <span>{count}</span>}
    </header>
  );
}

function Toolbar({
  filter,
  setFilter,
  query,
  setQuery,
  compact = false,
  onlyDone = false,
}: {
  filter: "all" | JobStatus;
  setFilter: (value: "all" | JobStatus) => void;
  query: string;
  setQuery: (value: string) => void;
  compact?: boolean;
  onlyDone?: boolean;
}) {
  const options: Array<["all" | JobStatus, string]> = onlyDone
    ? [["done", "已沉淀"]]
    : [
        ["all", "全部"],
        ["saved", "仅收藏"],
        ["queued", "排队"],
        ["running", "运行"],
        ["done", "完成"],
        ["failed", "失败"],
      ];
  return (
    <div className={`toolbar ${compact ? "compact" : ""}`}>
      {!compact && (
        <div className="segmented">
          {options.map(([value, label]) => (
            <button
              key={value}
              className={filter === value || onlyDone ? "active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="search-field">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、链接、主题" />
      </label>
    </div>
  );
}

function JobList({
  jobs,
  onSelect,
  selectedId,
  empty,
}: {
  jobs: Job[];
  onSelect: (id: string) => void;
  selectedId?: string | null;
  empty: string;
}) {
  if (!jobs.length) return <EmptyState text={empty} />;
  return (
    <div className="job-list">
      {jobs.map((job) => (
        <button
          key={job.id}
          type="button"
          className={`job-list-row ${selectedId === job.id ? "active" : ""}`}
          onClick={() => onSelect(job.id)}
        >
          <div>
            <strong>{job.title || extractVideoId(job.url)}</strong>
            <small>{job.topic || labelForStage(job.stage)} · {formatTime(job.updated_at)}</small>
          </div>
          <StatusBadge status={job.status} />
        </button>
      ))}
    </div>
  );
}

function JobCardGrid({ jobs, onSelect, setView }: { jobs: Job[]; onSelect: (id: string) => void; setView: (view: ViewKey) => void }) {
  const queryClient = useQueryClient();
  const processMutation = useMutation({
    mutationFn: processJob,
    onSuccess: async (job) => {
      onSelect(job.id);
      setView("workspace");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["job", job.id] }),
      ]);
    },
  });
  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async (job) => {
      onSelect(job.id);
      setView("workspace");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["job", job.id] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  if (!jobs.length) return <EmptyState text="收藏页还没有视频" />;
  return (
    <div className="collection-grid">
      {jobs.map((job) => (
        <article className="video-card" key={job.id}>
          <div className="video-card-top">
            <StatusBadge status={job.status} />
            <span>{job.topic || "未分类"}</span>
          </div>
          <h2>{job.title || extractVideoId(job.url)}</h2>
          <p>{job.url}</p>
          <div className="video-card-meta">
            <span>{labelForStage(job.stage)}</span>
            <span>{formatTime(job.updated_at)}</span>
          </div>
          <div className="card-actions">
            {job.status === "saved" && (
              <button type="button" onClick={() => processMutation.mutate(job.id)} disabled={processMutation.isPending}>
                {processMutation.isPending ? <LoadingDot /> : <Activity size={15} />}
                开始总结
              </button>
            )}
            {(job.status === "done" || job.status === "failed") && (
              <button type="button" onClick={() => retryMutation.mutate(job.id)} disabled={retryMutation.isPending}>
                {retryMutation.isPending ? <LoadingDot /> : <RefreshCw size={15} />}
                重新总结
              </button>
            )}
            <a href={job.url} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              打开
            </a>
            <button
              type="button"
              className="danger-action"
              onClick={() => {
                if (window.confirm("确定要删除这条收藏和任务记录吗？")) {
                  deleteMutation.mutate(job.id);
                }
              }}
              disabled={deleteMutation.isPending || job.status === "running"}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function LibraryView({ config }: { config: AppConfig | null }) {
  const queryClient = useQueryClient();
  const [selectedTopic, setSelectedTopic] = useState<string>("");
  const [feedback, setFeedback] = useState("");
  const libraryQuery = useQuery({
    queryKey: ["library-folders"],
    queryFn: fetchLibraryFolders,
    refetchInterval: 15_000,
  });
  const folders = libraryQuery.data ?? emptyLibraryFolders;
  const selectedFolder = folders.find((folder) => folder.topic === selectedTopic) ?? folders[0] ?? null;

  useEffect(() => {
    if (!selectedTopic && folders[0]) {
      setSelectedTopic(folders[0].topic);
    }
  }, [folders, selectedTopic]);

  const distillMutation = useMutation({
    mutationFn: distillLibraryFolder,
    onSuccess: async (result) => {
      setFeedback(`已生成文件夹知识蒸馏：${result.path}`);
      await queryClient.invalidateQueries({ queryKey: ["library-folders"] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "AI 蒸馏失败");
    },
  });

  if (libraryQuery.isLoading) {
    return (
      <motion.section className="surface library-view" {...fadeIn}>
        <EmptyState text="正在读取 Obsidian 文件夹" />
      </motion.section>
    );
  }

  if (!folders.length) {
    return (
      <motion.section className="surface library-view" {...fadeIn}>
        <EmptyState text="还没有可用的 Obsidian 分类，请先在工作台或设置中创建分类" />
      </motion.section>
    );
  }

  return (
    <motion.section className="library-console" {...fadeIn}>
      <aside className="surface library-sidebar">
        <PanelHeader title="知识文件夹" count={folders.length} />
        <div className="folder-list">
          {folders.map((folder) => (
            <button
              key={folder.topic}
              type="button"
              className={selectedFolder?.topic === folder.topic ? "active" : ""}
              onClick={() => setSelectedTopic(folder.topic)}
            >
              <span>{folder.topic}</span>
              <small>{folder.note_count} 篇</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="surface library-main">
        {selectedFolder && <FolderKnowledgePanel folder={selectedFolder} config={config} />}
        <section className="distill-panel">
          <div>
            <strong>AI 知识蒸馏</strong>
            <p>对当前文件夹内的 Markdown 笔记做一次综合归纳，并写入“文件夹知识蒸馏.md”。</p>
          </div>
          <button
            type="button"
            className="primary-button compact-primary"
            disabled={!selectedFolder || distillMutation.isPending}
            onClick={() => selectedFolder && distillMutation.mutate(selectedFolder.topic)}
          >
            {distillMutation.isPending ? <LoadingDot /> : <Sparkles size={16} />}
            蒸馏本文件夹
          </button>
          <span>{feedback || selectedFolder?.distillation_path || "蒸馏结果会保存回当前 Obsidian 文件夹。"}</span>
        </section>
      </section>
    </motion.section>
  );
}

function FolderKnowledgePanel({ folder, config }: { folder: LibraryFolder; config: AppConfig | null }) {
  const rootPath = config?.obsidian_output_dir || "";
  return (
    <div className="folder-panel">
      <header className="folder-panel-header">
        <div>
          <span>{folder.folder}</span>
          <h2>{folder.topic}</h2>
          <p>{folder.path || rootPath}</p>
        </div>
        <div className="folder-stats">
          <strong>{folder.note_count}</strong>
          <span>Markdown 笔记</span>
        </div>
      </header>

      <div className="folder-note-list">
        {folder.notes.map((note) => (
          <article className="folder-note" key={note.path}>
            <div>
              <strong>{note.title}</strong>
              <p>{note.preview || "暂无预览"}</p>
            </div>
            <span>{formatTime(note.updated_at)}</span>
          </article>
        ))}
        {!folder.notes.length && <EmptyState text="这个文件夹还没有 Markdown 笔记" />}
      </div>
    </div>
  );
}

function JobDetail({ job, loading, config }: { job: Job | null; loading: boolean; config: AppConfig | null }) {
  const queryClient = useQueryClient();
  const retryMutation = useMutation({
    mutationFn: retryJob,
    onSuccess: async (updatedJob) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["job", updatedJob.id] }),
      ]);
    },
  });

  if (loading) {
    return (
      <section className="surface job-detail empty-detail">
        <LoaderCircle size={20} className="spin" />
      </section>
    );
  }
  if (!job) {
    return (
      <section className="surface job-detail empty-detail">
        <Sparkles size={22} />
        <span>选择一个任务查看处理细节</span>
      </section>
    );
  }
  const summaryInfo = getSummaryInfo(job);
  const canRetry = job.status === "done" || job.status === "failed";
  return (
    <section className="surface job-detail">
      <header className="detail-header">
        <div className="detail-title-row">
          <StatusBadge status={job.status} />
          {canRetry && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => retryMutation.mutate(job.id)}
              disabled={retryMutation.isPending}
            >
              {retryMutation.isPending ? <LoadingDot /> : <RefreshCw size={15} />}
              重新处理
            </button>
          )}
        </div>
        <div>
          <h2>{job.title || extractVideoId(job.url)}</h2>
          <p>{job.url}</p>
        </div>
      </header>
      {summaryInfo && (
        <section className={`model-status-card ${summaryInfo.kind}`}>
          <div>
            <strong>{summaryInfo.title}</strong>
            <p>{summaryInfo.detail}</p>
          </div>
        </section>
      )}
      <ArchiveControls job={job} config={config} />
      <StageTimeline current={job.stage} status={job.status} />
      <section className="result-box">
        <div>
          <strong>输出文件</strong>
          <p>{job.output_path || "任务完成后显示 Markdown 路径"}</p>
        </div>
      </section>
      {job.error_message && <pre className="error-box">{job.error_message}</pre>}
    </section>
  );
}

function getSummaryInfo(job: Job) {
  const raw = typeof job.meta?.summary_source === "string" ? job.meta.summary_source : "";
  if (!raw) return null;
  if (raw.startsWith("extractive_fallback:")) {
    return {
      kind: "warning",
      title: "已写入临时摘要，模型分析未完成",
      detail: raw.replace("extractive_fallback:", "").trim() || "模型调用失败，系统已使用字幕兜底摘要。",
    };
  }
  if (raw.includes(":chunked:")) {
    const parts = raw.split(":chunked:");
    return {
      kind: "success",
      title: "已使用大模型分段总结",
      detail: `模型来源：${parts[0]}，分段数量：${parts[1]}。`,
    };
  }
  if (raw.endsWith(":direct_truncated")) {
    return {
      kind: "success",
      title: "已使用大模型快速总结",
      detail: `模型来源：${raw.replace(":direct_truncated", "")}，长字幕已压缩到单次请求。`,
    };
  }
  if (raw.endsWith(":direct")) {
    return {
      kind: "success",
      title: "已使用大模型直接总结",
      detail: `模型来源：${raw.replace(":direct", "")}，未触发分段。`,
    };
  }
  return {
    kind: "success",
    title: "已使用大模型生成总结",
    detail: `模型来源：${raw}。`,
  };
}

function ArchiveControls({ job, config }: { job: Job; config: AppConfig | null }) {
  const queryClient = useQueryClient();
  const topics = Object.keys(config?.topic_folders ?? {});
  const initialTopic = job.topic || (typeof job.meta?.preferred_topic === "string" ? job.meta.preferred_topic : "") || topics[0] || "其他";
  const [selectedTopic, setSelectedTopic] = useState(initialTopic);
  const [newTopic, setNewTopic] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    setSelectedTopic(initialTopic);
  }, [initialTopic, job.id]);

  const updateTopicMutation = useMutation({
    mutationFn: ({ jobId, topic }: { jobId: string; topic: string }) => updateJobTopic(jobId, topic),
    onSuccess: async (updatedJob) => {
      setFeedback("归档主题已保存，下一次处理会写入对应文件夹。");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["job", updatedJob.id] }),
      ]);
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "保存主题失败");
    },
  });

  const addTopicMutation = useMutation({
    mutationFn: ({ topic, folder }: { topic: string; folder: string }) => addTopicFolder(topic, folder),
    onSuccess: async () => {
      setSelectedTopic(newTopic.trim());
      setNewTopic("");
      setFeedback("新分类已创建，可以保存到当前任务。");
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "创建分类失败");
    },
  });

  const targetFolder = config?.topic_folders?.[selectedTopic] || selectedTopic;
  const targetPath = config ? `${config.obsidian_output_dir}/${targetFolder}` : "正在读取配置";

  function createTopic() {
    const topic = newTopic.trim();
    if (!topic) {
      setFeedback("请输入分类名称");
      return;
    }
    addTopicMutation.mutate({ topic, folder: topic });
  }

  return (
    <section className="archive-control-panel">
      <div className="archive-control-header">
        <div>
          <strong>归档设置</strong>
          <p>选择这个视频要写入的 Obsidian 文件夹。已完成笔记需要重新总结后才会按新目录写入。</p>
        </div>
      </div>

      <div className="archive-form-grid">
        <label className="settings-field">
          <span>主题 / 文件夹</span>
          <select value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value)} disabled={!config}>
            {!topics.includes(selectedTopic) && <option value={selectedTopic}>{selectedTopic}</option>}
            {topics.map((topic) => (
              <option key={topic} value={topic}>
                {topic} → {config?.topic_folders?.[topic] || topic}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>新建分类</span>
          <div className="inline-field">
            <input value={newTopic} onChange={(event) => setNewTopic(event.target.value)} placeholder="例如：宏观经济" />
            <button type="button" onClick={createTopic} disabled={addTopicMutation.isPending}>
              <Plus size={15} />
              新建
            </button>
          </div>
        </label>
      </div>

      <div className="archive-target-row">
        <FolderOpen size={16} />
        <span>{targetPath}</span>
      </div>

      <div className="archive-actions">
        <button
          type="button"
          className="primary-button compact-primary"
          disabled={updateTopicMutation.isPending || !selectedTopic}
          onClick={() => updateTopicMutation.mutate({ jobId: job.id, topic: selectedTopic })}
        >
          保存归档设置
        </button>
        <span>{feedback || "保存后点击重新处理，可将笔记写入新的 Obsidian 文件夹。"}</span>
      </div>
    </section>
  );
}

function StageTimeline({ current, status }: { current: JobStage; status: JobStatus }) {
  const entries = (Object.entries(stageLabels) as Array<[JobStage, string]>).filter(([stage]) => stage !== "failed");
  const index = entries.findIndex(([stage]) => stage === current);
  return (
    <div className="stage-list">
      {entries.map(([stage, label], itemIndex) => {
        const done = status === "done" || itemIndex < index;
        const active = stage === current && status !== "done";
        return (
          <div className={`stage-item ${done ? "done" : ""} ${active ? "active" : ""}`} key={stage}>
            <span />
            <strong>{label}</strong>
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  const map = {
    saved: ["saved", "仅收藏", Inbox],
    queued: ["queued", "排队中", Clock3],
    running: ["running", "运行中", null],
    done: ["done", "已完成", CheckCircle2],
    failed: ["failed", "失败", WifiOff],
  } as const;
  const [className, label, Icon] = map[status];
  return (
    <span className={`status-badge ${className}`}>
      {Icon ? <Icon size={14} /> : <LoadingDot />}
      {label}
    </span>
  );
}

function ModelSettings() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: fetchConfig,
  });
  const [draft, setDraft] = useState<ModelConfig>({
    provider: "ollama",
    model: "qwen3:14b",
    base_url: "http://127.0.0.1:11434",
    api_key: "",
    temperature: 0.3,
    timeout: 180,
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [resolvedBaseUrl, setResolvedBaseUrl] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (configQuery.data?.model) {
      setDraft({
        ...configQuery.data.model,
        api_key: "",
      });
      setResolvedBaseUrl(configQuery.data.model.base_url);
    }
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (config: ModelConfig) => {
      await testModelConfig(config);
      return updateModelConfig(config);
    },
    onSuccess: async (_result, variables) => {
      setFeedback(`模型配置已保存，且超短请求测试通过：${variables.model}`);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "保存失败");
    },
  });

  const testMutation = useMutation({
    mutationFn: testModelConfig,
    onSuccess: (result) => {
      if (result.base_url) {
        setResolvedBaseUrl(result.base_url);
        setDraft((current) => ({ ...current, base_url: result.base_url || current.base_url }));
      }
      setFeedback(result.message || "连接成功");
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "连接失败");
    },
  });

  const discoverMutation = useMutation({
    mutationFn: discoverModelOptions,
    onSuccess: async (result) => {
      setModelOptions(result.items);
      setResolvedBaseUrl(result.base_url);
      const nextBaseDraft = {
        ...draft,
        base_url: result.base_url || draft.base_url,
      };
      const preferred = pickPreferredModel(result.items, draft.model);
      const tested = result.items.length ? await findFirstWorkingModel(nextBaseDraft, result.items) : { model: "", failures: [] };
      const chosenModel = tested.model || preferred;
      setDraft((current) => ({
        ...current,
        base_url: result.base_url || current.base_url,
        model: chosenModel,
      }));
      if (!result.items.length) {
        setFeedback("接口可访问，但没有返回模型列表");
        return;
      }
      if (tested.model) {
        setFeedback(`已发现 ${result.items.length} 个模型，并自动验证可用模型：${tested.model}。当前只是已选中，记得点击“保存配置”。`);
        return;
      }
      setFeedback(
        `已发现 ${result.items.length} 个模型，但自动短测都未通过，先为你选中 ${chosenModel}。这通常是上游网关 503 或当前模型不可用。`,
      );
    },
    onError: (error) => {
      setModelOptions([]);
      setFeedback(error instanceof Error ? error.message : "发现模型失败");
    },
  });

  function updateDraft<K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setFeedback("");
    if (key === "base_url" || key === "api_key" || key === "provider") {
      setModelOptions([]);
      setResolvedBaseUrl("");
    }
  }

  function applyPreset(provider: ModelConfig["provider"]) {
    if (provider === "ollama") {
      setDraft((current) => ({
        ...current,
        provider,
        model: current.model || "qwen3:14b",
        base_url: "http://127.0.0.1:11434",
        timeout: Math.max(current.timeout || 180, 180),
      }));
      setModelOptions([]);
      setResolvedBaseUrl("");
      return;
    }
    setDraft((current) => ({
      ...current,
      provider,
      base_url: current.base_url.includes("11434") ? "https://api.openai.com/v1" : current.base_url,
      model: current.model === "qwen3:14b" ? "gpt-4.1-mini" : current.model,
      timeout: Math.max(current.timeout || 240, 240),
    }));
    setModelOptions([]);
    setResolvedBaseUrl("");
  }

  return (
    <section className="surface settings-panel model-settings">
      <PanelHeader title="模型接入" />
      <div className="provider-tabs">
        <button
          type="button"
          className={draft.provider === "ollama" ? "active" : ""}
          onClick={() => applyPreset("ollama")}
        >
          本地 Ollama
        </button>
        <button
          type="button"
          className={draft.provider === "openai_compatible" ? "active" : ""}
          onClick={() => applyPreset("openai_compatible")}
        >
          OpenAI-compatible
        </button>
      </div>

      <label className="settings-field">
        <span>Base URL</span>
        <input value={draft.base_url} onChange={(event) => updateDraft("base_url", event.target.value)} />
      </label>
      <label className="settings-field">
        <span>API Key</span>
        <input
          type="password"
          value={draft.api_key}
          onChange={(event) => updateDraft("api_key", event.target.value)}
          placeholder={configQuery.data?.model.has_api_key ? "已保存，留空则不覆盖" : "OpenAI-compatible 接口需要填写"}
        />
      </label>
      <div className="model-discovery-card">
        <div>
          <strong>模型发现</strong>
          <p>填入 API 后先拉取模型列表，再选择一个模型保存使用。兼容接口会自动尝试 `/v1/models`。</p>
        </div>
        <button type="button" onClick={() => discoverMutation.mutate(draft)} disabled={discoverMutation.isPending}>
          {discoverMutation.isPending ? <LoadingDot /> : <Search size={15} />}
          发现模型
        </button>
      </div>
      <label className="settings-field">
        <span>Model</span>
        {modelOptions.length ? (
          <select value={draft.model} onChange={(event) => updateDraft("model", event.target.value)}>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}{model.owned_by ? ` · ${model.owned_by}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <input value={draft.model} onChange={(event) => updateDraft("model", event.target.value)} placeholder="先发现模型，或手动填写模型 ID" />
        )}
      </label>
      {resolvedBaseUrl && (
        <div className="setting-line compact-line">
          <Link2 size={18} />
          <span>实际地址</span>
          <strong>{resolvedBaseUrl}</strong>
        </div>
      )}
      <div className="settings-row">
        <label className="settings-field">
          <span>Temperature</span>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={draft.temperature}
            onChange={(event) => updateDraft("temperature", Number(event.target.value))}
          />
        </label>
        <label className="settings-field">
          <span>Timeout 秒</span>
          <input
            type="number"
            min="30"
            value={draft.timeout}
            onChange={(event) => updateDraft("timeout", Number(event.target.value))}
          />
        </label>
      </div>

      <div className="settings-actions">
        <button type="button" onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending}>
          保存配置
        </button>
        <button type="button" onClick={() => testMutation.mutate(draft)} disabled={testMutation.isPending}>
          测试连接
        </button>
      </div>
      <p className="settings-feedback">{feedback || "DeepSeek、OpenAI、Qwen、OpenRouter 等兼容接口都可以填在这里。"}</p>
    </section>
  );
}

function PreferenceSettings() {
  const [accountName, setAccountName] = useState(() => localStorage.getItem("clipmind.accountName") || "本地用户");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("clipmind.theme");
    if (saved === "低对比夜间模式" || saved === "明亮知识库模式" || saved === "深色研究工作台") {
      return saved;
    }
    return "深色研究工作台";
  });
  const [language, setLanguage] = useState(() => localStorage.getItem("clipmind.language") || "简体中文");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function savePreferences() {
    localStorage.setItem("clipmind.accountName", accountName);
    localStorage.setItem("clipmind.theme", theme);
    localStorage.setItem("clipmind.language", language);
    setFeedback("本地偏好已保存");
  }

  return (
    <section className="surface settings-panel preference-panel">
      <PanelHeader title="账户、主题与语言" />
      <label className="settings-field">
        <span>账户名称</span>
        <input value={accountName} onChange={(event) => setAccountName(event.target.value)} />
      </label>
      <label className="settings-field">
        <span>主题</span>
        <select value={theme} onChange={(event) => setTheme(event.target.value as ThemeMode)}>
          <option>深色研究工作台</option>
          <option>低对比夜间模式</option>
          <option>明亮知识库模式</option>
        </select>
      </label>
      <label className="settings-field">
        <span>语言</span>
        <select value={language} onChange={(event) => setLanguage(event.target.value)}>
          <option>简体中文</option>
          <option>繁体中文</option>
          <option>English</option>
        </select>
      </label>
      <div className="settings-actions">
        <button type="button" onClick={savePreferences}>保存偏好</button>
      </div>
      <p className="settings-feedback">{feedback || "账户、主题和语言先保存为本地偏好，后续可接入云同步。"}</p>
    </section>
  );
}

function ObsidianSettings({ config }: { config: AppConfig | null }) {
  const queryClient = useQueryClient();
  const [outputDir, setOutputDir] = useState("");
  const [tags, setTags] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (config) {
      setOutputDir(config.obsidian_output_dir);
      setTags(config.default_tags.join(", "));
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: updateAppConfig,
    onSuccess: async () => {
      setFeedback("Obsidian 配置已保存");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["library-folders"] }),
      ]);
    },
    onError: (error) => {
      setFeedback(error instanceof Error ? error.message : "保存失败");
    },
  });

  return (
    <section className="surface settings-panel obsidian-panel">
      <PanelHeader title="Obsidian 与知识库" />
      <label className="settings-field">
        <span>Vault 输出目录</span>
        <input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} placeholder="/Users/xiaofei/Documents/投资/投资" />
      </label>
      <label className="settings-field">
        <span>默认标签</span>
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="youtube, investment, inbox" />
      </label>
      <div className="settings-actions">
        <button
          type="button"
          disabled={saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate({
              obsidian_output_dir: outputDir,
              default_tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
            })
          }
        >
          保存 Obsidian 配置
        </button>
      </div>
      <p className="settings-feedback">{feedback || "修改输出目录后，新生成的笔记和沉淀池会使用新的 Vault 路径。"}</p>
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function viewTitle(view: ViewKey) {
  const titles = {
    collection: { kicker: "Collection", title: "收藏页" },
    workspace: { kicker: "Workspace", title: "工作台" },
    library: { kicker: "Knowledge Pool", title: "沉淀池" },
    settings: { kicker: "Settings", title: "设置" },
  };
  return titles[view];
}

function labelForStage(stage: JobStage) {
  return stageLabels[stage] ?? stage;
}

function formatTime(value: string | null) {
  if (!value) return "未完成";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function extractVideoId(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") || parsed.pathname.split("/").filter(Boolean).pop() || url;
  } catch {
    return url;
  }
}

export default App;
