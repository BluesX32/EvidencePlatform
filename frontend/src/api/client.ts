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

export interface CriterionItem {
  id: string;
  text: string;
}

export interface ProjectCriteria {
  inclusion: CriterionItem[];
  exclusion: CriterionItem[];
  levels?: string[];     // editable levels vocabulary (Sprint 14)
}

export interface ProjectDetail extends Project {
  record_count: number;        // canonical records (unique after dedup)
  import_count: number;        // completed import jobs
  failed_import_count: number;
  criteria: ProjectCriteria;
  my_role: "owner" | "admin" | "reviewer" | "observer";
}

export interface ProjectListItem extends Project {
  record_count: number;
  my_role: "owner" | "admin" | "reviewer" | "observer";
}

export const projectsApi = {
  list: () => api.get<ProjectListItem[]>("/projects"),
  get: (id: string) => api.get<ProjectDetail>(`/projects/${id}`),
  create: (name: string, description?: string) =>
    api.post<Project>("/projects", { name, description }),
  updateCriteria: (id: string, body: ProjectCriteria) =>
    api.patch<ProjectDetail>(`/projects/${id}/criteria`, body),
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
  year_range: { min: number | null; max: number | null };
}

export const recordsApi = {
  list: (
    projectId: string,
    params: {
      page?: number;
      per_page?: number;
      q?: string;
      sort?: string;
      source_id?: string;
      source_ids?: string[];
      year_min?: number;
      year_max?: number;
      ta_status?: string;
      ft_status?: string;
      has_extraction?: boolean;
    }
  ) => api.get<PaginatedRecords>(`/projects/${projectId}/records`, {
    params,
    // axios serialises arrays as repeated params: source_ids=a&source_ids=b
    paramsSerializer: { indexes: null },
  }),
  overlap: (projectId: string) =>
    api.get<OverlapSummary>(`/projects/${projectId}/overlap`),
};

// ── Overlap ───────────────────────────────────────────────────────────────────

/** Controls which fields and tiers are active during overlap detection. */
export interface OverlapConfig {
  selected_fields: string[];
  fuzzy_enabled: boolean;
  fuzzy_threshold: number;
  year_tolerance: number;
}

export const DEFAULT_OVERLAP_CONFIG: OverlapConfig = {
  selected_fields: ["doi", "pmid", "title", "year", "first_author", "volume"],
  fuzzy_enabled: false,
  fuzzy_threshold: 0.93,
  year_tolerance: 0,
};

export interface OverlapSourceItem {
  id: string;
  name: string;
  total: number;
  with_doi: number;
  internal_overlaps: number;
  unique_count: number;
}

export interface OverlapSummary {
  sources: OverlapSourceItem[];
  strategy_name: string | null;
}

// ── Match Strategies ──────────────────────────────────────────────────────────

/** Mirrors backend StrategyConfig dataclass. Controls which matching tiers are enabled. */
export interface StrategyConfig {
  use_doi: boolean;
  use_pmid: boolean;
  use_title_year: boolean;
  use_title_author_year: boolean;
  use_fuzzy: boolean;
  fuzzy_threshold: number;
  fuzzy_author_check: boolean;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  use_doi: true,
  use_pmid: true,
  use_title_year: true,
  use_title_author_year: true,
  use_fuzzy: false,
  fuzzy_threshold: 0.85,
  fuzzy_author_check: true,
};

export interface MatchStrategy {
  id: string;
  project_id: string;
  name: string;
  preset: string;
  preset_label: string;
  config: StrategyConfig;
  selected_fields: OverlapConfig | string[] | null;
  is_active: boolean;
  created_at: string;
}

