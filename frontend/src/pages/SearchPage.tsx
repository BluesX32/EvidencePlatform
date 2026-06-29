import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Search, Sparkles, Database, CheckCircle, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { searchApi, type SearchStrategyResponse, type SearchExecuteResponse } from "../api/client";

// ── Step indicator ────────────────────────────────────────────────────────────

function StepBadge({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <div style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: "0.8rem",
      background: done ? "var(--success)" : active ? "var(--brand)" : "var(--border)",
      color: done || active ? "#fff" : "var(--text-muted)",
    }}>
      {done ? <CheckCircle size={14} /> : n}
    </div>
  );
}

function StepHeader({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: active ? 16 : 0 }}>
      <StepBadge n={n} active={active} done={done} />
      <span style={{ fontWeight: 700, fontSize: "0.95rem", color: active ? "var(--text)" : "var(--text-muted)" }}>
        {label}
      </span>
    </div>
  );
}

// ── PICO display ──────────────────────────────────────────────────────────────

function PicoCard({ pico }: { pico: SearchStrategyResponse["pico"] }) {
  const entries = Object.entries(pico).filter(([, v]) => v);
  if (entries.length === 0) return null;
  const labels: Record<string, string> = {
    population: "Population", intervention: "Intervention",
    comparison: "Comparison", outcome: "Outcome",
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
      {entries.map(([k, v]) => (
        <div key={k} style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "var(--radius)", padding: "0.3rem 0.7rem",
          fontSize: "0.78rem",
        }}>
          <span style={{ fontWeight: 700, color: "var(--brand)", marginRight: 4 }}>{labels[k] ?? k}:</span>
          {v}
        </div>
      ))}
    </div>
  );
}

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewTable({ results }: { results: SearchExecuteResponse }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? results.preview : results.preview.slice(0, 5);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: "0.84rem", fontWeight: 600, color: "var(--text)" }}>
          Preview — first {results.preview.length} of {results.total.toLocaleString()} results
        </span>
        {results.preview.length > 5 && (
          <button
            onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--brand)",
                     fontSize: "0.78rem", display: "flex", alignItems: "center", gap: 3, fontWeight: 600 }}
          >
            {expanded ? <><ChevronUp size={13} /> Show less</> : <><ChevronDown size={13} /> Show all {results.preview.length}</>}
          </button>
        )}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        {shown.map((r, i) => (
          <div key={r.pmid} style={{
            padding: "0.6rem 0.9rem",
            borderBottom: i < shown.length - 1 ? "1px solid var(--border)" : "none",
            background: i % 2 === 0 ? "var(--surface)" : "#fff",
          }}>
            <div style={{ fontSize: "0.84rem", fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
              {r.title}
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              {[r.authors, r.source, r.year].filter(Boolean).join(" · ")}
              <a
                href={`https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`}
                target="_blank" rel="noopener noreferrer"
                style={{ marginLeft: 8, color: "var(--brand)" }}
              >
                PMID {r.pmid} ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3;

export default function SearchPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);
  const [question, setQuestion] = useState("");
  const [strategy, setStrategy] = useState<SearchStrategyResponse | null>(null);
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [maxResults, setMaxResults] = useState(200);
  const [searchResults, setSearchResults] = useState<SearchExecuteResponse | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [importDone, setImportDone] = useState<{ jobId: string; count: number } | null>(null);

  const [strategyError, setStrategyError] = useState<string | null>(null);

  // Step 1: generate strategy
  const strategyMut = useMutation({
    mutationFn: () => searchApi.generateStrategy(projectId!, { research_question: question }),
    onSuccess: (res) => {
      setStrategyError(null);
      const s = res.data;
      setStrategy(s);
      setQuery(s.query);
      setActiveFilters(s.suggested_filters ?? []);
      setStep(2);
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setStrategyError(detail || "Generation failed — check server logs");
    },
  });

  // Step 2: execute search
  const executeMut = useMutation({
    mutationFn: () => searchApi.execute(projectId!, {
      query,
      filters: activeFilters.length > 0 ? activeFilters : undefined,
      max_results: maxResults,
    }),
    onSuccess: (res) => {
      setSearchResults(res.data);
      setStep(3);
    },
  });

  // Step 3: import
  const importMut = useMutation({
    mutationFn: () => searchApi.importRecords(projectId!, {
      query,
      filters: activeFilters.length > 0 ? activeFilters : undefined,
      max_results: maxResults,
      source_name: sourceName || undefined,
    }),
    onSuccess: (res) => {
      setImportDone({ jobId: res.data.import_job_id, count: res.data.estimated_records });
    },
  });

  function toggleFilter(f: string) {
    setActiveFilters(prev =>
      prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-title">
          <Link to={`/projects/${projectId}`} className="back-link">← Project</Link>
          <h1><Search size={18} style={{ verticalAlign: "middle", marginRight: 6 }} />Literature Search</h1>
          <span className="subtitle">Generate a search strategy and import papers from PubMed automatically</span>
        </div>
      </header>

      {/* ── Step 1: Research question ─────────────────────────────────────── */}
      <div className="card" style={{ padding: "1.1rem 1.3rem", marginBottom: "1rem" }}>
        <StepHeader n={1} label="Describe your research question" active={step === 1} done={step > 1} />
        {step >= 1 && (
          <div style={{ marginTop: step === 1 ? 16 : 8 }}>
            {step > 1 ? (
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-muted)", fontStyle: "italic" }}>
                  "{question}"
                </p>
                <button
                  onClick={() => { setStep(1); setSearchResults(null); setImportDone(null); }}
                  style={{ flexShrink: 0, fontSize: "0.75rem", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                >
                  Edit
                </button>
              </div>
            ) : (
              <>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="e.g. What is the effect of cognitive behavioural therapy on depression outcomes in adolescents?"
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  style={{ width: "100%", resize: "vertical" }}
                />
                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    className="btn-primary"
                    onClick={() => strategyMut.mutate()}
                    disabled={!question.trim() || strategyMut.isPending}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      background: strategyMut.isPending ? "#a5b4fc" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
                      border: "none", cursor: (!question.trim() || strategyMut.isPending) ? "default" : "pointer",
                    }}
                  >
                    <Sparkles size={14} />
                    {strategyMut.isPending ? "Generating strategy…" : "Generate Search Strategy"}
                  </button>
                  {strategyMut.isError && (
                    <span style={{ fontSize: "0.8rem", color: "var(--danger)", display: "flex", alignItems: "center", gap: 4 }}>
                      <AlertTriangle size={13} /> {strategyError || "Failed"}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Step 2: Review & refine strategy ─────────────────────────────── */}
      {step >= 2 && (
        <div className="card" style={{ padding: "1.1rem 1.3rem", marginBottom: "1rem" }}>
          <StepHeader n={2} label="Review and refine your search strategy" active={step === 2} done={step > 2} />
          {step >= 2 && strategy && (
            <div style={{ marginTop: 12 }}>
              {strategy.explanation && (
                <p style={{ margin: "0 0 12px", fontSize: "0.84rem", color: "var(--text-muted)" }}>
                  {strategy.explanation}
                </p>
              )}

              <PicoCard pico={strategy.pico} />

              <label style={{ display: "block", marginTop: 14, marginBottom: 4, fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                PubMed Search String <span style={{ fontWeight: 400, textTransform: "none" }}>(editable)</span>
              </label>
              <textarea
                className="form-input"
                rows={6}
                value={query}
                onChange={e => setQuery(e.target.value)}
                disabled={step > 2}
                style={{ width: "100%", fontFamily: "monospace", fontSize: "0.82rem", resize: "vertical" }}
              />

              {strategy.suggested_filters.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Suggested Filters
                  </span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                    {strategy.suggested_filters.map(f => (
                      <button
                        key={f}
                        onClick={() => step === 2 && toggleFilter(f)}
                        disabled={step > 2}
                        style={{
                          fontSize: "0.78rem", padding: "0.2rem 0.6rem", borderRadius: "1rem",
                          cursor: step === 2 ? "pointer" : "default",
                          background: activeFilters.includes(f) ? "var(--brand)" : "var(--surface)",
                          color: activeFilters.includes(f) ? "#fff" : "var(--text)",
                          border: `1px solid ${activeFilters.includes(f) ? "var(--brand)" : "var(--border)"}`,
                          fontWeight: activeFilters.includes(f) ? 600 : 400,
                        }}
                      >
                        {activeFilters.includes(f) ? "✓ " : ""}{f}
                      </button>
                    ))}
                  </div>
                  <p style={{ margin: "4px 0 0", fontSize: "0.73rem", color: "var(--text-muted)" }}>
                    Click to toggle filters (active ones are applied to the search)
                  </p>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
                <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)" }}>
                  Max results:
                </label>
                <input
                  type="number"
                  className="form-input"
                  value={maxResults}
                  min={10} max={2000}
                  onChange={e => setMaxResults(Number(e.target.value))}
                  disabled={step > 2}
                  style={{ width: 90 }}
                />
              </div>

              {step === 2 && (
                <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    className="btn-primary"
                    onClick={() => executeMut.mutate()}
                    disabled={!query.trim() || executeMut.isPending}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                  >
                    <Search size={14} />
                    {executeMut.isPending ? "Searching PubMed…" : "Search PubMed"}
                  </button>
                  {executeMut.isError && (
                    <span style={{ fontSize: "0.8rem", color: "var(--danger)", display: "flex", alignItems: "center", gap: 4 }}>
                      <AlertTriangle size={13} /> PubMed error — try again
                    </span>
                  )}
                </div>
              )}

              {step > 2 && (
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                  <button
                    onClick={() => { setStep(2); setSearchResults(null); setImportDone(null); }}
                    style={{ fontSize: "0.75rem", color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                  >
                    Edit strategy
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Preview & import ──────────────────────────────────────── */}
      {step >= 3 && searchResults && (
        <div className="card" style={{ padding: "1.1rem 1.3rem", marginBottom: "1rem" }}>
          <StepHeader n={3} label="Review results and import" active={step === 3} done={!!importDone} />

          {importDone ? (
            <div style={{ marginTop: 14, padding: "1rem", background: "var(--success-light)", border: "1px solid var(--success-border)", borderRadius: "var(--radius)", display: "flex", alignItems: "center", gap: 10 }}>
              <CheckCircle size={20} color="var(--success)" style={{ flexShrink: 0 }} />
              <div>
                <p style={{ margin: 0, fontWeight: 700, color: "var(--success)", fontSize: "0.9rem" }}>
                  Import started — {importDone.count.toLocaleString()} records fetching from PubMed
                </p>
                <p style={{ margin: "2px 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  Papers will appear on the Records page as they arrive. This may take a minute.
                </p>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button
                    className="btn-primary btn-sm"
                    onClick={() => navigate(`/projects/${projectId}/records`)}
                  >
                    View Records →
                  </button>
                  <button
                    className="btn-sm"
                    onClick={() => navigate(`/projects/${projectId}/import`)}
                    style={{ border: "1px solid var(--border)", background: "var(--surface)", cursor: "pointer" }}
                  >
                    Import Status
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 14 }}>
              {/* Stats bar */}
              <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
                <div className="card" style={{ padding: "0.6rem 1rem", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 100 }}>
                  <span style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--brand)" }}>
                    {searchResults.total.toLocaleString()}
                  </span>
                  <span style={{ fontSize: "0.73rem", color: "var(--text-muted)", fontWeight: 600 }}>total results</span>
                </div>
                <div className="card" style={{ padding: "0.6rem 1rem", display: "flex", flexDirection: "column", alignItems: "center", minWidth: 100 }}>
                  <span style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--text)" }}>
                    {Math.min(maxResults, searchResults.total).toLocaleString()}
                  </span>
                  <span style={{ fontSize: "0.73rem", color: "var(--text-muted)", fontWeight: 600 }}>will be imported</span>
                </div>
              </div>

              {searchResults.total > maxResults && (
                <div style={{ marginBottom: 12, padding: "0.6rem 0.9rem", background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: "var(--radius)", fontSize: "0.8rem", color: "#92400e", display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={13} />
                  Only the first {maxResults.toLocaleString()} of {searchResults.total.toLocaleString()} results will be imported. Increase "Max results" in step 2 to get more.
                </div>
              )}

              <PreviewTable results={searchResults} />

              {/* Source name + import */}
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 240px" }}>
                  <label style={{ display: "block", fontSize: "0.78rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: 4 }}>
                    Source name <span style={{ fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input
                    className="form-input"
                    placeholder={`PubMed: ${query.slice(0, 40)}…`}
                    value={sourceName}
                    onChange={e => setSourceName(e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <button
                  className="btn-primary"
                  onClick={() => importMut.mutate()}
                  disabled={importMut.isPending}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                >
                  <Database size={14} />
                  {importMut.isPending
                    ? "Starting import…"
                    : `Import ${Math.min(maxResults, searchResults.total).toLocaleString()} papers`}
                </button>
                {importMut.isError && (
                  <span style={{ fontSize: "0.8rem", color: "var(--danger)", display: "flex", alignItems: "center", gap: 4 }}>
                    <AlertTriangle size={13} /> Import failed — try again
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
