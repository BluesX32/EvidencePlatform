/**
 * ConceptTaxonomyPage — two-tab view over all extracted concept values.
 *
 * Part 1 (Entities tab): all values from entity fields, aggregated by value+field.
 * Part 2 (Relations tab): all values from relation fields.
 * Other tab: metadata fields.
 *
 * From each tab users can select values and push them to the Ontology as nodes.
 * Entity values → namespace "concept" (ontology nodes)
 * Relation values → namespace "relationships" (ontology nodes)
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { conceptExtractionApi, projectsApi, type ConceptTaxonomyEntry, type ConceptFieldType } from "../api/client";

const TAB_LABELS: Record<string, string> = {
  entity: "Entities",
  relation: "Relations",
  metadata: "Other",
};

const TAB_COLORS: Record<string, string> = {
  entity: "#4f46e5",
  relation: "#0891b2",
  metadata: "#6b7280",
};

const NAMESPACE_DEFAULTS: Record<string, string> = {
  entity: "concept",
  relation: "relationships",
  metadata: "concept",
};

// ── Entry row ─────────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  selected,
  onToggle,
}: {
  entry: ConceptTaxonomyEntry;
  selected: boolean;
  onToggle: () => void;
}) {
  const color = TAB_COLORS[entry.field_type] ?? "#6b7280";
  return (
    <div
      onClick={onToggle}
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr 140px 60px",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.45rem 0.75rem",
        borderBottom: "1px solid #f1f3f4",
        background: selected ? "#f0f4ff" : "#fff",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        style={{ accentColor: color, cursor: "pointer" }}
      />
      <span style={{ fontSize: "0.88rem", fontWeight: selected ? 600 : 400, color: "#1f2937" }}>
        {entry.value}
      </span>
      <span style={{
        fontSize: "0.76rem", color: "#6b7280",
        background: "#f3f4f6", borderRadius: "0.25rem",
        padding: "1px 6px", display: "inline-block", maxWidth: 130,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {entry.field_label}
      </span>
      <span style={{
        fontSize: "0.8rem", fontWeight: 700, color,
        textAlign: "right",
      }}>
        {entry.count} {entry.count === 1 ? "paper" : "papers"}
      </span>
    </div>
  );
}

// ── Push to ontology panel ─────────────────────────────────────────────────────

function PushPanel({
  projectId,
  tab,
  selected,
  allEntries,
  onSuccess,
}: {
  projectId: string;
  tab: ConceptFieldType;
  selected: Set<string>;
  allEntries: ConceptTaxonomyEntry[];
  onSuccess: () => void;
}) {
  const [namespace, setNamespace] = useState(NAMESPACE_DEFAULTS[tab] ?? "concept");
  const [parentId, setParentId] = useState<string>("");

  const { data: ontologyNodes = [] } = useQuery({
    queryKey: ["ontology", projectId],
    queryFn: () => import("../api/client").then((m) => m.ontologyApi.list(projectId).then((r) => r.data)),
    staleTime: 30_000,
  });

  const pushMut = useMutation({
    mutationFn: () => {
      const items = allEntries
        .filter((e) => selected.has(`${e.field_id}::${e.value}`))
        .map((e) => ({
          value: e.value,
          field_type: e.field_type,
          namespace,
          parent_id: parentId || null,
        }));
      return conceptExtractionApi.pushToOntology(projectId, items);
    },
    onSuccess: (res) => {
      const { created, skipped } = res.data;
      onSuccess();
      alert(`Pushed to ontology: ${created} created, ${skipped} already existed.`);
    },
    onError: () => alert("Failed to push to ontology — please try again."),
  });

  const selectedEntries = allEntries.filter((e) => selected.has(`${e.field_id}::${e.value}`));

  return (
    <div style={{
      border: "1px solid #e0e7ff", borderRadius: "0.5rem",
      background: "#fafafe", padding: "1rem 1.1rem", marginBottom: "1rem",
    }}>
      <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "#374151", marginBottom: "0.75rem" }}>
        Push {selectedEntries.length} selected value{selectedEntries.length !== 1 ? "s" : ""} to Ontology
      </div>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", marginBottom: "0.2rem" }}>
            Namespace
          </label>
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            style={{ fontSize: "0.84rem", padding: "0.3rem 0.5rem", border: "1px solid #dadce0", borderRadius: "0.3rem", background: "#fff" }}
          >
            <option value="concept">concept</option>
            <option value="relationships">relationships</option>
            <option value="level">level</option>
            <option value="dimension">dimension</option>
            <option value="thematic">thematic</option>
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.75rem", fontWeight: 600, color: "#6b7280", marginBottom: "0.2rem" }}>
            Parent node (optional)
          </label>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            style={{ fontSize: "0.84rem", padding: "0.3rem 0.5rem", border: "1px solid #dadce0", borderRadius: "0.3rem", background: "#fff", maxWidth: 220 }}
          >
            <option value="">— no parent (root) —</option>
            {ontologyNodes.map((n: any) => (
              <option key={n.id} value={n.id}>
                {n.name} [{n.namespace}]
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={() => pushMut.mutate()}
          disabled={selectedEntries.length === 0 || pushMut.isPending}
          className="btn-primary"
          style={{ fontSize: "0.84rem" }}
        >
          {pushMut.isPending ? "Pushing…" : `Push ${selectedEntries.length} to Ontology`}
        </button>
      </div>

      {/* Preview chips */}
      {selectedEntries.length > 0 && (
        <div style={{ marginTop: "0.75rem", display: "flex", flexWrap: "wrap", gap: 5 }}>
          {selectedEntries.map((e) => (
            <span
              key={`${e.field_id}::${e.value}`}
              style={{
                fontSize: 12, padding: "2px 9px", borderRadius: 4,
                background: `${TAB_COLORS[e.field_type]}22`,
                border: `1px solid ${TAB_COLORS[e.field_type]}66`,
                color: TAB_COLORS[e.field_type],
              }}
            >
              {e.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConceptTaxonomyPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<ConceptFieldType>("entity");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState<string>("__all__");

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => projectsApi.get(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  const { data: aggregate, isLoading, error } = useQuery({
    queryKey: ["concept-taxonomy-aggregate", projectId],
    queryFn: () => conceptExtractionApi.getAggregate(projectId!).then((r) => r.data),
    enabled: !!projectId,
    staleTime: 30_000,
  });

  const hasTemplate = (project?.concept_template?.fields?.length ?? 0) > 0;

  const tabData: ConceptTaxonomyEntry[] = aggregate?.[activeTab] ?? [];

  // Unique field labels in this tab (for filter)
  const fieldOptions = Array.from(new Set(tabData.map((e) => e.field_label)));

  const filtered = tabData.filter((e) => {
    const matchSearch = !search || e.value.toLowerCase().includes(search.toLowerCase());
    const matchField = fieldFilter === "__all__" || e.field_label === fieldFilter;
    return matchSearch && matchField;
  });

  function toggleEntry(entry: ConceptTaxonomyEntry) {
    const key = `${entry.field_id}::${entry.value}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filtered.map((e) => `${e.field_id}::${e.value}`)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  const tabColor = TAB_COLORS[activeTab];
  const selectedForTab = new Set([...selected].filter((k) => tabData.some((e) => `${e.field_id}::${e.value}` === k)));

  return (
    <div style={{ padding: "1.5rem 2rem", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 700, color: "#111827" }}>
            Concept Taxonomy
          </h1>
          {project && (
            <span style={{ fontSize: "0.82rem", color: "#6b7280", background: "#f3f4f6", padding: "2px 10px", borderRadius: 999 }}>
              {project.name}
            </span>
          )}
        </div>
        <p style={{ margin: 0, fontSize: "0.88rem", color: "#6b7280" }}>
          Aggregated view of all extracted concepts. Select values to push to the Ontology as nodes.
        </p>
        <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Link
            to={`/projects/${projectId}/ontology`}
            style={{ fontSize: "0.82rem", color: "#4f46e5", textDecoration: "none", fontWeight: 600 }}
          >
            → Open Ontology
          </Link>
          {!hasTemplate && (
            <Link
              to={`/projects/${projectId}`}
              style={{ fontSize: "0.82rem", color: "#d97706", textDecoration: "none", fontWeight: 600 }}
            >
              ⚠ No concept template defined — configure it in Project Overview
            </Link>
          )}
        </div>
      </div>

      {/* No template warning */}
      {!isLoading && !hasTemplate && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "0.5rem", padding: "1rem 1.1rem", marginBottom: "1.5rem" }}>
          <p style={{ margin: 0, fontSize: "0.88rem", color: "#92400e" }}>
            <strong>No concept extraction template defined yet.</strong>{" "}
            Go to <Link to={`/projects/${projectId}`} style={{ color: "#92400e", fontWeight: 600 }}>Project Overview</Link> to add a Concept Extraction Template,
            then screen some papers to extract concepts.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "0", borderBottom: "2px solid #e5e7eb", marginBottom: "1.25rem" }}>
        {(["entity", "relation", "metadata"] as ConceptFieldType[]).map((tab) => {
          const count = aggregate?.[tab]?.length ?? 0;
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setSelected(new Set()); setSearch(""); setFieldFilter("__all__"); }}
              style={{
                padding: "0.55rem 1.1rem", border: "none", background: "transparent",
                cursor: "pointer", fontSize: "0.88rem", fontWeight: active ? 700 : 400,
                color: active ? TAB_COLORS[tab] : "#6b7280",
                borderBottom: `3px solid ${active ? TAB_COLORS[tab] : "transparent"}`,
                marginBottom: -2, transition: "color 0.1s",
              }}
            >
              {TAB_LABELS[tab]}
              <span style={{ marginLeft: 6, fontSize: "0.78rem", background: active ? `${TAB_COLORS[tab]}22` : "#f3f4f6", color: active ? TAB_COLORS[tab] : "#6b7280", padding: "1px 6px", borderRadius: 999, fontWeight: 600 }}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Push panel — shown when items selected */}
      {selectedForTab.size > 0 && (
        <PushPanel
          projectId={projectId!}
          tab={activeTab}
          selected={selectedForTab}
          allEntries={tabData}
          onSuccess={() => {
            setSelected(new Set());
            qc.invalidateQueries({ queryKey: ["ontology", projectId] });
          }}
        />
      )}

      {/* Search + filter bar */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="Search values…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 160, padding: "0.4rem 0.6rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", fontSize: "0.84rem", outline: "none" }}
        />
        {fieldOptions.length > 1 && (
          <select
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value)}
            style={{ fontSize: "0.84rem", padding: "0.4rem 0.5rem", border: "1px solid #e5e7eb", borderRadius: "0.375rem", background: "#fff" }}
          >
            <option value="__all__">All fields</option>
            {fieldOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        )}
        <button onClick={selectAll} style={{ fontSize: "0.78rem", padding: "0.3rem 0.65rem", border: "1px solid #e5e7eb", borderRadius: "0.25rem", background: "#fff", cursor: "pointer", color: tabColor }}>
          Select all
        </button>
        {selected.size > 0 && (
          <button onClick={clearAll} style={{ fontSize: "0.78rem", padding: "0.3rem 0.65rem", border: "1px solid #e5e7eb", borderRadius: "0.25rem", background: "#fff", cursor: "pointer", color: "#6b7280" }}>
            Clear ({selected.size})
          </button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <p style={{ color: "#9ca3af", fontSize: "0.88rem" }}>Loading…</p>
      ) : error ? (
        <p style={{ color: "#dc2626", fontSize: "0.88rem" }}>Failed to load concept data.</p>
      ) : filtered.length === 0 ? (
        <div style={{ padding: "2rem 1rem", textAlign: "center", color: "#9ca3af", border: "1px dashed #e5e7eb", borderRadius: "0.5rem" }}>
          {tabData.length === 0
            ? `No ${TAB_LABELS[activeTab].toLowerCase()} extracted yet. Screen some papers with a concept template to populate this view.`
            : "No values match your search."}
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", overflow: "hidden" }}>
          {/* Header */}
          <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 140px 60px", gap: "0.5rem", padding: "0.4rem 0.75rem", background: "#f9fafb", borderBottom: "1px solid #e5e7eb", fontSize: "0.72rem", fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span />
            <span>Value</span>
            <span>Field</span>
            <span style={{ textAlign: "right" }}>Count</span>
          </div>
          {filtered.map((entry) => (
            <EntryRow
              key={`${entry.field_id}::${entry.value}`}
              entry={entry}
              selected={selected.has(`${entry.field_id}::${entry.value}`)}
              onToggle={() => toggleEntry(entry)}
            />
          ))}
        </div>
      )}

      {/* Stats footer */}
      {filtered.length > 0 && (
        <div style={{ marginTop: "0.75rem", fontSize: "0.78rem", color: "#9ca3af" }}>
          Showing {filtered.length} of {tabData.length} unique values
          {selectedForTab.size > 0 && ` · ${selectedForTab.size} selected`}
        </div>
      )}
    </div>
  );
}
