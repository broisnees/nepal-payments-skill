// The landing page for signed-out visitors at "/". Every claim here comes from the specs and the code; the product
// panel runs the dashboard's own components on sample data.
import { DISPLAY_NAME, EVENT_TYPES, GATEWAYS, GATEWAY_LOGOS, SKILL_SITE_NAME, SKILL_SITE_URL, explain } from "@paynp/shared";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { CodeBlock, Command, Gateway, Money, StatusPill } from "../components/ui.tsx";
import { formatRelative, gatewayName } from "../lib/format.ts";
import { highlight } from "../lib/markdown.tsx";
import { PublicLayout } from "./PublicLayout.tsx";
import { samplePayments } from "./sample.ts";

const RULE_COUNT = 11; // RuleType in shared/src/api.ts

// From platform/sdk-ts/README.md, "Gateway modules from the blog".
const WIRE = `// paynp.ts
import { createPaynp } from "@paynp/sdk";
import * as esewa from "./esewa";

export const paynp = createPaynp({ key: process.env.PAYNP_KEY });
export const gateway = paynp.wrapGateway("esewa", esewa);`;

const FEATURES: { icon: IconName; title: string; body: string; doc: string }[] = [
  { icon: "list", title: "Payments and timelines", body: "Every attempt with its status, amount and references. Open one to see each step as a trace: redirect, callback, signature check, every gateway call with its duration.", doc: "introduction" },
  { icon: "activity", title: "Live tail", body: "Events as they arrive, with pause and filters, in the browser or in the terminal with paynp tail.", doc: "analytics#live" },
  { icon: "info", title: "Error explainer", body: "eSewa ES104, Khalti 401, Fonepay 409 and generic reasons like amount_mismatch come with the likely cause and the fix.", doc: "introduction" },
  { icon: "bell", title: "Alerts and channels", body: `${RULE_COUNT} rule types, from one failed payment to a slow gateway. Email, Slack, Discord or a signed webhook, with cooldowns and auto-resolve.`, doc: "alerts" },
  { icon: "chart", title: "Analytics", body: "Success rate, revenue, gateway latency and error rate, the checkout funnel, failure reasons, time to pay at p50 and p95.", doc: "analytics" },
  { icon: "mail", title: "Daily digest", body: "At 09:00 Nepal time: yesterday's payments, success rate, revenue, top failure reasons and open incidents.", doc: "analytics#daily-digest" },
  { icon: "undo", title: "Refunds and duplicates", body: "A paid-twice order becomes a refund case with the gateway's checklist. Khalti refunds run through a signed request to my own server.", doc: "operations#double-payments-and-the-refund-queue" },
  { icon: "file", title: "Reconcile", body: "Upload a settlement CSV and see matched rows, settlements paynp never saw, paid payments missing from the statement, and fees.", doc: "operations#settlement-reconciliation" },
  { icon: "download", title: "Exports", body: "Transactions, Tally-style and Hamrokhata CSVs, credit notes for refunds, and a Nepal fiscal year summary.", doc: "operations#exports" },
  { icon: "checkCircle", title: "Go-live checklist", body: "Sandbox credentials on live traffic, http return URLs, a return route that trusts the redirect. Checked on traffic and by paynp doctor.", doc: "go-live" },
  { icon: "monitor", title: "Status page", body: "A public page with each gateway's error rate and latency, from live traffic across at least 3 projects per minute.", doc: "status-page" },
  { icon: "terminal", title: "CLI", body: "login, init (writes the key and wires the SDK, diff first), tail, test, keys, doctor, and a local dev server with no account.", doc: "cli" },
];

