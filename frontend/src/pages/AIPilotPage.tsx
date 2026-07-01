import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Cpu, CheckCircle2, Circle, Loader2, AlertCircle,
  Settings, Upload, GitMerge, Search, FileText,
  Layers, MessageSquare, BarChart3, ChevronRight,
  Sparkles, RefreshCw,
} from "lucide-react";
import { aiPilotApi } from "../api/client";

const MODEL_OPTIONS = [
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku (fast, via OpenRouter)" },
  { value: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet (smart, via OpenRouter)" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku (Anthropic direct)" },
];

// ── Status badge ──────────────────────────────────────────────────────────────

type StageStatus = "done" | "running" | "review" | "idle";

function StatusBadge({ status }: { status: StageStatus }) {
  const cfg = {
    done:    { icon: <CheckCircle2 size={14} />, label: "Done",       color: "#16a34a", bg: "#dcfce7" },
    running: { icon: <Loader2 size={14} className="spin" />, label: "Running", color: "#9333ea", bg: "#f3e8ff" },
    review:  { icon: <AlertCircle size={14} />, label: "Needs review", color: "#d97706", bg: "#fef3c7" },
    idle:    { icon: <Circle size={14} />,     label: "Not started",  color: "#9ca3af", bg: "#f3f4f6" },
  }[status];

  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "0.2rem 0.55rem", borderRadius: "1rem",
      background: cfg.bg, color: cfg.color,
      fontSize: "0.73rem", fontWeight: 600,
    }}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ── Pipeline row ──────────────────────────────────────────────────────────────

function PipelineRow({
  icon, title, subtitle, status, reviewPath, action, progress,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  status: StageStatus;
  reviewPath?: string;
  action?: React.ReactNode;
  progress?: { done: number; total: number };
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "1rem",
      padding: "0.85rem 1.1rem",
      borderBottom: "1px solid var(--border)",
    }}>
      {/* Stage icon */}
      <div style={{
        width: 36, height: 36, borderRadius: "50%",
        background: status === "done" ? "#dcfce7" : status === "running" ? "#f3e8ff" : "#f1f3f4",
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        color: status === "done" ? "#16a34a" : status === "running" ? "#9333ea" : "#9ca3af",
      }}>
        {icon}
      </div>

      {/* Title + subtitle */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "var(--text)" }}>{title}</div>
        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</div>
        {progress && progress.total > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2, overflow: "hidden", width: 200 }}>
              <div style={{
                height: "100%", borderRadius: 2,
                background: "#7c3aed",
                width: `${Math.round(progress.done / progress.total * 100)}%`,
                transition: "width 0.4s",
              }} />
            </div>
            <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: 2, display: "block" }}>
              {progress.done} / {progress.total}
            </span>
          </div>
        )}
      </div>

      {/* Status badge */}
      <StatusBadge status={status} />

      {/* AI action */}
      {action && <div>{action}</div>}

      {/* Review link */}
      {reviewPath && (
        <Link to={reviewPath} style={{
          display: "inline-flex", alignItems: "center", gap: 3,
          fontSize: "0.78rem", fontWeight: 600, color: "var(--brand)", textDecoration: "none",
          whiteSpace: "nowrap",
        }}>
          Review <ChevronRight size={13} />
        </Link>
      )}
    </div>
  );
}

// ── AI action button ──────────────────────────────────────────────────────────

