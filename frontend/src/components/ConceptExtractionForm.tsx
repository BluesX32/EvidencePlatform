/**
 * ConceptExtractionForm — renders and saves per-item concept extractions.
 *
 * Novelty: for single_select and multi_select fields, each selected value is
 * auto-classified as "new" (not seen in prior articles) or "existing" (seen
 * before).  The user can toggle the badge to override.  The classification is
 * stored in extracted_json.novelty and powers the chart in ExtractionLibrary.
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conceptExtractionApi,
  type ConceptTemplate,
  type ConceptTemplateField,
  type ConceptExtractionJson,
  type ConceptExtractionRecord,
} from "../api/client";

const EMPTY_CE: ConceptExtractionJson = { cells: {}, note: "" };

interface Props {
  projectId: string;
  template: ConceptTemplate;
  recordId?: string | null;
  clusterId?: string | null;
  onSaved?: () => void;
  allExtractions?: ConceptExtractionRecord[];
}

const SECTION_COLORS: Record<string, string> = {
  entity: "#4f46e5",
  relation: "#0891b2",
  metadata: "#6b7280",
};

const SECTION_LABELS: Record<string, string> = {
  entity: "Entity Fields",
  relation: "Relation Fields",
  metadata: "Other Fields",
};

// ── Novelty badge ─────────────────────────────────────────────────────────────

function NoveltyBadge({
  status,
  onClick,
}: {
  status: "new" | "existing" | undefined;
  onClick: (e: React.MouseEvent) => void;
}) {
  if (!status) return null;
  const isNew = status === "new";
  return (
    <span
      onClick={onClick}
      title={isNew ? "New concept — click to mark as existing" : "Seen before — click to mark as new"}
      style={{
        marginLeft: 5,
        fontSize: 9,
        fontWeight: 800,
        color: isNew ? "#16a34a" : "#9ca3af",
        cursor: "pointer",
        userSelect: "none",
        letterSpacing: "0.01em",
      }}
    >
      {isNew ? "★NEW" : "=SEEN"}
    </span>
  );
}

// ── Field input ───────────────────────────────────────────────────────────────

function FieldInput({
  field,
  value,
  onChange,
  novelty,
  onToggleNovelty,
}: {
  field: ConceptTemplateField;
  value: string | string[];
  onChange: (v: string | string[]) => void;
  novelty?: Record<string, "new" | "existing">;
  onToggleNovelty?: (value: string) => void;
}) {
  const strVal = typeof value === "string" ? value : "";
  const arrVal = Array.isArray(value) ? value : [];

  if (field.input_type === "string") {
    return (
      <textarea
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? ""}
        rows={2}
        style={{
          width: "100%", boxSizing: "border-box", padding: "0.35rem 0.5rem",
          border: "1px solid #e2e8f0", borderRadius: "0.3rem",
          fontSize: "0.84rem", resize: "vertical", outline: "none",
          fontFamily: "inherit", lineHeight: 1.45,
        }}
      />
    );
  }

  if (field.input_type === "single_select") {
    const customSelected = strVal && !field.options.includes(strVal) ? strVal : null;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {field.options.map((opt) => {
          const active = strVal === opt;
          return (
            <button
              key={opt}
              onClick={() => { if (!active) onChange(opt); }}
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 13,
                cursor: active ? "default" : "pointer",
                border: `1.5px solid ${active ? "#4f46e5" : "#e2e8f0"}`,
                background: active ? "#4f46e5" : "#fff",
                color: active ? "#fff" : "#374151",
                fontWeight: active ? 600 : 400,
                display: "inline-flex", alignItems: "center", gap: 4,
              }}
            >
              {opt}
              {active && novelty && (
                <NoveltyBadge status={novelty[opt]} onClick={(e) => { e.stopPropagation(); onToggleNovelty?.(opt); }} />
              )}
              {active && (
                <span
                  onClick={(e) => { e.stopPropagation(); onChange(""); }}
                  title="Remove"
                  style={{ marginLeft: 2, fontSize: 11, opacity: 0.75, cursor: "pointer", lineHeight: 1 }}
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
        {customSelected && (
          <button
            onClick={() => {}}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "default",
              border: "1.5px solid #4f46e5", background: "#4f46e5",
              color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            {customSelected}
            {novelty && (
              <NoveltyBadge status={novelty[customSelected]} onClick={(e) => { e.stopPropagation(); onToggleNovelty?.(customSelected); }} />
            )}
            <span
              onClick={(e) => { e.stopPropagation(); onChange(""); }}
              title="Remove"
              style={{ marginLeft: 2, fontSize: 11, opacity: 0.75, cursor: "pointer", lineHeight: 1 }}
            >
              ✕
            </span>
          </button>
        )}
        <CustomOptionInput selected={strVal} options={field.options} onSelect={onChange} multi={false} />
      </div>
    );
  }

  // multi_select
  const customValues = arrVal.filter((v) => !field.options.includes(v));
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {field.options.map((opt) => {
        const active = arrVal.includes(opt);
        return (
          <button
            key={opt}
            onClick={() => { if (!active) onChange([...arrVal, opt]); }}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 13,
              cursor: active ? "default" : "pointer",
              border: `1.5px solid ${active ? "#4f46e5" : "#e2e8f0"}`,
              background: active ? "#4f46e5" : "#fff",
              color: active ? "#fff" : "#374151",
              fontWeight: active ? 600 : 400,
              display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            {opt}
            {active && novelty && (
              <NoveltyBadge status={novelty[opt]} onClick={(e) => { e.stopPropagation(); onToggleNovelty?.(opt); }} />
            )}
            {active && (
              <span
                onClick={(e) => { e.stopPropagation(); onChange(arrVal.filter((v) => v !== opt)); }}
                title="Remove"
                style={{ marginLeft: 2, fontSize: 11, opacity: 0.75, cursor: "pointer", lineHeight: 1 }}
              >
                ✕
              </span>
            )}
          </button>
        );
      })}
      {customValues.map((v) => (
        <button
          key={v}
          onClick={() => {}}
          style={{
            padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "default",
            border: "1.5px solid #4f46e5", background: "#4f46e5",
            color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4,
          }}
        >
          {v}
          {novelty && (
            <NoveltyBadge status={novelty[v]} onClick={(e) => { e.stopPropagation(); onToggleNovelty?.(v); }} />
          )}
          <span
            onClick={(e) => { e.stopPropagation(); onChange(arrVal.filter((x) => x !== v)); }}
            title="Remove"
            style={{ marginLeft: 2, fontSize: 11, opacity: 0.75, cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </span>
        </button>
      ))}
      <CustomOptionInput selected={arrVal} options={field.options} onSelect={onChange} multi={true} />
    </div>
  );
}

function CustomOptionInput({
  selected, options, onSelect, multi,
}: {
  selected: string | string[]; options: string[];
  onSelect: (v: string | string[]) => void; multi: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  function submit() {
    const v = draft.trim();
    if (!v) return;
    if (multi) {
      const arr = Array.isArray(selected) ? selected : [];
      if (!arr.includes(v)) onSelect([...arr, v]);
    } else {
      onSelect(v);
    }
    setDraft(""); setAdding(false);
  }

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        style={{
          padding: "3px 10px", borderRadius: 4, fontSize: 12,
          border: "1px dashed #c4b5fd", background: "transparent",
          color: "#7c3aed", cursor: "pointer",
        }}
      >
        + custom
      </button>
    );
  }

  return (
    <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input
        autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { setAdding(false); setDraft(""); } }}
        style={{ fontSize: 12, padding: "2px 7px", borderRadius: 4, border: "1px solid #c4b5fd", outline: "none", width: 120 }}
        placeholder="custom value…"
      />
      <button onClick={submit} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}>Add</button>
      <button onClick={() => { setAdding(false); setDraft(""); }} style={{ fontSize: 11, padding: "2px 5px", borderRadius: 4, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}>✕</button>
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────

export default function ConceptExtractionForm({ projectId, template, recordId, clusterId, onSaved, allExtractions }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;

  const [form, setForm] = useState<ConceptExtractionJson>(EMPTY_CE);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const userEdited = useRef(false);

  // Build set of values seen in OTHER articles (for auto-detection)
  const seenValues = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!allExtractions) return map;
    const currentKey = recordId ?? clusterId;
    for (const ce of allExtractions) {
      const key = ce.record_id ?? ce.cluster_id;
      if (key === currentKey) continue;
      const cells = ce.extracted_json?.cells ?? {};
      for (const [fieldId, val] of Object.entries(cells)) {
        if (!map.has(fieldId)) map.set(fieldId, new Set());
        if (Array.isArray(val)) val.forEach((v) => map.get(fieldId)!.add(v));
        else if (val) map.get(fieldId)!.add(val);
      }
    }
    return map;
  }, [allExtractions, recordId, clusterId]);

  const { data: existing } = useQuery({
    queryKey: ["concept-extraction-item", projectId, itemKey],
    queryFn: () =>
      conceptExtractionApi.getItem(projectId, {
        record_id: recordId ?? undefined,
        cluster_id: clusterId ?? undefined,
      }).then((r) => r.data[0] ?? null),
    enabled: !!itemKey,
  });

  useEffect(() => {
    userEdited.current = false;
    if (existing) setForm(existing.extracted_json || EMPTY_CE);
    else setForm(EMPTY_CE);
  }, [existing, itemKey]);

  const saveMut = useMutation({
    mutationFn: () =>
      conceptExtractionApi.upsert(projectId, {
        record_id: recordId ?? null,
        cluster_id: clusterId ?? null,
        extracted_json: form,
      }),
    onSuccess: () => {
      userEdited.current = false;
      qc.invalidateQueries({ queryKey: ["concept-extraction-item", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["concept-taxonomy-aggregate", projectId] });
      qc.invalidateQueries({ queryKey: ["concept-extractions-list", projectId] });
      onSaved?.();
    },
  });

  useEffect(() => {
    if (!userEdited.current || !itemKey) return;
    const timer = setTimeout(() => { saveMut.mutate(); }, 600);
    return () => clearTimeout(timer);
  }, [form]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cell + novelty helpers ─────────────────────────────────────────────────

  function setCell(fieldId: string, value: string | string[]) {
    userEdited.current = true;
    setForm((prev) => {
      const selectedVals = Array.isArray(value) ? value : (value ? [value] : []);
      const currentNovelty = prev.novelty ?? {};
      const fieldNovelty = { ...(currentNovelty[fieldId] ?? {}) };
      const seen = seenValues.get(fieldId) ?? new Set<string>();

      // Auto-classify newly selected values
      for (const v of selectedVals) {
        if (!(v in fieldNovelty)) {
          fieldNovelty[v] = seen.has(v) ? "existing" : "new";
        }
      }
      // Drop entries for deselected values
      const finalNovelty: Record<string, "new" | "existing"> = {};
      for (const v of selectedVals) {
        if (v in fieldNovelty) finalNovelty[v] = fieldNovelty[v];
      }

      return {
        ...prev,
        cells: { ...prev.cells, [fieldId]: value },
        novelty: { ...currentNovelty, [fieldId]: finalNovelty },
      };
    });
  }

  function toggleNovelty(fieldId: string, value: string) {
    userEdited.current = true;
    setForm((prev) => {
      const currentNovelty = prev.novelty ?? {};
      const fieldNovelty = { ...(currentNovelty[fieldId] ?? {}) };
      fieldNovelty[value] = fieldNovelty[value] === "new" ? "existing" : "new";
      return { ...prev, novelty: { ...currentNovelty, [fieldId]: fieldNovelty } };
    });
  }

  function setNote(note: string) {
    userEdited.current = true;
    setForm((prev) => ({ ...prev, note }));
  }

  const fields = template.fields ?? [];
  const sections: Record<string, ConceptTemplateField[]> = { entity: [], relation: [], metadata: [] };
  for (const f of fields) {
    const bucket = f.field_type in sections ? f.field_type : "metadata";
    sections[bucket].push(f);
  }

  const noveltyEnabled = !!allExtractions;
  const sectionOrder = ["entity", "relation", "metadata"] as const;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Concept Extraction
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {noveltyEnabled && (
            <span style={{ fontSize: 10, color: "#9ca3af" }}>
              <span style={{ color: "#16a34a", fontWeight: 700 }}>★NEW</span> / <span style={{ fontWeight: 700 }}>= SEEN</span> — click to toggle
            </span>
          )}
          <span style={{ fontSize: 11, color: saveMut.isPending ? "#6b7280" : saveMut.isError ? "#dc2626" : saveMut.isSuccess ? "#16a34a" : "#9ca3af" }}>
            {saveMut.isPending ? "Saving…" : saveMut.isError ? "Save failed" : saveMut.isSuccess ? "Saved ✓" : ""}
          </span>
        </div>
      </div>

      {sectionOrder.map((sectionKey) => {
        const sectionFields = sections[sectionKey];
        if (sectionFields.length === 0) return null;
        const color = SECTION_COLORS[sectionKey];
        const isCollapsed = collapsed[sectionKey];

        return (
          <div key={sectionKey} style={{ marginBottom: 12 }}>
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [sectionKey]: !c[sectionKey] }))}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                background: "none", border: "none", padding: "0 0 5px", cursor: "pointer",
                width: "100%", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 9, color: "#9ca3af" }}>{isCollapsed ? "▸" : "▾"}</span>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color }}>
                {SECTION_LABELS[sectionKey]}
              </span>
            </button>

            {!isCollapsed && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sectionFields.map((field) => {
                  // Merge stored novelty with auto-classification for any active value not yet recorded
                  let fieldNovelty: Record<string, "new" | "existing"> | undefined;
                  if (noveltyEnabled && field.input_type !== "string") {
                    const stored = form.novelty?.[field.id] ?? {};
                    const seen = seenValues.get(field.id) ?? new Set<string>();
                    const cellVal = form.cells[field.id];
                    const activeVals = Array.isArray(cellVal) ? cellVal : (cellVal ? [cellVal] : []);
                    fieldNovelty = { ...stored };
                    for (const v of activeVals) {
                      if (!(v in fieldNovelty)) {
                        fieldNovelty[v] = seen.has(v) ? "existing" : "new";
                      }
                    }
                  }
                  return (
                    <div key={field.id}>
                      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#4b5563", marginBottom: 3 }}>
                        {field.label}
                      </label>
                      <FieldInput
                        field={field}
                        value={form.cells[field.id] ?? (field.input_type === "multi_select" ? [] : "")}
                        onChange={(v) => setCell(field.id, v)}
                        novelty={fieldNovelty}
                        onToggleNovelty={noveltyEnabled ? (v) => toggleNovelty(field.id, v) : undefined}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: 4 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 3 }}>Notes</label>
        <textarea
          value={form.note ?? ""}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Optional notes…"
          style={{
            width: "100%", boxSizing: "border-box", padding: "0.3rem 0.5rem",
            border: "1px solid #e2e8f0", borderRadius: "0.3rem",
            fontSize: "0.82rem", resize: "vertical", outline: "none",
            fontFamily: "inherit", color: "#374151",
          }}
        />
      </div>
    </div>
  );
}