export const strategiesApi = {
  list: (projectId: string) =>
    api.get<MatchStrategy[]>(`/projects/${projectId}/strategies`),
  /** Create a strategy from a preset name or a custom config object. */
  create: (
    projectId: string,
    name: string,
    preset: string,
    activate = false,
    config?: Partial<StrategyConfig> | null,
    selected_fields?: OverlapConfig | string[] | null
  ) =>
    api.post<MatchStrategy>(`/projects/${projectId}/strategies`, {
      name,
      preset,
      activate,
      config: config ?? null,
      selected_fields: selected_fields ?? null,
    }),
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

// ── Overlap Resolution ────────────────────────────────────────────────────────

export interface OverlapWithinSource {
  cluster_count: number;
  duplicate_record_count: number;
}

export interface OverlapCrossSource {
  cluster_count: number;
}

export interface OverlapResolutionSummary {
  strategy_name: string | null;
  within_source: OverlapWithinSource;
  cross_source: OverlapCrossSource;
  sources: OverlapSourceItem[];
}

export interface OverlapIntersectionItem {
  source_ids: string[];
  source_names: string[];
  count: number;
}

export interface OverlapIntersectionsData {
  sources: { id: string; name: string }[];
  intersections: OverlapIntersectionItem[];
}

// ── Overlap cluster detail types ──────────────────────────────────────────────

export interface OverlapClusterMemberDetail {
  record_source_id: string;
  source_id: string;
  source_name: string;
  role: "canonical" | "duplicate";
  added_by: "auto" | "user";
  note: string | null;
  title: string | null;
  year: number | null;
  doi: string | null;
}

export interface OverlapClusterDetail {
  cluster_id: string;
  scope: "within_source" | "cross_source";
  match_tier: number;
  match_basis: string;
  match_reason: string | null;
  similarity_score: number | null;
  member_count: number;
  origin: "auto" | "manual" | "mixed";
  locked: boolean;
  members: OverlapClusterMemberDetail[];
}

export interface OverlapVisualSummary {
  sources: { id: string; name: string }[];
  matrix: number[][];
  unique_counts: Record<string, number>;
  top_intersections: {
    source_ids: string[];
    source_names: string[];
    count: number;
  }[];
}

export interface ManualLinkRequest {
  record_ids: string[];
  locked?: boolean;
  note?: string;
}

export interface ClusterLockRequest {
  locked: boolean;
}

// ── Strategy history types ─────────────────────────────────────────────────

export interface StrategyLastRun {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  within_source_groups: number | null;
  within_source_records: number | null;
  cross_source_groups: number | null;
  cross_source_records: number | null;
}

export interface OverlapStrategyDetail {
  id: string;
  name: string;
  preset: string;
  is_active: boolean;
  created_at: string;
  /** Human-readable one-liner, e.g. "DOI · Title + Year + First Author · Fuzzy: off · Year: exact" */
  config_summary: string;
  selected_fields_detail: OverlapConfig | string[] | null;
  last_run: StrategyLastRun | null;
}

export interface OverlapRunItem {
  id: string;
  strategy_id: string | null;
  strategy_name: string | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  triggered_by: "manual" | "auto";
  within_source_groups: number | null;
  within_source_records: number | null;
  cross_source_groups: number | null;
  cross_source_records: number | null;
  sources_count: number | null;
  error_message: string | null;
}

export interface OverlapRunDetail extends OverlapRunItem {
  params_snapshot: OverlapConfig | null;
}

export interface PaginatedOverlapRuns {
  runs: OverlapRunItem[];
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
}

export const overlapsApi = {
  /** Get the latest overlap resolution summary for a project. */
  getSummary: (projectId: string) =>
    api.get<OverlapResolutionSummary>(`/projects/${projectId}/overlaps`),
  /** Start an overlap detection job in the background. */
  run: (projectId: string, strategyId: string) =>
    api.post<{ overlap_job_id: string; status: string; message: string }>(
      `/projects/${projectId}/overlaps/run`,
      { strategy_id: strategyId }
    ),
  /** Preview overlap detection without writing (synchronous). */
  preview: (projectId: string, strategyId: string) =>
    api.get(`/projects/${projectId}/overlaps/preview`, {
      params: { strategy_id: strategyId },
    }),
  /** List detected overlap clusters with member details (server-side paginated). */
  listClusters: (
    projectId: string,
    params?: {
      scope?: "within_source" | "cross_source";
      page?: number;
      page_size?: number;
      source_id?: string;
      origin?: string;
      locked?: boolean;
      min_sources?: number;
      q?: string;
    }
  ) =>
    api.get<{
      clusters: OverlapClusterDetail[];
      page: number;
      page_size: number;
      total_items: number;
      total_pages: number;
    }>(`/projects/${projectId}/overlaps/clusters`, { params }),
  /** Get NxN visual overlap matrix for a project. */
  getVisualSummary: (projectId: string) =>
    api.get<OverlapVisualSummary>(`/projects/${projectId}/overlaps/visual-summary`),
  /** Get multi-source intersection counts (source-combination groups). */
  getIntersections: (projectId: string, topN = 20, minSize = 2) =>
    api.get<OverlapIntersectionsData>(`/projects/${projectId}/overlaps/intersections`, {
      params: { top_n: topN, min_size: minSize },
    }),
  /** Manually link a set of records into a cross-source overlap cluster. */
  manualLink: (projectId: string, body: ManualLinkRequest) =>
    api.post<OverlapClusterDetail>(`/projects/${projectId}/overlaps/manual-link`, body),
  /** Set or clear the locked flag on a cluster. */
  lockCluster: (projectId: string, clusterId: string, body: ClusterLockRequest) =>
    api.post<OverlapClusterDetail>(
      `/projects/${projectId}/overlaps/${clusterId}/lock`,
      body
    ),
  /** Remove a user-added member from a cluster. */
  removeMember: (projectId: string, clusterId: string, recordSourceId: string) =>
    api.delete(`/projects/${projectId}/overlaps/${clusterId}/members/${recordSourceId}`),
  /** List all strategies with config summary and last run info. */
  listStrategies: (projectId: string) =>
    api.get<OverlapStrategyDetail[]>(`/projects/${projectId}/overlaps/strategies`),
  /** List paginated run history (most recent first). */
  listRuns: (projectId: string, params?: { page?: number; page_size?: number }) =>
    api.get<PaginatedOverlapRuns>(`/projects/${projectId}/overlaps/strategy-runs`, { params }),
  /** Full run detail including params_snapshot. */
  getRun: (projectId: string, runId: string) =>
    api.get<OverlapRunDetail>(`/projects/${projectId}/overlaps/strategy-runs/${runId}`),
};

// ── Screening (VS4 — direct project-scoped, no corpus layer) ─────────────────

export interface ScreeningSource {
  id: string;           // UUID | "all"
  name: string;
  record_count: number;
  ta_screened: number;
  ta_included: number;
  ft_screened: number;
  ft_included: number;
  extracted_count: number;
}

export interface ScreeningNextItem {
  done: boolean;
  record_id?: string | null;
  cluster_id?: string | null;
  title?: string | null;
  abstract?: string | null;
  year?: number | null;
  authors?: string[] | null;
  doi?: string | null;
  source_names?: string[];
  remaining?: number | null;
  /** Current reviewer's TA decision for this item, if any ("include" | "exclude" | null) */
  ta_decision?: string | null;
  /** Current reviewer's FT decision for this item, if any */
  ft_decision?: string | null;
  pmid?: string | null;
  pmcid?: string | null;
}

export interface HighlightRect {
  x: number; // normalised 0-1 fraction of page width
  y: number; // normalised 0-1 fraction of page height
  w: number;
  h: number;
}

export interface Annotation {
  id: string;
  project_id: string;
  record_id: string | null;
  cluster_id: string | null;
  selected_text: string;
  comment: string;
  page_num: number | null;
  highlight_rects: HighlightRect[] | null;
  reviewer_id: string | null;
  created_at: string;
}

export const annotationsApi = {
  list: (projectId: string, params: { record_id?: string; cluster_id?: string }) =>
    api.get<Annotation[]>(`/projects/${projectId}/annotations`, { params }),
  create: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      selected_text: string;
      comment: string;
      page_num?: number | null;
      highlight_rects?: HighlightRect[] | null;
    }
  ) => api.post<Annotation>(`/projects/${projectId}/annotations`, body),
  delete: (projectId: string, annId: string) =>
    api.delete(`/projects/${projectId}/annotations/${annId}`),
};

