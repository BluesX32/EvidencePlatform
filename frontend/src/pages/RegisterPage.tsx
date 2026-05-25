import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { authApi, setToken } from "../api/client";

export default function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.register(email, password, inviteCode.trim() || undefined);
      setToken(res.data.access_token);
      navigate("/projects");
    } catch (err: any) {
      const detail = err.response?.data?.detail;
      if (typeof detail === "string") {
        setError(detail);
      } else if (Array.isArray(detail) && detail.length > 0) {
        setError(detail[0].msg ?? "Validation error");
      } else {
        setError("Registration failed — please check your connection and try again");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>
          <span style={{ width:28,height:28,borderRadius:7,background:"var(--brand)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:14 }}>E</span>
          EvidencePlatform
        </h1>
        <h2>Create your account</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password (8+ characters)</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="invite-code">
              Invite code
              <span style={{ marginLeft:6, fontSize:11, fontWeight:500, color:"var(--text-muted)" }}>
                format: EVP-XXXX-XXXX
              </span>
            </label>
            <input
              id="invite-code"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="EVP-XXXX-XXXX"
              spellCheck={false}
              autoComplete="off"
              style={{ fontFamily: "monospace", letterSpacing: "0.05em" }}
            />
          </div>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="auth-link">
          Have an account? <Link to="/login">Sign in</Link>
        </p>
        <p className="auth-link" style={{ marginTop: 0 }}>
          <Link to="/">← Back to home</Link>
        </p>
      </div>
    </div>
  );
}
