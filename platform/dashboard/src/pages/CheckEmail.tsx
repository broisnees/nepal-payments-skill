import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Icon } from "../components/Icon.tsx";
import { toast } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { signupFor } from "../lib/signup.ts";
import { AuthLayout } from "./AuthLayout.tsx";

export default function CheckEmail() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const email = params.get("email") ?? "";
  const next = params.get("next") ?? "/";
  const [wait, setWait] = useState(30);
  // Back to the form the visitor came from, with the email filled in.
  const back = `${signupFor(email) ? "/signup" : "/signin"}?email=${encodeURIComponent(email)}`;

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const resend = async () => {
    setWait(30);
    try {
      const draft = signupFor(email);
      if (draft) await api("/auth/signup", { method: "POST", body: draft });
      else await api("/auth/login", { method: "POST", body: { email } });
      toast("Sent another link", { sub: email });
    } catch {
      toast("Could not send the link", { kind: "error" });
    }
  };

  return (
    <AuthLayout>
      <div className="card tone-sky" style={{ padding: 16, display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Icon name="mail" size={20} />
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ fontSize: 20, lineHeight: "28px" }}>Check your email</h1>
          <p className="muted">
            A link is on its way to <span className="ink">{email || "your inbox"}</span>. It works once and expires in 15 minutes.
          </p>
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {import.meta.env.VITE_MOCK === "1" && (
          <button
            className="btn btn-primary btn-lg"
            onClick={async () => {
              await api("/auth/mock-verify", { method: "POST" });
              location.assign(next);
            }}
          >
            Open the link (mock mode)
          </button>
        )}
        <button className="btn btn-secondary btn-lg" disabled={wait > 0 || !email} onClick={resend}>
          {wait > 0 ? <span className="num">Resend in {wait}s</span> : "Resend the link"}
        </button>
      </div>
      <p className="hint">
        Nothing after a minute? Check spam, or{" "}
        <Link className="inline-link" to={back} onClick={(e) => (e.preventDefault(), nav(back))}>
          use a different email
        </Link>
        .
      </p>
    </AuthLayout>
  );
}
