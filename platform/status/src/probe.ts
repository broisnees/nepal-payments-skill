// Calls each gateway's production API once a minute (from the platform Worker's minute cron; the free plan has no
// cron trigger to spare for the status Worker) and records whether it answered and how fast. No credentials and
// no transactions: each probe hits a status or lookup endpoint that refuses an empty request with a 4xx, which proves
// the API is up. A probe fails on a network error, a timeout, or a 5xx.
import { H_COLS, bucketOf } from "../../worker/src/status/buckets.ts";

export const PROBE_TIMEOUT_MS = 10_000;
export const USER_AGENT = "discerns-status-probe/1.0 (+https://status.discerns.app/developers#method)";

export interface Probe {
  gateway: string;
  /** What is called, shown on the methodology page. */
  method: "GET" | "POST";
  url: string;
  body?: string;
}

/**
 * One endpoint per gateway, from skills/nepal-payments/references. IME Pay is left out: its API only answers servers
 * IME has whitelisted, so an outside probe would always read as down.
 */
export const PROBES: Probe[] = [
  { gateway: "esewa", method: "GET", url: "https://epay.esewa.com.np/api/epay/transaction/status/?product_code=EPAYTEST&total_amount=10&transaction_uuid=discerns-status-probe" },
  { gateway: "khalti", method: "POST", url: "https://khalti.com/api/v2/epayment/lookup/", body: "{}" },
  { gateway: "fonepay", method: "GET", url: "https://clientapi.fonepay.com/api/merchantRequest" },
  { gateway: "connectips", method: "POST", url: "https://login.connectips.com/connectipswebws/api/creditor/validatetxn", body: "{}" },
  { gateway: "cybersource", method: "GET", url: "https://secureacceptance.cybersource.com/pay" },
  { gateway: "nps", method: "POST", url: "https://apigateway.nepalpayment.com/CheckTransactionStatus", body: "{}" },
  { gateway: "nepalpay", method: "POST", url: "https://opennpi.connectips.com/qr/generateQR", body: "{}" },
  { gateway: "hamropay", method: "POST", url: "https://payclient.hamropatro.com/v1/checkout/transaction", body: "{}" },
  { gateway: "getpay", method: "GET", url: "https://ecom-getpay.nchl.com.np/ecom-web-checkout/v1/secure-merchant/transactions" },
];

export const UNMONITORED: Record<string, string> = {
  imepay: "IME Pay's API only answers servers that IME has whitelisted, so it cannot be checked from outside.",
};

export interface ProbeResult {
  gateway: string;
  ok: boolean;
  ms: number;
  http_status: number | null;
  error: string | null;
}

export async function runProbe(p: Probe, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetcher(p.url, {
      method: p.method,
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...(p.body ? { "content-type": "application/json" } : {}) },
      body: p.body,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    const ms = Date.now() - t0;
    return { gateway: p.gateway, ok: res.status < 500, ms, http_status: res.status, error: res.status >= 500 ? `HTTP ${res.status}` : null };
  } catch (e) {
    const ms = Date.now() - t0;
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { gateway: p.gateway, ok: false, ms, http_status: null, error: timeout ? `no answer in ${PROBE_TIMEOUT_MS / 1000} s` : "connection failed" };
  }
}

/**
 * Runs every probe in parallel and stores one probe_minutes row per gateway for this minute, in one statement: it
 * runs inside the platform Worker's minute cron, which shares the free plan's 50-query budget with alerts.
 */
export async function runProbes(env: Env, t = Date.now(), fetcher: typeof fetch = fetch): Promise<ProbeResult[]> {
  const minute = Math.floor(t / 60_000);
  const results = await Promise.all(PROBES.map((p) => runProbe(p, fetcher)));
  const rows = results.map((r) => {
    // Latency is recorded only for answered calls, so a timeout does not read as a 10 s response.
    const lat = r.ok ? [r.ms, 1, r.ms] : [0, 0, 0];
    return [r.gateway, minute, r.ok ? 0 : 1, ...lat, ...H_COLS.map((_, i) => (r.ok && i === bucketOf(r.ms) ? 1 : 0)), r.http_status, r.error];
  });
  const j = (i: number) => `json_extract(value, '$[${i}]')`;
  const hist = H_COLS.map((_, i) => j(6 + i)).join(", ");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO probe_minutes (gateway, minute, projects, requests, errors, ms_total, samples, ms_max, ${H_COLS.join(", ")}, http_status, error)
     SELECT ${j(0)}, ${j(1)}, 1, 1, ${j(2)}, ${j(3)}, ${j(4)}, ${j(5)}, ${hist}, ${j(6 + H_COLS.length)}, ${j(7 + H_COLS.length)} FROM json_each(?)`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return results;
}
