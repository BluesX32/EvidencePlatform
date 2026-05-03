import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, sourcesApi } from "../api/client";

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

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nPerCorpus, setNPerCorpus] = useState(50);
  const [seedMode, setSeedMode] = useState<"auto" | "manual">("auto");
  const [seed, setSeed] = useState<number>(Math.floor(Math.random() * 2_000_000_000));
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string> | null>(null); // null = not yet initialised
  const [inheritCriteria, setInheritCriteria] = useState(false);
  const [inheritExtraction, setInheritExtraction] = useState(false);
  const [inheritConcept, setInheritConcept] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: sources = [], isLoading: sourcesLoading } = useQuery({
    queryKey: ["sources", parentProjectId],
    queryFn: () => sourcesApi.list(parentProjectId).then((r) => r.data),
    staleTime: 30_000,
    onSuccess: (data) => {
      // Initialise all corpora as selected on first load
      if (selectedSourceIds === null) {
        setSelectedSourceIds(new Set(data.map((s) => s.id)));
      }
    },
  } as any);

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

  const mutation = useMutation({
    mutationFn: () => {
      const ids = selectedSourceIds && selectedSourceIds.size < sources.length
        ? Array.from(selectedSourceIds)
        : undefined; // undefined = all
      return projectsApi.createSubProject(parentProjectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        n_per_corpus: nPerCorpus,
        seed: seedMode === "manual" ? seed : undefined,
        source_ids: ids,
        inherit_criteria: inheritCriteria,
        inherit_extraction_template: inheritExtraction,
        inherit_concept_template: inheritConcept,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", parentProjectId] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? "Failed to create sub-project.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Name is required."); return; }
    if (nPerCorpus < 1) { setError("Articles per corpus must be at least 1."); return; }
    if (!selectedSourceIds || selectedSourceIds.size === 0) {
      setError("Select at least one corpus."); return;
    }
    mutation.mutate();
  };

  const sectionLabel: React.CSSProperties = {
    display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13,
  };
  const hint: React.CSSProperties = {
    marginTop: 4, fontSize: 12, color: "var(--text-muted)",
  };
  const checkRow: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer",
    padding: "5px 8px", borderRadius: 5,
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Create Sub-project</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>
          Sampling from <strong>{parentProjectName}</strong>.
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 12 }}>

          {/* ── Name & description ───────────────────────────────────────── */}
          <div>
            <label style={sectionLabel}>Sub-project name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reliability sample — round 1"
              autoFocus
            />
          </div>

          <div>
            <label style={sectionLabel}>Description <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span></label>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Purpose of this sub-project"
            />
          </div>

          {/* ── Corpus selection ─────────────────────────────────────────── */}
          <div>
            <label style={sectionLabel}>Corpora to include</label>
            {sourcesLoading ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading corpora…</p>
            ) : sources.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No corpora found in this project.</p>
            ) : (
              <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
                {/* Select-all header */}
                <label
                  style={{
                    ...checkRow,
                    borderBottom: "1px solid var(--border)",
                    background: "#f8f9fa",
                    fontWeight: 600,
                  }}
                >
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  Select all corpora
                </label>
                {sources.map((s) => (
                  <label key={s.id} style={{ ...checkRow, borderBottom: "1px solid var(--border)" }}>
                    <input
                      type="checkbox"
                      checked={selectedSourceIds?.has(s.id) ?? false}
                      onChange={() => toggleSource(s.id)}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
            <p style={hint}>Only articles from selected corpora will be sampled into the sub-project.</p>
          </div>

          {/* ── Sampling config ──────────────────────────────────────────── */}
          <div>
            <label style={sectionLabel}>Articles per corpus</label>
            <input
              className="input"
              type="number"
              min={1}
              max={10000}
              value={nPerCorpus}
              onChange={(e) => setNPerCorpus(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: 120 }}
            />
            <p style={hint}>
              Up to this many articles are randomly selected per corpus. If a corpus has fewer,
              all of them are included.
            </p>
          </div>

          <div>
            <label style={sectionLabel}>Random seed</label>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="radio" checked={seedMode === "auto"} onChange={() => setSeedMode("auto")} />
                Auto-generate
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="radio" checked={seedMode === "manual"} onChange={() => setSeedMode("manual")} />
                Set manually
              </label>
            </div>
            {seedMode === "manual" ? (
              <input
                className="input"
                type="number"
                min={0}
                value={seed}
                onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                style={{ width: 160 }}
              />
            ) : (
              <p style={hint}>Seed is generated automatically and stored for full reproducibility.</p>
            )}
          </div>

          {/* ── Inherit settings ─────────────────────────────────────────── */}
          <div>
            <label style={sectionLabel}>Inherit settings from parent</label>
            <p style={{ ...hint, marginBottom: 8, marginTop: 0 }}>
              By default the sub-project starts blank. Check any settings you want copied from
              the parent.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label style={checkRow}>
                <input
                  type="checkbox"
                  checked={inheritCriteria}
                  onChange={(e) => setInheritCriteria(e.target.checked)}
                />
                <span>
                  <strong>Inclusion / exclusion criteria</strong>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>
                    Copy screening criteria to sub-project
                  </span>
                </span>
              </label>

              <label style={{ ...checkRow, opacity: hasExtractionTemplate ? 1 : 0.45 }}>
                <input
                  type="checkbox"
                  checked={inheritExtraction}
                  onChange={(e) => setInheritExtraction(e.target.checked)}
                  disabled={!hasExtractionTemplate}
                />
                <span>
                  <strong>Extraction template</strong>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>
                    {hasExtractionTemplate ? "Copy data extraction form" : "Not configured in parent"}
                  </span>
                </span>
              </label>

              <label style={{ ...checkRow, opacity: hasConceptTemplate ? 1 : 0.45 }}>
                <input
                  type="checkbox"
                  checked={inheritConcept}
                  onChange={(e) => setInheritConcept(e.target.checked)}
                  disabled={!hasConceptTemplate}
                />
                <span>
                  <strong>Concept template</strong>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>
                    {hasConceptTemplate ? "Copy concept extraction template" : "Not configured in parent"}
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "8px 12px", color: "#dc2626", fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={mutation.isPending || sourcesLoading}
            >
              {mutation.isPending ? "Creating…" : "Create sub-project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
