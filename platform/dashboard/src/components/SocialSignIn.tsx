import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api.ts";
import { Icon } from "./Icon.tsx";

type Provider = "github" | "google";
const LABEL: Record<Provider, string> = { github: "GitHub", google: "Google" };

/** GitHub and Google sign-in through Better Auth. Renders nothing until the Worker reports a provider is configured. */
export function SocialSignIn({ next }: { next?: string | null }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [busy, setBusy] = useState<Provider | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    // The local dev server has no accounts and answers 404 here; that just means no buttons.
    api<{ social: Provider[] }>("/auth/providers")
      .then((r) => setProviders(r.social))
      .catch(() => setProviders([]));
  }, []);

  if (!providers.length) return null;

  const go = async (provider: Provider) => {
    setBusy(provider);
    setErr("");
    try {
      const callbackURL = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      const r = await api<{ url: string }>("/auth/sign-in/social", { method: "POST", body: { provider, callbackURL, errorCallbackURL: "/signin" } });
      window.location.assign(r.url);
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(null);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {providers.map((p) => (
        <button key={p} type="button" className="btn btn-lg" disabled={busy !== null} onClick={() => go(p)}>
          {busy === p ? <span className="spinner" /> : <Icon name={p} size={18} />}
          Continue with {LABEL[p]}
        </button>
      ))}
      {err && <span className="err">{err}</span>}
      <div className="divider-text" role="separator">
        or
      </div>
    </div>
  );
}
