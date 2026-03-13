import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Layers, Shuffle } from "lucide-react";
import { screeningApi } from "../api/client";
import type { ScreeningSource } from "../api/client";

type Strategy = "sequential" | "mixed";

interface BucketCardDef {
  bucket: string;
  title: string;
  description: string;
  remaining: (s: ScreeningSource) => number;
}

const BUCKET_CARDS: BucketCardDef[] = [
  {
    bucket: "ta_unscreened",
    title: "Screen (Title / Abstract)",
    description: "First-pass screening — include or exclude based on title and abstract.",
    remaining: (s) => s.record_count - s.ta_screened,
  },
  {
    bucket: "ta_included",
    title: "TA Included (browse)",
    description: "Browse all title/abstract-included papers.",
    remaining: (s) => s.ta_included,
  },
  {
    bucket: "ft_pending",
    title: "Full-text Review",
    description: "TA included, full-text not yet decided.",
    remaining: (s) => s.ta_included - s.ft_screened,
  },
  {
    bucket: "ft_included",
    title: "FT Included (browse)",
    description: "Browse all full-text-included papers.",
    remaining: (s) => s.ft_included,
  },
  {
    bucket: "extract_pending",
    title: "Extract Data",
    description: "FT included, extraction not yet done.",
    remaining: (s) => s.ft_included - s.extracted_count,
  },
  {
    bucket: "extract_done",
    title: "Extracted (browse)",
    description: "Browse completed extractions.",
    remaining: (s) => s.extracted_count,
  },
];

interface Props {
  projectId: string;
  onClose: () => void;
}

// Shared card button style
const cardBtn = (selected: boolean): React.CSSProperties => ({
  textAlign: "left",
  padding: "0.85rem 1.1rem",
  border: `1.5px solid ${selected ? "#1a73e8" : "#dadce0"}`,
  borderRadius: "0.5rem",
  background: selected ? "#f0f4ff" : "#fff",
  cursor: "pointer",
  width: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
});

