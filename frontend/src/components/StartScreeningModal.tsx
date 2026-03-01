import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { screeningApi } from "../api/client";
import type { ScreeningSource } from "../api/client";

type ScreeningMode = "screen" | "fulltext" | "extract";
type Strategy = "sequential" | "mixed";

interface ModeCardDef {
  mode: ScreeningMode;
  title: string;
  description: string;
  countLabel: (s: ScreeningSource) => string;
  remaining: (s: ScreeningSource) => number;
}

const MODE_CARDS: ModeCardDef[] = [
  {
    mode: "screen",
    title: "Screen (Title / Abstract)",
    description: "First-pass screening — include or exclude based on title and abstract.",
    countLabel: (s) => `${s.record_count} total · ${s.record_count - s.ta_screened} unscreened`,
    remaining: (s) => s.record_count - s.ta_screened,
  },
  {
    mode: "fulltext",
    title: "Full-text Review",
    description: "Review full texts of title/abstract-included papers.",
    countLabel: (s) => `${s.ta_included} eligible · ${s.ta_included - s.ft_screened} pending`,
    remaining: (s) => s.ta_included - s.ft_screened,
  },
  {
    mode: "extract",
    title: "Extract Data",
    description: "Conceptual extraction from full-text-included papers.",
    countLabel: (s) => `${s.ft_included} eligible · ${s.ft_included - s.extracted_count} pending`,
    remaining: (s) => s.ft_included - s.extracted_count,
  },
];

interface Props {
  projectId: string;
  onClose: () => void;
}

// Shared card button style
const cardBtn = (selected: boolean): React.CSSProperties => ({
  textAlign: "left",
  padding: "1rem 1.25rem",
  border: `1.5px solid ${selected ? "#1a73e8" : "#dadce0"}`,
  borderRadius: "0.5rem",
  background: selected ? "#f0f4ff" : "#fff",
  cursor: "pointer",
  width: "100%",
});

export default function StartScreeningModal({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [selectedMode, setSelectedMode] = useState<ScreeningMode | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>("all");

  const { data: sources, isLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId).then((r) => r.data),
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

  function handleStart() {
    if (selectedStrategy === "mixed") {
      navigate(
        `/projects/${projectId}/screen?strategy=mixed&mode=mixed&source=${selectedSource}`
      );
    } else {
      if (!selectedMode) return;
      navigate(
        `/projects/${projectId}/screen?strategy=sequential&mode=${selectedMode}&source=${selectedSource}`
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
          width: "min(90vw, 580px)",
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
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>Start Screening</h2>
            <p style={{ margin: "0 0 1.5rem", color: "#5f6368", fontSize: "0.9rem" }}>
              Choose a workflow strategy.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <button
                style={cardBtn(false)}
                onClick={() => handleStrategySelect("sequential")}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                  Sequential
                </div>
                <div style={{ fontSize: "0.85rem", color: "#5f6368" }}>
                  Classic gating: Title/Abstract first, then Full-text, then Extraction.
                  Each stage unlocks after the previous.
                </div>
              </button>
              <button
                style={cardBtn(false)}
                onClick={() => handleStrategySelect("mixed")}
              >
                <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                  Mixed / Parallel
                </div>
                <div style={{ fontSize: "0.85rem", color: "#5f6368" }}>
                  Saturation-driven: screen title/abstract and review full-text in the
                  same session. Include at TA, then immediately decide on full-text —
                  no waiting.
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

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
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

        {/* ── Step 3: Mode selection (Sequential only) ───────────────── */}
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
            <p style={{ margin: "0 0 1.5rem", color: "#5f6368", fontSize: "0.9rem" }}>
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

            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {MODE_CARDS.map((card) => {
                const src = sortedSources.find((s) => s.id === selectedSource);
                const rem = src ? card.remaining(src) : 0;
                const isDisabled = rem <= 0;
                const isSelected = selectedMode === card.mode;
                return (
                  <button
                    key={card.mode}
                    onClick={() => !isDisabled && setSelectedMode(card.mode)}
                    disabled={isDisabled}
                    style={{
                      ...cardBtn(isSelected),
                      opacity: isDisabled ? 0.5 : 1,
                      cursor: isDisabled ? "not-allowed" : "pointer",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                          {card.title}
                        </div>
                        <div style={{ fontSize: "0.85rem", color: "#5f6368" }}>
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
                          {rem > 0 ? `${rem} pending` : "Done"}
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
                disabled={!selectedMode}
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
