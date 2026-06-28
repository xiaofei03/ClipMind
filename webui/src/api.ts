import type {
  AppConfig,
  FolderDistillation,
  HealthResponse,
  Job,
  JobStage,
  LibraryFolder,
  ModelConfig,
  ModelListResponse,
} from "./types";

export const stageLabels: Record<JobStage, string> = {
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

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchHealth() {
  return request<HealthResponse>("/health");
}

export async function fetchJobs() {
  const data = await request<{ items: Job[] }>("/jobs");
  return data.items;
}

export async function fetchJob(jobId: string) {
  return request<Job>(`/jobs/${jobId}`);
}

export async function createJob(url: string, isFavorited = true, processNow = true) {
  const response = await fetch("/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      url,
      is_favorited: isFavorited,
      process_now: processNow,
    }),
  });

  if (!response.ok) {
    throw new Error(`Create job failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<Job>;
}

export async function processJob(jobId: string) {
  const response = await fetch(`/jobs/${jobId}/process`, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Process job failed: ${response.status}`);
  }

  return response.json() as Promise<Job>;
}

export async function retryJob(jobId: string) {
  const response = await fetch(`/jobs/${jobId}/retry`, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Retry job failed: ${response.status}`);
  }

  return response.json() as Promise<Job>;
}

export async function deleteJob(jobId: string) {
  const response = await fetch(`/jobs/${jobId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Delete job failed: ${response.status}`);
  }

  return response.json() as Promise<{ ok: boolean }>;
}

export async function fetchConfig() {
  return request<AppConfig>("/config");
}

export async function fetchLibraryFolders() {
  const data = await request<{ items: LibraryFolder[] }>("/library/folders");
  return data.items;
}

export async function distillLibraryFolder(topic: string) {
  const response = await fetch(`/library/folders/${encodeURIComponent(topic)}/distill`, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Distill folder failed: ${response.status}`);
  }
  return response.json() as Promise<FolderDistillation>;
}

export async function addTopicFolder(topic: string, folder?: string) {
  const response = await fetch("/config/topic-folders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ topic, folder }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Add topic folder failed: ${response.status}`);
  }
  return response.json() as Promise<AppConfig>;
}

export async function updateJobTopic(jobId: string, topic: string) {
  const response = await fetch(`/jobs/${jobId}/topic`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ topic }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Update job topic failed: ${response.status}`);
  }
  return response.json() as Promise<Job>;
}

export async function updateModelConfig(config: ModelConfig) {
  const response = await fetch("/config/model", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Update model failed: ${response.status}`);
  }
  return response.json() as Promise<AppConfig>;
}

export async function updateAppConfig(config: Pick<AppConfig, "obsidian_output_dir" | "default_tags">) {
  const response = await fetch("/config/app", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Update app config failed: ${response.status}`);
  }
  return response.json() as Promise<AppConfig>;
}

export async function testModelConfig(config: ModelConfig) {
  const response = await fetch("/config/model/test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Test model failed: ${response.status}`);
  }
  return response.json() as Promise<{ ok: boolean; message: string; base_url?: string }>;
}

export async function discoverModelOptions(config: ModelConfig) {
  const response = await fetch("/config/model/models", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.detail || `Discover models failed: ${response.status}`);
  }
  return response.json() as Promise<ModelListResponse>;
}