function AiButton({
  label, loading, onClick, disabled,
}: { label: string; loading?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        padding: "0.3rem 0.75rem", borderRadius: "0.375rem", border: "none",
        background: loading || disabled ? "#a5b4fc" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
        color: "#fff", fontSize: "0.78rem", fontWeight: 600,
        cursor: loading || disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
      {label}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIPilotPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [model, setModel] = useState("anthropic/claude-haiku-4-5");

  const { data: status, isLoading, refetch } = useQuery({
    queryKey: ["ai-pilot-status", projectId],
    queryFn: () => aiPilotApi.getStatus(projectId!).then(r => r.data),
    enabled: !!projectId,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d) return false;
      const anyRunning =
        d.screening.llm_run?.status === "running" ||
        d.extraction.batch_job.status === "running" ||
        d.concepts.batch_job.status === "running";
      return anyRunning ? 3000 : false;
    },
  });

  // ── Bulk extraction ──────────────────────────────────────────────────────────
  const extractAll = useMutation({
    mutationFn: () => aiPilotApi.startBulkExtraction(projectId!, { model }),
    onSuccess: () => { refetch(); },
  });

  // ── Bulk concepts ────────────────────────────────────────────────────────────
  const conceptsAll = useMutation({
    mutationFn: () => aiPilotApi.startBulkConcepts(projectId!, { model }),
    onSuccess: () => { refetch(); },
  });

  // ── Resolve all conflicts ─────────────────────────────────────────────────
  const resolveAll = useMutation({
    mutationFn: () => aiPilotApi.resolveAll(projectId!, { model }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["ai-pilot-status", projectId] }); },
  });

  if (isLoading || !status) {
    return (
      <div className="page">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3rem" }}>
          <Loader2 size={24} className="spin" style={{ color: "var(--brand)" }} />
        </div>
      </div>
    );
  }

  const s = status;
  const extractJob = s.extraction.batch_job;
  const conceptsJob = s.concepts.batch_job;

  // Derive stage statuses
  const setupStatus: StageStatus =
    s.setup.has_criteria && s.setup.has_extraction_template ? "done" : "idle";

  const importStatus: StageStatus =
    s.import.record_count > 0 ? "done" : "idle";

  const dedupStatus: StageStatus =
    s.import.record_count > 0 ? "done" : "idle";

  const screenStatus: StageStatus =
    s.screening.llm_run?.status === "running" ? "running"
    : s.screening.ft_included_count > 0 ? "done"
    : "idle";

  const extractStatus: StageStatus =
    extractJob.status === "running" ? "running"
    : s.extraction.extracted_count > 0 ? (s.extraction.extracted_count < s.screening.ft_included_count ? "review" : "done")
    : "idle";

  const conceptStatus: StageStatus =
    conceptsJob.status === "running" ? "running"
    : s.concepts.concept_count > 0 ? "done"
    : "idle";

  const thematicStatus: StageStatus =
    s.thematic.theme_count > 0 ? "done" : "idle";

  const conflictStatus: StageStatus =
    resolveAll.isPending ? "running"
    : s.conflicts.unresolved_count === 0 ? "done"
    : "review";

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1><Cpu size={18} style={{ verticalAlign: "middle", marginRight: 6 }} />AI Pilot</h1>
          <span className="subtitle">AI-assisted pipeline — every step, human reviews the output</span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{ fontSize: "0.8rem", padding: "0.3rem 0.5rem", borderRadius: "0.375rem", border: "1px solid var(--border)", background: "var(--surface)" }}
          >
            {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button
            onClick={() => refetch()}
            style={{ padding: "0.3rem 0.6rem", borderRadius: "0.375rem", border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}
            title="Refresh status"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* Resolve-all feedback */}
      {resolveAll.isSuccess && resolveAll.data && (
        <div className="card" style={{ padding: "0.75rem 1rem", marginBottom: "1rem", background: "#f0fdf4", borderColor: "#bbf7d0" }}>
          <span style={{ color: "#16a34a", fontSize: "0.85rem", fontWeight: 600 }}>{resolveAll.data.data.message}</span>
        </div>
      )}
      {resolveAll.isError && (
        <div className="card" style={{ padding: "0.75rem 1rem", marginBottom: "1rem", background: "#fff5f5", borderColor: "#fca5a5" }}>
          <span style={{ color: "#c5221f", fontSize: "0.85rem" }}>Conflict resolution failed. Check API key and retry.</span>
        </div>
      )}

      {/* Pipeline */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>

        {/* Section header */}
        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Setup</span>
        </div>

        <PipelineRow
          icon={<Settings size={16} />}
          title="Project setup"
          subtitle={
            s.setup.has_criteria
              ? "Criteria configured" + (s.setup.has_extraction_template ? " + extraction template" : "")
              : "No criteria yet"
          }
          status={setupStatus}
          reviewPath={`/projects/${projectId}`}
          action={
            <Link to={`/projects/${projectId}`} style={{ textDecoration: "none" }}>
              <AiButton label="Draft with AI" onClick={() => {}} />
            </Link>
          }
        />

        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Literature</span>
        </div>

        <PipelineRow
          icon={<Upload size={16} />}
          title="Import & search"
          subtitle={s.import.record_count > 0 ? `${s.import.record_count.toLocaleString()} records from ${s.import.source_count} source${s.import.source_count !== 1 ? "s" : ""}` : "No records yet"}
          status={importStatus}
          reviewPath={`/projects/${projectId}/search`}
          action={
            <Link to={`/projects/${projectId}/search`} style={{ textDecoration: "none" }}>
              <AiButton label="PubMed Search" onClick={() => {}} />
            </Link>
          }
        />

        <PipelineRow
          icon={<GitMerge size={16} />}
          title="Deduplication"
          subtitle={s.dedup.cluster_count > 0 ? `${s.dedup.cluster_count} overlap cluster${s.dedup.cluster_count !== 1 ? "s" : ""} detected` : "No overlap clusters"}
          status={dedupStatus}
          reviewPath={`/projects/${projectId}/overlap`}
        />

        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Screening</span>
        </div>

        <PipelineRow
          icon={<Search size={16} />}
          title="Title / abstract + full-text screening"
          subtitle={
            s.screening.llm_run
              ? `${s.screening.llm_run.status} · ${s.screening.ft_included_count} included`
              : s.screening.ft_included_count > 0
              ? `${s.screening.ft_included_count} papers included after screening`
              : "Not screened yet"
          }
          status={screenStatus}
          progress={
            s.screening.llm_run?.status === "running"
              ? { done: s.screening.llm_run.done, total: s.screening.llm_run.total }
              : undefined
          }
          reviewPath={`/projects/${projectId}/llm-screening`}
          action={
            <Link to={`/projects/${projectId}/llm-screening`} style={{ textDecoration: "none" }}>
              <AiButton label="Run AI Screening" onClick={() => {}} />
            </Link>
          }
        />

        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Extraction</span>
        </div>

        <PipelineRow
          icon={<FileText size={16} />}
          title="Data extraction"
          subtitle={
            extractJob.status === "running"
              ? `Extracting… ${extractJob.done ?? 0} / ${extractJob.total ?? "?"}`
              : extractJob.status === "done"
              ? `Bulk extraction complete — ${s.extraction.extracted_count} extracted`
              : s.extraction.extracted_count > 0
              ? `${s.extraction.extracted_count} / ${s.extraction.ft_included_count} extracted`
              : s.extraction.ft_included_count > 0
              ? `${s.extraction.ft_included_count} papers awaiting extraction`
              : "Screen papers first"
          }
          status={extractStatus}
          progress={extractJob.status === "running" && extractJob.total ? { done: extractJob.done ?? 0, total: extractJob.total } : undefined}
          reviewPath={`/projects/${projectId}/extractions`}
          action={
            s.setup.has_extraction_template && s.extraction.ft_included_count > 0 ? (
              <AiButton
                label={extractJob.status === "running" ? "Running…" : "Extract All with AI"}
                loading={extractJob.status === "running"}
                disabled={extractJob.status === "running"}
                onClick={() => extractAll.mutate()}
              />
            ) : undefined
          }
        />

        <PipelineRow
          icon={<Layers size={16} />}
          title="Concept extraction"
          subtitle={
            conceptsJob.status === "running"
              ? `Extracting concepts… ${conceptsJob.done ?? 0} / ${conceptsJob.total ?? "?"}`
              : s.concepts.concept_count > 0
              ? `${s.concepts.concept_count} concept record${s.concepts.concept_count !== 1 ? "s" : ""}`
              : s.extraction.ft_included_count > 0
              ? "Concepts not yet extracted"
              : "Screen papers first"
          }
          status={conceptStatus}
          progress={conceptsJob.status === "running" && conceptsJob.total ? { done: conceptsJob.done ?? 0, total: conceptsJob.total } : undefined}
          reviewPath={`/projects/${projectId}/concept-taxonomy`}
          action={
            s.setup.has_concept_template && s.extraction.ft_included_count > 0 ? (
              <AiButton
                label={conceptsJob.status === "running" ? "Running…" : "Extract All with AI"}
                loading={conceptsJob.status === "running"}
                disabled={conceptsJob.status === "running"}
                onClick={() => conceptsAll.mutate()}
              />
            ) : undefined
          }
        />

        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Analysis</span>
        </div>

        <PipelineRow
          icon={<BarChart3 size={16} />}
          title="Thematic analysis"
          subtitle={
            s.thematic.theme_count > 0
              ? `${s.thematic.theme_count} theme${s.thematic.theme_count !== 1 ? "s" : ""}, ${s.thematic.code_count} code${s.thematic.code_count !== 1 ? "s" : ""}`
              : "No themes yet"
          }
          status={thematicStatus}
          reviewPath={`/projects/${projectId}/thematic`}
          action={
            s.extraction.extracted_count > 0 ? (
              <Link to={`/projects/${projectId}/thematic`} style={{ textDecoration: "none" }}>
                <AiButton label="Suggest Themes" onClick={() => {}} />
              </Link>
            ) : undefined
          }
        />

        <PipelineRow
          icon={<MessageSquare size={16} />}
          title="Conflict resolution"
          subtitle={
            s.conflicts.unresolved_count > 0
              ? `${s.conflicts.unresolved_count} unresolved conflict${s.conflicts.unresolved_count !== 1 ? "s" : ""}`
              : "No unresolved conflicts"
          }
          status={conflictStatus}
          reviewPath={`/projects/${projectId}/consensus`}
          action={
            s.conflicts.unresolved_count > 0 ? (
              <AiButton
                label={resolveAll.isPending ? "Resolving…" : "Resolve All with AI"}
                loading={resolveAll.isPending}
                onClick={() => resolveAll.mutate()}
              />
            ) : undefined
          }
        />

        <div style={{ padding: "0.75rem 1.1rem", background: "#f8f9fa", borderBottom: "1px solid var(--border)", borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: "0.73rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Synthesis</span>
        </div>

        <PipelineRow
          icon={<Sparkles size={16} />}
          title="Evidence synthesis"
          subtitle="AI-generated report from all extracted evidence"
          status="idle"
          reviewPath={`/projects/${projectId}/report`}
          action={
            s.extraction.extracted_count > 0 ? (
              <Link to={`/projects/${projectId}/report`} style={{ textDecoration: "none" }}>
                <AiButton label="Generate Report" onClick={() => {}} />
              </Link>
            ) : undefined
          }
        />

      </div>

      {/* Tip */}
      <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "1rem", textAlign: "center" }}>
        AI proposes — you review and correct. Each "Review →" link opens the full human workspace for that stage.
      </p>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  );
}
