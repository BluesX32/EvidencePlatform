/**
 * LLMScreeningPage — AI-assisted screening and extraction.
 *
 * Tab layout:
 *   A. Run       — mode selection, model, estimate, launch, run history
 *   B. Prompt    — research question, custom prompt additions, extraction instructions, glossary
 *   C. Results   — paginated results table with export CSV
 *   D. Compare   — LLM vs human agreement stats + disagreement table + send to consensus
 */
import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "../components/Feedback";
import {
  AlertCircle,
  Bot,
  ChevronLeft,
  Play,
  RefreshCw,
  X,
  ChevronDown,
  ChevronUp,
  Download,
  GitCompare,
  Wand2,
  Layers,
  User,
  Plus,
  Trash2,
  RotateCcw,
} from "lucide-react";
import {
  projectsApi,
  sourcesApi,
  llmScreeningApi,
  fulltextApi,
  authApi,
  screeningApi,
  teamApi,
  type LlmRunResponse,
  type LlmResultResponse,
  type LlmConfig,
  type LlmComparisonResponse,
  type RunVsRunResponse,
  type AgentSpec,
  type EstimateStage,
  type Source,
  type ScreeningQueueHistoryEntry,
  type TeamMember,
  type MissingPdfRecord,
  type FtQueuePaper,
} from "../api/client";

// ── Model catalog ─────────────────────────────────────────────────────────────

interface ModelDef {
  id: string;
  label: string;
  cost_per_1k: string;
  speed: string;
  context: string;
  tags: string[];
  pros: string[];
  cons: string[];
  best_for: string;
  recommended?: boolean;
}

interface ModelGroup {
  group: string;
  key: "anthropic_or_openrouter" | "openrouter";
  models: ModelDef[];
}

const MODEL_CATALOG: ModelGroup[] = [
  {
    group: "Claude — Anthropic",
    key: "anthropic_or_openrouter",
    models: [
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        cost_per_1k: "~$0.25",
        speed: "Fast",
        context: "200k tokens",
        tags: ["⚡ Fast", "💰 Budget"],
        pros: [
          "Fastest Claude model — ideal for large-scale screening",
          "Low cost per paper",
          "Reliable structured JSON output",
        ],
        cons: [
          "Less nuanced reasoning on complex inclusion criteria",
          "May miss subtle thematic connections",
        ],
        best_for: "High-volume first-pass screening with clear criteria",
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        cost_per_1k: "~$3",
        speed: "Medium",
        context: "200k tokens",
        tags: ["⭐ Recommended", "⚖️ Balanced"],
        pros: [
          "Best balance of accuracy and cost for academic screening",
          "Strong at following nuanced inclusion/exclusion criteria",
          "Excellent structured output with tool_use",
        ],
        cons: [
          "More expensive than Haiku",
          "Slower than Haiku for bulk processing",
        ],
        best_for: "Standard systematic review screening",
        recommended: true,
      },
      {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        cost_per_1k: "~$15",
        speed: "Slow",
        context: "200k tokens",
        tags: ["🧠 Most Capable"],
        pros: [
          "Highest reasoning quality for complex research questions",
          "Best at identifying subtle thematic patterns",
          "Most thorough concept extraction",
        ],
        cons: [
          "Most expensive — 5x Sonnet cost",
          "Slowest processing speed",
        ],
        best_for: "High-stakes reviews where maximum accuracy is critical",
      },
    ],
  },
  {
    group: "OpenAI — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "openai/gpt-4o-mini",
        label: "GPT-4o mini",
        cost_per_1k: "~$0.15",
        speed: "Fast",
        context: "128k tokens",
        tags: ["⚡ Fast", "💰 Budget"],
        pros: [
          "Very cheap — ideal for exploratory runs",
          "Fast and reliable function calling",
          "Widely benchmarked in research contexts",
        ],
        cons: [
          "Weaker at nuanced academic language vs Claude",
          "Smaller context window than Claude/Gemini",
        ],
        best_for: "Budget screening runs and quick validation",
      },
      {
        id: "openai/gpt-4o",
        label: "GPT-4o",
        cost_per_1k: "~$2.50",
        speed: "Medium",
        context: "128k tokens",
        tags: ["🔬 Research-Tested"],
        pros: [
          "Strong general reasoning across academic domains",
          "Widely tested in peer-reviewed research",
          "Good JSON schema adherence",
        ],
        cons: [
          "No advantage over Claude Sonnet for most screening tasks",
          "128k context may be limiting for very long papers",
        ],
        best_for: "Teams already using OpenAI infrastructure",
      },
      {
        id: "openai/o3-mini",
        label: "o3-mini (Reasoning)",
        cost_per_1k: "~$1.10",
        speed: "Medium",
        context: "200k tokens",
        tags: ["🧠 Reasoning"],
        pros: [
          "Explicit chain-of-thought reasoning aids transparency",
          "Strong at evaluating complex multi-criteria decisions",
          "Larger context than GPT-4o",
        ],
        cons: [
          "Reasoning overhead adds latency",
          "May over-explain simple decisions",
        ],
        best_for: "Complex inclusion criteria requiring step-by-step evaluation",
      },
      {
        id: "openai/gpt-5.3-chat",
        label: "GPT-5.3",
        cost_per_1k: "~$8",
        speed: "Medium",
        context: "256k tokens",
        tags: ["🆕 New", "🧠 Frontier"],
        pros: [
          "Next-generation reasoning — significant step up from GPT-4o",
          "Better instruction-following for complex criteria",
          "Improved long-context comprehension",
        ],
        cons: [
          "More expensive than GPT-4o",
          "May be overkill for straightforward screening tasks",
        ],
        best_for: "High-stakes reviews needing the latest OpenAI reasoning",
      },
      {
        id: "openai/gpt-5.4",
        label: "GPT-5.4",
        cost_per_1k: "~$10",
        speed: "Medium",
        context: "256k tokens",
        tags: ["🆕 New", "🧠 Frontier"],
        pros: [
          "OpenAI's most capable standard model",
          "Excellent at synthesizing evidence across long documents",
          "State-of-the-art on academic benchmarks",
        ],
        cons: [
          "Expensive at $10/1k tokens",
          "Diminishing returns over GPT-5.3 for routine screening",
        ],
        best_for: "Flagship performance — complex, nuanced inclusion decisions",
      },
    ],
  },
  {
    group: "Google Gemini — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "google/gemini-2.0-flash-001",
        label: "Gemini 2.0 Flash",
        cost_per_1k: "~$0.10",
        speed: "Very Fast",
        context: "1M tokens",
        tags: ["⚡ Very Fast", "📄 Long Context"],
        pros: [
          "Massive 1M token context — excellent for full papers",
          "Very high throughput at very low cost",
          "Good multimodal capabilities",
        ],
        cons: [
          "Less consistent structured output than Claude",
          "Reasoning depth weaker than Sonnet/GPT-4o",
        ],
        best_for: "Large-scale screening with full-text PDFs available",
      },
      {
        id: "google/gemini-2.5-pro-preview",
        label: "Gemini 2.5 Pro",
        cost_per_1k: "~$1.25",
        speed: "Medium",
        context: "1M tokens",
        tags: ["📄 Long Context", "🧠 Reasoning"],
        pros: [
          "Excellent at long-document comprehension",
          "Strong reasoning with massive context",
          "Good for complex multi-paper synthesis",
        ],
        cons: [
          "Preview model — may have stability issues",
          "More expensive than Flash",
        ],
        best_for: "Full-text screening of long papers and technical reports",
      },
    ],
  },
  {
    group: "Meta Llama — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "meta-llama/llama-4-scout",
        label: "Llama 4 Scout",
        cost_per_1k: "~$0.15",
        speed: "Fast",
        context: "10M tokens",
        tags: ["🆕 New", "🔓 Open Source", "📄 Ultra Long Context"],
        pros: [
          "Groundbreaking 10M token context — entire corpora in one call",
          "Open-source with multimodal capabilities",
          "Very competitive pricing",
        ],
        cons: [
          "New model — less community validation on academic tasks",
          "Ultra-long context may slow inference",
        ],
        best_for: "Full-corpus screening where entire literature fits in context",
      },
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B",
        cost_per_1k: "~$0.12",
        speed: "Fast",
        context: "128k tokens",
        tags: ["🔓 Open Source", "💰 Budget"],
        pros: [
          "Fully open-source — results are auditable and reproducible",
          "Good cost/performance ratio",
          "Can be self-hosted for privacy-sensitive research",
        ],
        cons: [
          "Weaker at nuanced academic inclusion/exclusion vs Claude/GPT-4o",
          "Less reliable structured output",
        ],
        best_for: "Transparency-focused research requiring open-source auditability",
      },
    ],
  },
  {
    group: "DeepSeek — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "deepseek/deepseek-chat",
        label: "DeepSeek Chat",
        cost_per_1k: "~$0.14",
        speed: "Medium",
        context: "128k tokens",
        tags: ["💰 Budget", "🌏 Chinese AI"],
        pros: [
          "Very competitive pricing",
          "Strong STEM and medical literature reasoning",
          "Good structured output",
        ],
        cons: [
          "Data governance concerns for some institutions",
          "Less tested on systematic review tasks",
        ],
        best_for: "Budget-conscious researchers comfortable with Chinese AI providers",
      },
    ],
  },
  {
    group: "NVIDIA — Free via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        label: "Nemotron 3 Super 120B (Free)",
        cost_per_1k: "Free",
        speed: "Medium",
        context: "128k tokens",
        tags: ["🆓 Free", "🔓 Open Source"],
        pros: [
          "Completely free — $0 cost for unlimited screening",
          "Open-source weights — fully auditable",
          "Strong STEM reasoning",
        ],
        cons: [
          "Free tier has rate limits",
          "Less tested on systematic review screening",
        ],
        best_for: "Zero-budget exploratory runs or researchers without API credits",
      },
    ],
  },
];

const MODEL_BY_ID: Record<string, ModelDef & { groupKey: string }> = Object.fromEntries(
  MODEL_CATALOG.flatMap((g) => g.models.map((m) => [m.id, { ...m, groupKey: g.key }]))
);

const DEFAULT_COMPARISON_IDS = ["claude-sonnet-4-6", "openai/gpt-4o", "google/gemini-2.0-flash-001"];

const DECISION_FILTER_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "include", label: "Include" },
  { value: "exclude", label: "Exclude" },
  { value: "uncertain", label: "Uncertain" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function decisionBadge(decision: string | null, small?: boolean) {
  if (!decision) return <span style={{ color: "#9aa0a6" }}>—</span>;
  const colors: Record<string, { bg: string; fg: string }> = {
    include:   { bg: "#e6f4ea", fg: "#188038" },
    exclude:   { bg: "#fce8e6", fg: "#c5221f" },
    uncertain: { bg: "#fef7e0", fg: "#b06000" },
  };
  const c = colors[decision] ?? { bg: "#f1f3f4", fg: "#5f6368" };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        fontWeight: 600,
        padding: small ? "0.1rem 0.4rem" : "0.15rem 0.55rem",
        borderRadius: "0.75rem",
        fontSize: small ? "0.72rem" : "0.78rem",
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {decision}
    </span>
  );
}

function isEffectivelyCompleted(run: { status: string; processed_records: number; total_records?: number | null }) {
  if (run.status === "completed") return true;
  const total = run.total_records ?? 0;
  return total > 0 && run.processed_records >= total && (run.status === "cancelled" || run.status === "interrupted");
}

function statusBadge(run: { status: string; processed_records: number; total_records?: number | null }) {
  const effectiveStatus = isEffectivelyCompleted(run) ? "completed" : run.status;
  const map: Record<string, { label: string; color: string }> = {
    queued:      { label: "Queued",      color: "#9aa0a6" },
    running:     { label: "Running…",    color: "#1a73e8" },
    completed:   { label: "Completed",   color: "#188038" },
    failed:      { label: "Failed",      color: "#c5221f" },
    interrupted: { label: "Interrupted", color: "#b06000" },
  };
  const s = map[effectiveStatus] ?? { label: effectiveStatus, color: "#5f6368" };
  return <span style={{ color: s.color, fontWeight: 600, fontSize: "0.82rem" }}>{s.label}</span>;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        background: "#e8f0fe",
        borderRadius: "0.5rem",
        height: 6,
        width: 120,
        overflow: "hidden",
        display: "inline-block",
        verticalAlign: "middle",
      }}
    >
      <div
        style={{
          background: "#1a73e8",
          height: "100%",
          width: `${Math.min(pct, 100)}%`,
          borderRadius: "0.5rem",
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

function fmtCost(usd: number | null | undefined) {
  if (usd == null) return "—";
  return `$${usd.toFixed(4)}`;
}

function fmtMinutes(min: number) {
  if (min < 1) return `~${Math.round(min * 60)}s`;
  return `~${min.toFixed(1)} min`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}


// ── Model Description Card ────────────────────────────────────────────────────

function ModelDescriptionCard({ modelId }: { modelId: string }) {
  const m = MODEL_BY_ID[modelId];
  if (!m) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.5rem", padding: "1rem", marginTop: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: "0.9rem", color: "#3c4043" }}>{m.label}</span>
        {m.tags.map((tag) => (
          <span key={tag} style={{ background: "#ede9fe", color: "#6366f1", padding: "0.1rem 0.5rem", borderRadius: "0.75rem", fontSize: "0.72rem", fontWeight: 600 }}>{tag}</span>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", fontSize: "0.82rem" }}>
        <div>
          <p style={{ margin: "0 0 0.35rem", fontWeight: 600, color: "#188038", fontSize: "0.78rem" }}>Strengths</p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "#3c4043" }}>
            {m.pros.map((p) => <li key={p} style={{ marginBottom: "0.15rem" }}>{p}</li>)}
          </ul>
        </div>
        <div>
          <p style={{ margin: "0 0 0.35rem", fontWeight: 600, color: "#c5221f", fontSize: "0.78rem" }}>Limitations</p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "#3c4043" }}>
            {m.cons.map((c) => <li key={c} style={{ marginBottom: "0.15rem" }}>{c}</li>)}
          </ul>
        </div>
      </div>
      <div style={{ marginTop: "0.65rem", display: "flex", gap: "1.5rem", fontSize: "0.78rem", color: "#5f6368", flexWrap: "wrap" }}>
        <span><strong>Context:</strong> {m.context}</span>
        <span><strong>Cost/1k:</strong> {m.cost_per_1k}</span>
        <span><strong>Speed:</strong> {m.speed}</span>
        <span><strong>Best for:</strong> {m.best_for}</span>
      </div>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", color: "#9aa0a6" }}>
        {m.groupKey === "anthropic_or_openrouter" ? "Requires Anthropic API key or OpenRouter API key" : "Requires OpenRouter API key"}
      </p>
    </div>
  );
}

// ── Model Comparison Table ────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  fontSize: "0.78rem", padding: "0.3rem 0.5rem", borderRadius: "0.3rem",
  border: "1px solid #dadce0", background: "#fff", color: "#3c4043", width: "100%", cursor: "pointer",
};

