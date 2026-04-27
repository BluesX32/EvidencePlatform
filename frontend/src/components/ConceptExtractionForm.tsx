/**
 * ConceptExtractionForm — renders and saves per-item concept extractions.
 *
 * Fields are grouped by field_type: Entity Fields, Relation Fields, Other.
 * Shown in ScreeningWorkspace after data extraction when a concept_template exists.
 */
import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conceptExtractionApi,
  type ConceptTemplate,
  type ConceptTemplateField,
  type ConceptExtractionJson,
} from "../api/client";

const EMPTY_CE: ConceptExtractionJson = { cells: {}, note: "" };

interface Props {
  projectId: string;
  template: ConceptTemplate;
  recordId?: string | null;
  clusterId?: string | null;
  onSaved?: () => void;
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

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ConceptTemplateField;
  value: string | string[];
  onChange: (v: string | string[]) => void;
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
        {field.options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(strVal === opt ? "" : opt)}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
              border: `1.5px solid ${strVal === opt ? "#4f46e5" : "#e2e8f0"}`,
              background: strVal === opt ? "#4f46e5" : "#fff",
              color: strVal === opt ? "#fff" : "#374151",
              fontWeight: strVal === opt ? 600 : 400,
            }}
          >
            {opt}
          </button>
        ))}
        {/* Render selected custom value that isn't in predefined options */}
        {customSelected && (
          <button
            onClick={() => onChange("")}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
              border: "1.5px solid #4f46e5", background: "#4f46e5",
              color: "#fff", fontWeight: 600,
            }}
          >
            {customSelected} ✕
          </button>
        )}
        <CustomOptionInput
          selected={strVal}
          options={field.options}
          onSelect={onChange}
          multi={false}
        />
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
            onClick={() => onChange(active ? arrVal.filter((v) => v !== opt) : [...arrVal, opt])}
            style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
              border: `1.5px solid ${active ? "#4f46e5" : "#e2e8f0"}`,
              background: active ? "#4f46e5" : "#fff",
              color: active ? "#fff" : "#374151",
              fontWeight: active ? 600 : 400,
            }}
          >
            {opt}
          </button>
        );
      })}
      {/* Render selected custom values not in predefined options */}
      {customValues.map((v) => (
        <button
          key={v}
          onClick={() => onChange(arrVal.filter((x) => x !== v))}
          style={{
            padding: "3px 10px", borderRadius: 4, fontSize: 13, cursor: "pointer",
            border: "1.5px solid #4f46e5", background: "#4f46e5",
            color: "#fff", fontWeight: 600,
          }}
        >
          {v} ✕
        </button>
      ))}
      <CustomOptionInput
        selected={arrVal}
        options={field.options}
        onSelect={onChange}
        multi={true}
      />
    </div>
  );
}

function CustomOptionInput({
  selected,
  options,
  onSelect,
  multi,
}: {
  selected: string | string[];
  options: string[];
  onSelect: (v: string | string[]) => void;
  multi: boolean;
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
    setDraft("");
    setAdding(false);
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
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") { setAdding(false); setDraft(""); }
        }}
        style={{
          fontSize: 12, padding: "2px 7px", borderRadius: 4,
          border: "1px solid #c4b5fd", outline: "none", width: 120,
        }}
        placeholder="custom value…"
      />
      <button onClick={submit} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 4, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}>Add</button>
      <button onClick={() => { setAdding(false); setDraft(""); }} style={{ fontSize: 11, padding: "2px 5px", borderRadius: 4, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}>✕</button>
    </div>
  );
}

export default function ConceptExtractionForm({ projectId, template, recordId, clusterId, onSaved }: Props) {
  const qc = useQueryClient();
  const itemKey = recordId ?? clusterId;

  const [form, setForm] = useState<ConceptExtractionJson>(EMPTY_CE);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // True only when form was changed by the user (not by loading existing data)
  const userEdited = useRef(false);

  const { data: existing } = useQuery({
    queryKey: ["concept-extraction-item", projectId, itemKey],
    queryFn: () =>
      conceptExtractionApi.getItem(projectId, {
        record_id: recordId ?? undefined,
        cluster_id: clusterId ?? undefined,
      }).then((r) => r.data[0] ?? null),
    enabled: !!itemKey,
  });

  // Load existing data — mark as NOT user-edited so auto-save doesn't fire
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

  // Auto-save 600 ms after the last user-initiated change
  useEffect(() => {
    if (!userEdited.current || !itemKey) return;
    const timer = setTimeout(() => { saveMut.mutate(); }, 600);
    return () => clearTimeout(timer);
  }, [form]);  // eslint-disable-line react-hooks/exhaustive-deps

  const fields = template.fields ?? [];
  const sections: Record<string, ConceptTemplateField[]> = { entity: [], relation: [], metadata: [] };
  for (const f of fields) {
    const bucket = f.field_type in sections ? f.field_type : "metadata";
    sections[bucket].push(f);
  }

  function setCell(fieldId: string, value: string | string[]) {
    userEdited.current = true;
    setForm((prev) => ({ ...prev, cells: { ...prev.cells, [fieldId]: value } }));
  }

  function setNote(note: string) {
    userEdited.current = true;
    setForm((prev) => ({ ...prev, note }));
  }

  const sectionOrder = ["entity", "relation", "metadata"] as const;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Concept Extraction
        </span>
        <span style={{ fontSize: 11, color: saveMut.isPending ? "#6b7280" : saveMut.isError ? "#dc2626" : saveMut.isSuccess ? "#16a34a" : "#9ca3af" }}>
          {saveMut.isPending ? "Saving…" : saveMut.isError ? "Save failed — retry?" : saveMut.isSuccess ? "Saved ✓" : ""}
        </span>
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
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                letterSpacing: "0.06em", color,
              }}>
                {SECTION_LABELS[sectionKey]}
              </span>
            </button>

            {!isCollapsed && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sectionFields.map((field) => (
                  <div key={field.id}>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#4b5563", marginBottom: 3 }}>
                      {field.label}
                    </label>
                    <FieldInput
                      field={field}
                      value={form.cells[field.id] ?? (field.input_type === "multi_select" ? [] : "")}
                      onChange={(v) => setCell(field.id, v)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Note field */}
      <div style={{ marginTop: 4 }}>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6b7280", marginBottom: 3 }}>
          Notes
        </label>
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