export interface ScreeningDecision {
  id: string;
  project_id: string;
  record_id: string | null;
  cluster_id: string | null;
  stage: "TA" | "FT";
  decision: "include" | "exclude";
  reason_code: string | null;
  notes: string | null;
  reviewer_id: string | null;
  created_at: string;
}

export interface Snippet {
  snippet: string;
  note: string;
  tag?: string | null;
}

/**
 * Conceptual framework extraction schema (v1).
 * framework_updated drives the saturation counter:
 *   true  → reset consecutive_no_novelty to 0
 *   false → increment counter
 */
export interface ExtractionJson {
  levels: string[];
  dimensions: string[];
  snippets: Snippet[];
  free_note: string;
  framework_updated: boolean;
  framework_update_note: string;
}

export interface ExtractionRecord {
  id: string;
  project_id: string;
  record_id: string | null;
  cluster_id: string | null;
  extracted_json: ExtractionJson;
  reviewer_id: string | null;
  created_at: string;
}

export interface ExtractionLibraryItem extends ExtractionRecord {
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  source_names: string[];
}

export const extractionLibraryApi = {
  list: (projectId: string) =>
    api.get<ExtractionLibraryItem[]>(`/projects/${projectId}/extractions`),
  get: (projectId: string, extractionId: string) =>
    api.get<ExtractionLibraryItem>(`/projects/${projectId}/extractions/${extractionId}`),
};

