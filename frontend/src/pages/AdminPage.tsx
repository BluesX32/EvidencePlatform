import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { adminApi, type InviteCode } from "../api/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function StatusBadge({ active, used, max }: { active: boolean; used: number; max: number }) {
  const exhausted = used >= max;
  if (!active) return <span style={badge("#dc2626","#fee2e2")}>Inactive</span>;
  if (exhausted) return <span style={badge("#d97706","#fef3c7")}>Exhausted</span>;
  return <span style={badge("#059669","#dcfce7")}>Active</span>;
}

function badge(color: string, bg: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, color, background: bg };
}

// ── Create code form ──────────────────────────────────────────────────────────

function CreateCodeForm({ onCreated }: { onCreated: (c: InviteCode) => void }) {
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<InviteCode | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      adminApi.createInviteCode({
        label: label.trim() || undefined,
        max_uses: maxUses,
        expires_at: expiresAt || undefined,
      }),
    onSuccess: (res) => {
      setNewCode(res.data);
      setLabel("");
      setMaxUses(1);
      setExpiresAt("");
      onCreated(res.data);
    },
  });

  function copyCode(code: string) {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(code);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div style={{
      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12,
      padding: "1.5rem", marginBottom: "1.5rem",
    }}>
      <h3 style={{ margin: "0 0 1.1rem", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
        Generate invite code
      </h3>

      {newCode && (
        <div style={{
          background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10,
          padding: "1rem 1.25rem", marginBottom: "1.25rem",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#15803d", textTransform: "uppercase", marginBottom: 4 }}>
              Code generated
            </div>
            <span style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 800, color: "#166534", letterSpacing: "0.06em" }}>
              {newCode.code}
            </span>
          </div>
          <button
            onClick={() => copyCode(newCode.code)}
            style={{
              padding: "0.5rem 1rem", borderRadius: 8,
              border: "1px solid #86efac", background: copied === newCode.code ? "#dcfce7" : "#fff",
              fontWeight: 600, fontSize: 13, cursor: "pointer", color: "#166534",
              flexShrink: 0,
            }}
          >
            {copied === newCode.code ? "Copied ✓" : "Copy code"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "2 1 180px" }}>
          <label style={labelSt}>Label (optional)</label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. colleague, conference-2026"
            style={inputSt}
          />
        </div>
        <div style={{ flex: "1 1 100px" }}>
          <label style={labelSt}>Max uses</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxUses}
            onChange={e => setMaxUses(Math.max(1, Number(e.target.value)))}
            style={inputSt}
          />
        </div>
        <div style={{ flex: "1 1 150px" }}>
          <label style={labelSt}>Expires (optional)</label>
          <input
            type="date"
            value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)}
            style={inputSt}
          />
        </div>
        <button
          onClick={() => mut.mutate()}
          disabled={mut.isPending}
          style={{
            padding: "0.55rem 1.4rem", borderRadius: 8,
            border: "none", background: "#4f46e5", color: "#fff",
            fontWeight: 700, fontSize: 14, cursor: "pointer",
            flexShrink: 0, height: 38,
          }}
        >
          {mut.isPending ? "Generating…" : "Generate"}
        </button>
      </div>

      {mut.isError && (
        <p style={{ margin: "0.75rem 0 0", fontSize: 12.5, color: "#dc2626" }}>
          Failed to create code — please try again.
        </p>
      )}
    </div>
  );
}

const labelSt: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 };
const inputSt: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "0.45rem 0.6rem", border: "1px solid #cbd5e1", borderRadius: 7, fontSize: 13.5, outline: "none", height: 38 };

// ── Code row ──────────────────────────────────────────────────────────────────

