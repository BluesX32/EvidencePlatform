import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/client";

const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const lbl: React.CSSProperties  = { fontSize: 13, fontWeight: 600, color: "#374151" };
const inp: React.CSSProperties  = {
  padding: "0.5rem 0.7rem", border: "1px solid #cbd5e1", borderRadius: 8,
  fontSize: 14, outline: "none", width: "100%", boxSizing: "border-box",
  background: "#fff",
};
const inpDisabled: React.CSSProperties = { ...inp, background: "#f8fafc", color: "#94a3b8", cursor: "not-allowed" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden", marginBottom: "1.5rem" }}>
      <div style={{ padding: "1rem 1.5rem", borderBottom: "1px solid #f1f5f9" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{title}</h2>
      </div>
      <div style={{ padding: "1.25rem 1.5rem" }}>{children}</div>
    </div>
  );
}

// ── Profile section ────────────────────────────────────────────────────────────

function ProfileSection() {
  const qc = useQueryClient();
  const { data: profile } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => authApi.me().then(r => r.data),
    staleTime: 5 * 60_000,
  });

  const [name, setName] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);

  const mut = useMutation({
    mutationFn: (n: string) => authApi.updateProfile(n),
    onSuccess: (res) => {
      qc.setQueryData(["auth-me"], res.data);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  function startEdit() {
    setName(profile?.name ?? "");
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setName("");
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim()) mut.mutate(name.trim());
  }

  return (
    <Section title="Profile">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", maxWidth: 540 }}>
        <div style={field}>
          <label style={lbl}>Display name</label>
          {editing ? (
            <form onSubmit={save} style={{ display: "flex", gap: 8 }}>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                style={{ ...inp, flex: 1 }}
                required
              />
              <button type="submit" className="btn-primary btn-sm" disabled={mut.isPending}>
                {mut.isPending ? "…" : "Save"}
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={cancel}>Cancel</button>
            </form>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ ...inp, flex: 1, color: "#0f172a" }}>{profile?.name}</span>
              <button className="btn-ghost btn-sm" onClick={startEdit}>Edit</button>
            </div>
          )}
          {saved && <span style={{ fontSize: 12, color: "#059669" }}>Name updated ✓</span>}
        </div>
        <div style={field}>
          <label style={lbl}>Email address</label>
          <input value={profile?.email ?? ""} disabled style={inpDisabled} readOnly />
          <span style={{ fontSize: 11.5, color: "#94a3b8" }}>Email cannot be changed</span>
        </div>
      </div>
    </Section>
  );
}

// ── Password section ───────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent]   = useState("");
  const [next, setNext]         = useState("");
  const [confirm, setConfirm]   = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [success, setSuccess]   = useState(false);

  const mut = useMutation({
    mutationFn: () => authApi.changePassword(current, next),
    onSuccess: () => {
      setSuccess(true);
      setCurrent(""); setNext(""); setConfirm("");
      setError(null);
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? "Password change failed — please try again.");
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (next.length < 8)    { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm)   { setError("New passwords do not match."); return; }
    if (next === current)   { setError("New password must differ from the current one."); return; }
    mut.mutate();
  }

  return (
    <Section title="Change password">
      {success ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          background: "#f0fdf4", border: "1px solid #86efac",
          borderRadius: 8, padding: "0.85rem 1.1rem", maxWidth: 400,
        }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <div>
            <div style={{ fontWeight: 700, color: "#166534", fontSize: 14 }}>Password updated</div>
            <div style={{ color: "#15803d", fontSize: 13, marginTop: 2 }}>
              Your new password is active.{" "}
              <button
                onClick={() => setSuccess(false)}
                style={{ background: "none", border: "none", color: "#15803d", cursor: "pointer", fontSize: 13, padding: 0, textDecoration: "underline" }}
              >
                Change again
              </button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 380 }}>
          <div style={field}>
            <label style={lbl} htmlFor="cp-current">Current password</label>
            <input
              id="cp-current" type="password"
              value={current} onChange={e => setCurrent(e.target.value)}
              required autoComplete="current-password" style={inp}
              placeholder="Enter your current password"
            />
          </div>
          <div style={field}>
            <label style={lbl} htmlFor="cp-new">New password</label>
            <input
              id="cp-new" type="password"
              value={next} onChange={e => setNext(e.target.value)}
              required autoComplete="new-password" style={inp}
              placeholder="At least 8 characters"
            />
          </div>
          <div style={field}>
            <label style={lbl} htmlFor="cp-confirm">Confirm new password</label>
            <input
              id="cp-confirm" type="password"
              value={confirm} onChange={e => setConfirm(e.target.value)}
              required autoComplete="new-password" style={inp}
              placeholder="Repeat your new password"
            />
            {next && confirm && next !== confirm && (
              <span style={{ fontSize: 12, color: "#dc2626" }}>Passwords do not match</span>
            )}
            {next && confirm && next === confirm && next.length >= 8 && (
              <span style={{ fontSize: 12, color: "#059669" }}>Passwords match ✓</span>
            )}
          </div>
          {error && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca",
              borderRadius: 7, padding: "0.6rem 0.85rem",
              fontSize: 13, color: "#dc2626",
            }}>
              {error}
            </div>
          )}
          <div>
            <button
              type="submit"
              className="btn-primary"
              disabled={mut.isPending || !current || !next || !confirm}
              style={{ minWidth: 160 }}
            >
              {mut.isPending ? "Updating…" : "Update password"}
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div style={{ padding: "2rem 2.5rem", maxWidth: 700 }}>
      <div style={{ marginBottom: "1.75rem" }}>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.5rem", fontWeight: 800, color: "#0f172a" }}>
          Account settings
        </h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 14 }}>
          Manage your profile and security preferences.
        </p>
      </div>
      <ProfileSection />
      <PasswordSection />
    </div>
  );
}