// ── Labels ────────────────────────────────────────────────────────────────────

export interface ProjectLabel {
  id: string;
  project_id: string;
  name: string;
  /** Hex color, e.g. "#6366f1" */
  color: string;
  created_at: string;
}

export interface LabeledArticle {
  record_id: string | null;
  cluster_id: string | null;
  title: string | null;
  year: number | null;
  doi: string | null;
  authors: string[];
  source_names: string[];
  labels: Pick<ProjectLabel, "id" | "name" | "color">[];
}

export interface LabeledArticlesResponse {
  articles: LabeledArticle[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export const labelsApi = {
  list: (projectId: string) =>
    api.get<ProjectLabel[]>(`/projects/${projectId}/labels`),

  create: (projectId: string, body: { name: string; color: string }) =>
    api.post<ProjectLabel>(`/projects/${projectId}/labels`, body),

  update: (
    projectId: string,
    labelId: string,
    body: { name?: string; color?: string }
  ) => api.patch<ProjectLabel>(`/projects/${projectId}/labels/${labelId}`, body),

  delete: (projectId: string, labelId: string) =>
    api.delete(`/projects/${projectId}/labels/${labelId}`),

  assign: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      label_id: string;
    }
  ) => api.post(`/projects/${projectId}/labels/assign`, body),

  unassign: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      label_id: string;
    }
  ) => api.delete(`/projects/${projectId}/labels/assign`, { data: body }),

  getItemLabels: (
    projectId: string,
    params: { record_id?: string; cluster_id?: string }
  ) =>
    api.get<ProjectLabel[]>(`/projects/${projectId}/labels/item`, { params }),

  listArticles: (
    projectId: string,
    params?: {
      label_id?: string;
      record_id?: string;
      cluster_id?: string;
      page?: number;
      page_size?: number;
    }
  ) =>
    api.get<LabeledArticlesResponse>(`/projects/${projectId}/labels/articles`, {
      params,
    }),
};

export interface SaturationStatus {
  /** Number of consecutive most-recent extractions where framework_updated=false. */
  consecutive_no_novelty: number;
  /** True when consecutive_no_novelty >= threshold. */
  saturated: boolean;
  /** Stopping threshold (default 5). */
  threshold: number;
}

