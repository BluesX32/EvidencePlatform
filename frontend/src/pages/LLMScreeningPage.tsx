/**
 * LLMScreeningPage — Launch and review AI-assisted screening runs.
 *
 * Layout:
 *   A. API Keys panel   — store Anthropic / OpenRouter keys in localStorage
 *   B. Model selection  — grouped select + model description card
 *   C. Estimate         — paper count, token estimates, time
 *   D. Model comparison — inline table for 3 representative models
 *   E. Launch button
 *   F. Run history      — list of past runs with status + progress
 *   G. Results panel    — paginated per-result table for the selected run
 */
import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronLeft,
  Play,
  RefreshCw,
  Key,
  X,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  projectsApi,
  llmScreeningApi,
  type LlmRunResponse,
  type LlmResultResponse,
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
      {
        id: "openai/gpt-5.4-pro",
        label: "GPT-5.4 Pro",
        cost_per_1k: "~$117",
        speed: "Slow",
        context: "1M tokens",
        tags: ["👑 Most Powerful", "📄 Ultra Long Context"],
        pros: [
          "1M token context — can process entire literature corpora at once",
          "Highest academic reasoning quality available from OpenAI",
          "Exceptional for multi-document synthesis tasks",
        ],
        cons: [
          "Extremely expensive — $117/1k tokens; cost-prohibitive at scale",
          "Only justified for very small, high-value paper sets",
        ],
        best_for: "Tiny high-value corpora where cost is no constraint",
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
          "Good multimodal capabilities (PDF tables/figures)",
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
      {
        id: "google/gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        cost_per_1k: "~$0.15",
        speed: "Very Fast",
        context: "1M tokens",
        tags: ["🆕 New", "⚡ Very Fast", "📄 Long Context"],
        pros: [
          "Next-generation Gemini at Flash speed and price",
          "Improved structured output over Gemini 2",
          "1M token context at low cost",
        ],
        cons: [
          "Preview — may have API stability issues",
          "Less community testing than Gemini 2 series",
        ],
        best_for: "High-volume screening with latest Gemini capabilities",
      },
      {
        id: "google/gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash Lite",
        cost_per_1k: "~$0.05",
        speed: "Very Fast",
        context: "1M tokens",
        tags: ["🆕 New", "💰 Cheapest", "⚡ Very Fast"],
        pros: [
          "Cheapest option with 1M token context",
          "Excellent for ultra-high-volume first-pass screening",
          "Fastest Gemini variant",
        ],
        cons: [
          "Lite model — reduced capability for nuanced decisions",
          "Preview stability concerns",
        ],
        best_for: "Massive-scale first-pass where cost and speed are paramount",
      },
      {
        id: "google/gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        cost_per_1k: "~$8",
        speed: "Medium",
        context: "1M tokens",
        tags: ["🆕 New", "🧠 Frontier", "📄 Long Context"],
        pros: [
          "Google's most capable model with 1M context",
          "State-of-the-art reasoning on academic tasks",
          "Excellent multimodal comprehension for PDFs with figures",
        ],
        cons: [
          "Preview — potential instability",
          "Expensive relative to Gemini 3 Flash",
        ],
        best_for: "Complex full-text screening requiring frontier reasoning + long context",
      },
    ],
  },
  {
    group: "Meta Llama — via OpenRouter",
    key: "openrouter",
    models: [
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
      {
        id: "meta-llama/llama-4-scout",
        label: "Llama 4 Scout",
        cost_per_1k: "~$0.15",
        speed: "Fast",
        context: "10M tokens",
        tags: ["🆕 New", "🔓 Open Source", "📄 Ultra Long Context"],
        pros: [
          "Groundbreaking 10M token context — entire corpora in one call",
          "Open-source with multimodal capabilities (images/PDFs)",
          "Very competitive pricing for the context window size",
        ],
        cons: [
          "New model — less community validation on academic tasks",
          "Ultra-long context may slow inference for standard abstracts",
        ],
        best_for: "Full-corpus screening where the entire literature fits in context",
      },
      {
        id: "meta-llama/llama-4-maverick",
        label: "Llama 4 Maverick",
        cost_per_1k: "~$0.90",
        speed: "Medium",
        context: "1M tokens",
        tags: ["🆕 New", "🔓 Open Source", "🧠 MoE"],
        pros: [
          "128-expert mixture-of-experts architecture — strong reasoning",
          "Open-source with 1M token context",
          "Competitive with GPT-4o on academic benchmarks",
        ],
        cons: [
          "More expensive than Scout",
          "MoE overhead can add latency variance",
        ],
        best_for: "Open-source alternative to GPT-4o with long-context capability",
      },
      {
        id: "meta-llama/llama-3.1-405b-instruct",
        label: "Llama 3.1 405B",
        cost_per_1k: "~$2.70",
        speed: "Slow",
        context: "128k tokens",
        tags: ["🔓 Open Source", "🧠 Large Scale"],
        pros: [
          "Largest Llama 3 model — approaches GPT-4o quality",
          "Fully auditable weights and training",
          "Competitive with proprietary models on academic tasks",
        ],
        cons: [
          "Slowest throughput",
          "Expensive for open-source — Llama 4 is better value",
        ],
        best_for: "Open-source research requiring maximum Llama 3 capability",
      },
    ],
  },
  {
    group: "Mistral — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "mistralai/ministral-8b-2512",
        label: "Ministral 8B (2512)",
        cost_per_1k: "~$0.28",
        speed: "Fast",
        context: "128k tokens",
        tags: ["⚡ Fast", "🇪🇺 EU-compliant", "💰 Budget"],
        pros: [
          "Very affordable EU-compliant option",
          "Strong multilingual capabilities",
          "Fast inference for high-volume runs",
        ],
        cons: [
          "8B parameters — weaker reasoning than larger models",
          "Less reliable structured output",
        ],
        best_for: "Multilingual EU-compliant screening on a budget",
      },
      {
        id: "mistralai/mistral-small-3.1",
        label: "Mistral Small 3.1",
        cost_per_1k: "~$0.10",
        speed: "Fast",
        context: "128k tokens",
        tags: ["⚡ Fast", "🇪🇺 EU-compliant"],
        pros: [
          "Strong multilingual capabilities for non-English literature",
          "EU data residency options via Mistral API",
          "Good instruction-following at low cost",
        ],
        cons: [
          "Less tested on systematic review tasks vs Claude/GPT",
          "Smaller model means weaker reasoning",
        ],
        best_for: "Multilingual reviews or EU data-residency requirements",
      },
      {
        id: "mistralai/mistral-large-2512",
        label: "Mistral Large (2512)",
        cost_per_1k: "~$1.35",
        speed: "Medium",
        context: "262k tokens",
        tags: ["🇪🇺 EU-compliant", "📄 Long Context"],
        pros: [
          "Extended 262k context — handles long full-text papers",
          "Best Mistral reasoning at reasonable cost",
          "EU-compliant with strong multilingual support",
        ],
        cons: [
          "Claude Sonnet generally outperforms at similar price",
          "Less widely benchmarked on systematic review tasks",
        ],
        best_for: "European research needing EU compliance + long-context capability",
      },
      {
        id: "mistralai/mistral-large",
        label: "Mistral Large 2",
        cost_per_1k: "~$2",
        speed: "Medium",
        context: "128k tokens",
        tags: ["🇪🇺 EU-compliant"],
        pros: [
          "Proven EU-compliant option for complex reasoning",
          "Good structured output reliability",
        ],
        cons: [
          "Superseded by Mistral Large 2512 at lower cost",
          "Shorter context than the 2512 variant",
        ],
        best_for: "European research projects needing EU-compliant LLM processing",
      },
    ],
  },
  {
    group: "DeepSeek — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "deepseek/deepseek-v3.2",
        label: "DeepSeek V3.2",
        cost_per_1k: "~$0.55",
        speed: "Fast",
        context: "163k tokens",
        tags: ["🆕 New", "💰 Budget", "🌏 Chinese AI"],
        pros: [
          "Significant upgrade over V3 — better reasoning at similar price",
          "Extended 163k context fits most papers and abstracts",
          "Strong academic task performance",
        ],
        cons: [
          "Data processed via Chinese servers — check institutional policy",
          "Less predictable structured output vs Claude",
        ],
        best_for: "Budget screening with improved context and reasoning over V3",
      },
      {
        id: "deepseek/deepseek-chat",
        label: "DeepSeek V3",
        cost_per_1k: "~$0.14",
        speed: "Fast",
        context: "64k tokens",
        tags: ["💰 Cheapest", "🌏 Chinese AI"],
        pros: [
          "Lowest cost per paper of any high-quality model",
          "Good English and Chinese literature coverage",
        ],
        cons: [
          "Smaller context window limits full-text use",
          "Superseded by V3.2 for most use cases",
          "Data processed via Chinese servers",
        ],
        best_for: "Ultra-budget screening of abstracts only",
      },
      {
        id: "deepseek/deepseek-r1",
        label: "DeepSeek R1 (Reasoning)",
        cost_per_1k: "~$0.55",
        speed: "Slow",
        context: "64k tokens",
        tags: ["🧠 Reasoning", "🌏 Chinese AI"],
        pros: [
          "Explicit chain-of-thought reasoning — highly transparent decisions",
          "Strong academic benchmark performance",
          "Low cost for a reasoning model",
        ],
        cons: [
          "Data privacy concerns for sensitive research",
          "Small context window",
          "Verbose reasoning can be slow",
        ],
        best_for: "Transparent, step-by-step screening decisions on a budget",
      },
    ],
  },
  {
    group: "Qwen (Alibaba) — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "qwen/qwen3.5-plus-02-15",
        label: "Qwen 3.5 Plus",
        cost_per_1k: "~$0.50",
        speed: "Fast",
        context: "128k tokens",
        tags: ["🌏 Chinese AI", "💰 Budget"],
        pros: [
          "Excellent for Chinese-language and multilingual literature",
          "Strong STEM reasoning — good for science/medicine domains",
          "Competitive cost vs DeepSeek",
        ],
        cons: [
          "Data processed via Alibaba Cloud — check institutional policy",
          "Less community validation on English-language systematic reviews",
        ],
        best_for: "Multilingual reviews with Chinese-language literature",
      },
      {
        id: "qwen/qwen3-max-thinking",
        label: "Qwen 3 Max (Thinking)",
        cost_per_1k: "~$1.80",
        speed: "Slow",
        context: "128k tokens",
        tags: ["🧠 Reasoning", "🌏 Chinese AI"],
        pros: [
          "Extended reasoning mode — similar to o3 but from Alibaba",
          "Strong on STEM and medical literature comprehension",
          "Transparent chain-of-thought output",
        ],
        cons: [
          "Slower due to reasoning overhead",
          "Data governance concerns for Western institutions",
        ],
        best_for: "Step-by-step transparent screening of STEM/medical literature",
      },
    ],
  },
  {
    group: "NVIDIA — Free via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "nemotron/nemotron-3-super",
        label: "Nemotron 3 Super (Free)",
        cost_per_1k: "Free",
        speed: "Medium",
        context: "128k tokens",
        tags: ["🆓 Free", "🔓 Open Source"],
        pros: [
          "Completely free — $0 cost for unlimited screening",
          "Open-source weights — fully auditable",
          "Strong STEM reasoning trained on scientific literature",
        ],
        cons: [
          "Free tier has rate limits — may be slow for large corpora",
          "Less tested on systematic review screening tasks",
          "Quality below Claude/GPT-4o on nuanced criteria",
        ],
        best_for: "Zero-budget exploratory runs or researchers without API credits",
      },
    ],
  },
  {
    group: "Cohere — via OpenRouter",
    key: "openrouter",
    models: [
      {
        id: "cohere/command-a-03-2025",
        label: "Command A (Mar 2025)",
        cost_per_1k: "~$2.50",
        speed: "Medium",
        context: "256k tokens",
        tags: ["🔓 Open Weights", "📄 Long Context"],
        pros: [
          "Open-weights model — can be self-hosted for data privacy",
          "256k context — handles long papers well",
          "Strong RAG and document comprehension capabilities",
        ],
        cons: [
          "Less widely benchmarked on systematic review tasks",
          "Claude/GPT-4o generally stronger on academic reasoning",
        ],
        best_for: "Privacy-sensitive research requiring open-weights with long context",
      },
    ],
  },
];

