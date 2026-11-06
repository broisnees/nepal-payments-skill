import { DISPLAY_NAME } from "@paynp/shared";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { saveNext } from "../components/Shell.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { SocialSignIn } from "../components/SocialSignIn.tsx";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function SignUp() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [err, setErr] = useState("");
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = email.trim().toLowerCase();
    if (!v) return setErr("Enter your work email"), ref.current?.focus();
    if (!EMAIL.test(v) || v.length > 254) return setErr("Enter an email like name@company.com.np"), ref.current?.focus();
    setErr("");
    setFormErr("");
    setBusy(true);
    try {
      // The account, its organization and a first project are created when the link is opened.
      await api("/auth/signup", { method: "POST", body: { email: v } });
      saveNext(params.get("next"));
      nav(`/signin/check?${new URLSearchParams({ email: v })}`);
    } catch (e) {
      setFormErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <AuthLayout current="signup">
      <div className="stack" style={{ gap: 6 }}>
        <h1>Create your {DISPLAY_NAME} account</h1>
        <p className="lead">We email a link to confirm the address. It creates the account, an organization and a first project with test and live environments.</p>
      </div>
      {formErr && (
        <div className="card tone-rose" role="alert" style={{ padding: "12px 14px", display: "flex", gap: 10 }}>
          <Icon name="alert" />
          <span>{formErr}</span>
        </div>
      )}
      <SocialSignIn next={params.get("next")} />
      <form className="stack" onSubmit={submit} noValidate aria-label="Sign up">
        <div className="field">
          <label className="label" htmlFor="su-email">
            Work email
          </label>
          <input
            ref={ref}
            id="su-email"
            name="email"
            className="input input-lg"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            maxLength={254}
            spellCheck={false}
            placeholder="you@company.com.np"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (err) setErr("");
            }}
            required
            aria-invalid={!!err || undefined}
            aria-describedby={`su-email-hint${err ? " su-email-err" : ""}`}
          />
          <span className="hint" id="su-email-hint">
            The sign-in link goes here.
          </span>
          {err && (
            <span className="err" id="su-email-err">
              {err}
            </span>
          )}
        </div>
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy && <span className="spinner" />}
          Email me a link
        </button>
      </form>
      <p className="hint">
        Already have an account?{" "}
        <Link className="inline-link" to={`/signin${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ""}`}>
          Sign in
        </Link>
        . An email that already has an account just signs in.
      </p>
    </AuthLayout>
  );
}
