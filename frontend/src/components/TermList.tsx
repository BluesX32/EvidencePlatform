import React from "react";
import type { Term } from "../api/client";

interface TermListProps {
  label: string;
  items: Term[];
  onChange: (items: Term[]) => void;
}

export function TermList({ label, items, onChange }: TermListProps) {
  const update = (idx: number, field: keyof Term, value: string) => {
    const next = items.map((item, i) =>
      i === idx ? { ...item, [field]: value } : item
    );
    onChange(next);
  };

  const remove = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  const add = () => {
    onChange([...items, { term: "", snippet: "", notes: "" }]);
  };

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ fontWeight: 600, marginBottom: "0.4rem", fontSize: "0.9rem" }}>
        {label}
      </div>
      {items.length === 0 && (
        <div style={{ color: "#888", fontSize: "0.85rem", marginBottom: "0.4rem" }}>
          No terms added.
        </div>
      )}
      {items.map((item, idx) => (
        <div
          key={idx}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1.5fr 1.5fr auto",
            gap: "0.4rem",
            marginBottom: "0.35rem",
            alignItems: "center",
          }}
        >
          <input
            type="text"
            placeholder="Term"
            value={item.term}
            onChange={(e) => update(idx, "term", e.target.value)}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Snippet"
            value={item.snippet}
            onChange={(e) => update(idx, "snippet", e.target.value)}
            style={inputStyle}
          />
          <input
            type="text"
            placeholder="Notes"
            value={item.notes}
            onChange={(e) => update(idx, "notes", e.target.value)}
            style={inputStyle}
          />
          <button
            onClick={() => remove(idx)}
            style={{
              background: "none",
              border: "none",
              color: "#c00",
              cursor: "pointer",
              fontSize: "1rem",
              padding: "0 0.3rem",
            }}
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={add}
        style={{
          fontSize: "0.8rem",
          padding: "0.25rem 0.6rem",
          border: "1px dashed #aaa",
          background: "none",
          cursor: "pointer",
          borderRadius: 4,
          color: "#555",
        }}
      >
        + Add
      </button>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: "0.85rem",
  width: "100%",
  boxSizing: "border-box",
};
