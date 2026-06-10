import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { projectsApi, sourcesApi } from "../api/client";

type TopChoice = "corpora" | "included" | "excluded";

interface Props {
  parentProjectId: string;
  parentProjectName: string;
  hasExtractionTemplate: boolean;
  hasConceptTemplate: boolean;
  onClose: () => void;
}

export default function CreateSubProjectModal({
  parentProjectId,
  parentProjectName,
  hasExtractionTemplate,
  hasConceptTemplate,
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // ── Top-level choice ───────────────────────────────────────────────────────
  const [topChoice, setTopChoice] = useState<TopChoice | null>(null);

  // ── Corpora path ───────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nPerCorpus, setNPerCorpus] = useState(50);
  const [seedMode, setSeedMode] = useState<"auto" | "manual">("auto");
  const [seed, setSeed] = useState<number>(Math.floor(Math.random() * 2_000_000_000));
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string> | null>(null);
  const [inheritCriteria, setInheritCriteria] = useState(false);
  const [inheritExtraction, setInheritExtraction] = useState(false);
  const [inheritConcept, setInheritConcept] = useState(false);
  const [sharedWithTeam, setSharedWithTeam] = useState(false);

  // ── Human screening path (included / excluded) ────────────────────────────
  const [screeningStage, setScreeningStage] = useState<"TA" | "FT" | "both">("both");
  const [selectedReasonCode, setSelectedReasonCode] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const { data: sources = [], isLoading: sourcesLoading } = useQuery({
    queryKey: ["sources", parentProjectId],
    queryFn: () => sourcesApi.list(parentProjectId).then((r) => r.data),
    staleTime: 30_000,
    onSuccess: (data: typeof sources) => {
      if (selectedSourceIds === null) {
        setSelectedSourceIds(new Set(data.map((s) => s.id)));
      }
    },
  } as any);

  const stageParam = screeningStage === "both" ? undefined : screeningStage;
  const { data: excludedReasons } = useQuery({
    queryKey: ["human-excluded-reasons", parentProjectId, stageParam],
    queryFn: () => projectsApi.getHumanExcludedReasonCodes(parentProjectId, stageParam).then((r) => r.data),
    staleTime: 30_000,
    enabled: topChoice === "excluded",
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const toggleSource = (id: string) => {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allSelected = sources.length > 0 && selectedSourceIds?.size === sources.length;
  const toggleAll = () =>
    setSelectedSourceIds(allSelected ? new Set() : new Set(sources.map((s) => s.id)));

  function handleTopChoice(c: TopChoice) {
    setTopChoice(c);
    setError(null);
    setSelectedReasonCode(null);
  }

  function handleStageChange(s: "TA" | "FT" | "both") {
    setScreeningStage(s);
    setSelectedReasonCode(null);
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const corpusMutation = useMutation({
    mutationFn: () => {
      const ids = selectedSourceIds && selectedSourceIds.size < sources.length
        ? Array.from(selectedSourceIds) : undefined;
      return projectsApi.createSubProject(parentProjectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        n_per_corpus: nPerCorpus,
        seed: seedMode === "manual" ? seed : undefined,
        source_ids: ids,
        inherit_criteria: inheritCriteria,
        inherit_extraction_template: inheritExtraction,
        inherit_concept_template: inheritConcept,
        shared_with_team: sharedWithTeam,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", parentProjectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
    onError: (err: any) => setError(err?.response?.data?.detail ?? "Failed to create sub-project."),
  });

  async function handleScreeningFork() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const decision = topChoice === "included" ? "include" : "exclude";
      const stage = screeningStage === "both" ? undefined : screeningStage;
      const res = await projectsApi.createSubProjectFromScreening(parentProjectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        decision,
        stage,
        reason_code: topChoice === "excluded" && selectedReasonCode ? selectedReasonCode : undefined,
        shared_with_team: sharedWithTeam,
      });
      queryClient.invalidateQueries({ queryKey: ["project", parentProjectId] });
      navigate(`/projects/${res.data.id}`);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Failed to create sub-project.");
      setBusy(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required."); return; }
    if (topChoice === "corpora") {
      if (nPerCorpus < 1) { setError("Articles per corpus must be at least 1."); return; }
      if (!selectedSourceIds || selectedSourceIds.size === 0) { setError("Select at least one corpus."); return; }
      corpusMutation.mutate();
    } else {
      void handleScreeningFork();
    }
  }

  const sectionLabel: React.CSSProperties = { display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 };
  const hint: React.CSSProperties = { marginTop: 4, fontSize: 12, color: "var(--text-muted)" };
  const checkRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", padding: "5px 8px", borderRadius: 5 };

  const TOP_CHOICES: Array<{ value: TopChoice; label: string; sub: string; color: string; bg: string; border: string }> = [
    { value: "corpora",  label: "Sample from corpora",   sub: "Randomly sample N papers per corpus (for reliability studies, pilot screening)", color: "#1e3a5f", bg: "#eff6ff", border: "#93c5fd" },
    { value: "included", label: "From included papers",  sub: "Papers human reviewers marked as included during screening",                      color: "#166534", bg: "#dcfce7", border: "#86efac" },
    { value: "excluded", label: "From excluded papers",  sub: "Papers human reviewers excluded during screening",                                color: "#991b1b", bg: "#fee2e2", border: "#fca5a5" },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 540, maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create Sub-project</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>
          From <strong>{parentProjectName}</strong>
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 12 }}>

          {/* ── Step 1: Type ──────────────────────────────────────────────── */}
          <div>
            <label style={sectionLabel}>1. What to include</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {TOP_CHOICES.map((c) => {
                const active = topChoice === c.value;
                return (
                  <button key={c.value} type="button" onClick={() => handleTopChoice(c.value)}
                    style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "0.6rem 0.85rem", borderRadius: 8, border: `1.5px solid ${active ? c.border : "var(--border)"}`, background: active ? c.bg : "var(--surface)", cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <input type="radio" readOnly checked={active} style={{ marginTop: 2, accentColor: "#4f46e5", flexShrink: 0 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: active ? c.color : "var(--text)" }}>{c.label}</div>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{c.sub}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Step 2a: Corpora options ──────────────────────────────────── */}
          {topChoice === "corpora" && (
            <>
              <div>
                <label style={sectionLabel}>Corpora to include</label>
                {sourcesLoading ? (
                  <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading corpora…</p>
                ) : sources.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No corpora found.</p>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                    <label style={{ ...checkRow, borderBottom: "1px solid var(--border)", background: "#f8f9fa", fontWeight: 600 }}>
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} /> Select all corpora
                    </label>
                    {sources.map((s) => (
                      <label key={s.id} style={{ ...checkRow, borderBottom: "1px solid var(--border)" }}>
                        <input type="checkbox" checked={selectedSourceIds?.has(s.id) ?? false} onChange={() => toggleSource(s.id)} />
                        {s.name}
                      </label>
                    ))}
                  </div>
                )}
                <p style={hint}>Only articles from selected corpora will be sampled.</p>
              </div>

              <div>
                <label style={sectionLabel}>Articles per corpus</label>
                <input className="input" type="number" min={1} max={10000} value={nPerCorpus}
                  onChange={(e) => setNPerCorpus(Math.max(1, parseInt(e.target.value) || 1))} style={{ width: 120 }} />
                <p style={hint}>Up to this many articles are randomly selected per corpus.</p>
              </div>

              <div>
                <label style={sectionLabel}>Random seed</label>
                <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="radio" checked={seedMode === "auto"} onChange={() => setSeedMode("auto")} /> Auto-generate
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="radio" checked={seedMode === "manual"} onChange={() => setSeedMode("manual")} /> Set manually
                  </label>
                </div>
                {seedMode === "manual" ? (
                  <input className="input" type="number" min={0} value={seed}
                    onChange={(e) => setSeed(parseInt(e.target.value) || 0)} style={{ width: 160 }} />
                ) : (
                  <p style={hint}>Seed is generated automatically and stored for reproducibility.</p>
                )}
              </div>

              <div>
                <label style={sectionLabel}>Inherit settings from parent</label>
                <p style={{ ...hint, marginBottom: 8, marginTop: 0 }}>By default the sub-project starts blank.</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <label style={checkRow}>
                    <input type="checkbox" checked={inheritCriteria} onChange={(e) => setInheritCriteria(e.target.checked)} />
                    <span><strong>Inclusion / exclusion criteria</strong></span>
                  </label>
                  <label style={{ ...checkRow, opacity: hasExtractionTemplate ? 1 : 0.45 }}>
                    <input type="checkbox" checked={inheritExtraction} onChange={(e) => setInheritExtraction(e.target.checked)} disabled={!hasExtractionTemplate} />
                    <span><strong>Extraction template</strong><span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>{!hasExtractionTemplate ? "(not configured)" : ""}</span></span>
                  </label>
                  <label style={{ ...checkRow, opacity: hasConceptTemplate ? 1 : 0.45 }}>
                    <input type="checkbox" checked={inheritConcept} onChange={(e) => setInheritConcept(e.target.checked)} disabled={!hasConceptTemplate} />
                    <span><strong>Concept template</strong><span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>{!hasConceptTemplate ? "(not configured)" : ""}</span></span>
                  </label>
                </div>
              </div>
            </>
          )}

          {/* ── Step 2b: Stage selector (included / excluded) ─────────────── */}
          {(topChoice === "included" || topChoice === "excluded") && (
            <div>
              <label style={sectionLabel}>2. Screening stage</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {(["both", "TA", "FT"] as const).map((s) => (
                  <label key={s} style={{ ...checkRow, border: `1.5px solid ${screeningStage === s ? "var(--brand)" : "var(--border)"}`, borderRadius: 6, background: screeningStage === s ? "#eff6ff" : "var(--surface)" }}>
                    <input type="radio" checked={screeningStage === s} onChange={() => handleStageChange(s)} style={{ accentColor: "#4f46e5" }} />
                    <span style={{ fontSize: 13 }}>
                      {s === "both" ? <><strong>Both stages</strong> — any TA or FT decision</> : s === "TA" ? <><strong>Title &amp; abstract (TA)</strong> only</> : <><strong>Full text (FT)</strong> only</>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2c: Exclusion reason category (excluded only) ────────── */}
          {topChoice === "excluded" && (
            <div style={{ padding: "0.65rem 0.85rem", background: "#fff7f7", border: "1px solid #fecaca", borderRadius: 8 }}>
              <label style={{ ...sectionLabel, marginBottom: 8 }}>
                3. Filter by exclusion category <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span>
              </label>
              {!excludedReasons ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Loading categories…</p>
              ) : !excludedReasons.has_reason_codes ? (
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                  No exclusion categories found{screeningStage !== "both" ? ` for ${screeningStage} stage` : ""}. All {excludedReasons.total_excluded.toLocaleString()} excluded papers will be included.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px" }}>
                    Select a category or leave blank to fork all excluded papers:
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", padding: "4px 8px", borderRadius: 5, background: selectedReasonCode === null ? "#e0e7ff" : "transparent" }}>
                      <input type="radio" checked={selectedReasonCode === null} onChange={() => setSelectedReasonCode(null)} style={{ accentColor: "#4f46e5" }} />
                      <span style={{ fontWeight: selectedReasonCode === null ? 700 : 400 }}>All excluded ({excludedReasons.total_excluded.toLocaleString()})</span>
                    </label>
                    {excludedReasons.reason_codes.map((rc) => (
                      <label key={rc.reason_code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", padding: "4px 8px", borderRadius: 5, background: selectedReasonCode === rc.reason_code ? "#fee2e2" : "transparent" }}>
                        <input type="radio" checked={selectedReasonCode === rc.reason_code} onChange={() => setSelectedReasonCode(rc.reason_code)} style={{ accentColor: "#991b1b" }} />
                        <span style={{ flex: 1 }}>{rc.reason_code}</span>
                        <span style={{ color: "var(--text-muted)", fontSize: 12, flexShrink: 0 }}>{rc.count.toLocaleString()} papers</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Step 3: Name (shown once a top choice is made) ───────────── */}
          {topChoice && (
            <>
              <div>
                <label style={sectionLabel}>{topChoice === "corpora" ? "Sub-project name" : topChoice === "excluded" ? "4. Sub-project name" : "3. Sub-project name"}</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus
                  placeholder={
                    topChoice === "included" ? "e.g. Full-text review — LLM included"
                    : topChoice === "excluded" ? "e.g. Excluded — not severity conceptualization"
                    : "e.g. Reliability sample — round 1"
                  }
                />
              </div>
              <div>
                <label style={sectionLabel}>Description <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span></label>
                <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="Purpose of this sub-project" />
              </div>
            </>
          )}

          {/* ── Share with team toggle ────────────────────────────────── */}
          {topChoice && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "0.6rem 0.85rem", borderRadius: 8, border: `1.5px solid ${sharedWithTeam ? "#818cf8" : "var(--border)"}`, background: sharedWithTeam ? "#eff6ff" : "var(--surface)", cursor: "pointer" }}>
              <input type="checkbox" checked={sharedWithTeam} onChange={(e) => setSharedWithTeam(e.target.checked)} style={{ marginTop: 2, accentColor: "#4f46e5", flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: sharedWithTeam ? "#3730a3" : "var(--text)" }}>Share with team</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>All members of the parent project can see and use this sub-project.</div>
              </div>
            </label>
          )}

          {error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 12px", color: "#dc2626", fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary"
              disabled={!topChoice || !name.trim() || busy || corpusMutation.isPending}>
              {(busy || corpusMutation.isPending) ? "Creating…" : "Create sub-project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
