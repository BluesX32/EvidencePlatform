import axios from "axios";

const TOKEN_KEY = "ep_access_token";

export const api = axios.create({
  baseURL: "http://localhost:8000",
});

// Attach token to every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401, clear token and redirect to login.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);
export const getToken = () => localStorage.getItem(TOKEN_KEY);

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface RegisterResponse {
  user_id: string;
  access_token: string;
}

export interface TokenResponse {
  access_token: string;
}

export const authApi = {
  register: (email: string, password: string, name: string) =>
    api.post<RegisterResponse>("/auth/register", { email, password, name }),
  login: (email: string, password: string) =>
    api.post<TokenResponse>("/auth/login", { email, password }),
};

// ── Projects ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
}

export interface ProjectListItem extends Project {
  record_count: number;
}

export interface ProjectDetail extends Project {
  record_count: number;        // canonical records (unique after dedup)
  import_count: number;        // completed import jobs
  failed_import_count: number;
}

export const projectsApi = {
  list: () => api.get<ProjectListItem[]>("/projects"),
  get: (id: string) => api.get<ProjectDetail>(`/projects/${id}`),
  create: (name: string, description?: string) =>
    api.post<Project>("/projects", { name, description }),
};

// ── Sources ───────────────────────────────────────────────────────────────────

export interface Source {
  id: string;
  name: string;
  created_at: string;
}

export const sourcesApi = {
  list: (projectId: string) =>
    api.get<Source[]>(`/projects/${projectId}/sources`),
  create: (projectId: string, name: string) =>
    api.post<Source>(`/projects/${projectId}/sources`, { name }),
};

// ── Imports ───────────────────────────────────────────────────────────────────

export interface ImportJob {
  id: string;
  filename: string;
  status: "pending" | "processing" | "completed" | "failed";
  source_id: string | null;
  record_count: number | null;
  error_msg: string | null;
  created_at: string;
  completed_at: string | null;
}

export const importsApi = {
  start: (projectId: string, file: File, sourceId?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (sourceId) form.append("source_id", sourceId);
    return api.post<{ import_job_id: string; status: string }>(
      `/projects/${projectId}/imports`,
      form
    );
  },
  get: (projectId: string, jobId: string) =>
    api.get<ImportJob>(`/projects/${projectId}/imports/${jobId}`),
  list: (projectId: string) =>
    api.get<ImportJob[]>(`/projects/${projectId}/imports`),
};

// ── Records ───────────────────────────────────────────────────────────────────

export interface RecordItem {
  id: string;
  title: string | null;
  abstract: string | null;
  authors: string[] | null;
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  issn: string | null;
  keywords: string[] | null;
  sources: string[];
  match_basis: string | null;
  created_at: string;
}

export interface PaginatedRecords {
  records: RecordItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export const recordsApi = {
  list: (
    projectId: string,
    params: { page?: number; per_page?: number; q?: string; sort?: string; source_id?: string }
  ) => api.get<PaginatedRecords>(`/projects/${projectId}/records`, { params }),
  overlap: (projectId: string) =>
    api.get<OverlapSummary>(`/projects/${projectId}/overlap`),
};

// ── Overlap ───────────────────────────────────────────────────────────────────

export interface OverlapSourceItem {
  id: string;
  name: string;
  total: number;
  with_doi: number;
}

export interface OverlapPair {
  source_a_id: string;
  source_a_name: string;
  source_b_id: string;
  source_b_name: string;
  shared_records: number;
}

export interface OverlapSummary {
  sources: OverlapSourceItem[];
  pairs: OverlapPair[];
  strategy_name: string | null;
}

// ── Match Strategies ──────────────────────────────────────────────────────────

export interface MatchStrategy {
  id: string;
  project_id: string;
  name: string;
  preset: string;
  preset_label: string;
  is_active: boolean;
  created_at: string;
}

export const strategiesApi = {
  list: (projectId: string) =>
    api.get<MatchStrategy[]>(`/projects/${projectId}/strategies`),
  create: (projectId: string, name: string, preset: string, activate = false) =>
    api.post<MatchStrategy>(`/projects/${projectId}/strategies`, { name, preset, activate }),
  getActive: (projectId: string) =>
    api.get<MatchStrategy | null>(`/projects/${projectId}/strategies/active`),
  activate: (projectId: string, strategyId: string) =>
    api.patch<MatchStrategy>(`/projects/${projectId}/strategies/${strategyId}/activate`),
};

// ── Dedup Jobs ────────────────────────────────────────────────────────────────

export interface DedupJob {
  id: string;
  project_id: string;
  strategy_id: string;
  strategy: { id: string; name: string; preset: string } | null;
  status: "pending" | "running" | "completed" | "failed";
  records_before: number | null;
  records_after: number | null;
  merges: number | null;
  clusters_created: number | null;
  clusters_deleted: number | null;
  error_msg: string | null;
  created_at: string;
  completed_at: string | null;
}

export const dedupJobsApi = {
  start: (projectId: string, strategyId: string) =>
    api.post<{ dedup_job_id: string; status: string }>(
      `/projects/${projectId}/dedup-jobs`,
      { strategy_id: strategyId }
    ),
  list: (projectId: string) =>
    api.get<DedupJob[]>(`/projects/${projectId}/dedup-jobs`),
  get: (projectId: string, jobId: string) =>
    api.get<DedupJob>(`/projects/${projectId}/dedup-jobs/${jobId}`),
};
