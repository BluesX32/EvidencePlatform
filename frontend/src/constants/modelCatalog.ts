/**
 * Shared LLM model catalog — used by LLMScreeningPage (full comparison UI)
 * and AIPilotPage (compact per-action model picker), so every AI-assisted
 * feature in the app offers the same model list instead of each page
 * hand-rolling its own subset.
 */

export interface ModelDef {
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

export interface ModelGroup {
  group: string;
  key: "anthropic_or_openrouter" | "openrouter";
  models: ModelDef[];
}

export const MODEL_CATALOG: ModelGroup[] = [
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

export const MODEL_BY_ID: Record<string, ModelDef & { groupKey: string }> = Object.fromEntries(
  MODEL_CATALOG.flatMap((g) => g.models.map((m) => [m.id, { ...m, groupKey: g.key }]))
);
