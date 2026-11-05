import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { lastProject, useMe } from "../components/Shell.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { AuthLayout } from "./AuthLayout.tsx";

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function normalize(v: string) {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export default function Device() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const code = normalize(params.get("code") ?? "");
  const [draft, setDraft] = useState(code);
  const [state, setState] = useState<"idle" | "busy" | "approved" | "denied">("idle");
  const [err, setErr] = useState("");

  const approve = async () => {
    setErr("");
    setState("busy");
    try {
      await api("/api/device/approve", { method: "POST", body: { user_code: code } });
      setState("approved");
    } catch (e) {
      setErr(errorMessage(e));
      setState("idle");
    }
  };

  if (state === "approved")
    return (
      <AuthLayout>
        <div className="card tone-mint" style={{ padding: 16, display: "flex", gap: 12 }}>
          <Icon name="check" size={20} />
          <div className="stack" style={{ gap: 4 }}>
            <h1 style={{ fontSize: 20, lineHeight: "28px" }}>The CLI is signed in</h1>
            <p className="muted">Go back to the terminal. This tab can be closed.</p>
          </div>
        </div>
        <p className="hint">
          The token shows up under{" "}
          <Link className="inline-link" to={(() => { const l = lastProject(); return l ? `/p/${l.project}/${l.env}/settings/tokens` : "/"; })()}>
            Settings, CLI tokens
          </Link>{" "}
          and can be revoked there at any time.
        </p>
      </AuthLayout>
    );

  if (state === "denied")
    return (
      <AuthLayout>
        <div className="stack" style={{ gap: 6 }}>
          <h1>Request canceled</h1>
          <p className="lead">Nothing was approved. The CLI stops waiting when the code expires.</p>
        </div>
        <Link className="btn btn-secondary btn-lg" to="/">
          Go to the dashboard
        </Link>
      </AuthLayout>
    );

  if (!CODE.test(code))
    return (
      <AuthLayout>
        <div className="stack" style={{ gap: 6 }}>
          <h1>Connect the paynp CLI</h1>
          <p className="lead">Enter the code shown in the terminal after paynp login.</p>
        </div>
        <form
          className="stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (CODE.test(draft)) setParams({ code: draft });
            else setErr("The code has 8 letters or digits, like ABCD-EFGH");
          }}
        >
          <label className="field">
            <span className="label">Code</span>
            <input className="input input-lg mono" autoFocus autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH" value={draft} onChange={(e) => setDraft(normalize(e.target.value))} style={{ letterSpacing: "0.08em" }} />
            {err && <span className="err">{err}</span>}
          </label>
          <button className="btn btn-primary btn-lg">Continue</button>
        </form>
      </AuthLayout>
    );

  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Approve the CLI sign-in?</h1>
        <p className="lead">
          A terminal asked to act as <span className="ink">{me.user.email}</span>. Check that the code matches what it shows.
        </p>
      </div>
      <div className="device-code" aria-label={`Code ${code}`}>
        <span>{code.slice(0, 4)}</span>
        <span className="dash">-</span>
        <span>{code.slice(5)}</span>
      </div>
      <div className="note">
        <Icon name="shield" />
        <span>Only approve if you ran paynp login yourself just now. The CLI gets the same access you have in every organization.</span>
      </div>
      {err && <p className="err">{err}</p>}
      <div className="stack" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-lg" onClick={approve} disabled={state === "busy"}>
          {state === "busy" && <span className="spinner" />}
          Approve sign-in
        </button>
        <button className="btn btn-secondary btn-lg" onClick={() => setState("denied")} disabled={state === "busy"}>
          Cancel
        </button>
      </div>
    </AuthLayout>
  );
}
