import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

// Doubles as first-run setup: with no users in the database the same form
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
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" />Photo Archive</div>
        <p className="hint" style={{ margin: 0 }}>
          {needsSetup
            ? "No account exists yet. The email and password you enter here become the first one."
            : "Sign in to run and manage client archives."}
        </p>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? "new-password" : "current-password"}
            required
            minLength={8}
          />
        </label>
        {error && <div className="flash flash-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Working…" : needsSetup ? "Create account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