export const screeningApi = {
  getSources: (projectId: string) =>
    api.get<ScreeningSource[]>(`/projects/${projectId}/screening/sources`),

  nextItem: (
    projectId: string,
    params: { source_id: string; mode: string; strategy?: string; bucket?: string; randomize?: boolean }
  ) =>
    api.get<ScreeningNextItem>(`/projects/${projectId}/screening/next`, { params }),

  getItem: (
    projectId: string,
    params: { record_id?: string; cluster_id?: string }
  ) =>
    api.get<ScreeningNextItem>(`/projects/${projectId}/screening/item`, { params }),

  submitDecision: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: "TA" | "FT";
      decision: "include" | "exclude";
      reason_code?: string;
      notes?: string;
      strategy?: string;
    }
  ) => api.post<ScreeningDecision>(`/projects/${projectId}/screening/decisions`, body),

  listDecisions: (projectId: string, params?: { stage?: string }) =>
    api.get<ScreeningDecision[]>(`/projects/${projectId}/screening/decisions`, { params }),

  submitExtraction: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      extracted_json: ExtractionJson;
    }
  ) => api.post<ExtractionRecord>(`/projects/${projectId}/screening/extractions`, body),

  listExtractions: (projectId: string) =>
    api.get<ExtractionRecord[]>(`/projects/${projectId}/screening/extractions`),

  getSaturation: (projectId: string, threshold?: number) =>
    api.get<SaturationStatus>(`/projects/${projectId}/screening/saturation`, {
      params: threshold !== undefined ? { threshold } : undefined,
    }),
};

// ── Ontology / Taxonomy ───────────────────────────────────────────────────────

export const ONTOLOGY_NAMESPACES = [
  "level",
  "dimension",
  "concept",
  "population",
  "intervention",
  "outcome",
  "other",
] as const;

export type OntologyNamespace = (typeof ONTOLOGY_NAMESPACES)[number];

/** A flat node as returned by GET /ontology (includes depth for rendering). */
export interface OntologyNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  namespace: OntologyNamespace;
  color: string | null;
  position: number;
  depth: number;
  created_at: string;
  updated_at: string;
}

/** Nested tree node (used for export format and client-side tree building). */
export interface OntologyTreeNode extends Omit<OntologyNode, "depth"> {
  children: OntologyTreeNode[];
}

export interface OntologyExport {
  project_id: string;
  format: string;
  nodes: OntologyTreeNode[];
}

export const ontologyApi = {
  list: (projectId: string) =>
    api.get<OntologyNode[]>(`/projects/${projectId}/ontology`),

  create: (
    projectId: string,
    body: {
      name: string;
      parent_id?: string | null;
      namespace?: OntologyNamespace;
      description?: string | null;
      color?: string | null;
    }
  ) => api.post<OntologyNode>(`/projects/${projectId}/ontology`, body),

  update: (
    projectId: string,
    nodeId: string,
    body: {
      name?: string;
      parent_id?: string | null;
      clear_parent?: boolean;
      namespace?: OntologyNamespace;
      description?: string | null;
      color?: string | null;
      clear_color?: boolean;
      position?: number;
    }
  ) => api.patch<OntologyNode>(`/projects/${projectId}/ontology/${nodeId}`, body),

  delete: (projectId: string, nodeId: string) =>
    api.delete(`/projects/${projectId}/ontology/${nodeId}`),

  syncLevels: (
    projectId: string,
    body: { namespace?: OntologyNamespace; under_node_id?: string | null }
  ) =>
    api.post<{ created: number; skipped: number }>(
      `/projects/${projectId}/ontology/sync-levels`,
      body
    ),

  export: (projectId: string) =>
    api.get<OntologyExport>(`/projects/${projectId}/ontology/export`),

  importTree: (
    projectId: string,
    body: { nodes: OntologyTreeNode[]; merge?: boolean }
  ) =>
    api.post<{ created: number; skipped: number }>(
      `/projects/${projectId}/ontology/import`,
      body
    ),
};

// ── Thematic Analysis ─────────────────────────────────────────────────────────