// Flat lookup for model metadata
const MODEL_BY_ID: Record<string, ModelDef & { groupKey: string }> = Object.fromEntries(
  MODEL_CATALOG.flatMap((g) => g.models.map((m) => [m.id, { ...m, groupKey: g.key }]))
);

// Default comparison model IDs (user can change in the table)
const DEFAULT_COMPARISON_IDS = ["claude-sonnet-4-6", "openai/gpt-4o", "google/gemini-2.0-flash-001"];

// Flat list of all model options for comparison selects
const ALL_MODEL_OPTIONS = MODEL_CATALOG.flatMap((g) =>
  g.models.map((m) => ({ id: m.id, label: `${m.label} (${g.group.split(" —")[0]})` }))
);

const DECISION_FILTER_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "include", label: "Include" },
  { value: "exclude", label: "Exclude" },
  { value: "uncertain", label: "Uncertain" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function decisionBadge(decision: string | null) {
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
        padding: "0.15rem 0.55rem",
        borderRadius: "0.75rem",
        fontSize: "0.78rem",
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {decision}
    </span>
  );
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; color: string }> = {
    pending:   { label: "Pending",   color: "#9aa0a6" },
    running:   { label: "Running…",  color: "#1a73e8" },
    completed: { label: "Completed", color: "#188038" },
    failed:    { label: "Failed",    color: "#c5221f" },
  };
  const s = map[status] ?? { label: status, color: "#5f6368" };
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

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 7) + "••••";
}

