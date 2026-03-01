import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { screeningApi } from "../api/client";
import type { ScreeningSource } from "../api/client";

type ScreeningMode = "screen" | "fulltext" | "extract";

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

export default function StartScreeningModal({ projectId, onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedMode, setSelectedMode] = useState<ScreeningMode | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>("all");

  const { data: sources, isLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId).then((r) => r.data),
  });

  const modeDef = MODE_CARDS.find((m) => m.mode === selectedMode);

  function handleModeSelect(mode: ScreeningMode) {
    setSelectedMode(mode);
    setStep(2);
  }

  function handleStart() {
    if (!selectedMode) return;
    navigate(`/projects/${projectId}/screen?mode=${selectedMode}&source=${selectedSource}`);
    onClose();
  }

  // Sort: "all" row first, then sources alphabetically
  const sortedSources = sources
    ? [
        sources.find((s) => s.id === "all")!,
        ...sources.filter((s) => s.id !== "all"),
      ].filter(Boolean)
    : [];

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
          width: "min(90vw, 560px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          position: "relative",
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

        {/* ── Step 1: Mode selection ─────────────────────────────────── */}
        {step === 1 && (
          <>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>Start Screening</h2>
            <p style={{ margin: "0 0 1.5rem", color: "#5f6368", fontSize: "0.9rem" }}>
              Choose what you want to do.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {MODE_CARDS.map((card) => (
                <button
                  key={card.mode}
                  onClick={() => handleModeSelect(card.mode)}
                  style={{
                    textAlign: "left",
                    padding: "1rem 1.25rem",
                    border: "1.5px solid #dadce0",
                    borderRadius: "0.5rem",
                    background: "#fff",
                    cursor: "pointer",
                    transition: "border-color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "#1a73e8";
                    (e.currentTarget as HTMLButtonElement).style.background = "#f8f9ff";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "#dadce0";
                    (e.currentTarget as HTMLButtonElement).style.background = "#fff";
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{card.title}</div>
                  <div style={{ fontSize: "0.85rem", color: "#5f6368" }}>{card.description}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ── Step 2: Source selection ───────────────────────────────── */}
        {step === 2 && modeDef && (
          <>
            <button
              onClick={() => setStep(1)}
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
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>{modeDef.title}</h2>
            <p style={{ margin: "0 0 1.25rem", color: "#5f6368", fontSize: "0.9rem" }}>
              Select which database to screen.
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
                  const rem = modeDef.remaining(src);
                  const isDisabled = rem <= 0;
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
                          {modeDef.countLabel(src)}
                        </div>
                      </div>
                      {rem > 0 && (
                        <span
                          style={{
                            background: "#e8f0fe",
                            color: "#1a73e8",
                            borderRadius: "1rem",
                            padding: "0.15rem 0.6rem",
                            fontSize: "0.8rem",
                            fontWeight: 600,
                          }}
                        >
                          {rem} remaining
                        </span>
                      )}
                      {rem === 0 && (
                        <span style={{ fontSize: "0.82rem", color: "#888" }}>Done</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                className="btn-primary"
                onClick={handleStart}
                disabled={!selectedSource}
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