export interface ThemeCode {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  evidence_count: number;
}

export interface ThemeItem {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  codes: ThemeCode[];
}

export interface ThematicMap {
  themes: ThemeItem[];
  ungrouped_codes: ThemeCode[];
}

export interface CodeEvidence {
  assignment_id: string;
  extraction_id: string;
  record_id: string | null;
  cluster_id: string | null;
  title: string | null;
  year: number | null;
  authors: string[] | null;
  snippet_text: string | null;
  note: string | null;
  assigned_at: string;
}

export interface ThematicHistoryEntry {
  id: string;
  code_id: string | null;
  code_name: string;
  action: string;
  old_theme_name: string | null;
  new_theme_name: string | null;
  note: string | null;
  changed_at: string;
}

export const thematicApi = {
  getMap: (projectId: string) =>
    api.get<ThematicMap>(`/projects/${projectId}/thematic`),

  createTheme: (
    projectId: string,
    body: { name: string; description?: string; color?: string }
  ) => api.post<{ id: string; name: string; color: string | null }>(`/projects/${projectId}/thematic/themes`, body),

  updateTheme: (
    projectId: string,
    themeId: string,
    body: { name?: string; description?: string; color?: string }
  ) => api.patch<{ id: string; name: string; color: string | null }>(`/projects/${projectId}/thematic/themes/${themeId}`, body),

  deleteTheme: (projectId: string, themeId: string) =>
    api.delete(`/projects/${projectId}/thematic/themes/${themeId}`),

  createCode: (
    projectId: string,
    body: { name: string; theme_id?: string | null; description?: string; color?: string }
  ) => api.post<{ id: string; name: string; theme_id: string | null }>(`/projects/${projectId}/thematic/codes`, body),

  updateCode: (
    projectId: string,
    codeId: string,
    body: {
      name?: string;
      description?: string;
      color?: string;
      theme_id?: string | null;
      clear_theme?: boolean;
    }
  ) => api.patch<{ id: string; name: string; theme_id: string | null }>(`/projects/${projectId}/thematic/codes/${codeId}`, body),

  deleteCode: (projectId: string, codeId: string) =>
    api.delete(`/projects/${projectId}/thematic/codes/${codeId}`),

  getCodeEvidence: (projectId: string, codeId: string) =>
    api.get<CodeEvidence[]>(`/projects/${projectId}/thematic/codes/${codeId}/evidence`),

  assignCode: (
    projectId: string,
    body: { code_id: string; extraction_id: string; snippet_text?: string; note?: string }
  ) => api.post<{ id: string }>(`/projects/${projectId}/thematic/assignments`, body),

  removeAssignment: (projectId: string, assignmentId: string) =>
    api.delete(`/projects/${projectId}/thematic/assignments/${assignmentId}`),

  getHistory: (projectId: string) =>
    api.get<ThematicHistoryEntry[]>(`/projects/${projectId}/thematic/history`),
};

// ── LLM Screening ─────────────────────────────────────────────────────────────

export interface LlmEstimateResponse {
  total_records: number;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: number;
  estimated_minutes: number;
  model: string;
  cost_breakdown: Record<string, number>;
}

export interface LlmRunResponse {
  id: string;
  project_id: string;
  status: string;
  model: string;
  total_records: number | null;
  processed_records: number;
  included_count: number;
  excluded_count: number;
  uncertain_count: number;
  new_concepts_count: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  triggered_by: string | null;
  progress_pct: number;
}

export interface LlmResultResponse {
  id: string;
  run_id: string;
  project_id: string;
  record_id: string | null;
  cluster_id: string | null;
  ta_decision: string | null;
  ta_reason: string | null;
  ft_decision: string | null;
  ft_reason: string | null;
  matched_codes: string[] | null;
  new_concepts: string[] | null;
  full_text_source: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_action: string | null;
  created_at: string;
}

export interface PaginatedLlmResults {
  total: number;
  page: number;
  page_size: number;
  items: LlmResultResponse[];
}

