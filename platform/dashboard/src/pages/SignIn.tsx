import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, errorMessage } from "../lib/api.ts";
import { Icon } from "../components/Icon.tsx";
import { saveNext } from "../components/Shell.tsx";
import { AuthLayout } from "./AuthLayout.tsx";

export default function SignIn() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [busy, setBusy] = useState(false);
  const linkError = params.get("error");
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return setErr("Enter the email address you use for work");
    setErr("");
    setBusy(true);
    try {
      await api("/auth/login", { method: "POST", body: { email: v } });
      saveNext(params.get("next"));
      const q = new URLSearchParams({ email: v });
      if (params.get("next")) q.set("next", params.get("next")!);
      nav(`/signin/check?${q}`);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Sign in to paynp</h1>
        <p className="lead">We email a link that signs you in. No password to remember.</p>
      </div>
      {linkError && (
        <div className="card tone-rose" role="alert" style={{ padding: "12px 14px", display: "flex", gap: 10 }}>
          <Icon name="alert" />
          <span>
            {linkError === "invalid_invite"
              ? "That invite link has expired or was already used. Ask for a new invite, or sign in if you already joined."
              : "That sign-in link has expired or was already used. Links work once, for 15 minutes. Request a new one below."}
          </span>
        </div>
      )}
      <form className="stack" onSubmit={submit} noValidate>
        <label className="field">
          <span className="label">Email</span>
          <input
            className="input input-lg"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            placeholder="you@company.com.np"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!err || undefined}
            aria-describedby={err ? "email-err" : undefined}
          />
          {err && (
            <span className="err" id="email-err">
              {err}
            </span>
          )}
        </label>
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy && <span className="spinner" />}
          Email me a sign-in link
        </button>
      </form>
      <p className="hint">New here? The same link creates the account, a personal organization and a first project.</p>
    </AuthLayout>
  );
}
