import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

type State = "verifying" | "success" | "error";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, setState] = useState<State>("verifying");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!token) {
      setErrorMsg("Missing verification token.");
      setState("error");
      return;
    }
    axios
      .get(`${API_BASE}/auth/verify-email`, { params: { token } })
      .then(() => setState("success"))
      .catch((err) => {
        const detail = err.response?.data?.detail;
        setErrorMsg(
          typeof detail === "string" ? detail : "The link is invalid or has already been used."
        );
        setState("error");
      });
  }, [token]);

  return (
    <div className="auth-container">
      <div className="auth-card" style={{ textAlign: "center" }}>
        <h1>
          <span style={{ width:28,height:28,borderRadius:7,background:"var(--brand)",display:"inline-flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:800,fontSize:14 }}>E</span>
          EvidencePlatform
        </h1>

        {state === "verifying" && (
          <>
            <div style={{ fontSize: 40, margin: "24px 0" }}>⏳</div>
            <h2>Verifying your email…</h2>
          </>
        )}

        {state === "success" && (
          <>
            <div style={{ fontSize: 40, margin: "24px 0" }}>✅</div>
            <h2>Email verified!</h2>
            <p style={{ color: "var(--text-muted)", marginBottom: 24 }}>
              Your email address has been confirmed.
            </p>
            <Link to="/projects" className="btn-primary" style={{ display: "inline-block" }}>
              Go to projects
            </Link>
          </>
        )}

        {state === "error" && (
          <>
            <div style={{ fontSize: 40, margin: "24px 0" }}>❌</div>
            <h2>Verification failed</h2>
            <p style={{ color: "var(--text-muted)", marginBottom: 24 }}>{errorMsg}</p>
            <Link to="/projects" className="btn-primary" style={{ display: "inline-block" }}>
              Go to projects
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
