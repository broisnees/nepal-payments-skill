import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, errorMessage } from "../lib/api.ts";
import type { TestPaymentResult } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";
import { useProject } from "./Shell.tsx";
import { CodeBlock, Command, toast } from "./ui.tsx";

const WIRING = `import { createPaynp } from "@paynp/sdk";
import * as esewaModule from "./esewa";

const paynp = createPaynp({
  key: process.env.PAYNP_KEY,
});
export const esewa = paynp.wrapGateway("esewa", esewaModule);`;

/** Sends the same synthetic eSewa trace as `paynp test` to the test environment and opens it. */
export function useTestPayment() {
  const { project } = useProject();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<TestPaymentResult>(`/api/projects/${project.id}/test-payment`, { method: "POST" });
      toast("Test payment sent", { sub: "Rs 100.00 on eSewa. Watch it arrive." });
      nav(`/p/${project.id}/test/payments/${encodeURIComponent(r.attempt_id)}`);
    } catch (e) {
      toast("Could not send a test payment", { kind: "error", sub: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return { send, busy };
}

export function TestPaymentButton({ className = "btn btn-primary" }: { className?: string }) {
  const { send, busy } = useTestPayment();
  return (
    <button type="button" className={className} onClick={send} disabled={busy}>
      {busy ? <span className="spinner" /> : <Icon name="send" />}
      Send a test payment
    </button>
  );
}

/** The first thing a new project shows: three steps to the first event. */
export function SetupEmpty({ title }: { title?: string }) {
  const { env, base, local } = useProject();
  if (local) return <LocalSetup title={title} />;
  return (
    <section className="empty-hero fade-in" aria-labelledby="setup-title">
      <div className="empty-top">
        <span className={`tag ${env === "live" ? "tag-live" : "tag-test"}`} style={{ width: "fit-content" }}>
          {env === "live" ? "Live" : "Test"} environment
        </span>
        <h2 id="setup-title">{title ?? (env === "live" ? "No live payments yet" : "Connect your app to see payments here")}</h2>
        <p className="muted">
          {env === "live"
            ? "Live events arrive once the server runs with a live key. Test first, then swap the key."
            : "Your server sends events through a small SDK. Nothing about the payment itself goes through discerns, so a checkout never waits on it."}
        </p>
      </div>
      <div className="empty-steps">
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">01</span>
            <h3>Link the app</h3>
            <p className="hint">Detects the stack, creates a test key and writes PAYNP_KEY to .env.</p>
          </div>
          <div className="empty-step-do">
            <Command cmd="npx paynp init" />
          </div>
        </div>
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">02</span>
            <h3>Wrap the gateway</h3>
            <p className="hint">Three lines around the eSewa, Khalti or Fonepay module already in the app.</p>
          </div>
          <div className="empty-step-do">
            <CodeBlock code={WIRING} />
          </div>
        </div>
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">03</span>
            <h3>Check it works</h3>
            <p className="hint">A synthetic eSewa payment from start to fulfilment, in the test environment.</p>
          </div>
          <div className="empty-step-do">
            <div className="actions">
              <TestPaymentButton />
            </div>
            <p className="hint">
              Or run <code>npx paynp test</code>. {env === "live" && <Link className="inline-link" to={`${base}/settings/keys`}>Create a live key</Link>}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The empty state on `paynp dev`: no key, no account, just point the app at this server. */
function LocalSetup({ title }: { title?: string }) {
  const origin = location.origin;
  return (
    <section className="empty-hero fade-in" aria-labelledby="setup-title">
      <div className="empty-top">
        <span className="tag tag-local" style={{ width: "fit-content" }}>
          Local dev server
        </span>
        <h2 id="setup-title">{title ?? "Waiting for the first payment from your app"}</h2>
        <p className="muted">
          Events from your app land here and stay on this machine. No account, no key. Keep this tab open while you build and every
          payment shows up as it happens.
        </p>
      </div>
      <div className="empty-steps">
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">01</span>
            <h3>Install the SDK</h3>
            <p className="hint">Zero dependencies. Runs on Node, Bun, Deno and edge runtimes.</p>
          </div>
          <div className="empty-step-do">
            <Command cmd="npm install @paynp/sdk" />
          </div>
        </div>
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">02</span>
            <h3>Wrap the gateway</h3>
            <p className="hint">Three lines around the eSewa, Khalti or Fonepay module already in the app.</p>
          </div>
          <div className="empty-step-do">
            <CodeBlock code={WIRING} />
          </div>
        </div>
        <div className="empty-step">
          <div className="empty-step-text">
            <span className="step-n">03</span>
            <h3>Point it here</h3>
            <p className="hint">
              {origin === "http://localhost:4040"
                ? "Leave PAYNP_KEY unset and the SDK finds this server by itself whenever NODE_ENV is not production. Or say so in the app's .env:"
                : `This server is not on the default port, so tell the app where it is. With no PAYNP_KEY, PAYNP_DEV_URL=${origin} works too.`}
            </p>
          </div>
          <div className="empty-step-do">
            <CodeBlock code={`PAYNP_ENDPOINT=${origin}`} />
            <div className="actions">
              <TestPaymentButton className="btn btn-secondary" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