// ── API Keys Panel ────────────────────────────────────────────────────────────

function ApiKeysPanel({
  anthropicKey,
  openrouterKey,
  onSaveAnthropic,
  onSaveOpenrouter,
}: {
  anthropicKey: string;
  openrouterKey: string;
  onSaveAnthropic: (val: string) => void;
  onSaveOpenrouter: (val: string) => void;
}) {
  const [anthropicInput, setAnthropicInput] = useState("");
  const [openrouterInput, setOpenrouterInput] = useState("");
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenrouter, setShowOpenrouter] = useState(false);

  const hasNoKey = !anthropicKey && !openrouterKey;

  return (
    <section
      style={{
        background: "#f8f9fa",
        border: "1px solid #dadce0",
        borderRadius: "0.5rem",
        padding: "1.25rem",
        marginBottom: "1.5rem",
        maxWidth: 680,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
        <Key size={16} style={{ color: "#6366f1" }} />
        <h3 style={{ margin: 0 }}>API Keys</h3>
      </div>

      {hasNoKey && (
        <div
          style={{
            background: "#fef7e0",
            border: "1px solid #f6d858",
            borderRadius: "0.375rem",
            padding: "0.6rem 0.85rem",
            marginBottom: "1rem",
            fontSize: "0.84rem",
            color: "#7a5200",
          }}
        >
          No API key configured. Add an Anthropic or OpenRouter key to launch a run.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        {/* Anthropic */}
        <div>
          <label
            style={{ fontSize: "0.83rem", fontWeight: 600, display: "block", marginBottom: "0.35rem", color: "#3c4043" }}
          >
            Anthropic API Key
          </label>
          {anthropicKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <code
                style={{
                  background: "#e8f0fe",
                  color: "#1a73e8",
                  padding: "0.3rem 0.6rem",
                  borderRadius: "0.3rem",
                  fontSize: "0.82rem",
                  flex: 1,
                }}
              >
                {maskKey(anthropicKey)}
              </code>
              <button
                title="Remove key"
                onClick={() => onSaveAnthropic("")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#c5221f",
                  padding: "0.2rem",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <input
                  type={showAnthropic ? "text" : "password"}
                  placeholder="sk-ant-…"
                  value={anthropicInput}
                  onChange={(e) => setAnthropicInput(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.4rem 2rem 0.4rem 0.6rem",
                    borderRadius: "0.375rem",
                    border: "1px solid #dadce0",
                    fontSize: "0.85rem",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowAnthropic((v) => !v)}
                  style={{
                    position: "absolute",
                    right: "0.4rem",
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#9aa0a6",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {showAnthropic ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <button
                className="btn-primary"
                style={{ fontSize: "0.82rem", padding: "0.35rem 0.75rem" }}
                onClick={() => {
                  onSaveAnthropic(anthropicInput);
                  setAnthropicInput("");
                }}
                disabled={!anthropicInput.trim()}
              >
                Save
              </button>
            </div>
          )}
          <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.3rem" }}>
            For Claude models (direct)
          </p>
        </div>

        {/* OpenRouter */}
        <div>
          <label
            style={{ fontSize: "0.83rem", fontWeight: 600, display: "block", marginBottom: "0.35rem", color: "#3c4043" }}
          >
            OpenRouter API Key
          </label>
          {openrouterKey ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <code
                style={{
                  background: "#e8f0fe",
                  color: "#1a73e8",
                  padding: "0.3rem 0.6rem",
                  borderRadius: "0.3rem",
                  fontSize: "0.82rem",
                  flex: 1,
                }}
              >
                {maskKey(openrouterKey)}
              </code>
              <button
                title="Remove key"
                onClick={() => onSaveOpenrouter("")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#c5221f",
                  padding: "0.2rem",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <div style={{ position: "relative", flex: 1 }}>
                <input
                  type={showOpenrouter ? "text" : "password"}
                  placeholder="sk-or-…"
                  value={openrouterInput}
                  onChange={(e) => setOpenrouterInput(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "0.4rem 2rem 0.4rem 0.6rem",
                    borderRadius: "0.375rem",
                    border: "1px solid #dadce0",
                    fontSize: "0.85rem",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowOpenrouter((v) => !v)}
                  style={{
                    position: "absolute",
                    right: "0.4rem",
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#9aa0a6",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {showOpenrouter ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <button
                className="btn-primary"
                style={{ fontSize: "0.82rem", padding: "0.35rem 0.75rem" }}
                onClick={() => {
                  onSaveOpenrouter(openrouterInput);
                  setOpenrouterInput("");
                }}
                disabled={!openrouterInput.trim()}
              >
                Save
              </button>
            </div>
          )}
          <p style={{ fontSize: "0.75rem", color: "#9aa0a6", marginTop: "0.3rem" }}>
            For all models via{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#6366f1" }}
            >
              openrouter.ai
            </a>
          </p>
        </div>
      </div>

      <p
        style={{
          fontSize: "0.75rem",
          color: "#9aa0a6",
          marginTop: "0.85rem",
          marginBottom: 0,
        }}
      >
        Keys are stored in your browser's local storage and sent only to our backend when
        making LLM calls.
      </p>
    </section>
  );
}

// ── Model Description Card ────────────────────────────────────────────────────

function ModelDescriptionCard({ modelId }: { modelId: string }) {
  const m = MODEL_BY_ID[modelId];
  if (!m) return null;

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8eaed",
        borderRadius: "0.5rem",
        padding: "1rem",
        marginTop: "0.75rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: "0.9rem", color: "#3c4043" }}>{m.label}</span>
        {m.tags.map((tag) => (
          <span
            key={tag}
            style={{
              background: "#ede9fe",
              color: "#6366f1",
              padding: "0.1rem 0.5rem",
              borderRadius: "0.75rem",
              fontSize: "0.72rem",
              fontWeight: 600,
            }}
          >
            {tag}
          </span>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", fontSize: "0.82rem" }}>
        <div>
          <p style={{ margin: "0 0 0.35rem", fontWeight: 600, color: "#188038", fontSize: "0.78rem" }}>
            Strengths
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "#3c4043" }}>
            {m.pros.map((p) => (
              <li key={p} style={{ marginBottom: "0.15rem" }}>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p style={{ margin: "0 0 0.35rem", fontWeight: 600, color: "#c5221f", fontSize: "0.78rem" }}>
            Limitations
          </p>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", color: "#3c4043" }}>
            {m.cons.map((c) => (
              <li key={c} style={{ marginBottom: "0.15rem" }}>
                {c}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div
        style={{
          marginTop: "0.65rem",
          display: "flex",
          gap: "1.5rem",
          fontSize: "0.78rem",
          color: "#5f6368",
          flexWrap: "wrap",
        }}
      >
        <span>
          <strong>Context:</strong> {m.context}
        </span>
        <span>
          <strong>Cost/1k:</strong> {m.cost_per_1k}
        </span>
        <span>
          <strong>Speed:</strong> {m.speed}
        </span>
        <span>
          <strong>Best for:</strong> {m.best_for}
        </span>
      </div>

      <p style={{ margin: "0.5rem 0 0", fontSize: "0.75rem", color: "#9aa0a6" }}>
        {m.groupKey === "anthropic_or_openrouter"
          ? "Requires Anthropic API key or OpenRouter API key"
          : "Requires OpenRouter API key"}
      </p>
    </div>
  );
}

// ── Model Comparison Table ────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  padding: "0.3rem 0.5rem",
  borderRadius: "0.3rem",
  border: "1px solid #dadce0",
  background: "#fff",
  color: "#3c4043",
  width: "100%",
  cursor: "pointer",
};

function ModelComparisonTable({
  onSelectModel,
}: {
  onSelectModel: (id: string) => void;
}) {
  const [selected, setSelected] = useState<[string, string, string]>(
    DEFAULT_COMPARISON_IDS as [string, string, string]
  );

  const models = selected.map((id) => MODEL_BY_ID[id]).filter(Boolean);

  function changeSlot(slotIdx: number, newId: string) {
    setSelected((prev) => {
      const next = [...prev] as [string, string, string];
      next[slotIdx] = newId;
      return next;
    });
  }

  return (
    <div
      style={{
        marginTop: "1rem",
        border: "1px solid #dadce0",
        borderRadius: "0.5rem",
        overflow: "hidden",
        fontSize: "0.82rem",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f1f3f4" }}>
            <th
              style={{
                padding: "0.6rem 0.85rem",
                textAlign: "left",
                fontWeight: 600,
                fontSize: "0.75rem",
                color: "#5f6368",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                width: 130,
              }}
            >
              Attribute
            </th>
            {selected.map((id, slotIdx) => (
              <th key={slotIdx} style={{ padding: "0.5rem 0.85rem", verticalAlign: "bottom" }}>
                <select
                  value={id}
                  onChange={(e) => changeSlot(slotIdx, e.target.value)}
                  style={selectStyle}
                  title="Change model for this column"
                >
                  {MODEL_CATALOG.map((g) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(
            [
              ["Speed", (m: ModelDef) => m.speed],
              ["Context", (m: ModelDef) => m.context],
              ["Cost/1k tokens", (m: ModelDef) => m.cost_per_1k],
              ["Best for", (m: ModelDef) => m.best_for],
              [
                "Limitations",
                (m: ModelDef) => m.cons[0] + (m.cons.length > 1 ? ` (+${m.cons.length - 1})` : ""),
              ],
            ] as [string, (m: ModelDef) => string][]
          ).map(([label, getter], rowIdx) => (
            <tr
              key={label}
              style={{ background: rowIdx % 2 === 0 ? "#fff" : "#f8f9fa" }}
            >
              <td
                style={{
                  padding: "0.55rem 0.85rem",
                  fontWeight: 600,
                  color: "#5f6368",
                  verticalAlign: "top",
                }}
              >
                {label}
              </td>
              {models.map((m) => (
                <td
                  key={m.id}
                  style={{ padding: "0.55rem 0.85rem", color: "#3c4043", verticalAlign: "top" }}
                >
                  {getter(m)}
                </td>
              ))}
            </tr>
          ))}
          <tr style={{ background: "#f1f3f4" }}>
            <td style={{ padding: "0.6rem 0.85rem" }} />
            {models.map((m) => (
              <td key={m.id} style={{ padding: "0.6rem 0.85rem" }}>
                <button
                  className="btn-primary"
                  style={{ fontSize: "0.78rem", padding: "0.3rem 0.7rem" }}
                  onClick={() => onSelectModel(m.id)}
                >
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

function ReviewActions({
  result,
  projectId,
  runId,
  onReviewed,
}: {
  result: LlmResultResponse;
  projectId: string;
  runId: string;
  onReviewed: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function handle(action: "accepted" | "rejected" | "merged") {
    setPending(true);
    try {
      await llmScreeningApi.reviewResult(projectId, runId, result.id, action);
      onReviewed();
    } finally {
      setPending(false);
    }
  }

  if (result.review_action) {
    const colors: Record<string, string> = {
      accepted: "#188038",
      rejected: "#c5221f",
      merged:   "#1a73e8",
    };
    return (
      <span
        style={{
          fontSize: "0.78rem",
          color: colors[result.review_action] ?? "#5f6368",
          fontWeight: 600,
          textTransform: "capitalize",
        }}
      >
        {result.review_action}
      </span>
    );
  }

  return (
    <div style={{ display: "flex", gap: "0.3rem" }}>
      <button
        title="Accept — LLM finding confirmed"
        disabled={pending}
        onClick={() => handle("accepted")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #b7dfc4",
          background: "#e6f4ea",
          color: "#188038",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Accept
      </button>
      <button
        title="Reject — LLM result not useful"
        disabled={pending}
        onClick={() => handle("rejected")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #f28b82",
          background: "#fce8e6",
          color: "#c5221f",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Reject
      </button>
      <button
        title="Merge — incorporate into human extraction"
        disabled={pending}
        onClick={() => handle("merged")}
        style={{
          padding: "0.2rem 0.5rem",
          fontSize: "0.72rem",
          borderRadius: "0.3rem",
          border: "1px solid #c5d9f7",
          background: "#e8f0fe",
          color: "#1a73e8",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Merge
      </button>
    </div>
  );
}

// ── Result Row ────────────────────────────────────────────────────────────────

function ResultRow({
  result,
  projectId,
  runId,
  onReviewed,
}: {
  result: LlmResultResponse;
  projectId: string;
  runId: string;
  onReviewed: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isNew = (result.new_concepts?.length ?? 0) > 0;

  return (
    <>
      <tr
        style={{
          background: isNew ? "rgba(79,70,229,0.04)" : undefined,
          cursor: "pointer",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <td
          style={{
            fontSize: "0.8rem",
            color: "#9aa0a6",
            maxWidth: 120,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "0.5rem 0.75rem",
          }}
        >
          {result.record_id?.slice(-8) ?? result.cluster_id?.slice(-8) ?? "—"}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(result.ta_decision)}</td>
        <td style={{ padding: "0.5rem 0.75rem" }}>{decisionBadge(result.ft_decision)}</td>
        <td
          style={{
            padding: "0.5rem 0.75rem",
            fontSize: "0.8rem",
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {result.ta_reason ?? "—"}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }}>
          {isNew ? (
            <span style={{ color: "#6366f1", fontWeight: 600, fontSize: "0.78rem" }}>
              +{result.new_concepts!.length} new
            </span>
          ) : (
            <span style={{ color: "#9aa0a6", fontSize: "0.78rem" }}>—</span>
          )}
        </td>
        <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.78rem", color: "#5f6368" }}>
          {result.full_text_source ?? "abstract"}
        </td>
        <td style={{ padding: "0.5rem 0.75rem" }} onClick={(e) => e.stopPropagation()}>
          <ReviewActions
            result={result}
            projectId={projectId}
            runId={runId}
            onReviewed={onReviewed}
          />
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "#f8f9fa" }}>
          <td colSpan={7} style={{ padding: "0.75rem 1rem", fontSize: "0.83rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              {result.ta_reason && (
                <div>
                  <strong style={{ color: "#3c4043" }}>TA reason:</strong>
                  <p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ta_reason}</p>
                </div>
              )}
              {result.ft_reason && (
                <div>
                  <strong style={{ color: "#3c4043" }}>FT reason:</strong>
                  <p style={{ marginTop: "0.25rem", color: "#5f6368" }}>{result.ft_reason}</p>
                </div>
              )}
              {(result.matched_codes?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#3c4043" }}>Matched concepts:</strong>
                  <div
                    style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}
                  >
                    {result.matched_codes!.map((c) => (
                      <span
                        key={c}
                        style={{
                          background: "#e8f0fe",
                          color: "#1a73e8",
                          padding: "0.15rem 0.55rem",
                          borderRadius: "0.75rem",
                          fontSize: "0.78rem",
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(result.new_concepts?.length ?? 0) > 0 && (
                <div>
                  <strong style={{ color: "#6366f1" }}>New concepts suggested:</strong>
                  <div
                    style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.35rem" }}
                  >
                    {result.new_concepts!.map((c) => (
                      <span
                        key={c}
                        style={{
                          background: "#ede9fe",
                          color: "#6366f1",
                          padding: "0.15rem 0.55rem",
                          borderRadius: "0.75rem",
                          fontSize: "0.78rem",
                          fontWeight: 600,
                        }}
                      >
                        + {c}
                      </span>
                    ))}
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

function ResultsPanel({
  projectId,
  run,
}: {
  projectId: string;
  run: LlmRunResponse;
}) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [decisionFilter, setDecisionFilter] = useState("");
  const PAGE_SIZE = 50;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["llm-results", run.id, page, decisionFilter],
    queryFn: () =>
      llmScreeningApi
        .listResults(projectId, run.id, {
          page,
          page_size: PAGE_SIZE,
          ta_decision: decisionFilter || undefined,
        })
        .then((r) => r.data),
    enabled: run.status === "completed" || run.processed_records > 0,
    staleTime: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>Results</h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {DECISION_FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setDecisionFilter(opt.value);
                setPage(1);
              }}
              style={{
                padding: "0.2rem 0.65rem",
                borderRadius: "0.75rem",
                border: `1.5px solid ${decisionFilter === opt.value ? "#1a73e8" : "#dadce0"}`,
                background: decisionFilter === opt.value ? "#e8f0fe" : "#f8f9fa",
                color: decisionFilter === opt.value ? "#1a73e8" : "#5f6368",
                fontSize: "0.8rem",
                fontWeight: decisionFilter === opt.value ? 600 : 400,
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            void refetch();
          }}
          className="btn-ghost"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.35rem" }}
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Summary stats */}
      <div
        style={{
          display: "flex",
          gap: "1.5rem",
          background: "#f8f9fa",
          border: "1px solid #dadce0",
          borderRadius: "0.5rem",
          padding: "0.65rem 1rem",
          marginBottom: "1rem",
          fontSize: "0.85rem",
          flexWrap: "wrap",
        }}
      >
        <span>
          <strong style={{ color: "#188038" }}>{run.included_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>included</span>
        </span>
        <span>
          <strong style={{ color: "#c5221f" }}>{run.excluded_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>excluded</span>
        </span>
        <span>
          <strong style={{ color: "#b06000" }}>{run.uncertain_count}</strong>{" "}
          <span style={{ color: "#5f6368" }}>uncertain</span>
        </span>
        {run.new_concepts_count > 0 && (
          <span>
            <strong style={{ color: "#6366f1" }}>{run.new_concepts_count}</strong>{" "}
            <span style={{ color: "#5f6368" }}>new concepts suggested</span>
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "#5f6368" }}>
          {fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)} actual cost ·{" "}
          {(run.input_tokens + run.output_tokens).toLocaleString()} tokens
        </span>
      </div>

      {isLoading ? (
        <p style={{ color: "#5f6368" }}>Loading results…</p>
      ) : !data || data.items.length === 0 ? (
        <p style={{ color: "#9aa0a6", fontStyle: "italic" }}>
          {run.status === "running"
            ? "Processing — results will appear as they complete."
            : "No results match the current filter."}
        </p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr
                  style={{
                    background: "#f1f3f4",
                    fontSize: "0.78rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "#5f6368",
                  }}
                >
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Record ID</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>TA</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>FT</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Reason</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>New Concepts</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Full Text</th>
                  <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>Review</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((result) => (
                  <ResultRow
                    key={result.id}
                    result={result}
                    projectId={projectId}
                    runId={run.id}
                    onReviewed={() => {
                      qc.invalidateQueries({ queryKey: ["llm-results", run.id] });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                alignItems: "center",
                justifyContent: "center",
                marginTop: "1rem",
                fontSize: "0.85rem",
              }}
            >
              <button
                className="btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← Prev
              </button>
              <span style={{ color: "#5f6368" }}>
                Page {page} of {totalPages} ({data.total.toLocaleString()} results)
              </span>
              <button
                className="btn-ghost"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LLMScreeningPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  // ── Persistent API keys ────────────────────────────────────────────────────
  const [anthropicKey, setAnthropicKey] = useState(
    () => localStorage.getItem("ep_llm_anthropic_key") ?? ""
  );
  const [openrouterKey, setOpenrouterKey] = useState(
    () => localStorage.getItem("ep_llm_openrouter_key") ?? ""
  );

  function saveKey(type: "anthropic" | "openrouter", value: string) {
    if (value.trim()) {
      localStorage.setItem(`ep_llm_${type}_key`, value.trim());
    } else {
      localStorage.removeItem(`ep_llm_${type}_key`);
    }
    if (type === "anthropic") setAnthropicKey(value.trim());
    else setOpenrouterKey(value.trim());
  }

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4-6");
  const [selectedRun, setSelectedRun] = useState<LlmRunResponse | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [showComparison, setShowComparison] = useState(false);

  // ── Project ────────────────────────────────────────────────────────────────
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // ── Estimate ───────────────────────────────────────────────────────────────
  const { data: estimate, isLoading: estimateLoading } = useQuery({
    queryKey: ["llm-estimate", projectId, selectedModel],
    queryFn: () =>
      llmScreeningApi.estimate(projectId!, selectedModel).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // ── Run list ───────────────────────────────────────────────────────────────
  const { data: runs, refetch: refetchRuns } = useQuery({
    queryKey: ["llm-runs", projectId],
    queryFn: () => llmScreeningApi.listRuns(projectId!).then((r) => r.data),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((r) => r.status === "running" || r.status === "pending")
        ? 3000
        : false;
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

  // ── Poll running run ───────────────────────────────────────────────────────
  const runningRun = runs?.find((r) => r.status === "running" || r.status === "pending");

  const { data: liveRun } = useQuery({
    queryKey: ["llm-run-live", runningRun?.id],
    queryFn: () =>
      llmScreeningApi.getRun(projectId!, runningRun!.id).then((r) => r.data),
    enabled: !!runningRun,
    refetchInterval: 3000,
  });

  const displayRuns = runs?.map((r) => (liveRun && r.id === liveRun.id ? liveRun : r));

  // ── Launch mutation ────────────────────────────────────────────────────────
  const launch = useMutation({
    mutationFn: () =>
      llmScreeningApi.createRun(projectId!, selectedModel, {
        anthropic: anthropicKey || undefined,
        openrouter: openrouterKey || undefined,
      }),
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

  const hasRunningRun = !!runningRun;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <header className="page-header">
        <Link to={`/projects/${projectId}`} className="back-link">
          <ChevronLeft size={15} /> {project?.name ?? "Project"}
        </Link>
      </header>

      <main>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "0.5rem",
          }}
        >
          <Bot size={22} style={{ color: "#6366f1" }} />
          <h2 style={{ margin: 0 }}>LLM Screening</h2>
        </div>
        <p className="muted" style={{ marginBottom: "2rem", maxWidth: 640 }}>
          Run an AI screening pass over all papers in parallel with the human workflow.
          The LLM reads each paper (using full text where available), applies your
          inclusion/exclusion criteria, and flags any themes or concepts not yet in your
          codebook. Human decisions remain primary — use this panel to review and
          selectively incorporate LLM findings.
        </p>

        {/* ── A. API Keys ─────────────────────────────────────────────────── */}
        <ApiKeysPanel
          anthropicKey={anthropicKey}
          openrouterKey={openrouterKey}
          onSaveAnthropic={(v) => saveKey("anthropic", v)}
          onSaveOpenrouter={(v) => saveKey("openrouter", v)}
        />

        {/* ── B + C + D + E: Model selection, estimate, compare, launch ────── */}
        <section
          style={{
            background: "#f8f9fa",
            border: "1px solid #dadce0",
            borderRadius: "0.5rem",
            padding: "1.25rem",
            marginBottom: "2rem",
            maxWidth: 680,
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: "1rem" }}>Model & Estimate</h3>

          {/* Model select + Compare button */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                marginBottom: "0.35rem",
                flexWrap: "wrap",
              }}
            >
              <label style={{ fontSize: "0.85rem", fontWeight: 500, color: "#3c4043" }}>
                Model
              </label>
              <button
                className="btn-ghost"
                style={{
                  fontSize: "0.78rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.25rem",
                }}
                onClick={() => setShowComparison((v) => !v)}
              >
                {showComparison ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Compare models
              </button>
            </div>

            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              style={{
                fontSize: "0.9rem",
                padding: "0.4rem 0.65rem",
                borderRadius: "0.375rem",
                border: "1px solid #dadce0",
                minWidth: 320,
              }}
            >
              {MODEL_CATALOG.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.recommended ? " ★" : ""} — {m.cost_per_1k} · {m.speed}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* Model description card */}
            <ModelDescriptionCard modelId={selectedModel} />

            {/* Comparison table */}
            {showComparison && (
              <ModelComparisonTable
                onSelectModel={(id) => {
                  setSelectedModel(id);
                  setShowComparison(false);
                }}
              />
            )}
          </div>

          {/* Estimate stats */}
          <div style={{ marginTop: "1.25rem" }}>
            {estimateLoading ? (
              <p style={{ color: "#9aa0a6", fontSize: "0.88rem" }}>Calculating estimate…</p>
            ) : estimate ? (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, 1fr)",
                    gap: "0.75rem",
                  }}
                >
                  {(
                    [
                      {
                        value: estimate.total_records.toLocaleString(),
                        label: "papers to screen",
                        color: "#3c4043",
                      },
                      {
                        value: estimate.estimated_input_tokens.toLocaleString(),
                        label: "est. input tokens",
                        color: "#3c4043",
                      },
                      {
                        value: estimate.estimated_output_tokens.toLocaleString(),
                        label: "est. output tokens",
                        color: "#3c4043",
                      },
                      {
                        value: `$${estimate.estimated_cost_usd.toFixed(2)}`,
                        label: "est. total cost",
                        color: estimate.estimated_cost_usd === 0 ? "#188038" : "#b06000",
                      },
                      {
                        value: fmtMinutes(estimate.estimated_minutes),
                        label: "est. time",
                        color: "#1a73e8",
                      },
                    ] as { value: string; label: string; color: string }[]
                  ).map(({ value, label, color }) => (
                    <div
                      key={label}
                      style={{
                        background: "#fff",
                        border: "1px solid #e8eaed",
                        borderRadius: "0.375rem",
                        padding: "0.75rem",
                      }}
                    >
                      <div style={{ fontSize: "1.2rem", fontWeight: 700, color }}>
                        {value}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#5f6368", marginTop: "0.15rem" }}>
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {/* Launch button */}
          <div style={{ marginTop: "1.25rem", display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              className="btn-primary"
              disabled={
                launch.isPending ||
                hasRunningRun ||
                (estimate?.total_records ?? 0) === 0
              }
              onClick={() => launch.mutate()}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <Play size={15} />
              {launch.isPending ? "Launching…" : "Launch LLM screening run"}
            </button>
            {hasRunningRun && (
              <span style={{ color: "#1a73e8", fontSize: "0.85rem" }}>
                A run is already in progress.
              </span>
            )}
            {(estimate?.total_records ?? 0) === 0 && !hasRunningRun && (
              <span style={{ color: "#9aa0a6", fontSize: "0.85rem" }}>
                Import records first.
              </span>
            )}
          </div>
          {launchError && (
            <p className="error" style={{ marginTop: "0.5rem" }}>
              {launchError}
            </p>
          )}
        </section>

        {/* ── F. Run history ─────────────────────────────────────────────────── */}
        <section style={{ marginBottom: "2rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              marginBottom: "0.75rem",
            }}
          >
            <h3 style={{ margin: 0 }}>Run history</h3>
            <button
              className="btn-ghost"
              onClick={() => void refetchRuns()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                fontSize: "0.8rem",
              }}
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {!displayRuns || displayRuns.length === 0 ? (
            <p className="muted">No runs yet. Launch your first LLM screening run above.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr
                    style={{
                      background: "#f1f3f4",
                      fontSize: "0.78rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "#5f6368",
                    }}
                  >
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>
                      Started
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>
                      Model
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>
                      Status
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "left", fontWeight: 600 }}>
                      Progress
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>
                      Include
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>
                      Exclude
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>
                      Uncertain
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>
                      New Concepts
                    </th>
                    <th style={{ padding: "0.5rem 0.75rem", textAlign: "right", fontWeight: 600 }}>
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayRuns.map((run) => {
                    const isSelected = selectedRun?.id === run.id;
                    const modelLabel =
                      MODEL_BY_ID[run.model]?.label ??
                      run.model.split("/").pop()?.replace(/-\d{10}$/, "") ??
                      run.model;
                    return (
                      <tr
                        key={run.id}
                        onClick={() => setSelectedRun(isSelected ? null : run)}
                        style={{
                          cursor: "pointer",
                          background: isSelected ? "#e8f0fe" : undefined,
                          borderLeft: isSelected
                            ? "3px solid #1a73e8"
                            : "3px solid transparent",
                        }}
                      >
                        <td style={{ padding: "0.55rem 0.75rem" }}>
                          {fmtDate(run.started_at ?? run.created_at)}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            color: "#5f6368",
                            fontSize: "0.78rem",
                          }}
                        >
                          {modelLabel}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem" }}>
                          {statusBadge(run.status)}
                          {run.error_message && (
                            <span
                              title={run.error_message}
                              style={{ marginLeft: "0.35rem", cursor: "help" }}
                            >
                              ⚠
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "0.55rem 0.75rem" }}>
                          {run.status === "running" || run.status === "pending" ? (
                            <span
                              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                            >
                              <ProgressBar pct={run.progress_pct} />
                              <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>
                                {run.progress_pct.toFixed(1)}%
                              </span>
                            </span>
                          ) : (
                            <span style={{ fontSize: "0.78rem", color: "#5f6368" }}>
                              {run.processed_records.toLocaleString()} /{" "}
                              {(run.total_records ?? 0).toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            textAlign: "right",
                            color: "#188038",
                            fontWeight: 600,
                          }}
                        >
                          {run.included_count}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            textAlign: "right",
                            color: "#c5221f",
                            fontWeight: 600,
                          }}
                        >
                          {run.excluded_count}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            textAlign: "right",
                            color: "#b06000",
                            fontWeight: 600,
                          }}
                        >
                          {run.uncertain_count}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            textAlign: "right",
                            color: "#6366f1",
                            fontWeight: 600,
                          }}
                        >
                          {run.new_concepts_count > 0 ? `+${run.new_concepts_count}` : "—"}
                        </td>
                        <td
                          style={{
                            padding: "0.55rem 0.75rem",
                            textAlign: "right",
                            fontSize: "0.82rem",
                            color: "#5f6368",
                          }}
                        >
                          {fmtCost(run.actual_cost_usd ?? run.estimated_cost_usd)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── G. Results for selected run ─────────────────────────────────── */}
        {selectedRun && projectId && (
          <ResultsPanel projectId={projectId} run={selectedRun} />
        )}
      </main>
    </div>
  );
}
