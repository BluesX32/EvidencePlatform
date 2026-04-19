/**
 * ConceptExtractionForm — renders and saves per-item concept extractions.
 *
 * Fields are grouped by field_type: Entity Fields, Relation Fields, Other.
 * Shown in ScreeningWorkspace after data extraction when a concept_template exists.
 */
import { useState, useEffect } from "react";
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
        {field.allow_custom_options && (
          <CustomOptionInput
            selected={strVal}
            options={field.options}
            onSelect={onChange}
            multi={false}
          />
        )}
      </div>
    );
  }

  // multi_select
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
      {field.allow_custom_options && (
        <CustomOptionInput
          selected={arrVal}
          options={field.options}
          onSelect={onChange}
          multi={true}
        />
      )}
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

  // Load existing extraction on mount
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
      qc.invalidateQueries({ queryKey: ["concept-extraction-item", projectId, itemKey] });
      qc.invalidateQueries({ queryKey: ["concept-taxonomy-aggregate", projectId] });
      onSaved?.();
    },
  });

  const fields = template.fields ?? [];
  const sections: Record<string, ConceptTemplateField[]> = { entity: [], relation: [], metadata: [] };
  for (const f of fields) {
    const bucket = f.field_type in sections ? f.field_type : "metadata";
    sections[bucket].push(f);
  }

  function setCell(fieldId: string, value: string | string[]) {
    setForm((prev) => ({ ...prev, cells: { ...prev.cells, [fieldId]: value } }));
  }

  const sectionOrder = ["entity", "relation", "metadata"] as const;

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Concept Extraction
        </span>
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          style={{
            fontSize: 12, padding: "3px 12px", borderRadius: 4,
            border: "none", background: "#4f46e5", color: "#fff",
            cursor: "pointer", fontWeight: 600,
          }}
        >
          {saveMut.isPending ? "Saving…" : "Save"}
        </button>
      </div>

      {saveMut.isError && (
        <p style={{ fontSize: 12, color: "#dc2626", marginBottom: 8 }}>Save failed — please try again.</p>
      )}
      {saveMut.isSuccess && (
        <p style={{ fontSize: 12, color: "#16a34a", marginBottom: 8 }}>Saved ✓</p>
      )}

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
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
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