export const llmScreeningApi = {
  estimate: (projectId: string, model = "claude-sonnet-4-6") =>
    api.get<LlmEstimateResponse>(`/projects/${projectId}/llm-screening/estimate`, {
      params: { model },
    }),

  createRun: (
    projectId: string,
    model: string,
    keys?: { anthropic?: string; openrouter?: string }
  ) =>
    api.post<LlmRunResponse>(
      `/projects/${projectId}/llm-screening/runs`,
      { model },
      {
        headers: {
          ...(keys?.anthropic ? { "X-Anthropic-Api-Key": keys.anthropic } : {}),
          ...(keys?.openrouter ? { "X-Openrouter-Api-Key": keys.openrouter } : {}),
        },
      }
    ),

  listRuns: (projectId: string) =>
    api.get<LlmRunResponse[]>(`/projects/${projectId}/llm-screening/runs`),

  getRun: (projectId: string, runId: string) =>
    api.get<LlmRunResponse>(`/projects/${projectId}/llm-screening/runs/${runId}`),

  listResults: (
    projectId: string,
    runId: string,
    params?: { page?: number; page_size?: number; ta_decision?: string }
  ) =>
    api.get<PaginatedLlmResults>(
      `/projects/${projectId}/llm-screening/runs/${runId}/results`,
      { params }
    ),

  reviewResult: (
    projectId: string,
    runId: string,
    resultId: string,
    action: "accepted" | "rejected" | "merged"
  ) =>
    api.post<LlmResultResponse>(
      `/projects/${projectId}/llm-screening/runs/${runId}/results/${resultId}/review`,
      { action }
    ),
};

// ── Full-text PDF upload ───────────────────────────────────────────────────────

export interface FulltextPdfMeta {
  id: string;
  original_filename: string;
  file_size: number;
  content_type: string;
  uploaded_at: string;
  drawing_data?: Record<string, DrawingStroke[]> | null;
}

export interface DrawingStroke {
  color: string;
  width: number;
  points: [number, number][];
  tool?: "pen" | "eraser";
}

export const fulltextApi = {
  /** Fetch metadata for the uploaded PDF for a given record or cluster. */
  getMeta: (
    projectId: string,
    params: { record_id?: string | null; cluster_id?: string | null }
  ) =>
    api.get<FulltextPdfMeta | null>(`/projects/${projectId}/fulltext`, { params }),

  /** Upload a PDF (replaces any existing one for the same item). */
  upload: (
    projectId: string,
    file: File,
    params: { record_id?: string | null; cluster_id?: string | null }
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (params.record_id) form.append("record_id", params.record_id);
    if (params.cluster_id) form.append("cluster_id", params.cluster_id);
    return api.post<FulltextPdfMeta>(`/projects/${projectId}/fulltext`, form);
  },

  /** Download the file as a Blob (use with URL.createObjectURL to open in tab). */
  download: (projectId: string, pdfId: string) =>
    api.get<Blob>(`/projects/${projectId}/fulltext/${pdfId}/download`, {
      responseType: "blob",
    }),

  delete: (projectId: string, pdfId: string) =>
    api.delete(`/projects/${projectId}/fulltext/${pdfId}`),

  /** Save freehand drawing strokes for a PDF. */
  saveDrawing: (
    projectId: string,
    pdfId: string,
    drawing_data: Record<string, DrawingStroke[]>
  ) =>
    api.patch<FulltextPdfMeta>(`/projects/${projectId}/fulltext/${pdfId}/drawing`, {
      drawing_data,
    }),
};

// ── Team collaboration ────────────────────────────────────────────────────────

export interface TeamMember {
  user_id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "reviewer" | "observer";
  joined_at: string;
  is_owner: boolean;
}

export interface ProjectInvitation {
  id: string;
  email: string;
  role: string;
  token: string;
  status: "pending" | "accepted" | "revoked";
  created_at: string;
  accepted_at: string | null;
}

export interface MyRole {
  role: "owner" | "admin" | "reviewer" | "observer";
  is_owner: boolean;
  user_id: string;
}