export default function StartScreeningModal({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>("all");
  const [seed, setSeed] = useState<string>("");
  const [showSeedHistory, setShowSeedHistory] = useState(false);

  const { data: sources, isLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId).then((r) => r.data),
  });

  const { data: seedHistory } = useQuery({
    queryKey: ["queue-history", projectId],
    queryFn: () => screeningApi.getQueueHistory(projectId).then((r) => r.data),
    enabled: showSeedHistory,
  });

  // Sort: "all" row first, then sources alphabetically
  const sortedSources = sources
    ? [
        sources.find((s) => s.id === "all")!,
        ...sources.filter((s) => s.id !== "all"),
      ].filter(Boolean)
    : [];

  function handleStrategySelect(strategy: Strategy) {
    setSelectedStrategy(strategy);
    setStep(2);
  }

  async function handleStart() {
    const seedNum = seed ? parseInt(seed, 10) : null;
    const sourceParam = selectedSource || "all";
    const stageParam = selectedStrategy === "mixed" ? "mixed" : (selectedBucket || "screen");

    try {
      // Normalize stage to backend values
      const normalizedStage =
        selectedStrategy === "mixed"
          ? "mixed"
          : stageParam === "ft_pending" || stageParam === "ft_included"
          ? "fulltext"
          : stageParam === "extract_pending" || stageParam === "extract_done"
          ? "extract"
          : "screen";
      await screeningApi.createQueue(projectId, {
        source: sourceParam,
        stage: normalizedStage,
        seed: seedNum !== null && !isNaN(seedNum) ? seedNum : null,
        reset: false,  // Resume from last unfinished paper
      });
    } catch {
      // Queue creation is best-effort; proceed anyway
    }

    const seedSuffix = seedNum !== null && !isNaN(seedNum) ? `&seed=${seedNum}` : "";
    if (selectedStrategy === "mixed") {
      navigate(
        `/projects/${projectId}/screen?strategy=mixed&source=${selectedSource}&randomize=true${seedSuffix}`
      );
    } else {
      if (!selectedBucket) return;
      navigate(
        `/projects/${projectId}/screen?strategy=sequential&bucket=${selectedBucket}&source=${selectedSource}&randomize=true${seedSuffix}`
      );
    }
    onClose();
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "0.75rem",
          padding: "2rem",
          width: "min(90vw, 600px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          position: "relative",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "1rem",
            right: "1rem",
            background: "none",
            border: "none",
            fontSize: "1.2rem",
            cursor: "pointer",
            color: "#666",
            lineHeight: 1,
          }}
          aria-label="Close"
        >
          ✕
        </button>

        {/* ── Step 1: Strategy selection ─────────────────────────────── */}
        {step === 1 && (
          <>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem", fontWeight: 700 }}>
              Start Screening
            </h2>
            <p style={{ margin: "0 0 1.5rem", color: "#5f6368", fontSize: "0.875rem" }}>
              Choose a workflow strategy to begin.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>

              {/* Sequential card */}
              <button
                style={cardBtn(false)}
                onClick={() => handleStrategySelect("sequential")}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.875rem" }}>
                  <div style={{
                    flexShrink: 0,
                    width: 36, height: 36,
                    borderRadius: "0.5rem",
                    background: "#eef2ff",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Layers size={18} color="#4f46e5" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                      <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Sequential</span>
                      <span style={{
                        fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.04em",
                        padding: "0.15rem 0.45rem", borderRadius: "999px",
                        background: "#eef2ff", color: "#4f46e5",
                        textTransform: "uppercase",
                      }}>
                        Recommended
                      </span>
                    </div>
                    <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "#374151", lineHeight: 1.5, overflowWrap: "break-word" }}>
                      Classic gated workflow. Each stage unlocks in order.
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {["Title / Abstract", "Full-text", "Extraction"].map((step, i, arr) => (
                        <span key={step} style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                          <span style={{
                            fontSize: "0.78rem", padding: "0.15rem 0.5rem",
                            border: "1px solid #e0e7ff", borderRadius: "0.3rem",
                            background: "#f5f3ff", color: "#4338ca", fontWeight: 500,
                          }}>{step}</span>
                          {i < arr.length - 1 && (
                            <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>→</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ color: "#9ca3af", flexShrink: 0, alignSelf: "center", fontSize: "1.1rem" }}>›</div>
                </div>
              </button>

              {/* Mixed / Parallel card */}
              <button
                style={cardBtn(false)}
                onClick={() => handleStrategySelect("mixed")}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.875rem" }}>
                  <div style={{
                    flexShrink: 0,
                    width: 36, height: 36,
                    borderRadius: "0.5rem",
                    background: "#ecfdf5",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Shuffle size={18} color="#059669" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                      <span style={{ fontWeight: 700, fontSize: "0.95rem" }}>Mixed / Parallel</span>
                      <span style={{
                        fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.04em",
                        padding: "0.15rem 0.45rem", borderRadius: "999px",
                        background: "#ecfdf5", color: "#059669",
                        textTransform: "uppercase",
                      }}>
                        Fast
                      </span>
                    </div>
                    <p style={{ margin: "0 0 0.6rem", fontSize: "0.85rem", color: "#374151", lineHeight: 1.5, overflowWrap: "break-word" }}>
                      Review TA and full-text in one session, back to back.
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
                      {["TA + FT in one pass", "Auto-advance on include", "Saturation tracking"].map((tag) => (
                        <span key={tag} style={{
                          fontSize: "0.78rem", padding: "0.15rem 0.5rem",
                          border: "1px solid #a7f3d0", borderRadius: "0.3rem",
                          background: "#f0fdf4", color: "#047857", fontWeight: 500,
                        }}>{tag}</span>
                      ))}
                    </div>
                  </div>
                  <div style={{ color: "#9ca3af", flexShrink: 0, alignSelf: "center", fontSize: "1.1rem" }}>›</div>
                </div>
              </button>

            </div>
          </>
        )}

        {/* ── Step 2: Source selection ───────────────────────────────── */}
        {step === 2 && (
          <>
            <button
              onClick={() => { setStep(1); setSelectedSource("all"); }}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#1a73e8",
                fontSize: "0.9rem",
                padding: 0,
                marginBottom: "1rem",
              }}
            >
              ← Back
            </button>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>
              {selectedStrategy === "mixed" ? "Mixed Screening" : "Choose Source"}
            </h2>
            <p style={{ margin: "0 0 1.25rem", color: "#5f6368", fontSize: "0.9rem" }}>
              Select which database to work with.
            </p>

            {isLoading ? (
              <p style={{ color: "#888" }}>Loading sources…</p>
            ) : sortedSources.length === 0 ? (
              <p style={{ color: "#888" }}>No records imported yet.</p>
            ) : (
              <div
                style={{
                  border: "1px solid #dadce0",
                  borderRadius: "0.5rem",
                  overflow: "hidden",
                  marginBottom: "1.25rem",
                }}
              >
                {sortedSources.map((src, i) => {
                  const isDisabled = src.record_count <= 0;
                  const isSelected = selectedSource === src.id;
                  return (
                    <label
                      key={src.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        padding: "0.75rem 1rem",
                        borderTop: i > 0 ? "1px solid #f1f3f4" : "none",
                        cursor: isDisabled ? "not-allowed" : "pointer",
                        background: isSelected ? "#e8f0fe" : "transparent",
                        opacity: isDisabled ? 0.5 : 1,
                      }}
                    >
                      <input
                        type="radio"
                        name="source"
                        value={src.id}
                        checked={isSelected}
                        disabled={isDisabled}
                        onChange={() => setSelectedSource(src.id)}
                      />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: src.id === "all" ? 600 : 400 }}>
                          {src.name}
                        </div>
                        <div style={{ fontSize: "0.82rem", color: "#5f6368" }}>
                          {src.record_count} records · {src.ta_included} TA included · {src.ft_included} FT included
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: "0.82rem",
                          color: src.record_count > 0 ? "#1a73e8" : "#888",
                        }}
                      >
                        {src.record_count > 0 ? `${src.record_count} slots` : "Empty"}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Seed section */}
            <div style={{ marginTop: 16, padding: "12px 16px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
                  Randomization seed
                </label>
                <button
                  type="button"
                  onClick={() => setShowSeedHistory(v => !v)}
                  style={{ fontSize: 12, color: "#6366f1", background: "none", border: "none", cursor: "pointer" }}
                >
                  Seed history
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number"
                  placeholder="Leave blank for random seed"
                  value={seed}
                  onChange={e => setSeed(e.target.value)}
                  style={{ flex: 1, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 }}
                />
              </div>
              <p style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
                Enter a specific number to reproduce a colleague's paper order.
              </p>
              {showSeedHistory && seedHistory && seedHistory.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  {seedHistory.map((h, i) => (
                    <div
                      key={i}
                      style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #f3f4f6", cursor: "pointer", color: "#6366f1" }}
                      onClick={() => setSeed(String(h.seed))}
                    >
                      <span>Seed {h.seed} — {h.stage} / {h.source_id}</span>
                      <span style={{ color: "#9ca3af" }}>{new Date(h.created_at).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              {selectedStrategy === "mixed" ? (
                <button
                  className="btn-primary"
                  onClick={handleStart}
                  disabled={!selectedSource}
                >
                  Start →
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={() => setStep(3)}
                  disabled={!selectedSource}
                >
                  Next →
                </button>
              )}
            </div>
          </>
        )}

        {/* ── Step 3: Bucket selection (Sequential only) ──────────────── */}
        {step === 3 && selectedStrategy === "sequential" && (
          <>
            <button
              onClick={() => setStep(2)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#1a73e8",
                fontSize: "0.9rem",
                padding: 0,
                marginBottom: "1rem",
              }}
            >
              ← Back
            </button>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>Choose Task</h2>
            <p style={{ margin: "0 0 1.25rem", color: "#5f6368", fontSize: "0.9rem" }}>
              What would you like to do in this session?
            </p>

            {/* Source context pill */}
            {selectedSource && sortedSources.length > 0 && (
              <div
                style={{
                  display: "inline-block",
                  background: "#f1f3f4",
                  borderRadius: "1rem",
                  padding: "0.2rem 0.75rem",
                  fontSize: "0.82rem",
                  color: "#5f6368",
                  marginBottom: "1rem",
                }}
              >
                {sortedSources.find((s) => s.id === selectedSource)?.name ?? selectedSource}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {BUCKET_CARDS.map((card) => {
                const src = sortedSources.find((s) => s.id === selectedSource);
                const rem = src ? card.remaining(src) : 0;
                const isSelected = selectedBucket === card.bucket;
                return (
                  <button
                    key={card.bucket}
                    onClick={() => setSelectedBucket(card.bucket)}
                    style={{ ...cardBtn(isSelected) }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: "0.2rem", fontSize: "0.9rem" }}>
                          {card.title}
                        </div>
                        <div style={{ fontSize: "0.82rem", color: "#5f6368" }}>
                          {card.description}
                        </div>
                      </div>
                      {src && (
                        <span
                          style={{
                            marginLeft: "1rem",
                            flexShrink: 0,
                            fontSize: "0.8rem",
                            color: rem > 0 ? "#1a73e8" : "#888",
                            fontWeight: rem > 0 ? 600 : 400,
                          }}
                        >
                          {rem}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
              <button
                className="btn-primary"
                onClick={handleStart}
                disabled={!selectedBucket}
              >
                Start →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
