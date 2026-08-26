import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// Doubles as first-run setup: with no users in the database this same form
// creates the first account, then never offers to again.
export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["auth-state"],
    queryFn: () => api.get<{ needsSetup: boolean }>("/api/auth/state"),
    retry: false,
  });
  const needsSetup = data?.needsSetup ?? false;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(needsSetup ? "/api/auth/setup" : "/api/auth/login", { email, password });
      navigate("/");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="card-head" style={{ justifyContent: "center" }}>
          <span className="brand-mark">PA</span>
          <strong style={{ fontSize: "1.05rem", letterSpacing: "-0.02em" }}>Photo Archive</strong>
        </div>
        <div className="card-body">
          <p className="sub">
            {needsSetup
              ? "Nobody has signed in here yet. The email and password you enter become the first account."
              : "Sign in to run and manage client archives."}
          </p>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={needsSetup ? "new-password" : "current-password"}
              required
              minLength={8}
            />
            {needsSetup && <span className="help">At least 8 characters.</span>}
          </label>
          {error && <div className="notice notice-bad">{error}</div>}
          <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }} disabled={busy}>
            {busy ? "Working…" : needsSetup ? "Create account" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
