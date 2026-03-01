import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  corporaApi,
  type Corpus,
  type CorpusDecision,
  type BorderlineCase,
  type CorpusExtraction,
  type ExtractionJson,
} from "../api/client";
import { TermList } from "../components/TermList";

type Tab = "screen" | "fulltext" | "extract" | "committee";

const EXCLUDE_REASONS = [
  { value: "irrelevant", label: "Irrelevant" },
  { value: "wrong_population", label: "Wrong population" },
  { value: "wrong_design", label: "Wrong design" },
  { value: "duplicate", label: "Duplicate" },
  { value: "language", label: "Language" },
  { value: "other", label: "Other" },
];

function emptyExtraction(): ExtractionJson {
  return {
    severity_terms: [],
    framework_terms: [],
    relationship_terms: [],
    context: { disease: "", setting: "", population: "", notes: "" },
    novelty_flag: true,
    novelty_notes: "",
  };
}

export default function ScreeningPage() {
  const { id: projectId, corpus_id: corpusId } = useParams<{
    id: string;
    corpus_id: string;
  }>();
  const [tab, setTab] = useState<Tab>("screen");

  return (
    <div style={{ maxWidth: 960, margin: "2rem auto", padding: "0 1rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1.25rem" }}>
        <Link to={`/projects/${projectId}/corpora`} style={{ color: "#1a73e8" }}>
          ← Corpora
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>Screening</h1>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: "2px solid #e0e0e0", marginBottom: "1.5rem" }}>
        {(["screen", "fulltext", "extract", "committee"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = {
            screen: "Screen (TA)",
            fulltext: "Full-Text",
            extract: "Extract",
            committee: "Committee",
          };
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "0.6rem 1.25rem",
                border: "none",
                borderBottom: tab === t ? "3px solid #1a73e8" : "3px solid transparent",
                background: "none",
                cursor: "pointer",
                color: tab === t ? "#1a73e8" : "#555",
                fontWeight: tab === t ? 600 : 400,
                fontSize: "0.9rem",
                marginBottom: -2,
              }}
            >
              {labels[t]}
            </button>
          );
        })}
      </div>

      {tab === "screen" && <ScreenTab projectId={projectId!} corpusId={corpusId!} />}
      {tab === "fulltext" && <FullTextTab projectId={projectId!} corpusId={corpusId!} />}
      {tab === "extract" && <ExtractTab projectId={projectId!} corpusId={corpusId!} />}
      {tab === "committee" && <CommitteeTab projectId={projectId!} corpusId={corpusId!} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Screen (TA)
// ---------------------------------------------------------------------------

function ScreenTab({ projectId, corpusId }: { projectId: string; corpusId: string }) {
  const qc = useQueryClient();
  const [excludeOpen, setExcludeOpen] = useState(false);

  const { data: corpus } = useQuery({
    queryKey: ["corpus", projectId, corpusId],
    queryFn: () => corporaApi.get(projectId, corpusId).then((r) => r.data),
  });

  const { data: nextData, isLoading } = useQuery({
    queryKey: ["corpus-next", projectId, corpusId],
    queryFn: () => corporaApi.nextItem(projectId, corpusId).then((r) => r.data),
  });

  const decisionMutation = useMutation({
    mutationFn: (body: {
      decision: "include" | "exclude" | "borderline";
      reason_code?: string;
    }) =>
      corporaApi.submitDecision(projectId, corpusId, {
        canonical_key: nextData!.canonical_key!,
        stage: "TA",
        decision: body.decision,
        reason_code: body.reason_code,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["corpus-next", projectId, corpusId] });
      qc.invalidateQueries({ queryKey: ["corpus", projectId, corpusId] });
      setExcludeOpen(false);
    },
  });

  if (isLoading) return <p style={{ color: "#888" }}>Loading next item…</p>;

  return (
    <div>
      {/* Saturation bar */}
      {corpus && <SaturationBar corpus={corpus} />}

      {nextData?.done ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            border: "1px dashed #ccc",
            borderRadius: 8,
            color: "#555",
          }}
        >
          <div style={{ fontSize: "2rem" }}>✓</div>
          <div style={{ fontWeight: 600, marginTop: "0.5rem" }}>No more items to screen</div>
          <div style={{ fontSize: "0.875rem", color: "#888", marginTop: "0.25rem" }}>
            All papers in this corpus have been screened at the title/abstract stage.
          </div>
        </div>
      ) : nextData ? (
        <div>
          {/* Progress */}
          <div style={{ fontSize: "0.85rem", color: "#888", marginBottom: "0.75rem" }}>
            Item {nextData.position} of {nextData.total}
          </div>

          {/* Paper card */}
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: "1.25rem",
              marginBottom: "1rem",
              background: "#fff",
            }}
          >
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>
              {nextData.title ?? <span style={{ color: "#aaa" }}>No title</span>}
            </h2>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
                fontSize: "0.85rem",
                color: "#555",
                marginBottom: "0.75rem",
              }}
            >
              {nextData.year && <span>{nextData.year}</span>}
              {nextData.doi && (
                <span style={{ fontFamily: "monospace" }}>{nextData.doi}</span>
              )}
              {(nextData.source_names ?? []).map((s) => (
                <span
                  key={s}
                  style={{
                    background: "#e8f0fe",
                    color: "#1a73e8",
                    borderRadius: 12,
                    padding: "0.1rem 0.5rem",
                    fontSize: "0.8rem",
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
            {nextData.authors && (
              <div style={{ fontSize: "0.875rem", color: "#444", marginBottom: "0.75rem" }}>
                {Array.isArray(nextData.authors)
                  ? nextData.authors.join("; ")
                  : nextData.authors}
              </div>
            )}
            {nextData.abstract ? (
              <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.6, color: "#333" }}>
                {nextData.abstract}
              </p>
            ) : (
              <p style={{ margin: 0, color: "#aaa", fontStyle: "italic" }}>No abstract</p>
            )}
          </div>

          {/* Decision buttons */}
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => decisionMutation.mutate({ decision: "include" })}
              disabled={decisionMutation.isPending}
              style={btnStyle("#2e7d32")}
            >
              Include
            </button>

            <div style={{ position: "relative" }}>
              <button
                onClick={() => setExcludeOpen((o) => !o)}
                disabled={decisionMutation.isPending}
                style={btnStyle("#c00")}
              >
                Exclude ▾
              </button>
              {excludeOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "110%",
                    left: 0,
                    background: "#fff",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    zIndex: 10,
                    minWidth: 200,
                  }}
                >
                  {EXCLUDE_REASONS.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => {
                        decisionMutation.mutate({
                          decision: "exclude",
                          reason_code: r.value,
                        });
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "0.5rem 0.75rem",
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        fontSize: "0.875rem",
                      }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={() => decisionMutation.mutate({ decision: "borderline" })}
              disabled={decisionMutation.isPending}
              style={btnStyle("#e65100")}
            >
              Borderline
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Full-Text
// ---------------------------------------------------------------------------

function FullTextTab({ projectId, corpusId }: { projectId: string; corpusId: string }) {
  const qc = useQueryClient();
  const [expandedExclude, setExpandedExclude] = useState<string | null>(null);

  const { data: decisions = [] } = useQuery({
    queryKey: ["corpus-decisions-ta", projectId, corpusId],
    queryFn: () =>
      corporaApi
        .listDecisions(projectId, corpusId, { stage: "TA" })
        .then((r) => r.data),
  });

  const ftDecisionMutation = useMutation({
    mutationFn: ({
      key,
      decision,
      reason_code,
    }: {
      key: string;
      decision: "include" | "exclude";
      reason_code?: string;
    }) =>
      corporaApi.submitDecision(projectId, corpusId, {
        canonical_key: key,
        stage: "FT",
        decision,
        reason_code,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["corpus-decisions-ta", projectId, corpusId] });
      qc.invalidateQueries({ queryKey: ["corpus-decisions-ft", projectId, corpusId] });
      setExpandedExclude(null);
    },
  });

  // Get FT decisions to know which TA-included papers are still pending
  const { data: ftDecisions = [] } = useQuery({
    queryKey: ["corpus-decisions-ft", projectId, corpusId],
    queryFn: () =>
      corporaApi
        .listDecisions(projectId, corpusId, { stage: "FT" })
        .then((r) => r.data),
  });

  const taIncluded = decisions.filter(
    (d: CorpusDecision) => d.decision === "include"
  );
  // Deduplicate by canonical_key (keep latest)
  const taIncludedUniq = Array.from(
    new Map(taIncluded.map((d: CorpusDecision) => [d.canonical_key, d])).values()
  );

  return (
    <div>
      <h3 style={{ margin: "0 0 1rem" }}>TA-Included Papers</h3>
      {taIncludedUniq.length === 0 ? (
        <p style={{ color: "#888" }}>No TA-included papers yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #ddd", textAlign: "left" }}>
              <th style={thStyle}>Canonical Key</th>
              <th style={thStyle}>FT Status</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {taIncludedUniq.map((d: CorpusDecision) => {
              const ftDec = ftDecisions.find(
                (f: CorpusDecision) => f.canonical_key === d.canonical_key
              );
              return (
                <tr key={d.canonical_key} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={tdStyle}>
                    <code style={{ fontSize: "0.8rem" }}>{d.canonical_key}</code>
                  </td>
                  <td style={tdStyle}>
                    {ftDec ? (
                      <span
                        style={{
                          color: ftDec.decision === "include" ? "#2e7d32" : "#c00",
                          fontWeight: 600,
                        }}
                      >
                        {ftDec.decision}
                      </span>
                    ) : (
                      <span style={{ color: "#888" }}>Pending</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {!ftDec && (
                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          onClick={() =>
                            ftDecisionMutation.mutate({
                              key: d.canonical_key,
                              decision: "include",
                            })
                          }
                          style={{ ...smallBtn, background: "#2e7d32", color: "#fff" }}
                        >
                          Proceed to Extraction
                        </button>
                        <div style={{ position: "relative" }}>
                          <button
                            onClick={() =>
                              setExpandedExclude(
                                expandedExclude === d.canonical_key ? null : d.canonical_key
                              )
                            }
                            style={{ ...smallBtn, background: "#c00", color: "#fff" }}
                          >
                            Exclude at FT ▾
                          </button>
                          {expandedExclude === d.canonical_key && (
                            <div
                              style={{
                                position: "absolute",
                                top: "110%",
                                left: 0,
                                background: "#fff",
                                border: "1px solid #ccc",
                                borderRadius: 6,
                                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                                zIndex: 10,
                                minWidth: 200,
                              }}
                            >
                              {EXCLUDE_REASONS.map((r) => (
                                <button
                                  key={r.value}
                                  onClick={() =>
                                    ftDecisionMutation.mutate({
                                      key: d.canonical_key,
                                      decision: "exclude",
                                      reason_code: r.value,
                                    })
                                  }
                                  style={{
                                    display: "block",
                                    width: "100%",
                                    textAlign: "left",
                                    padding: "0.5rem 0.75rem",
                                    border: "none",
                                    background: "none",
                                    cursor: "pointer",
                                    fontSize: "0.875rem",
                                  }}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Extract
// ---------------------------------------------------------------------------

function ExtractTab({ projectId, corpusId }: { projectId: string; corpusId: string }) {
  const qc = useQueryClient();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [form, setForm] = useState<ExtractionJson>(emptyExtraction());

  const { data: ftDecisions = [] } = useQuery({
    queryKey: ["corpus-decisions-ft-include", projectId, corpusId],
    queryFn: () =>
      corporaApi
        .listDecisions(projectId, corpusId, { stage: "FT" })
        .then((r) => r.data.filter((d: CorpusDecision) => d.decision === "include")),
  });

  const { data: extractions = [] } = useQuery({
    queryKey: ["corpus-extractions", projectId, corpusId],
    queryFn: () => corporaApi.listExtractions(projectId, corpusId).then((r) => r.data),
  });

  const extractedKeys = new Set(extractions.map((e: CorpusExtraction) => e.canonical_key));
  const ftIncludedUniq = Array.from(
    new Map(
      ftDecisions.map((d: CorpusDecision) => [d.canonical_key, d])
    ).values()
  );

  const saveMutation = useMutation({
    mutationFn: (key: string) =>
      corporaApi.submitExtraction(projectId, corpusId, {
        canonical_key: key,
        extracted_json: form,
        novelty_flag: form.novelty_flag,
        novelty_notes: form.novelty_notes || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["corpus-extractions", projectId, corpusId] });
      qc.invalidateQueries({ queryKey: ["corpus", projectId, corpusId] });
      setExpandedKey(null);
      setForm(emptyExtraction());
    },
  });

  const openExtract = (key: string) => {
    setExpandedKey(key);
    const existing = extractions.find((e: CorpusExtraction) => e.canonical_key === key);
    setForm(existing ? existing.extracted_json : emptyExtraction());
  };

  return (
    <div>
      <h3 style={{ margin: "0 0 1rem" }}>FT-Included Papers</h3>
      {ftIncludedUniq.length === 0 ? (
        <p style={{ color: "#888" }}>No papers passed full-text screening yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {ftIncludedUniq.map((d: CorpusDecision) => {
            const extracted = extractedKeys.has(d.canonical_key);
            const isExpanded = expandedKey === d.canonical_key;
            return (
              <div
                key={d.canonical_key}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.75rem 1rem",
                    background: "#fafafa",
                  }}
                >
                  <div>
                    <code style={{ fontSize: "0.8rem" }}>{d.canonical_key}</code>
                    {extracted && (
                      <span
                        style={{
                          marginLeft: "0.75rem",
                          color: "#2e7d32",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                        }}
                      >
                        ✓ Extracted
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      isExpanded ? setExpandedKey(null) : openExtract(d.canonical_key)
                    }
                    style={{ ...smallBtn, background: "#1a73e8", color: "#fff" }}
                  >
                    {isExpanded ? "Close" : extracted ? "Re-extract" : "Extract"}
                  </button>
                </div>

                {isExpanded && (
                  <div style={{ padding: "1rem", borderTop: "1px solid #eee" }}>
                    <TermList
                      label="Severity Terms"
                      items={form.severity_terms}
                      onChange={(items) => setForm((f) => ({ ...f, severity_terms: items }))}
                    />
                    <TermList
                      label="Framework Terms"
                      items={form.framework_terms}
                      onChange={(items) => setForm((f) => ({ ...f, framework_terms: items }))}
                    />
                    <TermList
                      label="Relationship Terms"
                      items={form.relationship_terms}
                      onChange={(items) =>
                        setForm((f) => ({ ...f, relationship_terms: items }))
                      }
                    />

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
                      {(["disease", "setting", "population", "notes"] as const).map((field) => (
                        <div key={field}>
                          <label style={labelStyle}>
                            {field.charAt(0).toUpperCase() + field.slice(1)}
                          </label>
                          <input
                            type="text"
                            value={form.context[field]}
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                context: { ...f.context, [field]: e.target.value },
                              }))
                            }
                            style={inputStyle}
                          />
                        </div>
                      ))}
                    </div>

                    <div style={{ marginBottom: "0.75rem" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={form.novelty_flag}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, novelty_flag: e.target.checked }))
                          }
                        />
                        <span style={{ fontWeight: 500 }}>New concepts found?</span>
                      </label>
                      {form.novelty_flag && (
                        <input
                          type="text"
                          placeholder="Describe the novel concepts…"
                          value={form.novelty_notes}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, novelty_notes: e.target.value }))
                          }
                          style={{ ...inputStyle, marginTop: "0.4rem" }}
                        />
                      )}
                    </div>

                    <button
                      onClick={() => saveMutation.mutate(d.canonical_key)}
                      disabled={saveMutation.isPending}
                      style={btnStyle("#1a73e8")}
                    >
                      {saveMutation.isPending ? "Saving…" : "Save & Continue"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Committee (borderline cases)
// ---------------------------------------------------------------------------

function CommitteeTab({ projectId, corpusId }: { projectId: string; corpusId: string }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data: cases = [] } = useQuery({
    queryKey: ["corpus-borderline", projectId, corpusId],
    queryFn: () =>
      corporaApi.listBorderline(projectId, corpusId, "open").then((r) => r.data),
  });

  const resolveMutation = useMutation({
    mutationFn: ({
      caseId,
      decision,
    }: {
      caseId: string;
      decision: "include" | "exclude";
      canonical_key: string;
    }) =>
      corporaApi.resolveBorderline(projectId, corpusId, caseId, {
        resolution_decision: decision,
        resolution_notes: notes[caseId] || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["corpus-borderline", projectId, corpusId] });
    },
  });

  return (
    <div>
      <h3 style={{ margin: "0 0 1rem" }}>Open Borderline Cases</h3>
      {cases.length === 0 ? (
        <p style={{ color: "#888" }}>No open borderline cases.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {cases.map((c: BorderlineCase) => (
            <div
              key={c.id}
              style={{
                border: "1px solid #f0c070",
                borderRadius: 8,
                padding: "1rem",
                background: "#fffdf0",
              }}
            >
              <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                  <code style={{ fontSize: "0.8rem" }}>{c.canonical_key}</code>
                  <span
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.8rem",
                      background: "#e0e0e0",
                      borderRadius: 8,
                      padding: "0.1rem 0.4rem",
                    }}
                  >
                    {c.stage}
                  </span>
                  <div style={{ marginTop: "0.5rem" }}>
                    <input
                      type="text"
                      placeholder="Committee notes…"
                      value={notes[c.id] ?? ""}
                      onChange={(e) =>
                        setNotes((n) => ({ ...n, [c.id]: e.target.value }))
                      }
                      style={{ ...inputStyle, maxWidth: 400 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    onClick={() =>
                      resolveMutation.mutate({
                        caseId: c.id,
                        decision: "include",
                        canonical_key: c.canonical_key,
                      })
                    }
                    style={{ ...smallBtn, background: "#2e7d32", color: "#fff" }}
                  >
                    Include
                  </button>
                  <button
                    onClick={() =>
                      resolveMutation.mutate({
                        caseId: c.id,
                        decision: "exclude",
                        canonical_key: c.canonical_key,
                      })
                    }
                    style={{ ...smallBtn, background: "#c00", color: "#fff" }}
                  >
                    Exclude
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saturation widget
// ---------------------------------------------------------------------------

function SaturationBar({ corpus }: { corpus: Corpus }) {
  const { consecutive_no_novelty, saturation_threshold, total_extracted, stopped_at } = corpus;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.6rem 1rem",
        background: stopped_at ? "#e8f5e9" : "#f5f5f5",
        borderRadius: 8,
        marginBottom: "1rem",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        {/* Block progress */}
        {Array.from({ length: saturation_threshold }).map((_, i) => (
          <div
            key={i}
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: i < consecutive_no_novelty ? "#1a73e8" : "#ccc",
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: "0.875rem", color: "#444" }}>
        {consecutive_no_novelty} / {saturation_threshold} consecutive non-novel
      </span>
      <span style={{ fontSize: "0.875rem", color: "#666" }}>
        {total_extracted} extracted
      </span>
      {stopped_at ? (
        <span style={{ color: "#2e7d32", fontWeight: 600, fontSize: "0.875rem" }}>
          Saturated — stopping rule fired
        </span>
      ) : (
        <span style={{ color: "#1a73e8", fontSize: "0.875rem" }}>Continue</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const btnStyle = (bg: string): React.CSSProperties => ({
  padding: "0.5rem 1.25rem",
  background: bg,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: "0.9rem",
});

const smallBtn: React.CSSProperties = {
  padding: "0.3rem 0.75rem",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.8rem",
  fontWeight: 500,
};

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  fontWeight: 600,
  fontSize: "0.85rem",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.875rem",
  verticalAlign: "middle",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 500,
  marginBottom: "0.2rem",
  fontSize: "0.85rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.875rem",
  boxSizing: "border-box",
};
