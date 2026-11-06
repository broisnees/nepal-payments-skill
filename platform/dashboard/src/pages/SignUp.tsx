import { DISPLAY_NAME } from "@paynp/shared";
import { useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { saveNext } from "../components/Shell.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { rememberSignup } from "../lib/signup.ts";
import { AuthLayout } from "./AuthLayout.tsx";

type Field = "name" | "email" | "org";
const MAX = 80;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Same rules as POST /auth/signup: required, at most 80 characters, a real-looking email. */
function check(v: Record<Field, string>): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (!v.name.trim()) e.name = "Enter your name";
  else if (v.name.trim().length > MAX) e.name = `Keep it under ${MAX} characters`;
  if (!v.email.trim()) e.email = "Enter your work email";
  else if (!EMAIL.test(v.email.trim()) || v.email.trim().length > 254) e.email = "Enter an email like name@company.com.np";
  if (!v.org.trim()) e.org = "Enter your company or organization";
  else if (v.org.trim().length > MAX) e.org = `Keep it under ${MAX} characters`;
  return e;
}

export default function SignUp() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [v, setV] = useState<Record<Field, string>>({ name: "", email: params.get("email") ?? "", org: "" });
  const [errs, setErrs] = useState<Partial<Record<Field, string>>>({});
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refs = { name: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null), org: useRef<HTMLInputElement>(null) };

  const set = (k: Field) => (e: ChangeEvent<HTMLInputElement>) => {
    setV((o) => ({ ...o, [k]: e.target.value }));
    // Clear a field's error as soon as it is edited; it is checked again on submit.
    if (errs[k]) setErrs((o) => ({ ...o, [k]: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = check(v);
    setErrs(found);
    setFormErr("");
    const first = (["name", "email", "org"] as const).find((k) => found[k]);
    if (first) return refs[first].current?.focus();
    const body = { name: v.name.trim().replace(/\s+/g, " "), email: v.email.trim().toLowerCase(), org: v.org.trim().replace(/\s+/g, " ") };
    setBusy(true);
    try {
      await api("/auth/signup", { method: "POST", body });
      rememberSignup(body);
      saveNext(params.get("next"));
      nav(`/signin/check?${new URLSearchParams({ email: body.email })}`);
    } catch (err) {
      setFormErr(errorMessage(err));
      setBusy(false);
    }
  };

  const field = (k: Field, label: string, hint: string, input: InputHTMLAttributes<HTMLInputElement>) => (
    <div className="field">
      <label className="label" htmlFor={`su-${k}`}>
        {label}
      </label>
      <input
        ref={refs[k]}
        id={`su-${k}`}
        name={k}
        className="input input-lg"
        value={v[k]}
        onChange={set(k)}
        required
        aria-invalid={!!errs[k] || undefined}
        aria-describedby={`su-${k}-hint${errs[k] ? ` su-${k}-err` : ""}`}
        {...input}
      />
      <span className="hint" id={`su-${k}-hint`}>
        {hint}
      </span>
      {errs[k] && (
        <span className="err" id={`su-${k}-err`}>
          {errs[k]}
        </span>
      )}
    </div>
  );

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
      <form className="stack" onSubmit={submit} noValidate aria-label="Sign up">
        {field("name", "Name", "Shown to teammates and in alert emails.", { type: "text", autoComplete: "name", autoFocus: true, maxLength: MAX + 20, placeholder: "Sita Sharma" })}
        {field("email", "Work email", "The sign-in link goes here.", { type: "email", autoComplete: "email", inputMode: "email", maxLength: 254, placeholder: "sita@company.com.np", spellCheck: false })}
        {field("org", "Company or organization", "The organization that owns your projects. Teammates join it by invite.", { type: "text", autoComplete: "organization", maxLength: MAX + 20, placeholder: "Himalayan Threads" })}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy && <span className="spinner" />}
          Email me a link
        </button>
      </form>
      <p className="hint">
        Already have an account?{" "}
        <Link className="inline-link" to={`/signin${v.email.trim() ? `?email=${encodeURIComponent(v.email.trim())}` : ""}`}>
          Sign in
        </Link>
        . An email that already has an account just signs in; its name and organization stay as they are.
      </p>
    </AuthLayout>
  );
}