export default function Landing() {
  useEffect(() => {
    document.title = `${DISPLAY_NAME}: payment observability for Nepali gateways`;
    return () => {
      document.title = DISPLAY_NAME;
    };
  }, []);

  return (
    <PublicLayout current="home">
      <main className="landing">
        <section className="pub-container pub-hero" aria-labelledby="hero-title">
          <span className="pub-badge">
            <span className="pub-badge-mark num">{GATEWAYS.length}</span>
            <span className="pub-badge-text">
              Nepali gateways, one dashboard
              <span className="mono">{EVENT_TYPES.length} event types · {RULE_COUNT} alert rules</span>
            </span>
          </span>
          <div className="pub-split">
            <h1 id="hero-title">Every payment, every gateway, one place.</h1>
            <div>
              <p className="pub-lede">
                {DISPLAY_NAME} records every payment attempt on eSewa, Khalti, Fonepay and seven more gateways as a timeline: what the gateway answered, how long it took, where it failed and why. The SDK only reports, so checkout never waits on it.
              </p>
              <div className="pub-actions">
                <Link className="btn pub-btn btn-primary" to="/signup">
                  Sign up
                </Link>
                <Link className="btn pub-btn btn-secondary" to="/docs/quickstart">
                  Read the quickstart
                  <Icon name="chevronRight" />
                </Link>
              </div>
              <p className="pub-fine subtle">Sign in with an email link, no password. Test and live environments from the first project.</p>
            </div>
          </div>
        </section>

        <section className="pub-container" aria-label="Product preview">
          <ProductPanel />
        </section>

        <section className="pub-container pub-logos" aria-labelledby="logos-title">
          <h2 id="logos-title" className="pub-kicker">
            Built for the {GATEWAYS.length} gateways the {SKILL_SITE_NAME} skill covers
          </h2>
          <ul>
            {GATEWAYS.filter((g) => GATEWAY_LOGOS[g]).map((g) => (
              <li key={g}>
                <Gateway id={g} logo size={22} />
              </li>
            ))}
          </ul>
        </section>

        <section className="pub-container pub-section" aria-labelledby="wire-title">
          <div className="pub-split pub-head">
            <h2 id="wire-title">Three lines to wire it</h2>
            <p>Wrap the gateway module once. The wrapped module keeps the same functions and types, and rethrows exactly what the original threw. The skill's adapters wrap the same way with wrapAdapter.</p>
          </div>
          <div className="pub-wire">
            <div className="pub-code">
              <div className="pub-code-bar">
                <span className="mono">paynp.ts</span>
              </div>
              <CodeBlock code={WIRE}>{highlight(WIRE, "ts")}</CodeBlock>
            </div>
            <div className="pub-wire-side">
              <p className="pub-kicker">Or let the CLI do it</p>
              <Command cmd="npx paynp init" />
              <p className="muted">
                It creates a test key, writes <code>PAYNP_KEY</code> to <code>.env</code>, installs <code>@paynp/sdk</code> and wires Express, Hono, Fastify or Next.js. It shows the diff and asks once before changing a file.
              </p>
              <Command cmd="npx paynp test" />
              <p className="muted">Sends a sample eSewa payment with the test key and prints the link to its timeline.</p>
            </div>
          </div>
        </section>

        <section className="pub-container pub-section" aria-labelledby="how-title">
          <div className="pub-split pub-head">
            <h2 id="how-title">How it works</h2>
            <p>Nothing about the payment itself goes through {DISPLAY_NAME}. If it is down, slow, or the key is wrong, checkout behaves exactly as before.</p>
          </div>
          <ol className="pub-flow">
            <li>
              <span className="pub-step mono">01 · My server</span>
              <h3>The SDK records</h3>
              <p>It wraps startPayment and confirmPayment (or initiate and verify), times each gateway call, and queues events in memory. A background send every 2 seconds; zero dependencies.</p>
            </li>
            <li>
              <span className="pub-step mono">02 · POST /v1/events</span>
              <h3>Ingest checks and redacts</h3>
              <p>Each event is validated and redacted again, stored once per event id, rolled up into one row per payment and pushed to everyone watching live.</p>
            </li>
            <li>
              <span className="pub-step mono">03 · Dashboard and alerts</span>
              <h3>I see it, or get told</h3>
              <p>Timelines, analytics and the live tail in the browser. Alert rules run on ingest and every minute, and post to the channels I chose.</p>
            </li>
          </ol>
        </section>

        <section className="pub-container pub-section" aria-labelledby="features-title">
          <div className="pub-split pub-head">
            <h2 id="features-title">Watch payments, then run them</h2>
            <p>From the first sandbox payment to settlement day: the timeline that shows why a payment failed, and the tools that follow from it.</p>
          </div>
          <ul className="pub-features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <Link to={`/docs/${f.doc}`}>
                  <Icon name={f.icon} size={18} />
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="pub-container pub-section" aria-labelledby="privacy-title">
          <div className="pub-split pub-head">
            <h2 id="privacy-title">What leaves the server, and what never does</h2>
            <p>The SDK and the ingest API run the same redaction code, so an event is cleaned before it is queued and again before it is stored.</p>
          </div>
          <div className="pub-privacy">
            <div>
              <p className="pub-kicker">Sent</p>
              <ul className="pub-checks" data-kind="yes">
                <li>Event type, attempt id, order id, gateway, amount and status</li>
                <li>Gateway status codes and references, like a Khalti pidx as provider_ref</li>
                <li>Gateway call timings, HTTP status and the path, never the query string</li>
                <li>Only 19 allowlisted data keys; unknown keys are dropped</li>
              </ul>
            </div>
            <div>
              <p className="pub-kicker">Never sent</p>
              <ul className="pub-checks" data-kind="no">
                <li>Gateway secret keys: refunds run on my server, through a signed request</li>
                <li>Signatures and raw callback bodies</li>
                <li>Card numbers and key blocks: any string that looks like one is removed</li>
                <li>Raw phone numbers and emails: only a salted hash and a masked form are stored</li>
              </ul>
            </div>
            <p className="pub-privacy-foot muted">
              Strings are cut at 500 characters. Events are kept 30 days, payments and analytics 400 days. <Link className="inline-link" to="/docs/events#redaction">How redaction works</Link>
            </p>
          </div>
        </section>

        <section className="pub-container pub-section" aria-labelledby="sister-title">
          <div className="pub-sister">
            <div>
              <p className="pub-kicker">The other half</p>
              <h2 id="sister-title">Integrating a gateway first? Start with the skill.</h2>
              <p className="muted">
                {SKILL_SITE_NAME} is an open-source Agent Skill with tested adapters for the same {GATEWAYS.length} gateways in TypeScript, Python, Go, Java, Kotlin and PHP. It builds the integration; {DISPLAY_NAME} watches it run.
              </p>
            </div>
            <a className="btn pub-btn btn-secondary" href={SKILL_SITE_URL}>
              Open {SKILL_SITE_NAME}
              <Icon name="arrowUpRight" />
            </a>
          </div>
        </section>

        <section className="pub-container pub-section" aria-labelledby="cta-title">
          <div className="pub-cta-card">
            <h2 id="cta-title">Wire it in, then watch the first payment arrive.</h2>
            <div className="pub-actions">
              <Link className="btn pub-btn btn-primary" to="/signup">
                Sign up
              </Link>
              <Link className="btn pub-btn btn-secondary" to="/docs">
                Docs
              </Link>
            </div>
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}

const TABS = ["Overview", "Payments", "Live", "Analytics", "Refunds", "Alerts"];

/** A slice of the Payments page and a payment's timeline, on sample data. Rows are buttons that switch the trace. */
function ProductPanel() {
  const [now] = useState(() => Date.now());
  const samples = useMemo(() => samplePayments(now), [now]);
  const [sel, setSel] = useState(1);
  const s = samples[sel];
  const last = [...s.events].reverse();
  const ex = explain({
    gateway: s.payment.gateway,
    provider_code: last.find((e) => e.data?.provider_code)?.data?.provider_code,
    reason: s.payment.last_reason,
    provider_status: last.find((e) => e.data?.provider_status)?.data?.provider_status,
  });
  const bad = s.payment.status === "failed" || s.payment.status === "expired";

  return (
    <div className="pub-panel">
      <div className="pub-panel-bar">
        <span className="pub-panel-tabs" aria-hidden="true">
          {TABS.map((t) => (
            <span key={t} data-on={t === "Payments" || undefined}>
              {t}
            </span>
          ))}
        </span>
        <span className="tag">Sample data</span>
      </div>
      <div className="pub-panel-body">
        <div className="pub-panel-list">
          <table className="t">
            <caption className="sr-only">Sample payments. Select one to see its timeline.</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col" className="r">
                  Amount
                </th>
                <th scope="col">Gateway</th>
                <th scope="col" className="hide-xs">
                  Order
                </th>
                <th scope="col" className="r hide-xs">
                  Started
                </th>
              </tr>
            </thead>
            <tbody>
              {samples.map((x, i) => (
                <tr key={x.payment.attempt_id} className="clickable" data-selected={i === sel || undefined}>
                  <td>
                    <button type="button" className="pub-row-btn" aria-pressed={i === sel} aria-label={`${gatewayName(x.payment.gateway)} payment ${x.payment.order_id}, ${x.payment.status}`} onClick={() => setSel(i)} />
                    <StatusPill status={x.payment.status} pulse={x.payment.status === "pending"} />
                  </td>
                  <td className="r">
                    <Money paisa={x.payment.amount_paisa} />
                  </td>
                  <td>
                    <Gateway id={x.payment.gateway} />
                  </td>
                  <td className="mono hide-xs">{x.payment.order_id}</td>
                  <td className="r subtle hide-xs num">{formatRelative(x.payment.started_at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pub-panel-detail" aria-live="polite">
          <div className="pub-panel-head">
            <span className="pub-panel-amount">
              <Money paisa={s.payment.amount_paisa} />
            </span>
            <StatusPill status={s.payment.status} pulse={s.payment.status === "pending"} />
            <span className="subtle mono">{s.payment.order_id}</span>
          </div>
          {ex && (
            <section className={`card ${bad ? "tone-rose" : "tone-cream"}`} aria-label="Explanation">
              <div className="explain">
                <div className="ex-title">
                  <Icon name="alert" />
                  {ex.title}
                </div>
                <dl>
                  <div>
                    <dt>Cause</dt>
                    <dd>{ex.cause}</dd>
                  </div>
                  <div>
                    <dt>Fix</dt>
                    <dd>{ex.fix}</dd>
                  </div>
                </dl>
              </div>
            </section>
          )}
          <Timeline key={s.payment.attempt_id} p={s.payment} events={s.events} />
        </div>
      </div>
    </div>
  );
}