export const teamApi = {
  getMyRole: (projectId: string) =>
    api.get<MyRole>(`/projects/${projectId}/team/me`),

  listMembers: (projectId: string) =>
    api.get<TeamMember[]>(`/projects/${projectId}/team/members`),

  invite: (projectId: string, email: string, role: string) =>
    api.post<ProjectInvitation>(`/projects/${projectId}/team/invite`, { email, role }),

  listInvitations: (projectId: string) =>
    api.get<ProjectInvitation[]>(`/projects/${projectId}/team/invitations`),

  revokeInvitation: (projectId: string, invitationId: string) =>
    api.delete(`/projects/${projectId}/team/invitations/${invitationId}`),

  acceptInvite: (projectId: string, token: string) =>
    api.post<{ project_id: string; role: string; message: string }>(
      `/projects/${projectId}/team/accept`,
      { token }
    ),

  updateMemberRole: (projectId: string, userId: string, role: string) =>
    api.patch(`/projects/${projectId}/team/members/${userId}`, { role }),

  removeMember: (projectId: string, userId: string) =>
    api.delete(`/projects/${projectId}/team/members/${userId}`),
};

// ── Consensus & inter-rater reliability ───────────────────────────────────────

export interface ReviewerDecision {
  id: string;
  stage: string;
  decision: string;
  reason_code: string | null;
  notes: string | null;
  reviewer_id: string | null;
  reviewer_name: string | null;
  created_at: string;
}

export interface ConflictItem {
  item_id: string;
  item_type: "record" | "cluster";
  record_id: string | null;
  cluster_id: string | null;
  stage: string;
  decisions: ReviewerDecision[];
  conflict_type: string;
}

export interface ConsensusDecision {
  id: string;
  project_id: string;
  record_id: string | null;
  cluster_id: string | null;
  stage: string;
  decision: string;
  reason_code: string | null;
  notes: string | null;
  adjudicator_id: string | null;
  created_at: string;
}

export interface ReviewerPairStats {
  reviewer_a: { id: string; name: string };
  reviewer_b: { id: string; name: string };
  n_items_both: number;
  n_agree: number;
  pct_agreement: number | null;
  kappa: number;
  kappa_label: string;
}

export interface ReliabilityReport {
  stage: string;
  pairs: ReviewerPairStats[];
  overall_pct_agreement: number | null;
  n_pairs: number;
}

export interface ReviewerStats {
  reviewer_id: string;
  name: string;
  ta_screened: number;
  ta_included: number;
  ta_excluded: number;
  ft_screened: number;
  ft_included: number;
  ft_excluded: number;
  extractions: number;
}

export const consensusApi = {
  listConflicts: (projectId: string, stage?: string) =>
    api.get<ConflictItem[]>(`/projects/${projectId}/consensus/conflicts`, {
      params: stage ? { stage } : undefined,
    }),

  listResolved: (projectId: string) =>
    api.get<ConsensusDecision[]>(`/projects/${projectId}/consensus/resolved`),

  adjudicate: (
    projectId: string,
    body: {
      record_id?: string | null;
      cluster_id?: string | null;
      stage: string;
      decision: string;
      reason_code?: string | null;
      notes?: string | null;
    }
  ) => api.post<ConsensusDecision>(`/projects/${projectId}/consensus/adjudicate`, body),

  getReliability: (projectId: string, stage?: string) =>
    api.get<ReliabilityReport>(`/projects/${projectId}/consensus/reliability`, {
      params: stage ? { stage } : undefined,
    }),

  getTeamStats: (projectId: string) =>
    api.get<ReviewerStats[]>(`/projects/${projectId}/consensus/stats`),

  getTeamDecisions: (
    projectId: string,
    params: { record_id?: string; cluster_id?: string }
  ) =>
    api.get<{ decisions: ReviewerDecision[]; consensus: ConsensusDecision[] | null }>(
      `/projects/${projectId}/consensus/team-decisions`,
      { params }
    ),
};