function CodeRow({ code, onToggle }: { code: InviteCode; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(code.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
      <td style={tdSt}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: "#1e293b", letterSpacing: "0.04em" }}>
            {code.code}
          </span>
          <button
            onClick={copy}
            title="Copy code"
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: copied ? "#059669" : "#94a3b8", padding: 0 }}
          >
            {copied ? "✓" : "⎘"}
          </button>
        </div>
        {code.label && (
          <div style={{ fontSize: 11.5, color: "#64748b", marginTop: 2 }}>{code.label}</div>
        )}
      </td>
      <td style={{ ...tdSt, textAlign: "center" }}>
        <StatusBadge active={code.is_active} used={code.used_count} max={code.max_uses} />
      </td>
      <td style={{ ...tdSt, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
        <span style={{ fontWeight: 700, color: code.used_count >= code.max_uses ? "#dc2626" : "#0f172a" }}>
          {code.used_count}
        </span>
        <span style={{ color: "#94a3b8" }}> / {code.max_uses}</span>
      </td>
      <td style={{ ...tdSt, color: "#64748b", fontSize: 12.5 }}>
        {fmtDate(code.expires_at)}
      </td>
      <td style={{ ...tdSt, color: "#64748b", fontSize: 12.5 }}>
        {fmtDate(code.created_at)}
      </td>
      <td style={{ ...tdSt, textAlign: "right" }}>
        <button
          onClick={onToggle}
          style={{
            fontSize: 12, fontWeight: 600, padding: "3px 10px", borderRadius: 6,
            border: `1px solid ${code.is_active ? "#fca5a5" : "#bbf7d0"}`,
            background: "transparent",
            color: code.is_active ? "#dc2626" : "#059669",
            cursor: "pointer",
          }}
        >
          {code.is_active ? "Deactivate" : "Reactivate"}
        </button>
      </td>
    </tr>
  );
}

const tdSt: React.CSSProperties = { padding: "0.7rem 1rem", verticalAlign: "middle" };

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const qc = useQueryClient();

  const { data: codes = [], isLoading, isError } = useQuery({
    queryKey: ["admin-invite-codes"],
    queryFn: () => adminApi.listInviteCodes().then(r => r.data),
  });

  const toggleMut = useMutation({
    mutationFn: (code: InviteCode) =>
      code.is_active
        ? adminApi.deactivateCode(code.id)
        : adminApi.reactivateCode(code.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-invite-codes"] }),
  });

  function handleCreated() {
    qc.invalidateQueries({ queryKey: ["admin-invite-codes"] });
  }

  const active = codes.filter(c => c.is_active && c.used_count < c.max_uses).length;
  const totalUses = codes.reduce((s, c) => s + c.used_count, 0);

  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 900 }}>
      {/* Header */}
      <div style={{ marginBottom: "1.75rem" }}>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          background: "#eef2ff", border: "1px solid #c7d2fe",
          borderRadius: 99, padding: "2px 10px", fontSize: 11.5,
          fontWeight: 700, color: "#4f46e5", marginBottom: 10,
        }}>
          Admin panel
        </div>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem", fontWeight: 800, color: "#0f172a" }}>
          Invite codes
        </h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>
          Generate and manage invite codes for new user registration.
        </p>
      </div>

      {/* Stats strip */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        {[
          { v: codes.length, l: "Total codes", c: "#4f46e5" },
          { v: active, l: "Active & available", c: "#059669" },
          { v: totalUses, l: "Total registrations", c: "#d97706" },
        ].map(s => (
          <div key={s.l} style={{
            flex: "1 1 130px", background: "#fff", border: "1px solid #e2e8f0",
            borderRadius: 10, padding: "0.85rem 1.1rem",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: s.c }}>{s.v}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <CreateCodeForm onCreated={handleCreated} />

      {/* Table */}
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>All invite codes</div>
          <div style={{ fontSize: 12.5, color: "#94a3b8" }}>{codes.length} total</div>
        </div>

        {isLoading && (
          <div style={{ padding: "2rem", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>Loading…</div>
        )}
        {isError && (
          <div style={{ padding: "2rem", textAlign: "center", color: "#dc2626", fontSize: 14 }}>
            Failed to load codes. Make sure you have admin access.
          </div>
        )}
        {!isLoading && !isError && codes.length === 0 && (
          <div style={{ padding: "2rem", textAlign: "center", color: "#94a3b8", fontSize: 14 }}>
            No codes yet. Generate one above to get started.
          </div>
        )}
        {!isLoading && codes.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Code", "Status", "Uses", "Expires", "Created", ""].map(h => (
                    <th key={h} style={{ padding: "0.6rem 1rem", textAlign: "left", fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {codes.map(c => (
                  <CodeRow
                    key={c.id}
                    code={c}
                    onToggle={() => toggleMut.mutate(c)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
