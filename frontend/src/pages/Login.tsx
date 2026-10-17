import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { errorText } from "../api";
import { useAuth } from "../auth";

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await (mode === "login" ? login : register)(username, password);
      navigate(params.get("next") || "/library");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="panel auth-panel" onSubmit={submit}>
        <div className="seg seg-full">
          <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>
            Log in
          </button>
          <button type="button" className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>
            Sign up
          </button>
        </div>
        <h1 className="display">{mode === "login" ? "Welcome back" : "Get an account"}</h1>
        <p className="muted">
          {mode === "login"
            ? "You only need an account to make quizzes or assignments. Playing never needs one."
            : "Create quizzes, host games, and track assignment scores."}
        </p>
        <label className="field">
          <span>Username</span>
          <input
            className="input"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : undefined}
          />
          {mode === "register" && <small className="muted">At least 8 characters.</small>}
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? "One sec…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
