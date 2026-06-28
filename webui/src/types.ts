export type JobStatus = "saved" | "queued" | "running" | "done" | "failed";

export type JobStage =
  | "saved"
  | "queued"
  | "extracting_metadata"
  | "fetching_transcript"
  | "downloading_audio"
  | "transcribing_audio"
  | "classifying_note"
  | "structuring_note"
  | "writing_obsidian"
  | "done"
  | "failed";

export type JobMeta = Record<string, unknown>;

export type Job = {
  id: string;
  url: string;
  title: string | null;
  status: JobStatus;
  stage: JobStage;
  topic: string | null;
  is_favorited: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  output_path: string | null;
  error_message: string | null;
  meta: JobMeta;
};

export type HealthResponse = {
  ok: boolean;
};

export type ModelProvider = "ollama" | "openai_compatible";

export type ModelConfig = {
  provider: ModelProvider;
  model: string;
  base_url: string;
  api_key: string;
  has_api_key?: boolean;
  temperature: number;
  timeout: number;
};

export type ModelOption = {
  id: string;
  name: string;
  owned_by?: string;
};

export type ModelListResponse = {
  ok: boolean;
  base_url: string;
  items: ModelOption[];
};

export type AppConfig = {
  obsidian_output_dir: string;
  default_tags: string[];
  topic_folders: Record<string, string>;
  transcription: {
    language?: string;
    whisper_model?: string;
  };
  model: ModelConfig;
};

export type LibraryNote = {
  title: string;
  path: string;
  updated_at: string;
  size: number;
  preview: string;
};

export type LibraryFolder = {
  topic: string;
  folder: string;
  path: string;
  note_count: number;
  updated_at: string | null;
  has_distillation: boolean;
  distillation_path: string | null;
  notes: LibraryNote[];
};

export type FolderDistillation = {
  topic: string;
  path: string;
  note_count: number;
  summary: string;
};
