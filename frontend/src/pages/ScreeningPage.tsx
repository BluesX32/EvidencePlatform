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
  type Snippet,
} from "../api/client";

type Tab = "screen" | "fulltext" | "extract" | "committee";

const EXCLUDE_REASONS = [
  { value: "irrelevant", label: "Irrelevant" },
  { value: "wrong_population", label: "Wrong population" },
  { value: "wrong_design", label: "Wrong design" },
  { value: "duplicate", label: "Duplicate" },
  { value: "language", label: "Language" },
  { value: "other", label: "Other" },
];

const LEVELS = [
  "gene",
  "molecular",
  "cellular",
  "tissue/organ",
  "patient/clinical",
  "population",
  "societal",
];

const DIMENSIONS = ["objective", "subjective", "societal"];

function emptyExtraction(): ExtractionJson {
  return {
    levels: [],
    dimensions: [],
    snippets: [],
    free_note: "",
    framework_updated: true,
    framework_update_note: "",
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

  const invalidateNext = () => {
    qc.invalidateQueries({ queryKey: ["corpus-next", projectId, corpusId] });
    qc.invalidateQueries({ queryKey: ["corpus", projectId, corpusId] });
  };

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
      invalidateNext();
      setExcludeOpen(false);
    },
  });

  const skipMutation = useMutation({
    mutationFn: () =>
      corporaApi.skipItem(projectId, corpusId, nextData!.canonical_key!),
    onSuccess: () => invalidateNext(),
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
            All papers in this corpus have been reviewed at the title/abstract stage.
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
              disabled={decisionMutation.isPending || skipMutation.isPending}
              style={btnStyle("#2e7d32")}
            >
              Include
            </button>

            <div style={{ position: "relative" }}>
              <button
                onClick={() => setExcludeOpen((o) => !o)}
                disabled={decisionMutation.isPending || skipMutation.isPending}
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
                      onClick={() =>
                        decisionMutation.mutate({ decision: "exclude", reason_code: r.value })
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

            <button
              onClick={() => decisionMutation.mutate({ decision: "borderline" })}
              disabled={decisionMutation.isPending || skipMutation.isPending}
              style={btnStyle("#e65100")}
            >
              Borderline
            </button>

            <button
              onClick={() => skipMutation.mutate()}
              disabled={decisionMutation.isPending || skipMutation.isPending}
              style={{
                padding: "0.5rem 1rem",
                background: "none",
                color: "#888",
                border: "1px solid #ccc",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Skip
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
      corporaApi.listDecisions(projectId, corpusId, { stage: "TA" }).then((r) => r.data),
  });

  const { data: ftDecisions = [] } = useQuery({
    queryKey: ["corpus-decisions-ft", projectId, corpusId],
    queryFn: () =>
      corporaApi.listDecisions(projectId, corpusId, { stage: "FT" }).then((r) => r.data),
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

  const taIncluded = decisions.filter((d: CorpusDecision) => d.decision === "include");
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
                            ftDecisionMutation.mutate({ key: d.canonical_key, decision: "include" })
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
// Tab 3: Extract (conceptual framework form)
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
    new Map(ftDecisions.map((d: CorpusDecision) => [d.canonical_key, d])).values()
  );

  const saveMutation = useMutation({
    mutationFn: (key: string) =>
      corporaApi.submitExtraction(projectId, corpusId, {
        canonical_key: key,
        extracted_json: form,
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
    setForm(existing ? { ...emptyExtraction(), ...existing.extracted_json } : emptyExtraction());
  };

  const toggleChip = (field: "levels" | "dimensions", value: string) => {
    setForm((f) => {
      const arr = f[field];
      return {
        ...f,
        [field]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value],
      };
    });
  };

  const addSnippet = () =>
    setForm((f) => ({
      ...f,
      snippets: [...f.snippets, { snippet: "", note: "", tag: "" }],
    }));

  const updateSnippet = (idx: number, patch: Partial<Snippet>) =>
    setForm((f) => ({
      ...f,
      snippets: f.snippets.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));

  const removeSnippet = (idx: number) =>
    setForm((f) => ({ ...f, snippets: f.snippets.filter((_, i) => i !== idx) }));

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
                style={{ border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}
              >
                {/* Row header */}
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

                {/* Extraction form */}
                {isExpanded && (
                  <div style={{ padding: "1rem", borderTop: "1px solid #eee" }}>

                    {/* Levels */}
                    <div style={{ marginBottom: "0.875rem" }}>
                      <label style={labelStyle}>Levels of analysis</label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.25rem" }}>
                        {LEVELS.map((lv) => (
                          <button
                            key={lv}
                            onClick={() => toggleChip("levels", lv)}
                            style={chipStyle(form.levels.includes(lv))}
                          >
                            {lv}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Dimensions */}
                    <div style={{ marginBottom: "0.875rem" }}>
                      <label style={labelStyle}>Dimensions</label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.25rem" }}>
                        {DIMENSIONS.map((dim) => (
                          <button
                            key={dim}
                            onClick={() => toggleChip("dimensions", dim)}
                            style={chipStyle(form.dimensions.includes(dim))}
                          >
                            {dim}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Snippets */}
                    <div style={{ marginBottom: "0.875rem" }}>
                      <label style={labelStyle}>Snippets</label>
                      {form.snippets.map((snip, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "2fr 1fr 1fr auto",
                            gap: "0.4rem",
                            marginBottom: "0.4rem",
                            alignItems: "center",
                          }}
                        >
                          <input
                            placeholder="Snippet text…"
                            value={snip.snippet}
                            onChange={(e) => updateSnippet(idx, { snippet: e.target.value })}
                            style={inputStyle}
                          />
                          <input
                            placeholder="Note"
                            value={snip.note}
                            onChange={(e) => updateSnippet(idx, { note: e.target.value })}
                            style={inputStyle}
                          />
                          <input
                            placeholder="Tag (optional)"
                            value={snip.tag ?? ""}
                            onChange={(e) => updateSnippet(idx, { tag: e.target.value })}
                            style={inputStyle}
                          />
                          <button
                            onClick={() => removeSnippet(idx)}
                            style={{
                              background: "none",
                              border: "none",
                              color: "#c00",
                              cursor: "pointer",
                              fontSize: "1rem",
                              padding: "0 0.25rem",
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={addSnippet}
                        style={{
                          background: "none",
                          border: "1px dashed #aaa",
                          borderRadius: 4,
                          color: "#555",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          padding: "0.25rem 0.6rem",
                          marginTop: "0.25rem",
                        }}
                      >
                        + Add snippet
                      </button>
                    </div>

                    {/* Free note */}
                    <div style={{ marginBottom: "0.875rem" }}>
                      <label style={labelStyle}>Free note</label>
                      <textarea
                        rows={3}
                        value={form.free_note}
                        onChange={(e) => setForm((f) => ({ ...f, free_note: e.target.value }))}
                        placeholder="Observations, context, emerging concepts…"
                        style={{ ...inputStyle, resize: "vertical" }}
                      />
                    </div>

                    {/* Framework updated? */}
                    <div style={{ marginBottom: "1rem" }}>
                      <label style={labelStyle}>Did this paper update the framework?</label>
                      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
                        <button
                          onClick={() =>
                            setForm((f) => ({ ...f, framework_updated: true, framework_update_note: "" }))
                          }
                          style={chipStyle(form.framework_updated)}
                        >
                          Yes — new concepts found
                        </button>
                        <button
                          onClick={() => setForm((f) => ({ ...f, framework_updated: false }))}
                          style={chipStyle(!form.framework_updated)}
                        >
                          No — no new concepts
                        </button>
                      </div>
                      {!form.framework_updated && (
                        <input
                          type="text"
                          placeholder="Why not? (optional)"
                          value={form.framework_update_note}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, framework_update_note: e.target.value }))
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
                      onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                      style={{ ...inputStyle, maxWidth: 400 }}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    onClick={() =>
                      resolveMutation.mutate({ caseId: c.id, decision: "include" })
                    }
                    style={{ ...smallBtn, background: "#2e7d32", color: "#fff" }}
                  >
                    Include
                  </button>
                  <button
                    onClick={() =>
                      resolveMutation.mutate({ caseId: c.id, decision: "exclude" })
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
      <span style={{ fontSize: "0.875rem", color: "#666" }}>{total_extracted} extracted</span>
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

const chipStyle = (active: boolean): React.CSSProperties => ({
  padding: "0.3rem 0.75rem",
  border: active ? "2px solid #1a73e8" : "1px solid #ccc",
  borderRadius: 20,
  background: active ? "#e8f0fe" : "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
  color: active ? "#1a73e8" : "#555",
  fontWeight: active ? 600 : 400,
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