function ModelComparisonTable({ onSelectModel }: { onSelectModel: (id: string) => void }) {
  const [selected, setSelected] = useState<[string, string, string]>(DEFAULT_COMPARISON_IDS as [string, string, string]);
  const models = selected.map((id) => MODEL_BY_ID[id]).filter(Boolean);

  function changeSlot(slotIdx: number, newId: string) {
    setSelected((prev) => { const next = [...prev] as [string, string, string]; next[slotIdx] = newId; return next; });
  }

  return (
    <div style={{ marginTop: "1rem", border: "1px solid #dadce0", borderRadius: "0.5rem", overflow: "hidden", fontSize: "0.82rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f1f3f4" }}>
            <th style={{ padding: "0.6rem 0.85rem", textAlign: "left", fontWeight: 600, fontSize: "0.75rem", color: "#5f6368", textTransform: "uppercase", letterSpacing: "0.04em", width: 130 }}>Attribute</th>
            {selected.map((id, slotIdx) => (
              <th key={slotIdx} style={{ padding: "0.5rem 0.85rem", verticalAlign: "bottom" }}>
                <select value={id} onChange={(e) => changeSlot(slotIdx, e.target.value)} style={selectStyle} title="Change model">
                  {MODEL_CATALOG.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {([
            ["Speed", (m: ModelDef) => m.speed],
            ["Context", (m: ModelDef) => m.context],
            ["Cost/1k tokens", (m: ModelDef) => m.cost_per_1k],
            ["Best for", (m: ModelDef) => m.best_for],
            ["Limitations", (m: ModelDef) => m.cons[0] + (m.cons.length > 1 ? ` (+${m.cons.length - 1})` : "")],
          ] as [string, (m: ModelDef) => string][]).map(([label, getter], rowIdx) => (
            <tr key={label} style={{ background: rowIdx % 2 === 0 ? "#fff" : "#f8f9fa" }}>
              <td style={{ padding: "0.55rem 0.85rem", fontWeight: 600, color: "#5f6368", verticalAlign: "top" }}>{label}</td>
              {models.map((m) => (
                <td key={m.id} style={{ padding: "0.55rem 0.85rem", color: "#3c4043", verticalAlign: "top" }}>{getter(m)}</td>
              ))}
            </tr>
          ))}
          <tr style={{ background: "#f1f3f4" }}>
            <td style={{ padding: "0.6rem 0.85rem" }} />
            {models.map((m) => (
              <td key={m.id} style={{ padding: "0.6rem 0.85rem" }}>
                <button className="btn-primary" style={{ fontSize: "0.78rem", padding: "0.3rem 0.7rem" }} onClick={() => onSelectModel(m.id)}>
                  Use this model
                </button>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Review Actions ────────────────────────────────────────────────────────────

export function ReviewActions({ result, projectId, runId, onReviewed }: { result: LlmResultResponse; projectId: string; runId: string; onReviewed: () => void }) {
  const [pending, setPending] = useState(false);

  async function handle(action: "accepted" | "rejected" | "merged") {
    setPending(true);
    try { await llmScreeningApi.reviewResult(projectId, runId, result.id, action); onReviewed(); }
    finally { setPending(false); }
  }

  if (result.review_action) {
    const colors: Record<string, string> = { accepted: "#188038", rejected: "#c5221f", merged: "#1a73e8" };
    return <span style={{ fontSize: "0.78rem", color: colors[result.review_action] ?? "#5f6368", fontWeight: 600, textTransform: "capitalize" }}>{result.review_action}</span>;
  }

  return (
    <div style={{ display: "flex", gap: "0.3rem" }}>
      {(["accepted", "rejected", "merged"] as const).map((action) => (
        <button key={action} disabled={pending} onClick={() => handle(action)} style={{ padding: "0.2rem 0.5rem", fontSize: "0.72rem", borderRadius: "0.3rem", border: "1px solid #dadce0", background: "#f8f9fa", cursor: "pointer", fontWeight: 600, textTransform: "capitalize" }}>
          {action.slice(0, 1).toUpperCase() + action.slice(1)}
        </button>
      ))}
    </div>
  );
}

// ── Result Row ────────────────────────────────────────────────────────────────

function ResultRow({ result, projectId: _projectId, runId: _runId, extractionTemplate, onReviewed: _onReviewed }: {
  result: LlmResultResponse;
  projectId: string;
  runId: string;
  extractionTemplate?: { rows: Array<{ id: string; domain?: string; item: string }> } | null;
  onReviewed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isNew = (result.new_concepts?.length ?? 0) > 0;
  const hasExtraction = result.extracted_json && Object.keys(result.extracted_json).length > 0;

  return (
    <>
      <tr style={{ background: isNew ? "rgba(79,70,229,0.04)" : undefined, cursor: "pointer" }} onClick={() => setExpanded((v) => !v)}>
        <td style={{ fontSize: "0.82rem", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0.5rem 0.75rem", color: "#3c4043" }}>
          {result.title ?? result.record_id?.slice(-8) ?? result.cluster_id?.slice(-8) ?? "—"}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(result.ta_decision)}</td>
        <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(result.ft_decision)}</td>
        <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.8rem", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {result.ta_reason ?? "—"}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }}>
          {isNew ? <span style={{ color: "#6366f1", fontWeight: 600, fontSize: "0.78rem" }}>+{result.new_concepts!.length} new</span> : <span style={{ color: "#9aa0a6", fontSize: "0.78rem" }}>—</span>}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }}>
          {hasExtraction ? <span style={{ color: "#188038", fontSize: "0.78rem" }}>✓</span> : <span style={{ color: "#9aa0a6", fontSize: "0.78rem" }}>—</span>}
        </td>
        <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem", color: "#5f6368" }}>{result.full_text_source ?? "abstract"}</td>
      </tr>
      {expanded && (
        <tr style={{ background: "#f8f9fa" }}>
          <td colSpan={7} style={{ padding: "0.75rem 1rem", fontSize: "0.83rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              {result.ta_reason && <div><strong style={{ color: "#3c4043" }}>TA reason:</strong><p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ta_reason}</p></div>}
              {result.ft_reason && <div><strong style={{ color: "#3c4043" }}>FT reason:</strong><p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ft_reason}</p></div>}
              {(result.matched_codes?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#3c4043" }}>Matched concepts:</strong>
                  <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                    {result.matched_codes!.map((c) => (
                      <span key={c.code_id} style={{ background: "#e8f0fe", color: "#1a73e8", padding: "0.15rem 0.55rem", borderRadius: "0.75rem", fontSize: "0.78rem" }}>
                        {c.code_name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(result.new_concepts?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#6366f1" }}>New concepts suggested:</strong>
                  <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                    {result.new_concepts!.map((c) => (
                      <span key={c.name} style={{ background: "#ede9fe", color: "#6366f1", padding: "0.15rem 0.55rem", borderRadius: "0.75rem", fontSize: "0.78rem", fontWeight: 600 }}>
                        + {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {hasExtraction && extractionTemplate && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <strong style={{ color: "#3c4043" }}>Extracted data:</strong>
                  <div style={{ marginTop: "0.35rem", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.5rem" }}>
                    {extractionTemplate.rows.map((row) => {
                      const val = result.extracted_json?.[row.id];
                      if (!val) return null;
                      const label = row.domain ? `${row.domain}: ${row.item}` : row.item;
                      return (
                        <div key={row.id} style={{ background: "#f1f3f4", borderRadius: "0.3rem", padding: "0.4rem 0.6rem", fontSize: "0.8rem" }}>
                          <div style={{ fontWeight: 600, color: "#5f6368", fontSize: "0.72rem", marginBottom: "0.15rem" }}>{label}</div>
                          <div style={{ color: "#3c4043" }}>{Array.isArray(val) ? val.join(", ") : String(val)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Results Panel ─────────────────────────────────────────────────────────────

// ── Missing PDFs Panel ────────────────────────────────────────────────────────

// ── Full Text Queue Panel (ta_only runs) ─────────────────────────────────────

function FtQueuePanel({ projectId, taRun }: { projectId: string; taRun: LlmRunResponse }) {
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pasteTarget, setPasteTarget] = useState<string | null>(null); // record_id
  const [pasteText, setPasteText] = useState("");
  const [launching, setLaunching] = useState(false);

  const { data: queue, refetch } = useQuery({
    queryKey: ["llm-ft-queue", taRun.id],
    queryFn: () => llmScreeningApi.getFtQueue(projectId, taRun.id).then((r) => r.data),
    staleTime: 10_000,
    refetchInterval: false,
  });

  const papers: FtQueuePaper[] = queue?.papers ?? [];
  const ftRun: LlmRunResponse | null = queue?.ft_run ?? null;
  const providedCount = papers.filter((p) => p.has_pdf).length;

  async function handleUpload(paper: FtQueuePaper, file: File) {
    setUploading(paper.record_id);
    try {
      await fulltextApi.upload(projectId, file, { record_id: paper.record_id });
      void refetch();
    } finally {
      setUploading(null);
    }
  }

  async function handlePasteSubmit(paper: FtQueuePaper) {
    if (!pasteText.trim()) return;
    setUploading(paper.record_id);
    try {
      // Upload pasted text as a plain-text blob named after the record
      const blob = new Blob([pasteText], { type: "text/plain" });
      const file = new File([blob], `${paper.record_id}.txt`, { type: "text/plain" });
      await fulltextApi.upload(projectId, file, { record_id: paper.record_id });
      setPasteTarget(null);
      setPasteText("");
      void refetch();
    } finally {
      setUploading(null);
    }
  }

  async function launchFtRun() {
    setLaunching(true);
    try {
      await llmScreeningApi.createRun(projectId, {
        model: taRun.model,
        mode: "ft_only",
        source_run_id: taRun.id,
        include_extraction: taRun.include_extraction,
        agent_mode: taRun.agent_mode as "single" | "multi",
      });
      qc.invalidateQueries({ queryKey: ["llm-runs", projectId] });
      void refetch();
    } finally {
      setLaunching(false);
    }
  }

  const ftRunning = ftRun && (ftRun.status === "running" || ftRun.status === "queued");

  return (
    <div style={{ border: "2px solid #b06000", borderRadius: "0.5rem", background: "#fffbeb", marginBottom: "1.25rem" }}>
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1rem", background: "transparent", border: "none", cursor: "pointer", fontSize: "0.9rem", fontWeight: 700, color: "#92400e" }}
      >
        <span>
          📄 Full-Text Review Queue — {papers.length} paper{papers.length !== 1 ? "s" : ""} included in TA
          {providedCount > 0 && <span style={{ marginLeft: "0.5rem", fontSize: "0.8rem", fontWeight: 400 }}>· {providedCount} PDF{providedCount !== 1 ? "s" : ""} provided</span>}
        </span>
        {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>

      {!collapsed && (
        <div style={{ padding: "0 1rem 1rem" }}>
          <p style={{ fontSize: "0.82rem", color: "#78350f", margin: "0 0 0.75rem" }}>
            These papers passed title/abstract screening. Upload PDFs (or paste article text) so the LLM can perform full-text review and extraction. Papers without a PDF will be skipped in the FT phase.
          </p>

          {/* Status banner for existing FT run */}
          {ftRun && (
            <div style={{ background: ftRun.status === "completed" ? "#e6f4ea" : "#e8f0fe", border: `1px solid ${ftRun.status === "completed" ? "#34a853" : "#1a73e8"}`, borderRadius: "0.375rem", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.83rem", color: ftRun.status === "completed" ? "#188038" : "#1a73e8" }}>
              {ftRun.status === "completed"
                ? `✓ Full-text screening complete — ${ftRun.included_count} included, ${ftRun.excluded_count} excluded, ${ftRun.abstract_only_count} still no full text`
                : `Running full-text screening… ${ftRun.processed_records}/${ftRun.total_records ?? "?"} done`}
            </div>
          )}

          {/* Paper list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: 420, overflowY: "auto", marginBottom: "0.75rem" }}>
            {papers.map((paper) => (
              <div key={paper.record_id} style={{ background: "#fff", border: `1px solid ${paper.has_pdf ? "#34a853" : "#fde68a"}`, borderRadius: "0.375rem", padding: "0.6rem 0.75rem", fontSize: "0.82rem" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "#1c1b1f", marginBottom: "0.15rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {paper.has_pdf && <span style={{ color: "#34a853", marginRight: "0.3rem" }}>✓</span>}
                      {paper.title || "(no title)"}
                    </div>
                    <div style={{ color: "#5f6368", fontSize: "0.77rem" }}>
                      {paper.authors ? `${paper.authors.split(";")[0].trim()}${paper.authors.includes(";") ? " et al." : ""}` : ""}
                      {paper.year ? ` · ${paper.year}` : ""}
                      {paper.journal ? ` · ${paper.journal}` : ""}
                    </div>
                    {paper.ta_reason && <div style={{ color: "#6366f1", fontSize: "0.76rem", marginTop: "0.2rem", fontStyle: "italic" }}>TA: {paper.ta_reason}</div>}
                  </div>

                  <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0, alignItems: "center" }}>
                    {/* Open in browser */}
                    {paper.doi && (
                      <a
                        href={`https://doi.org/${paper.doi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary btn-sm"
                        style={{ textDecoration: "none", fontSize: "0.78rem" }}
                      >
                        Open ↗
                      </a>
                    )}

                    {/* Upload PDF */}
                    <label style={{ cursor: "pointer" }}>
                      <input
                        type="file"
                        accept=".pdf,.txt"
                        style={{ display: "none" }}
                        disabled={uploading === paper.record_id}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleUpload(paper, file);
                          e.target.value = "";
                        }}
                      />
                      <span className="btn-secondary btn-sm" style={{ pointerEvents: uploading === paper.record_id ? "none" : "auto", opacity: uploading === paper.record_id ? 0.6 : 1 }}>
                        {uploading === paper.record_id ? "Uploading…" : paper.has_pdf ? "Replace" : "Upload PDF"}
                      </span>
                    </label>

                    {/* Paste text */}
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => { setPasteTarget(pasteTarget === paper.record_id ? null : paper.record_id); setPasteText(""); }}
                    >
                      Paste text
                    </button>
                  </div>
                </div>

                {/* Inline paste area */}
                {pasteTarget === paper.record_id && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <p style={{ fontSize: "0.77rem", color: "#5f6368", margin: "0 0 0.3rem" }}>Open the paper in your browser, select all text (Ctrl+A / ⌘A), copy, and paste below.</p>
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="Paste article full text here…"
                      rows={6}
                      style={{ width: "100%", fontSize: "0.8rem", padding: "0.4rem", borderRadius: "0.25rem", border: "1px solid #dadce0", resize: "vertical", boxSizing: "border-box" }}
                    />
                    <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.3rem" }}>
                      <button className="btn-primary btn-sm" disabled={!pasteText.trim() || uploading === paper.record_id} onClick={() => void handlePasteSubmit(paper)}>
                        {uploading === paper.record_id ? "Saving…" : "Save text"}
                      </button>
                      <button className="btn-secondary btn-sm" onClick={() => { setPasteTarget(null); setPasteText(""); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Launch FT screening */}
          {!ftRun && !ftRunning && (
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <button
                className="btn-primary"
                disabled={launching || papers.length === 0}
                onClick={() => void launchFtRun()}
                style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
              >
                <Play size={14} />
                {launching ? "Launching…" : `Start Full-Text Screening (${papers.length} papers)`}
              </button>
              {providedCount < papers.length && (
                <span style={{ fontSize: "0.8rem", color: "#b06000" }}>
                  {papers.length - providedCount} paper{papers.length - providedCount !== 1 ? "s" : ""} without PDF will be skipped
                </span>
              )}
            </div>
          )}

          {ftRunning && (
            <p style={{ fontSize: "0.83rem", color: "#1a73e8" }}>Full-text screening is running… check the run history above for progress.</p>
          )}
        </div>
      )}
    </div>
  );
}


function MissingPdfsPanel({ projectId, runId }: { projectId: string; runId: string }) {
  const [collapsed, setCollapsed] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null); // record_id being uploaded

  const { data: missing, refetch } = useQuery({
    queryKey: ["llm-missing-pdfs", runId],
    queryFn: () => llmScreeningApi.getMissingPdfs(projectId, runId).then((r) => r.data),
    staleTime: 60_000,
  });

  if (!missing || missing.length === 0) return null;

  async function handleUpload(record: MissingPdfRecord, file: File) {
    setUploading(record.record_id);
    try {
      await fulltextApi.upload(projectId, file, { record_id: record.record_id });
      void refetch();
    } catch {
      // ignore — user can retry
    } finally {
      setUploading(null);
    }
  }

  return (
    <div style={{ border: "1px solid #fbbf24", borderRadius: "0.5rem", background: "#fffbeb", marginBottom: "1.25rem" }}>
      <button
        onClick={() => setCollapsed((c) => !c)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.65rem 1rem", background: "transparent", border: "none", cursor: "pointer", fontSize: "0.88rem", fontWeight: 600, color: "#92400e" }}
      >
        <span>⚠ {missing.length} paper{missing.length !== 1 ? "s" : ""} screened from abstract only — upload PDFs for full-text screening</span>
        {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
      {!collapsed && (
        <div style={{ padding: "0 1rem 0.75rem" }}>
          <p style={{ fontSize: "0.8rem", color: "#78350f", margin: "0 0 0.75rem" }}>
            These records passed TA screening but the LLM could not access their full text (no open-access PDF found). Upload PDFs to include them in future FT screening runs.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {missing.map((r) => (
              <div key={r.record_id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "#fff", border: "1px solid #fde68a", borderRadius: "0.375rem", padding: "0.5rem 0.75rem", fontSize: "0.82rem" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#1c1b1f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.title || "(no title)"}
                  </div>
                  <div style={{ color: "#5f6368", fontSize: "0.78rem" }}>
                    {r.authors ? `${r.authors.split(";")[0].trim()}${r.authors.includes(";") ? " et al." : ""}` : ""}
                    {r.year ? ` · ${r.year}` : ""}
                    {r.doi ? ` · DOI: ${r.doi}` : ""}
                  </div>
                </div>
                <label style={{ cursor: "pointer", whiteSpace: "nowrap" }}>
                  <input
                    type="file"
                    accept=".pdf"
                    style={{ display: "none" }}
                    disabled={uploading === r.record_id}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleUpload(r, file);
                      e.target.value = "";
                    }}
                  />
                  <span className="btn-secondary btn-sm" style={{ pointerEvents: uploading === r.record_id ? "none" : "auto", opacity: uploading === r.record_id ? 0.6 : 1 }}>
                    {uploading === r.record_id ? "Uploading…" : "Upload PDF"}
                  </span>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


type SubprojectTopChoice = "corpora" | "included" | "excluded";

function SubprojectModal({ projectId, run, onClose }: {
  projectId: string;
  run: LlmRunResponse;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  // Step 1: top-level choice
  const [topChoice, setTopChoice] = useState<SubprojectTopChoice | null>(null);

  // Step 2 — "included" sub-options
  const [includeUncertain, setIncludeUncertain] = useState(false);

  // Step 2 — "excluded" sub-options
  const [excludedSummaryFetched, setExcludedSummaryFetched] = useState(false);
  const [reasonCodes, setReasonCodes] = useState<Array<{ reason_code: string; count: number }>>([]);
  const [hasReasonCodes, setHasReasonCodes] = useState(false);
  const [sampleReasons, setSampleReasons] = useState<string[]>([]);
  const [selectedReasonCode, setSelectedReasonCode] = useState<string | null>(null);
  const [reasonTextFilter, setReasonTextFilter] = useState("");
  const [loadingSummary, setLoadingSummary] = useState(false);

  // Step 3 — common
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchExcludedSummary() {
    if (excludedSummaryFetched) return;
    setLoadingSummary(true);
    try {
      const res = await llmScreeningApi.getExcludedSummary(projectId, run.id);
      setReasonCodes(res.data.reason_codes);
      setHasReasonCodes(res.data.has_reason_codes);
      setSampleReasons(res.data.sample_reasons);
    } catch { /* ignore */ }
    setLoadingSummary(false);
    setExcludedSummaryFetched(true);
  }

  function handleTopChoice(choice: SubprojectTopChoice) {
    setTopChoice(choice);
    setError(null);
    if (choice === "excluded") void fetchExcludedSummary();
  }

  function estimatedCount(): number {
    if (topChoice === "corpora") return run.total_records ?? 0;
    if (topChoice === "included") return run.included_count + (includeUncertain ? run.uncertain_count : 0);
    if (topChoice === "excluded") return run.excluded_count;
    return 0;
  }

  function getCategories(): Array<"include" | "uncertain" | "exclude"> {
    if (topChoice === "corpora") return ["include", "uncertain", "exclude"];
    if (topChoice === "included") return includeUncertain ? ["include", "uncertain"] : ["include"];
    return ["exclude"];
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof llmScreeningApi.createSubproject>[2] = {
        name: name.trim(),
        description: description.trim() || undefined,
        categories: getCategories(),
      };
      if (topChoice === "excluded") {
        if (selectedReasonCode) body.reason_code_filter = selectedReasonCode;
        else if (reasonTextFilter.trim()) body.ta_reason_contains = reasonTextFilter.trim();
      }
      const res = await llmScreeningApi.createSubproject(projectId, run.id, body);
      navigate(`/projects/${res.data.project_id}`);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? "Failed to create sub-project";
      setError(msg);
      setBusy(false);
    }
  }

  const canCreate = !!name.trim() && !!topChoice && estimatedCount() > 0 && !busy;

  const TOP_CHOICES: Array<{ value: SubprojectTopChoice; label: string; sub: string; count: number; color: string; bg: string; border: string }> = [
    { value: "corpora",  label: "All papers",     sub: "Fork the entire corpus regardless of LLM decision", count: run.total_records ?? 0, color: "#1e3a5f", bg: "#eff6ff", border: "#93c5fd" },
    { value: "included", label: "Included papers", sub: "Papers the LLM passed to full-text review",        count: run.included_count,              color: "#166534", bg: "#dcfce7", border: "#86efac" },
    { value: "excluded", label: "Excluded papers", sub: "Papers the LLM excluded — filter by reason below", count: run.excluded_count,              color: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: "0.75rem", padding: "1.5rem", width: 520, maxHeight: "90vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 0.25rem" }}>Fork as Sub-Project</h3>
        <p style={{ margin: "0 0 1.25rem", fontSize: "0.85rem", color: "#5f6368" }}>
          Choose what to include, then name your sub-project. LLM decisions and reasons are embedded for PRISMA traceability.
        </p>

        {/* ── Step 1: Top-level choice ─────────────────────────────────── */}
        <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.5rem" }}>1. What papers to include</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "1rem" }}>
          {TOP_CHOICES.map((c) => {
            const active = topChoice === c.value;
            const disabled = c.count === 0;
            return (
              <button key={c.value} onClick={() => !disabled && handleTopChoice(c.value)}
                style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.65rem 0.9rem", borderRadius: "0.5rem", border: `1.5px solid ${active ? c.border : "#e5e7eb"}`, background: active ? c.bg : "#f9fafb", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, textAlign: "left", width: "100%" }}>
                <input type="radio" readOnly checked={active} style={{ accentColor: "#4f46e5", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 700, fontSize: "0.88rem", color: active ? c.color : "#374151" }}>{c.label}</span>
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: active ? c.color : "#9ca3af" }}>{c.count.toLocaleString()} papers</span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.1rem" }}>{c.sub}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Step 2a: Included sub-options ───────────────────────────── */}
        {topChoice === "included" && (
          <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "0.5rem" }}>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.4rem", display: "block" }}>2. Sub-options</label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", cursor: "pointer" }}>
              <input type="checkbox" checked={includeUncertain} onChange={(e) => setIncludeUncertain(e.target.checked)} style={{ accentColor: "#4f46e5" }} />
              Also include uncertain papers
              <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>({run.uncertain_count.toLocaleString()} papers)</span>
            </label>
          </div>
        )}

        {/* ── Step 2b: Excluded sub-options ───────────────────────────── */}
        {topChoice === "excluded" && (
          <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "#fff7f7", border: "1px solid #fecaca", borderRadius: "0.5rem" }}>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.5rem", display: "block" }}>2. Filter by exclusion reason (optional)</label>

            {loadingSummary && <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>Loading reason summary…</p>}

            {!loadingSummary && hasReasonCodes && (
              <>
                <p style={{ fontSize: "0.78rem", color: "#6b7280", margin: "0 0 0.4rem" }}>Select a category or leave blank to fork all excluded papers:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", maxHeight: 200, overflowY: "auto" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.83rem", cursor: "pointer", padding: "0.35rem 0.5rem", borderRadius: "0.375rem", background: selectedReasonCode === null ? "#e0e7ff" : "transparent" }}>
                    <input type="radio" checked={selectedReasonCode === null} onChange={() => setSelectedReasonCode(null)} style={{ accentColor: "#4f46e5" }} />
                    <span style={{ fontWeight: selectedReasonCode === null ? 700 : 400 }}>All excluded ({run.excluded_count.toLocaleString()})</span>
                  </label>
                  {reasonCodes.map((rc) => (
                    <label key={rc.reason_code} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.83rem", cursor: "pointer", padding: "0.35rem 0.5rem", borderRadius: "0.375rem", background: selectedReasonCode === rc.reason_code ? "#fee2e2" : "transparent" }}>
                      <input type="radio" checked={selectedReasonCode === rc.reason_code} onChange={() => setSelectedReasonCode(rc.reason_code)} style={{ accentColor: "#991b1b" }} />
                      <code style={{ background: "#f1f5f9", padding: "0.1rem 0.35rem", borderRadius: "0.25rem", fontSize: "0.78rem" }}>{rc.reason_code}</code>
                      <span style={{ color: "#6b7280", fontSize: "0.78rem" }}>{rc.count.toLocaleString()} papers</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {!loadingSummary && !hasReasonCodes && (
              <>
                <p style={{ fontSize: "0.78rem", color: "#6b7280", margin: "0 0 0.5rem" }}>
                  This run was screened before reason codes were added. Use a keyword search to filter papers by their exclusion reason text.
                </p>
                <input
                  value={reasonTextFilter}
                  onChange={(e) => setReasonTextFilter(e.target.value)}
                  placeholder='e.g. "conceptualization" or "non-healthcare" — leave blank for all excluded'
                  style={{ width: "100%", padding: "0.4rem 0.6rem", borderRadius: "0.375rem", border: "1.5px solid #fca5a5", fontSize: "0.85rem", boxSizing: "border-box" }}
                />
                {sampleReasons.length > 0 && (
                  <details style={{ marginTop: "0.5rem" }}>
                    <summary style={{ fontSize: "0.78rem", color: "#6b7280", cursor: "pointer" }}>Sample exclusion reasons from this run ({sampleReasons.length})</summary>
                    <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", fontSize: "0.75rem", color: "#374151", maxHeight: 160, overflowY: "auto" }}>
                      {sampleReasons.map((r, i) => <li key={i} style={{ marginBottom: "0.2rem" }}>{r}</li>)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 3: Name & create ────────────────────────────────────── */}
        {topChoice && (
          <>
            <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.25rem" }}>3. Sub-project name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                topChoice === "included" ? "e.g. Full-text review — LLM included"
                : topChoice === "excluded" ? "e.g. Excluded — not severity conceptualization"
                : "e.g. All papers sub-review"
              }
              style={{ width: "100%", padding: "0.45rem 0.65rem", borderRadius: "0.375rem", border: "1.5px solid #dadce0", fontSize: "0.9rem", boxSizing: "border-box", marginBottom: "0.6rem" }}
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              style={{ width: "100%", padding: "0.45rem 0.65rem", borderRadius: "0.375rem", border: "1.5px solid #dadce0", fontSize: "0.9rem", boxSizing: "border-box", marginBottom: "0.85rem" }}
            />
            <p style={{ margin: "0 0 0.85rem", fontSize: "0.8rem", color: "#6b7280" }}>
              ~{estimatedCount().toLocaleString()} papers · LLM decisions embedded for PRISMA traceability
            </p>
          </>
        )}

        {error && <p style={{ color: "#c5221f", fontSize: "0.82rem", marginBottom: "0.75rem" }}>{error}</p>}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={!canCreate} onClick={() => void handleCreate()}>
            {busy ? "Creating…" : "Create Sub-Project"}
          </button>
        </div>
      </div>
    </div>
  );
}


function ResultsPanel({ projectId, run, extractionTemplate }: {
  projectId: string;
  run: LlmRunResponse;
  extractionTemplate?: { rows: Array<{ id: string; domain?: string; item: string }> } | null;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [decisionFilter, setDecisionFilter] = useState("");
  const [exporting, setExporting] = useState(false);
  const [showSubproject, setShowSubproject] = useState(false);
  const PAGE_SIZE = 50;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["llm-results", run.id, page, decisionFilter],
    queryFn: () =>
      llmScreeningApi.listResults(projectId, run.id, { page, page_size: PAGE_SIZE, ta_decision: decisionFilter || undefined }).then((r) => r.data),
    enabled: run.status === "completed" || run.processed_records > 0,
    staleTime: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  async function handleExport() {
    setExporting(true);
    try {
      const res = await llmScreeningApi.exportCsv(projectId, run.id);
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `llm_results_${run.id.slice(-8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0 }}>Results — {MODEL_BY_ID[run.model]?.label ?? run.model}</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {DECISION_FILTER_OPTIONS.map((opt) => (
            <button key={opt.value} onClick={() => { setDecisionFilter(opt.value); setPage(1); }}
              style={{ padding: "0.2rem 0.65rem", borderRadius: "0.75rem", border: `1.5px solid ${decisionFilter === opt.value ? "#1a73e8" : "#dadce0"}`, background: decisionFilter === opt.value ? "#e8f0fe" : "#f8f9fa", color: decisionFilter === opt.value ? "#1a73e8" : "#5f6368", fontSize: "0.8rem", fontWeight: decisionFilter === opt.value ? 600 : 400, cursor: "pointer" }}>
              {opt.label}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          {isEffectivelyCompleted(run) && run.processed_records > 0 && (
            <button onClick={() => setShowSubproject(true)} className="btn-ghost" style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem", color: "#6366f1", borderColor: "#6366f1" }}>
              <GitCompare size={13} /> Fork as Sub-Project
            </button>
          )}
          <button onClick={handleExport} disabled={exporting || !isEffectivelyCompleted(run)} className="btn-ghost" style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem" }}>
            <Download size={13} /> {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button onClick={() => void refetch()} className="btn-ghost" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {showSubproject && (
        <SubprojectModal projectId={projectId} run={run} onClose={() => setShowSubproject(false)} />
      )}

      {/* Summary stats */}
      <div style={{ display: "flex", gap: "1.5rem", background: "#f8f9fa", border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "0.65rem 1rem", marginBottom: "1rem", fontSize: "0.85rem", flexWrap: "wrap" }}>
        <span><strong style={{ color: "#188038" }}>{run.included_count}</strong> <span style={{ color: "#5f6368" }}>included</span></span>
        <span><strong style={{ color: "#c5221f" }}>{run.excluded_count}</strong> <span style={{ color: "#5f6368" }}>excluded</span></span>
        <span><strong style={{ color: "#b06000" }}>{run.uncertain_count}</strong> <span style={{ color: "#5f6368" }}>uncertain</span></span>
        {run.new_concepts_count > 0 && <span><strong style={{ color: "#6366f1" }}>{run.new_concepts_count}</strong> <span style={{ color: "#5f6368" }}>new concepts</span></span>}
        {run.stopped_at_saturation && <span style={{ color: "#6366f1", fontWeight: 600, fontSize: "0.82rem" }}>⬡ Stopped at saturation</span>}
        <span style={{ marginLeft: "auto", color: "#5f6368" }}>{fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)} · {(run.input_tokens + run.output_tokens).toLocaleString()} tokens</span>
      </div>

      {/* Full Text Queue — shown for completed ta_only runs as an optional next step */}
      {run.mode === "ta_only" && isEffectivelyCompleted(run) && (
        <FtQueuePanel projectId={projectId} taRun={run} />
      )}

      {/* Missing PDFs prompt — shown for completed prisma_scr / saturation runs */}
      {isEffectivelyCompleted(run) && run.mode !== "ta_only" && run.mode !== "ft_only" && (
        <MissingPdfsPanel projectId={projectId} runId={run.id} />
      )}

      {isLoading ? (
        <p style={{ color: "#5f6368" }}>Loading results…</p>
      ) : !data || data.items.length === 0 ? (
        <p style={{ color: "#9aa0a6", fontStyle: "italic" }}>
          {run.status === "running" ? "Processing — results will appear as they complete." : "No results match the current filter."}
        </p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ background: "#f1f3f4", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#5f6368" }}>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Title</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>TA</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>FT</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Reason</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>New Concepts</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Extracted</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Full Text</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((result) => (
                  <ResultRow key={result.id} result={result} projectId={projectId} runId={run.id} extractionTemplate={extractionTemplate} onReviewed={() => qc.invalidateQueries({ queryKey: ["llm-results", run.id] })} />
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", justifyContent: "center", marginTop: "1rem", fontSize: "0.85rem" }}>
              <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
              <span style={{ color: "#5f6368" }}>Page {page} of {totalPages} ({data.total.toLocaleString()} results)</span>
              <button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next →</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Prompt Config Panel ────────────────────────────────────────────────────────

/** Collapsible block showing a read-only default system prompt. */
function DefaultPromptBlock({ label, prompt }: { label: string; prompt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: "1px solid #e8eaed", borderRadius: "0.375rem", marginBottom: "1rem" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.55rem 0.75rem", background: "#f8f9fa", border: "none", cursor: "pointer", borderRadius: open ? "0.375rem 0.375rem 0 0" : "0.375rem", fontSize: "0.82rem", color: "#5f6368", fontWeight: 600 }}
      >
        <span>{label}</span>
        <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <pre style={{ margin: 0, padding: "0.75rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#3c4043", background: "#fff", borderTop: "1px solid #e8eaed", borderRadius: "0 0 0.375rem 0.375rem", lineHeight: 1.5 }}>
          {prompt}
        </pre>
      )}
    </div>
  );
}

/** Single-agent prompt section: edits llm_config (research question, additions, concepts, etc.) */
function SingleAgentPromptSection({
  projectId,
  defaultPrompts,
}: {
  projectId: string;
  defaultPrompts: Record<string, string>;
}) {
  const qc = useQueryClient();
  const [advancedMode, setAdvancedMode] = useState(false);
  const [config, setConfig] = useState<LlmConfig>({});
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{ system_prompt: string; user_prompt: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: savedConfig } = useQuery({
    queryKey: ["llm-config", projectId],
    queryFn: () => llmScreeningApi.getLlmConfig(projectId).then((r) => r.data),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (savedConfig) { setConfig(savedConfig); setDirty(false); }
  }, [savedConfig]);

  function update(patch: Partial<LlmConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
    setDirty(true);
  }

  async function handleSave() {
    setSaveStatus("saving");
    try {
      await llmScreeningApi.updateLlmConfig(projectId, config);
      qc.invalidateQueries({ queryKey: ["llm-config", projectId] });
      setDirty(false);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch { setSaveStatus("error"); }
  }

  async function handlePreview() {
    setPreviewLoading(true);
    try {
      const res = await llmScreeningApi.previewPrompt(projectId);
      setPreviewData(res.data);
      setPreviewOpen(true);
    } finally { setPreviewLoading(false); }
  }

  const taStyle: React.CSSProperties = {
    width: "100%", padding: "0.5rem 0.75rem", borderRadius: "0.375rem",
    border: "1px solid #dadce0", fontSize: "0.85rem", fontFamily: "inherit",
    boxSizing: "border-box", resize: "vertical",
  };

  const defaultSingle = defaultPrompts["single"] ?? "";

  return (
    <>
      {/* Research question */}
      <div style={{ marginBottom: "1.25rem" }}>
        <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>Research question / review scope</label>
        <textarea rows={2} style={taStyle} placeholder="e.g. What is the effect of mindfulness interventions on burnout in healthcare workers?" value={config.research_question ?? ""} onChange={(e) => update({ research_question: e.target.value })} />
        <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.2rem" }}>Prepended to every prompt as high-level context for the agent.</p>
      </div>

      {/* Basic / Advanced toggle */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}>
        {["Basic", "Advanced"].map((m) => (
          <button key={m} onClick={() => setAdvancedMode(m === "Advanced")}
            style={{ padding: "0.3rem 1rem", borderRadius: "0.375rem", border: `1.5px solid ${advancedMode === (m === "Advanced") ? "#6366f1" : "#dadce0"}`, background: advancedMode === (m === "Advanced") ? "#ede9fe" : "#f8f9fa", color: advancedMode === (m === "Advanced") ? "#6366f1" : "#5f6368", fontWeight: 600, cursor: "pointer", fontSize: "0.85rem" }}>
            {m}
          </button>
        ))}
      </div>

      {!advancedMode ? (
        <>
          <DefaultPromptBlock label="Default system prompt (built-in)" prompt={defaultSingle} />

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>Additional screening context</label>
            <textarea rows={3} style={taStyle} placeholder="Additional context or instructions prepended to the default prompt…" value={config.custom_system_additions ?? ""} onChange={(e) => update({ custom_system_additions: e.target.value })} />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>Extraction instructions</label>
            <textarea rows={3} style={taStyle} placeholder="Instructions for how to fill in the extraction template fields…" value={config.extraction_instructions ?? ""} onChange={(e) => update({ extraction_instructions: e.target.value })} />
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>Concepts &amp; what to extract</label>
            <textarea rows={5} style={taStyle}
              placeholder={"Describe what the agent should look for and extract. For example:\n- Focus on studies using validated burnout scales (MBI, OLBI).\n- Extract intervention type, duration, and primary outcome.\n- 'Mindfulness' includes MBSR, MBCT, and informal practices."}
              value={config.concept_instructions ?? ""}
              onChange={(e) => update({ concept_instructions: e.target.value })}
            />
            <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.2rem" }}>
              Injected as a "Concepts and Extraction Guidance" section. Plain language and bullet points work best.
            </p>
          </div>
        </>
      ) : (
        <>
          {/* Advanced: default prompt always visible */}
          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>
              Default system prompt
              <span style={{ fontWeight: 400, fontSize: "0.78rem", color: "#9aa0a6", marginLeft: "0.5rem" }}>(read-only — your edits below modify or replace this)</span>
            </label>
            <pre style={{ margin: 0, padding: "0.75rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#3c4043", background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem", lineHeight: 1.5 }}>
              {defaultSingle}
            </pre>
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
              <label style={{ fontWeight: 600 }}>
                {config.use_full_override ? "Full replacement prompt" : "Additional instructions (prepended)"}
              </label>
              <label style={{ fontSize: "0.82rem", color: "#5f6368", display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}>
                <input type="checkbox" checked={config.use_full_override ?? false} onChange={(e) => update({ use_full_override: e.target.checked })} />
                Full override
              </label>
            </div>
            {!config.use_full_override && (
              <p style={{ fontSize: "0.78rem", color: "#5f6368", margin: "0 0 0.4rem" }}>Your text will be prepended to the default prompt above.</p>
            )}
            <textarea rows={8} style={{ ...taStyle, fontFamily: "monospace", fontSize: "0.83rem" }}
              placeholder={config.use_full_override ? "Write the complete replacement system prompt…" : "Additional instructions prepended to the default prompt…"}
              value={(config.use_full_override ? config.full_override_prompt : config.custom_system_additions) ?? ""}
              onChange={(e) => update(config.use_full_override ? { full_override_prompt: e.target.value } : { custom_system_additions: e.target.value })}
            />
            <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.2rem" }}>
              Variables: <code>{"{title}"}</code> <code>{"{abstract}"}</code> <code>{"{criteria}"}</code> <code>{"{framework}"}</code> <code>{"{extraction_template}"}</code>
            </p>
          </div>

          <div style={{ marginBottom: "1.25rem" }}>
            <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem" }}>Extraction instructions</label>
            <textarea rows={3} style={taStyle} placeholder="Additional instructions for the extraction step…" value={config.extraction_instructions ?? ""} onChange={(e) => update({ extraction_instructions: e.target.value })} />
          </div>
        </>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <button className="btn-primary" disabled={!dirty || saveStatus === "saving"} onClick={() => void handleSave()} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved ✓" : "Save prompt config"}
        </button>
        <button className="btn-ghost" disabled={previewLoading} onClick={() => void handlePreview()} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <Wand2 size={13} /> {previewLoading ? "Loading…" : "Preview prompt"}
        </button>
        {saveStatus === "error" && <span style={{ color: "#c5221f", fontSize: "0.83rem" }}>Save failed</span>}
      </div>

      {previewOpen && previewData && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setPreviewOpen(false)}>
          <div style={{ background: "#fff", borderRadius: "0.5rem", padding: "1.5rem", maxWidth: 780, width: "90vw", maxHeight: "80vh", overflow: "auto", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
              <h3 style={{ margin: 0 }}>Prompt preview (sample record)</h3>
              <button onClick={() => setPreviewOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5f6368" }}><X size={18} /></button>
            </div>
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>System prompt:</p>
              <pre style={{ background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflow: "auto" }}>{previewData.system_prompt}</pre>
            </div>
            <div>
              <p style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>User prompt:</p>
              <pre style={{ background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 350, overflow: "auto" }}>{previewData.user_prompt}</pre>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Per-agent prompt editor for one agent in the multi-agent pipeline. */
function AgentPromptSection({
  agent,
  defaultPrompt,
  onChange,
}: {
  agent: AgentSpec;
  defaultPrompt: string;
  onChange: (patch: Partial<AgentSpec>) => void;
}) {
  const [open, setOpen] = useState(true);
  const color = ROLE_COLOR[agent.role] ?? ROLE_COLOR.custom;
  const taStyle: React.CSSProperties = {
    width: "100%", padding: "0.5rem 0.75rem", borderRadius: "0.375rem",
    border: "1px solid #dadce0", fontSize: "0.84rem", fontFamily: "inherit",
    boxSizing: "border-box", resize: "vertical",
  };

  const hasCustomisation = !!(agent.system_prompt_additions || agent.system_prompt_override);

  return (
    <div style={{ border: "1px solid #dadce0", borderRadius: "0.5rem", marginBottom: "1rem", background: "#fff" }}>
      {/* Accordion header */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.65rem", padding: "0.7rem 0.9rem", background: "none", border: "none", cursor: "pointer", borderRadius: open ? "0.5rem 0.5rem 0 0" : "0.5rem", textAlign: "left" }}
      >
        <span style={{ background: color.bg, color: color.fg, fontWeight: 700, fontSize: "0.72rem", padding: "0.15rem 0.6rem", borderRadius: "0.75rem", whiteSpace: "nowrap" }}>
          {ROLE_LABEL[agent.role] ?? agent.role}
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.9rem", color: "#3c4043", flex: 1 }}>
          {agent.name || agent.label || ROLE_LABEL[agent.role] || agent.role}
        </span>
        {hasCustomisation && (
          <span style={{ fontSize: "0.72rem", background: "#e8f0fe", color: "#1a73e8", borderRadius: "0.75rem", padding: "0 0.45rem", fontWeight: 600 }}>
            customised
          </span>
        )}
        {!agent.enabled && (
          <span style={{ fontSize: "0.72rem", color: "#9aa0a6", fontStyle: "italic" }}>disabled</span>
        )}
        <ChevronDown size={13} style={{ color: "#5f6368", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid #f1f3f4" }}>
          {/* Default system prompt — always shown */}
          <div style={{ marginTop: "0.85rem", marginBottom: "1rem" }}>
            <label style={{ fontWeight: 600, fontSize: "0.83rem", display: "block", marginBottom: "0.35rem" }}>
              Default system prompt
              <span style={{ fontWeight: 400, color: "#9aa0a6", marginLeft: "0.4rem", fontSize: "0.78rem" }}>(read-only)</span>
            </label>
            <pre style={{ margin: 0, padding: "0.65rem 0.75rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#3c4043", background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem", lineHeight: 1.5 }}>
              {agent.system_prompt_override
                ? <span style={{ color: "#9aa0a6", fontStyle: "italic" }}>(replaced by override below)</span>
                : defaultPrompt}
            </pre>
          </div>

          {/* Additions textarea */}
          {!agent.system_prompt_override && (
            <div style={{ marginBottom: "1rem" }}>
              <label style={{ fontWeight: 600, fontSize: "0.83rem", display: "block", marginBottom: "0.35rem" }}>
                Additional instructions
                <span style={{ fontWeight: 400, color: "#9aa0a6", marginLeft: "0.4rem", fontSize: "0.78rem" }}>(prepended to default prompt above)</span>
              </label>
              <textarea
                rows={4}
                style={taStyle}
                placeholder={`Any extra guidance for the ${agent.name || ROLE_LABEL[agent.role] || agent.role} agent…`}
                value={agent.system_prompt_additions ?? ""}
                onChange={(e) => onChange({ system_prompt_additions: e.target.value || undefined })}
              />
            </div>
          )}

          {/* Full override */}
          <div>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.83rem", marginBottom: "0.35rem" }}>
              <input
                type="checkbox"
                checked={!!agent.system_prompt_override}
                onChange={(e) => onChange({
                  system_prompt_override: e.target.checked ? (agent.system_prompt_override ?? defaultPrompt) : undefined,
                  system_prompt_additions: e.target.checked ? undefined : agent.system_prompt_additions,
                })}
              />
              <span style={{ fontWeight: 600 }}>Replace entire system prompt</span>
              <span style={{ color: "#9aa0a6", fontWeight: 400 }}>(full override)</span>
            </label>
            {!!agent.system_prompt_override && (
              <textarea
                rows={8}
                style={{ ...taStyle, fontFamily: "monospace", fontSize: "0.83rem" }}
                value={agent.system_prompt_override}
                onChange={(e) => onChange({ system_prompt_override: e.target.value })}
                placeholder="Complete replacement system prompt for this agent…"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Multi-agent prompt section: per-agent accordion editors. */
function MultiAgentPromptSection({
  pipeline,
  onPipelineChange,
  defaultPrompts,
}: {
  pipeline: AgentSpec[];
  onPipelineChange: (pipeline: AgentSpec[]) => void;
  defaultPrompts: Record<string, string>;
}) {
  const [pipelineDirty, setPipelineDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  function updateAgent(index: number, patch: Partial<AgentSpec>) {
    const next = pipeline.map((a, i) => (i === index ? { ...a, ...patch } : a));
    onPipelineChange(next);
    setPipelineDirty(true);
  }

  // Pipeline customisations are kept in React state (not persisted to DB) —
  // they are sent as part of the CreateRunBody when the user launches a run.
  function handleAcknowledge() {
    setSaveStatus("saved");
    setPipelineDirty(false);
    setTimeout(() => setSaveStatus("idle"), 2500);
  }

  return (
    <>
      <p style={{ fontSize: "0.83rem", color: "#5f6368", marginBottom: "1.25rem", padding: "0.6rem 0.85rem", background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem" }}>
        Each agent has its own default system prompt tailored to its role. Add instructions or replace
        the prompt entirely. Changes are applied on the next run — they are saved as part of the pipeline configuration.
      </p>

      {pipeline.map((agent, i) => (
        <AgentPromptSection
          key={agent.id}
          agent={agent}
          defaultPrompt={defaultPrompts[agent.role] ?? defaultPrompts["single"] ?? ""}
          onChange={(patch) => updateAgent(i, patch)}
        />
      ))}

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "0.5rem" }}>
        <button
          className="btn-primary"
          disabled={!pipelineDirty || saveStatus === "saved"}
          onClick={handleAcknowledge}
          style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
        >
          {saveStatus === "saved" ? "Saved to pipeline ✓" : "Apply to pipeline"}
        </button>
        <span style={{ fontSize: "0.78rem", color: "#9aa0a6" }}>
          Changes take effect when you launch a new run from the Run tab.
        </span>
      </div>
    </>
  );
}

/** Top-level Prompt tab component. Delegates to single or multi section based on agentMode. */
function PromptConfigPanel({
  projectId,
  agentMode,
  pipeline,
  onPipelineChange,
}: {
  projectId: string;
  agentMode: "single" | "multi";
  pipeline: AgentSpec[];
  onPipelineChange: (pipeline: AgentSpec[]) => void;
}) {
  const { data: defaultPrompts } = useQuery({
    queryKey: ["llm-default-system-prompts", projectId],
    queryFn: () => llmScreeningApi.getDefaultSystemPrompts(projectId).then((r) => r.data),
    staleTime: Infinity,
  });

  return (
    <section style={{ maxWidth: 760 }}>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Configure the prompts used when the LLM screens and extracts data. Inclusion/exclusion
        criteria and the thematic framework are automatically included — add supplementary context here.
      </p>

      {/* Mode indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1.5rem", padding: "0.5rem 0.85rem", background: agentMode === "multi" ? "#e6f4ea" : "#ede9fe", borderRadius: "0.375rem", fontSize: "0.83rem" }}>
        {agentMode === "multi" ? <Layers size={14} style={{ color: "#188038" }} /> : <User size={14} style={{ color: "#6366f1" }} />}
        <span style={{ fontWeight: 600, color: agentMode === "multi" ? "#188038" : "#6366f1" }}>
          {agentMode === "multi" ? "Multi-Agent Mode" : "Single-Agent Mode"}
        </span>
        <span style={{ color: "#5f6368" }}>
          {agentMode === "multi"
            ? "— each agent in your pipeline has its own configurable system prompt"
            : "— one agent, one configurable system prompt"}
        </span>
      </div>

      {!defaultPrompts ? (
        <p style={{ color: "#9aa0a6" }}>Loading default prompts…</p>
      ) : agentMode === "single" ? (
        <SingleAgentPromptSection projectId={projectId} defaultPrompts={defaultPrompts} />
      ) : (
        <MultiAgentPromptSection
          pipeline={pipeline}
          onPipelineChange={onPipelineChange}
          defaultPrompts={defaultPrompts}
        />
      )}
    </section>
  );
}

// ── Compare Panel ─────────────────────────────────────────────────────────────

function ComparePanel({ projectId, runs }: { projectId: string; runs: LlmRunResponse[] }) {
  const [mode, setMode] = useState<"human" | "run">("human");

  // ── LLM vs Human state ────────────────────────────────────────────────────
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<LlmComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedForConsensus, setSelectedForConsensus] = useState<Set<string>>(new Set());
  const [consensusStage, setConsensusStage] = useState<"TA" | "FT">("TA");
  const [sendingConsensus, setSendingConsensus] = useState(false);
  const [sendResult, setSendResult] = useState<{ created: number } | null>(null);

  // ── LLM vs LLM state ─────────────────────────────────────────────────────
  const [runAId, setRunAId] = useState<string>("");
  const [runBId, setRunBId] = useState<string>("");
  const [runVsRun, setRunVsRun] = useState<RunVsRunResponse | null>(null);
  const [rvLoading, setRvLoading] = useState(false);

  const completedRuns = runs.filter(isEffectivelyCompleted);
  const hasRunningRun = runs.some((r) => r.status === "running" || r.status === "queued");

  async function loadComparison(runId: string) {
    setLoading(true);
    setComparison(null);
    setSelectedForConsensus(new Set());
    setSendResult(null);
    try {
      const res = await llmScreeningApi.compareWithHumans(projectId, runId);
      setComparison(res.data);
    } finally {
      setLoading(false);
    }
  }

  function toggleConsensus(recordId: string) {
    setSelectedForConsensus((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  }

  function toggleAll(ids: string[]) {
    setSelectedForConsensus((prev) => {
      if (ids.every((id) => prev.has(id))) return new Set();
      return new Set(ids);
    });
  }

  async function handleSendToConsensus() {
    if (!selectedRunId || selectedForConsensus.size === 0) return;
    setSendingConsensus(true);
    try {
      const res = await llmScreeningApi.sendToConsensus(projectId, selectedRunId, Array.from(selectedForConsensus), consensusStage);
      setSendResult(res.data);
      setSelectedForConsensus(new Set());
    } finally {
      setSendingConsensus(false);
    }
  }

  async function loadRunVsRun() {
    if (!runAId || !runBId) return;
    setRvLoading(true);
    setRunVsRun(null);
    try {
      const res = await llmScreeningApi.compareRuns(projectId, runAId, runBId);
      setRunVsRun(res.data);
    } finally {
      setRvLoading(false);
    }
  }

  const disagreeItems = comparison?.items.filter((i) => i.ta_agrees === false || i.ft_agrees === false) ?? [];

  function kappaColor(kappa: number | null) {
    if (kappa === null) return "#9aa0a6";
    if (kappa >= 0.61) return "#188038";
    if (kappa >= 0.41) return "#b06000";
    return "#c5221f";
  }

  const runLabel = (r: LlmRunResponse) =>
    `${fmtDate(r.started_at ?? r.created_at)} — ${MODEL_BY_ID[r.model]?.label ?? r.model} (${r.mode})`;

  return (
    <section style={{ maxWidth: 900 }}>
      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: "1.5rem", border: "1px solid #dadce0", borderRadius: "0.5rem", overflow: "hidden", width: "fit-content" }}>
        {(["human", "run"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)}
            style={{ padding: "0.45rem 1.1rem", fontSize: "0.85rem", fontWeight: mode === m ? 700 : 400, background: mode === m ? "#4f46e5" : "#fff", color: mode === m ? "#fff" : "#5f6368", border: "none", cursor: "pointer", borderRight: m === "human" ? "1px solid #dadce0" : "none" }}>
            {m === "human" ? "LLM vs Human" : "LLM vs LLM"}
          </button>
        ))}
      </div>

      {/* ── LLM vs LLM ────────────────────────────────────────────────────── */}
      {mode === "run" && (
        <div>
          <p className="muted" style={{ marginBottom: "1.25rem" }}>
            Compare TA decisions between two completed screening runs — useful for evaluating model agreement or prompt changes.
          </p>
          <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", marginBottom: "1.5rem", flexWrap: "wrap" }}>
            <div>
              <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem", fontSize: "0.85rem" }}>Run A</label>
              <select value={runAId} onChange={(e) => { setRunAId(e.target.value); setRunVsRun(null); }}
                style={{ padding: "0.4rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem", minWidth: 260 }}>
                <option value="">— choose run A —</option>
                {completedRuns.map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem", fontSize: "0.85rem" }}>Run B</label>
              <select value={runBId} onChange={(e) => { setRunBId(e.target.value); setRunVsRun(null); }}
                style={{ padding: "0.4rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem", minWidth: 260 }}>
                <option value="">— choose run B —</option>
                {completedRuns.filter((r) => r.id !== runAId).map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}
              </select>
            </div>
            <button className="btn-primary" disabled={!runAId || !runBId || rvLoading}
              onClick={() => void loadRunVsRun()} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <GitCompare size={14} /> {rvLoading ? "Loading…" : "Compare Runs"}
            </button>
          </div>

          {runVsRun && (() => {
            const s = runVsRun.stats;
            const runALabel = completedRuns.find((r) => r.id === runAId);
            const runBLabel = completedRuns.find((r) => r.id === runBId);
            return (
              <>
                {/* Stats */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1.5rem" }}>
                  {[
                    { label: "Papers compared", value: s.n_compared.toLocaleString(), color: "#1a73e8" },
                    { label: "TA agreement", value: s.ta_agreement_pct != null ? `${s.ta_agreement_pct}%` : "—", color: kappaColor(s.kappa_ta) },
                    { label: "Cohen's κ", value: s.kappa_ta != null ? `${s.kappa_ta.toFixed(2)} · ${s.kappa_ta_label}` : "—", color: kappaColor(s.kappa_ta) },
                    { label: "Disagreements", value: runVsRun.disagreements.length.toLocaleString(), color: runVsRun.disagreements.length > 0 ? "#c5221f" : "#188038" },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: "#f8f9fa", border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "0.85rem 1rem" }}>
                      <div style={{ fontSize: "0.78rem", color: "#5f6368", marginBottom: "0.25rem" }}>{label}</div>
                      <div style={{ fontSize: "1.15rem", fontWeight: 700, color }}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Included count comparison */}
                <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
                  {[
                    { run: runALabel, count: s.run_a_included, onlyThis: s.only_a_included, label: "A" },
                    { run: runBLabel, count: s.run_b_included, onlyThis: s.only_b_included, label: "B" },
                  ].map(({ run, count, onlyThis, label }) => (
                    <div key={label} style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "0.5rem", padding: "0.75rem 1rem", fontSize: "0.83rem" }}>
                      <span style={{ fontWeight: 700 }}>Run {label}</span>
                      {run && <span style={{ color: "#5f6368", marginLeft: "0.4rem" }}>({MODEL_BY_ID[run.model]?.label ?? run.model})</span>}
                      <span style={{ marginLeft: "0.75rem" }}><strong>{count}</strong> included</span>
                      {onlyThis > 0 && <span style={{ marginLeft: "0.5rem", color: "#b06000" }}>({onlyThis} only in this run)</span>}
                    </div>
                  ))}
                </div>

                {/* Disagreements table */}
                {runVsRun.disagreements.length === 0 ? (
                  <p style={{ color: "#188038", fontWeight: 600 }}>No disagreements — both runs made identical TA decisions on all compared papers.</p>
                ) : (
                  <>
                    <h4 style={{ margin: "0 0 0.75rem" }}>Disagreements ({runVsRun.disagreements.length})</h4>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
                        <thead>
                          <tr style={{ background: "#f8f9fa", borderBottom: "2px solid #dadce0" }}>
                            <th style={{ padding: "0.55rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Title</th>
                            <th style={{ padding: "0.55rem 0.75rem", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>Run A</th>
                            <th style={{ padding: "0.55rem 0.75rem", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>Run B</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runVsRun.disagreements.map((item) => (
                            <tr key={item.record_id} style={{ borderBottom: "1px solid #f1f3f4" }}>
                              <td style={{ padding: "0.55rem 0.75rem", maxWidth: 380 }}>
                                <div style={{ fontWeight: 500, lineHeight: 1.3 }}>{item.title ?? "(no title)"}</div>
                                {item.year && <div style={{ fontSize: "0.75rem", color: "#5f6368" }}>{item.year}</div>}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem", verticalAlign: "top" }}>
                                {decisionBadge(item.run_a_ta)}
                                {item.run_a_reason_code && <div style={{ fontSize: "0.72rem", color: "#5f6368", marginTop: "0.2rem" }}><code>{item.run_a_reason_code}</code></div>}
                              </td>
                              <td style={{ padding: "0.55rem 0.75rem", verticalAlign: "top" }}>
                                {decisionBadge(item.run_b_ta)}
                                {item.run_b_reason_code && <div style={{ fontSize: "0.72rem", color: "#5f6368", marginTop: "0.2rem" }}><code>{item.run_b_reason_code}</code></div>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ── LLM vs Human ──────────────────────────────────────────────────── */}
      {mode === "human" && <>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Compare LLM screening decisions with human reviewer decisions. Flag disagreements to the
        consensus queue for senior review.
      </p>

      {hasRunningRun && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.65rem 0.9rem", marginBottom: "1.25rem", background: "#fff8e1", border: "1px solid #f9ab00", borderRadius: "0.375rem", fontSize: "0.83rem", color: "#5f4a00" }}>
          <AlertCircle size={15} style={{ flexShrink: 0, color: "#f9ab00" }} />
          A run is in progress. Comparison is only available for completed runs — the LLM operates independently and its results are not influenced by human decisions.
        </div>
      )}

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <div>
          <label style={{ fontWeight: 600, display: "block", marginBottom: "0.4rem", fontSize: "0.85rem" }}>Select run</label>
          <select value={selectedRunId ?? ""} onChange={(e) => setSelectedRunId(e.target.value || null)}
            style={{ padding: "0.4rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem", minWidth: 260 }}>
            <option value="">— choose a completed run —</option>
            {completedRuns.map((r) => (
              <option key={r.id} value={r.id}>{fmtDate(r.started_at ?? r.created_at)} — {MODEL_BY_ID[r.model]?.label ?? r.model} ({r.mode})</option>
            ))}
          </select>
        </div>
        <button className="btn-primary" disabled={!selectedRunId || loading || hasRunningRun} onClick={() => selectedRunId && void loadComparison(selectedRunId)} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <GitCompare size={14} /> {loading ? "Loading…" : "Compare with Human Reviewers"}
        </button>
      </div>

      {comparison && (
        <>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem", maxWidth: 540 }}>
            {[
              { stage: "TA", pct: comparison.stats.ta_agreement_pct, kappa: comparison.stats.kappa_ta, label: comparison.stats.kappa_ta_label, n: comparison.stats.n_compared_ta },
              { stage: "FT", pct: comparison.stats.ft_agreement_pct, kappa: comparison.stats.kappa_ft, label: comparison.stats.kappa_ft_label, n: comparison.stats.n_compared_ft },
            ].map(({ stage, pct, kappa, label, n }) => (
              <div key={stage} style={{ background: "#f8f9fa", border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "1rem" }}>
                <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>{stage} Stage</div>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: kappaColor(kappa) }}>{pct != null ? `${pct}%` : "—"}</div>
                <div style={{ fontSize: "0.78rem", color: "#5f6368" }}>agreement ({n} compared)</div>
                {kappa != null && <div style={{ fontSize: "0.82rem", marginTop: "0.25rem" }}>κ = {kappa.toFixed(2)} · <em>{label}</em></div>}
                {n === 0 && <div style={{ fontSize: "0.8rem", color: "#9aa0a6", fontStyle: "italic" }}>No human decisions to compare</div>}
              </div>
            ))}
          </div>

          {/* Disagreements */}
          {disagreeItems.length === 0 ? (
            <p style={{ color: "#188038", fontWeight: 600 }}>No disagreements found — perfect agreement with human reviewers.</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
                <h4 style={{ margin: 0 }}>Disagreements ({disagreeItems.length})</h4>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span style={{ fontSize: "0.83rem", color: "#5f6368" }}>Stage:</span>
                  {(["TA", "FT"] as const).map((s) => (
                    <button key={s} onClick={() => setConsensusStage(s)} style={{ padding: "0.2rem 0.6rem", borderRadius: "0.375rem", border: `1.5px solid ${consensusStage === s ? "#6366f1" : "#dadce0"}`, background: consensusStage === s ? "#ede9fe" : "#f8f9fa", color: consensusStage === s ? "#6366f1" : "#5f6368", fontWeight: 600, cursor: "pointer", fontSize: "0.83rem" }}>{s}</button>
                  ))}
                </div>
                {selectedForConsensus.size > 0 && (
                  <button className="btn-primary" disabled={sendingConsensus} onClick={() => void handleSendToConsensus()} style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.83rem" }}>
                    Flag {selectedForConsensus.size} for consensus
                  </button>
                )}
                {sendResult && <span style={{ color: "#188038", fontSize: "0.83rem" }}>✓ {sendResult.created} flagged</span>}
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ background: "#f1f3f4", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#5f6368" }}>
                      <th style={{ padding: "0.5rem 0.75rem" }}>
                        <input type="checkbox" checked={selectedForConsensus.size === disagreeItems.length && disagreeItems.length > 0} onChange={() => toggleAll(disagreeItems.map((i) => i.record_id))} />
                      </th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Title</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>LLM TA</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Human TA</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>TA Match</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>LLM FT</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Human FT</th>
                      <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>FT Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disagreeItems.map((item) => {
                      const taDisagree = item.ta_agrees === false;
                      const ftDisagree = item.ft_agrees === false;
                      return (
                        <tr key={item.record_id} style={{ background: selectedForConsensus.has(item.record_id) ? "#e8f0fe" : undefined }}>
                          <td style={{ padding: "0.5rem 0.75rem" }}>
                            <input type="checkbox" checked={selectedForConsensus.has(item.record_id)} onChange={() => toggleConsensus(item.record_id)} />
                          </td>
                          <td style={{ padding: "0.5rem 0.75rem", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.83rem" }}>
                            {item.title || <span style={{ color: "#9aa0a6" }}>{item.record_id.slice(-8)}</span>}
                          </td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(item.llm_ta, true)}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(item.human_ta, true)}</td>
                          <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem" }}>
                            {item.ta_agrees === null ? <span style={{ color: "#9aa0a6" }}>—</span> : taDisagree ? <span style={{ color: "#c5221f", fontWeight: 600 }}>✗</span> : <span style={{ color: "#188038" }}>✓</span>}
                          </td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(item.llm_ft, true)}</td>
                          <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(item.human_ft, true)}</td>
                          <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem" }}>
                            {item.ft_agrees === null ? <span style={{ color: "#9aa0a6" }}>—</span> : ftDisagree ? <span style={{ color: "#c5221f", fontWeight: 600 }}>✗</span> : <span style={{ color: "#188038" }}>✓</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      </>}
    </section>
  );
}

// ── Seed Picker ───────────────────────────────────────────────────────────────

function SeedPicker({
  sourceId,
  queueHistory,
  teamMembers,
  value,
  customValue,
  onChange,
  onCustomChange,
}: {
  sourceId: string;
  queueHistory: ScreeningQueueHistoryEntry[];
  teamMembers: TeamMember[];
  value: string;        // "random" | "custom" | "<seed number>"
  customValue: string;
  onChange: (v: string) => void;
  onCustomChange: (v: string) => void;
}) {
  const memberMap: Record<string, string> = Object.fromEntries(
    teamMembers.map((m) => [m.user_id, m.name || m.email])
  );

  // Filter to queues matching the selected source, deduplicate by seed+reviewer
  const relevant = queueHistory.filter(
    (q) => !sourceId || q.source_id === sourceId || q.source_id === "all"
  );

  // Group by seed so we can show which reviewers used each seed
  const bySeed: Map<number, ScreeningQueueHistoryEntry[]> = new Map();
  for (const q of relevant) {
    if (!bySeed.has(q.seed)) bySeed.set(q.seed, []);
    bySeed.get(q.seed)!.push(q);
  }
  const seedOptions = Array.from(bySeed.entries()).sort(([a], [b]) => a - b);

  return (
    <div>
      <label style={{ fontWeight: 600, fontSize: "0.83rem", display: "block", marginBottom: "0.35rem" }}>
        Seed — queue order
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", padding: "0.4rem 0.6rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem" }}
      >
        <option value="random">Random (new order)</option>
        {seedOptions.map(([seed, entries]) => {
          const reviewerNames = [...new Set(entries.map((e) => memberMap[e.reviewer_id] || `…${e.reviewer_id.slice(-6)}`))];
          const label = `Seed ${seed} — ${reviewerNames.join(", ")}`;
          return <option key={seed} value={String(seed)}>{label}</option>;
        })}
        <option value="custom">Custom seed…</option>
      </select>
      {value === "custom" && (
        <input
          type="number"
          placeholder="Enter seed number"
          value={customValue}
          onChange={(e) => onCustomChange(e.target.value)}
          style={{ width: "100%", marginTop: "0.4rem", padding: "0.4rem 0.6rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem", boxSizing: "border-box" }}
        />
      )}
      {value !== "random" && value !== "custom" && (
        <p style={{ fontSize: "0.75rem", color: "#5f6368", marginTop: "0.25rem" }}>
          LLM will process records in the same order as the human reviewer(s) who used seed {value}.
        </p>
      )}
      {value === "random" && (
        <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.25rem" }}>
          A new random order will be used (not matching any human reviewer).
        </p>
      )}
      {seedOptions.length === 0 && !sourceId && (
        <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.25rem" }}>
          Select a corpus above to see seeds from human reviewers.
        </p>
      )}
      {seedOptions.length === 0 && sourceId && (
        <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.25rem" }}>
          No human reviewer has screened this corpus yet — no existing seeds available.
        </p>
      )}
    </div>
  );
}

// ── Stage Cost Breakdown ──────────────────────────────────────────────────────

const ROLE_LABEL: Record<string, string> = {
  single: "Single Agent",
  ta_screener: "TA Screener",
  ft_screener: "FT Screener",
  extractor: "Extractor",
  verifier: "Verifier",
  custom: "Custom",
};

function StageCostBreakdown({ stages }: { stages: EstimateStage[] }) {
  if (!stages.length) return null;
  return (
    <div style={{ marginTop: "0.75rem", border: "1px solid #e8eaed", borderRadius: "0.375rem", overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
        <thead>
          <tr style={{ background: "#f1f3f4" }}>
            {["Stage", "Model", "Reach", "Input tokens", "Output tokens", "Cost"].map((h) => (
              <th key={h} style={{ padding: "0.4rem 0.65rem", textAlign: "left", fontWeight: 600, color: "#5f6368", fontSize: "0.75rem" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
              <td style={{ padding: "0.4rem 0.65rem", fontWeight: 600 }}>{ROLE_LABEL[s.role] ?? s.role}</td>
              <td style={{ padding: "0.4rem 0.65rem", color: "#5f6368" }}>{MODEL_BY_ID[s.model]?.label ?? s.model.split("/").pop()}</td>
              <td style={{ padding: "0.4rem 0.65rem", color: "#5f6368" }}>{s.reach_pct}%</td>
              <td style={{ padding: "0.4rem 0.65rem", color: "#3c4043" }}>{s.input_tokens.toLocaleString()}</td>
              <td style={{ padding: "0.4rem 0.65rem", color: "#3c4043" }}>{s.output_tokens.toLocaleString()}</td>
              <td style={{ padding: "0.4rem 0.65rem", color: s.cost_usd === 0 ? "#188038" : "#b06000", fontWeight: 600 }}>
                {s.cost_usd === 0 ? "Free" : `$${s.cost_usd.toFixed(4)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pipeline Editor ───────────────────────────────────────────────────────────

const AGENT_ROLES = [
  { role: "ta_screener", label: "TA Screener", desc: "Title & abstract screening — fast, cheap, high recall" },
  { role: "ft_screener", label: "FT Screener", desc: "Full-text screening — thorough, requires full text" },
  { role: "extractor",   label: "Extractor",   desc: "Structured data extraction from FT-included records" },
  { role: "verifier",    label: "Verifier",    desc: "Cross-checks TA/FT decisions for consistency" },
  { role: "custom",      label: "Custom",      desc: "Custom agent with your own role and prompt" },
];

const ROLE_COLOR: Record<string, { bg: string; fg: string }> = {
  ta_screener: { bg: "#e8f0fe", fg: "#1a73e8" },
  ft_screener: { bg: "#e6f4ea", fg: "#188038" },
  extractor:   { bg: "#fef7e0", fg: "#b06000" },
  verifier:    { bg: "#f3e8fd", fg: "#9333ea" },
  custom:      { bg: "#f1f3f4", fg: "#5f6368" },
  single:      { bg: "#ede9fe", fg: "#6366f1" },
};

function AgentCard({
  agent,
  onChange,
  onRemove,
  index,
}: {
  agent: AgentSpec;
  onChange: (patch: Partial<AgentSpec>) => void;
  onRemove?: () => void;
  index: number;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const color = ROLE_COLOR[agent.role] ?? ROLE_COLOR.custom;
  const roleInfo = AGENT_ROLES.find((r) => r.role === agent.role);

  return (
    <div
      style={{
        border: `1.5px solid ${agent.enabled ? "#dadce0" : "#e8eaed"}`,
        borderRadius: "0.5rem",
        background: agent.enabled ? "#fff" : "#f8f9fa",
        marginBottom: "0.65rem",
        opacity: agent.enabled ? 1 : 0.7,
        transition: "opacity 0.15s",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", padding: "0.65rem 0.85rem" }}>
        <span style={{ background: color.bg, color: color.fg, fontWeight: 700, fontSize: "0.72rem", padding: "0.15rem 0.55rem", borderRadius: "0.75rem", whiteSpace: "nowrap" }}>
          {index + 1}
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.88rem", color: "#3c4043", flex: 1 }}>
          {agent.name || agent.label || roleInfo?.label || agent.role}
        </span>
        {agent.role === "custom" && (
          <input
            value={agent.name ?? ""}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Agent name"
            style={{ fontSize: "0.83rem", padding: "0.25rem 0.5rem", border: "1px solid #dadce0", borderRadius: "0.3rem", flex: 1 }}
          />
        )}
        <select
          value={agent.model}
          onChange={(e) => onChange({ model: e.target.value })}
          style={{ fontSize: "0.8rem", padding: "0.25rem 0.4rem", border: "1px solid #dadce0", borderRadius: "0.3rem", minWidth: 160 }}
        >
          {MODEL_CATALOG.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id}>{m.label} — {m.cost_per_1k}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", cursor: "pointer", fontSize: "0.8rem", color: "#5f6368" }}>
          <input
            type="checkbox"
            checked={agent.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            style={{ cursor: "pointer" }}
          />
          Active
        </label>
        <button
          onClick={() => setPromptOpen((o) => !o)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#5f6368", padding: "0.2rem", display: "flex", alignItems: "center" }}
          title="Customize prompt"
        >
          <ChevronDown size={14} style={{ transform: promptOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        </button>
        {onRemove && (
          <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#c5221f", padding: "0.2rem", display: "flex", alignItems: "center" }} title="Remove agent">
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {roleInfo?.desc && !promptOpen && (
        <p style={{ margin: "0 0 0.5rem 2.8rem", fontSize: "0.78rem", color: "#9aa0a6" }}>{roleInfo.desc}</p>
      )}
      {/* Expandable prompt section */}
      {promptOpen && (
        <div style={{ padding: "0 0.85rem 0.85rem", borderTop: "1px solid #f1f3f4" }}>
          <div style={{ marginTop: "0.75rem" }}>
            <label style={{ fontWeight: 600, fontSize: "0.8rem", display: "block", marginBottom: "0.3rem" }}>
              System prompt additions <span style={{ fontWeight: 400, color: "#9aa0a6" }}>(appended to built-in prompt)</span>
            </label>
            <textarea
              rows={3}
              value={agent.system_prompt_additions ?? ""}
              onChange={(e) => onChange({ system_prompt_additions: e.target.value })}
              placeholder="Any additional instructions for this specific agent…"
              style={{ width: "100%", fontSize: "0.82rem", padding: "0.4rem 0.6rem", border: "1px solid #dadce0", borderRadius: "0.3rem", fontFamily: "inherit", boxSizing: "border-box", resize: "vertical" }}
            />
          </div>
          <div style={{ marginTop: "0.65rem" }}>
            <label style={{ fontWeight: 600, fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
              <input
                type="checkbox"
                checked={!!agent.system_prompt_override}
                onChange={(e) => onChange({ system_prompt_override: e.target.checked ? (agent.system_prompt_override || "") : undefined })}
              />
              Full prompt override (replace entire system prompt)
            </label>
            {agent.system_prompt_override !== undefined && (
              <textarea
                rows={5}
                value={agent.system_prompt_override}
                onChange={(e) => onChange({ system_prompt_override: e.target.value })}
                placeholder="Complete replacement system prompt for this agent…"
                style={{ width: "100%", fontSize: "0.82rem", padding: "0.4rem 0.6rem", border: "1px solid #dadce0", borderRadius: "0.3rem", fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineEditor({
  pipeline,
  onChange,
  defaultPipeline,
}: {
  pipeline: AgentSpec[];
  onChange: (pipeline: AgentSpec[]) => void;
  defaultPipeline: AgentSpec[];
}) {
  function updateAgent(index: number, patch: Partial<AgentSpec>) {
    const next = pipeline.map((a, i) => (i === index ? { ...a, ...patch } : a));
    onChange(next);
  }

  function removeAgent(index: number) {
    onChange(pipeline.filter((_, i) => i !== index));
  }

  function addCustomAgent() {
    onChange([
      ...pipeline,
      {
        id: `custom_${Date.now()}`,
        role: "custom",
        model: "claude-haiku-4-5-20251001",
        enabled: true,
        name: "Custom Agent",
      },
    ]);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
        <h4 style={{ margin: 0, fontSize: "0.9rem" }}>Agent pipeline</h4>
        <button
          onClick={() => onChange(defaultPipeline)}
          style={{ background: "none", border: "1px solid #dadce0", cursor: "pointer", color: "#5f6368", padding: "0.2rem 0.6rem", borderRadius: "0.3rem", fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "0.3rem" }}
          title="Reset to default multi-agent pipeline"
        >
          <RotateCcw size={11} /> Reset to default
        </button>
      </div>

      <div style={{ fontSize: "0.8rem", color: "#5f6368", marginBottom: "0.75rem", padding: "0.5rem 0.75rem", background: "#f8f9fa", border: "1px solid #e8eaed", borderRadius: "0.375rem" }}>
        <strong>Default pipeline:</strong> TA Screener → FT Screener (30% reach) → Extractor (15% reach) → Verifier (optional).
        Disable or customize individual agents below. Each agent can use a different model.
      </div>

      {pipeline.map((agent, i) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          index={i}
          onChange={(patch) => updateAgent(i, patch)}
          onRemove={pipeline.length > 1 ? () => removeAgent(i) : undefined}
        />
      ))}

      <button
        onClick={addCustomAgent}
        style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.4rem 0.85rem", border: "1.5px dashed #dadce0", borderRadius: "0.375rem", background: "none", cursor: "pointer", color: "#5f6368", fontSize: "0.83rem", width: "100%" }}
      >
        <Plus size={13} /> Add custom agent
      </button>
    </div>
  );
}

// ── Run History Table ─────────────────────────────────────────────────────────

function RunHistoryTable({ runs, selectedRunId, onSelect, onResume, onCancel, onDelete, onFork }: { runs: LlmRunResponse[]; selectedRunId: string | null; onSelect: (run: LlmRunResponse | null) => void; onResume: (runId: string) => void; onCancel: (runId: string) => void; onDelete: (runId: string) => void; onFork: (run: LlmRunResponse) => void }) {
  if (runs.length === 0) return <p className="muted">No runs yet. Launch your first LLM run above.</p>;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ background: "#f1f3f4", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#5f6368" }}>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Started</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Model</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Mode</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Status</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Progress</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Include</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Uncertain</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Exclude</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Abstract Only</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>New Concepts</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>Cost</th>
            <th style={{ padding: "0.5rem 0.75rem", textAlign: "center", fontWeight: 600 }}></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const isSelected = selectedRunId === run.id;
            const modelLabel = MODEL_BY_ID[run.model]?.label ?? run.model.split("/").pop()?.replace(/-\d{10}$/, "") ?? run.model;
            return (
              <tr key={run.id} onClick={() => onSelect(isSelected ? null : run)} style={{ cursor: "pointer", background: isSelected ? "#e8f0fe" : undefined, borderLeft: isSelected ? "3px solid #1a73e8" : "3px solid transparent" }}>
                <td style={{ padding: "0.55rem 0.75rem" }}>{fmtDate(run.started_at ?? run.created_at)}</td>
                <td style={{ padding: "0.55rem 0.75rem", color: "#5f6368", fontSize: "0.78rem" }}>{modelLabel}</td>
                <td style={{ padding: "0.55rem 0.75rem" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                    <span style={{ fontSize: "0.78rem", color: run.mode === "saturation" ? "#6366f1" : run.mode === "ta_only" ? "#b06000" : run.mode === "ft_only" ? "#1a73e8" : "#5f6368" }}>
                      {run.mode === "saturation" ? "Saturation" : run.mode === "ta_only" ? "TA Only" : run.mode === "ft_only" ? "FT Only" : "PRISMA-ScR"}
                      {run.stopped_at_saturation && " ⬡"}
                    </span>
                    {run.agent_mode === "multi" && (
                      <span style={{ fontSize: "0.72rem", background: "#e6f4ea", color: "#188038", borderRadius: "0.75rem", padding: "0 0.4rem", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "0.2rem", width: "fit-content" }}>
                        <Layers size={9} /> Multi-agent
                      </span>
                    )}
                  </div>
                </td>
                <td style={{ padding: "0.55rem 0.75rem" }}>
                  {statusBadge(run)}
                  {(run.status === "running" || run.status === "queued") && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCancel(run.id); }}
                      style={{ marginLeft: "0.5rem", fontSize: "0.75rem", padding: "0.1rem 0.5rem", background: "#fce8e6", color: "#c5221f", border: "1px solid #c5221f", borderRadius: "0.25rem", cursor: "pointer", fontWeight: 600 }}
                    >Stop</button>
                  )}
                  {(run.status === "interrupted" || run.status === "cancelled") && !isEffectivelyCompleted(run) && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onResume(run.id); }}
                      style={{ marginLeft: "0.5rem", fontSize: "0.75rem", padding: "0.1rem 0.5rem", background: "#fff3e0", color: "#b06000", border: "1px solid #b06000", borderRadius: "0.25rem", cursor: "pointer", fontWeight: 600 }}
                    >Resume</button>
                  )}
                  {run.error_message && run.status !== "interrupted" && (
                    <span title={run.error_message} style={{ marginLeft: "0.35rem", cursor: "help" }}>⚠</span>
                  )}
                </td>
                <td style={{ padding: "0.55rem 0.75rem" }}>
                  {run.status === "running" || run.status === "queued" ? (
                    <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <ProgressBar pct={run.progress_pct} />
                      <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>{run.progress_pct.toFixed(1)}%</span>
                    </span>
                  ) : (
                    <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>{run.processed_records.toLocaleString()} / {(run.total_records ?? 0).toLocaleString()}</span>
                  )}
                </td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#188038", fontWeight: 600 }}>{run.included_count}</td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: run.uncertain_count > 0 ? "#b06000" : "#9aa0a6", fontWeight: run.uncertain_count > 0 ? 600 : 400 }}>{run.uncertain_count > 0 ? run.uncertain_count : "—"}</td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#c5221f", fontWeight: 600 }}>{run.excluded_count}</td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: run.abstract_only_count > 0 ? "#b06000" : "#9aa0a6", fontWeight: run.abstract_only_count > 0 ? 600 : 400 }}>
                  {run.abstract_only_count > 0 ? run.abstract_only_count : "—"}
                </td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", color: "#6366f1", fontWeight: 600 }}>{run.new_concepts_count > 0 ? `+${run.new_concepts_count}` : "—"}</td>
                <td style={{ padding: "0.55rem 0.75rem", textAlign: "right", fontSize: "0.82rem", color: "#5f6368" }}>{fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)}</td>
                <td style={{ padding: "0.55rem 0.5rem", textAlign: "center", whiteSpace: "nowrap" }}>
                  {isEffectivelyCompleted(run) && run.processed_records > 0 && (
                    <button
                      title="Fork as Sub-Project"
                      onClick={(e) => { e.stopPropagation(); onFork(run); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#6366f1", padding: "0.2rem", borderRadius: "0.25rem", lineHeight: 1, display: "inline-flex", alignItems: "center", marginRight: "0.2rem" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#4338ca"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#6366f1"; }}
                    >
                      <GitCompare size={14} />
                    </button>
                  )}
                  {!["running", "queued", "cancelling"].includes(run.status) && (
                    <button
                      title="Delete this run"
                      onClick={(e) => { e.stopPropagation(); onDelete(run.id); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "#9aa0a6", padding: "0.2rem", borderRadius: "0.25rem", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#c5221f"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#9aa0a6"; }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LLMScreeningPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const confirmDialog = useConfirm();

  type Tab = "run" | "prompt" | "results" | "compare";
  const [activeTab, setActiveTab] = useState<Tab>("run");

  const { data: profile } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => authApi.me().then((r) => r.data),
    staleTime: 60_000,
  });
  const hasApiKey = !!(profile?.anthropic_key_hint || profile?.openrouter_key_hint);

  // ── Run config state ───────────────────────────────────────────────────────
  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4-6");
  const [mode, setMode] = useState<"prisma_scr" | "saturation" | "ta_only">("prisma_scr");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  // Seed: "random" | "custom" | "<number>" (selected from reviewer queue history)
  const [seedSelection, setSeedSelection] = useState<string>("random");
  const [customSeedValue, setCustomSeedValue] = useState<string>("");
  const [saturationThreshold, setSaturationThreshold] = useState(5);
  const [includeExtraction, setIncludeExtraction] = useState(true);
  const [showComparison, setShowComparison] = useState(false);
  // Agent mode
  const [agentMode, setAgentMode] = useState<"single" | "multi">("single");
  const [pipeline, setPipeline] = useState<AgentSpec[]>([]);

  // ── Results state ──────────────────────────────────────────────────────────
  const [selectedRun, setSelectedRun] = useState<LlmRunResponse | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // ── Data queries ───────────────────────────────────────────────────────────
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: sources } = useQuery({
    queryKey: ["sources", projectId],
    queryFn: () => sourcesApi.list(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: queueHistory } = useQuery({
    queryKey: ["screening-queue-history", projectId],
    queryFn: () => screeningApi.getQueueHistory(projectId!).then((r) => r.data),
    enabled: !!projectId && mode === "saturation",
    staleTime: 30_000,
  });

  const { data: teamMembers } = useQuery({
    queryKey: ["team-members", projectId],
    queryFn: () => teamApi.listMembers(projectId!).then((r) => r.data),
    enabled: !!projectId && mode === "saturation",
    staleTime: 60_000,
  });

  const { data: defaultPipelines } = useQuery({
    queryKey: ["llm-default-pipelines", projectId],
    queryFn: () => llmScreeningApi.getDefaultPipelines(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: Infinity,
  });

  // Seed pipeline when default pipelines load and user hasn't customised
  useEffect(() => {
    if (defaultPipelines && pipeline.length === 0) {
      setPipeline(defaultPipelines.multi);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultPipelines]);

  const { data: estimate, isLoading: estimateLoading } = useQuery({
    queryKey: ["llm-estimate", projectId, selectedModel, agentMode, mode, mode === "saturation" ? selectedSourceId : null],
    queryFn: () =>
      llmScreeningApi.estimate(projectId!, selectedModel, mode === "saturation" && selectedSourceId ? selectedSourceId : undefined, agentMode, mode).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: runs, refetch: refetchRuns } = useQuery({
    queryKey: ["llm-runs", projectId],
    queryFn: () => llmScreeningApi.listRuns(projectId!).then((r) => r.data),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((r) => r.status === "running" || r.status === "queued") ? 3000 : false;
    },
  });

  // Keep selectedRun in sync with live data
  useEffect(() => {
    if (selectedRun && runs) {
      const updated = runs.find((r) => r.id === selectedRun.id);
      if (updated) setSelectedRun(updated);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  // Poll running runs
  const runningRun = runs?.find((r) => r.status === "running" || r.status === "queued");
  const { data: liveRun } = useQuery({
    queryKey: ["llm-run-live", runningRun?.id],
    queryFn: () => llmScreeningApi.getRun(projectId!, runningRun!.id).then((r) => r.data),
    enabled: !!runningRun,
    refetchInterval: 3000,
  });
  const displayRuns = runs?.map((r) => (liveRun && r.id === liveRun.id ? liveRun : r)) ?? [];

  // ── Launch ─────────────────────────────────────────────────────────────────
  const launch = useMutation({
    mutationFn: () =>
      llmScreeningApi.createRun(
        projectId!,
        {
          model: selectedModel,
          mode,
          source_id: mode === "saturation" && selectedSourceId ? selectedSourceId : undefined,
          seed: mode === "saturation" ? effectiveSeed : undefined,
          saturation_threshold: saturationThreshold,
          include_extraction: includeExtraction,
          agent_mode: agentMode,
          pipeline: agentMode === "multi" && pipeline.length > 0 ? pipeline : undefined,
        }
      ).then((r) => ({ data: r.data })),
    onSuccess: (res) => {
      setLaunchError(null);
      qc.invalidateQueries({ queryKey: ["llm-runs", projectId] });
      setSelectedRun(res.data);
    },
    onError: (err: unknown) => {
      const anyErr = err as { response?: { data?: { detail?: unknown } } };
      const detail = anyErr.response?.data?.detail ?? "Failed to launch run";
      setLaunchError(typeof detail === "string" ? detail : JSON.stringify(detail));
    },
  });

  // Resolve the numeric seed from the three-way selector
  const effectiveSeed: number | undefined = (() => {
    if (seedSelection === "random") return undefined;
    if (seedSelection === "custom") {
      const v = parseInt(customSeedValue, 10);
      return isNaN(v) ? undefined : v;
    }
    const v = parseInt(seedSelection, 10);
    return isNaN(v) ? undefined : v;
  })();

  const hasRunningRun = !!runningRun;
  const canLaunch = !hasRunningRun && (estimate?.total_records ?? 0) > 0 && (mode !== "saturation" || !!selectedSourceId);

  const handleResume = async (runId: string) => {
    try {
      await llmScreeningApi.resumeRun(projectId!, runId);
      void refetchRuns();
    } catch (e) {
      console.error("Resume failed", e);
    }
  };

  const handleCancel = async (runId: string) => {
    try {
      await llmScreeningApi.cancelRun(projectId!, runId);
      void refetchRuns();
    } catch (e) {
      console.error("Cancel failed", e);
    }
  };

  const handleDelete = async (runId: string) => {
    const ok = await confirmDialog({
      title: "Delete this run?",
      message: "All its screening results will be deleted. This cannot be undone.",
      confirmLabel: "Delete run",
      danger: true,
    });
    if (!ok) return;
    try {
      await llmScreeningApi.deleteRun(projectId!, runId);
      if (selectedRun?.id === runId) setSelectedRun(null);
      void refetchRuns();
    } catch (e) {
      console.error("Delete failed", e);
    }
  };

  const [forkRun, setForkRun] = useState<LlmRunResponse | null>(null);

  // ── Tab definitions ────────────────────────────────────────────────────────
  const TABS: { id: Tab; label: string }[] = [
    { id: "run",     label: "Run" },
    { id: "prompt",  label: "Prompt" },
    { id: "results", label: "Results" },
    { id: "compare", label: "Compare" },
  ];

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          <ChevronLeft size={15} /> {project?.name ?? "Project"}
        </Link>
      </header>

      <main>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
          <Bot size={22} style={{ color: "#6366f1" }} />
          <h2 style={{ margin: 0 }}>LLM Screening</h2>
        </div>
        <p className="muted" style={{ marginBottom: "1.5rem", maxWidth: 640 }}>
          AI-assisted screening and extraction. Configure prompts, run the LLM, then compare with human decisions.
        </p>

        {/* Tab nav */}
        <div style={{ display: "flex", gap: 0, borderBottom: "2px solid #e8eaed", marginBottom: "1.75rem" }}>
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              style={{ padding: "0.5rem 1.25rem", background: "none", border: "none", borderBottom: activeTab === tab.id ? "2px solid #6366f1" : "2px solid transparent", marginBottom: "-2px", fontWeight: activeTab === tab.id ? 700 : 400, color: activeTab === tab.id ? "#6366f1" : "#5f6368", cursor: "pointer", fontSize: "0.9rem" }}>
              {tab.label}
              {tab.id === "results" && selectedRun && (
                <span style={{ marginLeft: "0.35rem", background: "#ede9fe", color: "#6366f1", borderRadius: "0.75rem", padding: "0 0.4rem", fontSize: "0.72rem", fontWeight: 700 }}>
                  {selectedRun.processed_records}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Tab: Run ─────────────────────────────────────────────────────── */}
        {activeTab === "run" && (
          <>
            {!hasApiKey && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.65rem 0.9rem", marginBottom: "1.25rem", background: "#fff8e1", border: "1px solid #f9ab00", borderRadius: "0.375rem", fontSize: "0.83rem", color: "#5f4a00", maxWidth: 700 }}>
                <AlertCircle size={15} style={{ flexShrink: 0, color: "#f9ab00" }} />
                No API key configured. Add an Anthropic or OpenRouter key in your{" "}
                <button onClick={() => {}} style={{ background: "none", border: "none", cursor: "pointer", color: "#6366f1", fontWeight: 600, padding: 0, fontSize: "0.83rem", textDecoration: "underline" }}>
                  account profile
                </button>
                {" "}(click your name in the bottom-left sidebar).
              </div>
            )}

            <section style={{ background: "#f8f9fa", border: "1px solid #dadce0", borderRadius: "0.5rem", padding: "1.25rem", marginBottom: "2rem", maxWidth: 700 }}>
              <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>Screening Mode</h3>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1.25rem" }}>
                {[
                  { id: "prisma_scr" as const, label: "PRISMA-ScR", desc: "Screen all records: TA → FT → Extract in parallel. Standard systematic review workflow." },
                  { id: "ta_only" as const, label: "TA Only (interactive)", desc: "Screen by title/abstract only. Pauses so you can upload PDFs for included papers, then launch FT screening." },
                  { id: "saturation" as const, label: "Saturation", desc: "Process one corpus sequentially. Stop when no new concepts found (mirrors human saturation review)." },
                ].map(({ id, label, desc }) => (
                  <div key={id} onClick={() => setMode(id)} style={{ padding: "0.85rem", border: `2px solid ${mode === id ? "#6366f1" : "#dadce0"}`, borderRadius: "0.5rem", cursor: "pointer", background: mode === id ? "#ede9fe" : "#fff" }}>
                    <div style={{ fontWeight: 700, color: mode === id ? "#6366f1" : "#3c4043", marginBottom: "0.25rem" }}>{label}</div>
                    <div style={{ fontSize: "0.8rem", color: "#5f6368" }}>{desc}</div>
                  </div>
                ))}
              </div>

              {mode === "saturation" && (
                <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "1rem", marginBottom: "1rem" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                    <div>
                      <label style={{ fontWeight: 600, fontSize: "0.83rem", display: "block", marginBottom: "0.35rem" }}>Corpus (required)</label>
                      <select value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)}
                        style={{ width: "100%", padding: "0.4rem 0.6rem", borderRadius: "0.375rem", border: `1px solid ${!selectedSourceId ? "#c5221f" : "#dadce0"}`, fontSize: "0.85rem" }}>
                        <option value="">— select corpus —</option>
                        {(sources ?? []).map((s: Source) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      {!selectedSourceId && <p style={{ fontSize: "0.75rem", color: "#c5221f", margin: "0.2rem 0 0" }}>Required for saturation mode</p>}
                    </div>
                    <div>
                      <SeedPicker
                        sourceId={selectedSourceId}
                        queueHistory={queueHistory ?? []}
                        teamMembers={teamMembers ?? []}
                        value={seedSelection}
                        customValue={customSeedValue}
                        onChange={setSeedSelection}
                        onCustomChange={setCustomSeedValue}
                      />
                    </div>
                    <div>
                      <label style={{ fontWeight: 600, fontSize: "0.83rem", display: "block", marginBottom: "0.35rem" }}>Saturation threshold: {saturationThreshold}</label>
                      <input type="range" min={3} max={10} value={saturationThreshold} onChange={(e) => setSaturationThreshold(parseInt(e.target.value, 10))} style={{ width: "100%" }} />
                      <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.2rem" }}>Stop after N consecutive records with no new concepts</p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input type="checkbox" id="include-extraction" checked={includeExtraction} onChange={(e) => setIncludeExtraction(e.target.checked)} />
                      <label htmlFor="include-extraction" style={{ fontSize: "0.85rem", cursor: "pointer" }}>Include structured extraction</label>
                    </div>
                  </div>
                </div>
              )}

              {mode === "prisma_scr" && (
                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <label style={{ fontWeight: 600, fontSize: "0.83rem" }}>Filter to corpus (optional)</label>
                    <select value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)} style={{ padding: "0.35rem 0.6rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.83rem" }}>
                      <option value="">All corpora</option>
                      {(sources ?? []).map((s: Source) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
                    <input type="checkbox" id="include-extraction-prisma" checked={includeExtraction} onChange={(e) => setIncludeExtraction(e.target.checked)} />
                    <label htmlFor="include-extraction-prisma" style={{ fontSize: "0.85rem", cursor: "pointer" }}>Include structured extraction for FT-included records</label>
                  </div>
                </div>
              )}

              {/* Agent Mode */}
              <h3 style={{ margin: "1.25rem 0 0.75rem" }}>Agent Mode</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
                {[
                  {
                    id: "single" as const,
                    icon: <User size={16} />,
                    label: "Single Agent",
                    desc: "One agent handles all screening stages (TA → FT → extraction) using a single model. Simple, cost-effective, and easy to audit.",
                  },
                  {
                    id: "multi" as const,
                    icon: <Layers size={16} />,
                    label: "Multi-Agent Pipeline",
                    desc: "Specialised agents for each stage, each with its own model and prompt. Use a fast/cheap model for TA and a more powerful one for FT.",
                  },
                ].map(({ id, icon, label, desc }) => (
                  <div
                    key={id}
                    onClick={() => setAgentMode(id)}
                    style={{ padding: "0.85rem", border: `2px solid ${agentMode === id ? "#6366f1" : "#dadce0"}`, borderRadius: "0.5rem", cursor: "pointer", background: agentMode === id ? "#ede9fe" : "#fff" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 700, color: agentMode === id ? "#6366f1" : "#3c4043", marginBottom: "0.3rem" }}>
                      {icon} {label}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "#5f6368" }}>{desc}</div>
                  </div>
                ))}
              </div>

              {agentMode === "multi" && defaultPipelines && pipeline.length > 0 && (
                <div style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "1rem", marginBottom: "1rem" }}>
                  <PipelineEditor
                    pipeline={pipeline}
                    onChange={setPipeline}
                    defaultPipeline={defaultPipelines.multi}
                  />
                </div>
              )}

              {/* Model + Estimate */}
              <h3 style={{ margin: "1.25rem 0 0.75rem" }}>
                {agentMode === "single" ? "Model & Estimate" : "Estimate"}
              </h3>
              <div>
                {agentMode === "single" && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.35rem" }}>
                      <label style={{ fontSize: "0.85rem", fontWeight: 500, color: "#3c4043" }}>Model</label>
                      <button className="btn-ghost" style={{ fontSize: "0.78rem", display: "flex", alignItems: "center", gap: "0.25rem" }} onClick={() => setShowComparison((v) => !v)}>
                        {showComparison ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Compare models
                      </button>
                    </div>
                    <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} style={{ fontSize: "0.9rem", padding: "0.4rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", minWidth: 320 }}>
                      {MODEL_CATALOG.map((group) => (
                        <optgroup key={group.group} label={group.group}>
                          {group.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.recommended ? " ★" : ""} — {m.cost_per_1k} · {m.speed}</option>)}
                        </optgroup>
                      ))}
                    </select>
                    <ModelDescriptionCard modelId={selectedModel} />
                    {showComparison && <ModelComparisonTable onSelectModel={(id) => { setSelectedModel(id); setShowComparison(false); }} />}
                  </>
                )}
                {agentMode === "multi" && (
                  <p style={{ fontSize: "0.83rem", color: "#5f6368", margin: "0 0 0.75rem" }}>
                    Cost is calculated per stage based on each agent's model and expected reach fraction.
                    Disabled agents are not included in the estimate.
                  </p>
                )}
              </div>

              <div style={{ marginTop: "1.25rem" }}>
                {estimateLoading ? (
                  <p style={{ color: "#9aa0a6", fontSize: "0.88rem" }}>Calculating estimate…</p>
                ) : estimate ? (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.75rem" }}>
                      {[
                        { value: estimate.total_records.toLocaleString(), label: "papers to screen", color: "#3c4043" },
                        { value: estimate.estimated_input_tokens.toLocaleString(), label: "est. input tokens", color: "#3c4043" },
                        { value: estimate.estimated_output_tokens.toLocaleString(), label: "est. output tokens", color: "#3c4043" },
                        { value: `$${estimate.estimated_cost_usd.toFixed(2)}`, label: "est. total cost", color: estimate.estimated_cost_usd === 0 ? "#188038" : "#b06000" },
                        { value: fmtMinutes(estimate.estimated_minutes), label: "est. time", color: "#1a73e8" },
                      ].map(({ value, label, color }) => (
                        <div key={label} style={{ background: "#fff", border: "1px solid #e8eaed", borderRadius: "0.375rem", padding: "0.75rem" }}>
                          <div style={{ fontSize: "1.2rem", fontWeight: 700, color }}>{value}</div>
                          <div style={{ fontSize: "0.75rem", color: "#5f6368", marginTop: "0.15rem" }}>{label}</div>
                        </div>
                      ))}
                    </div>
                    {agentMode === "multi" && estimate.stages.length > 0 && (
                      <StageCostBreakdown stages={estimate.stages} />
                    )}
                    {estimate.token_data_source && (
                      <p style={{ margin: "0.6rem 0 0", fontSize: "0.75rem", color: estimate.token_data_source.startsWith("actual") ? "#188038" : "#9aa0a6" }}>
                        {estimate.token_data_source.startsWith("actual")
                          ? `Estimate based on actual token usage from ${estimate.token_data_source.match(/\d+/)?.[0] ?? "past"} screened records in this project.`
                          : `No past run data — estimate uses default token averages and may be inaccurate. Run a small batch first for a better estimate.`}
                        {estimate.avg_ta_output_per_record != null && (
                          <> Avg output: {estimate.avg_ta_output_per_record.toLocaleString()} tokens/record.</>
                        )}
                      </p>
                    )}
                  </>
                ) : null}
              </div>

              <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <button className="btn-primary" disabled={launch.isPending || !canLaunch} onClick={() => launch.mutate()} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <Play size={15} /> {launch.isPending ? "Launching…" : "Launch LLM run"}
                </button>
                {hasRunningRun && <span style={{ color: "#1a73e8", fontSize: "0.85rem" }}>A run is already in progress.</span>}
                {(estimate?.total_records ?? 0) === 0 && !hasRunningRun && <span style={{ color: "#9aa0a6", fontSize: "0.85rem" }}>Import records first.</span>}
                {mode === "saturation" && !selectedSourceId && !hasRunningRun && <span style={{ color: "#c5221f", fontSize: "0.85rem" }}>Select a corpus to launch in saturation mode.</span>}
              </div>
              {launchError && <p className="error" style={{ marginTop: "0.5rem" }}>{launchError}</p>}
            </section>

            <section>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem" }}>
                <h3 style={{ margin: 0 }}>Run history</h3>
                <button className="btn-ghost" onClick={() => void refetchRuns()} style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem" }}>
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>
              <RunHistoryTable runs={displayRuns} selectedRunId={selectedRun?.id ?? null} onSelect={setSelectedRun} onResume={handleResume} onCancel={handleCancel} onDelete={handleDelete} onFork={setForkRun} />
            </section>
            {forkRun && projectId && (
              <SubprojectModal projectId={projectId} run={forkRun} onClose={() => setForkRun(null)} />
            )}
          </>
        )}

        {/* ── Tab: Prompt ────────────────────────────────────────────────── */}
        {activeTab === "prompt" && projectId && (
          <PromptConfigPanel
            projectId={projectId}
            agentMode={agentMode}
            pipeline={pipeline}
            onPipelineChange={setPipeline}
          />
        )}

        {/* ── Tab: Results ────────────────────────────────────────────────── */}
        {activeTab === "results" && (
          <>
            {displayRuns.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ fontWeight: 600, fontSize: "0.85rem", marginRight: "0.75rem" }}>Run:</label>
                <select value={selectedRun?.id ?? ""} onChange={(e) => { const r = displayRuns.find((x) => x.id === e.target.value); setSelectedRun(r ?? null); }}
                  style={{ padding: "0.35rem 0.65rem", borderRadius: "0.375rem", border: "1px solid #dadce0", fontSize: "0.85rem", minWidth: 260 }}>
                  <option value="">— select run —</option>
                  {displayRuns.map((r) => <option key={r.id} value={r.id}>{fmtDate(r.started_at ?? r.created_at)} — {MODEL_BY_ID[r.model]?.label ?? r.model} ({isEffectivelyCompleted(r) ? "completed" : r.status})</option>)}
                </select>
              </div>
            )}
            {selectedRun && projectId ? (
              <ResultsPanel projectId={projectId} run={selectedRun} extractionTemplate={project?.extraction_template as { rows: Array<{ id: string; domain?: string; item: string }> } | null} />
            ) : (
              <p className="muted">Select a run from the dropdown or click a row in the Run tab.</p>
            )}
          </>
        )}

        {/* ── Tab: Compare ───────────────────────────────────────────────── */}
        {activeTab === "compare" && projectId && <ComparePanel projectId={projectId} runs={displayRuns} />}
      </main>
    </div>
  );
}
