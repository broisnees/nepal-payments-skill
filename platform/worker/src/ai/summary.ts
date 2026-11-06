// A short AI read of a new incident for the alert message: what is failing, where, and what to look at first.
// Skipped without a provider; never holds an alert back for more than SUMMARY_TIMEOUT_MS.
import { complete } from "./model.ts";

export const SUMMARY_TIMEOUT_MS = 12_000;
const WINDOW_MS = 60 * 60_000;

const SYSTEM = `You write the first lines of a payment alert for an engineer on call at a Nepali merchant. Given the alert and the last hour of payment outcomes, say in at most three short sentences what is failing, on which gateway, and the most likely next thing to check. Use only the numbers given. Amounts are paisa (100 paisa = Rs 1). No greeting, no headings, no markdown.`;

export async function incidentSummary(
  env: Env,
  incident: { project_id: string; env: string | null; summary: string; context: string | null },
  ruleLabel: string,
): Promise<string | null> {
  const envName = incident.env ?? "live";
  const rows = await env.DB.prepare(
    `SELECT gateway, status, last_reason, COUNT(*) AS n FROM payments
     WHERE project_id = ? AND env = ? AND updated_at > ? GROUP BY gateway, status, last_reason ORDER BY n DESC LIMIT 20`,
  )
    .bind(incident.project_id, envName, Date.now() - WINDOW_MS)
    .all<{ gateway: string; status: string; last_reason: string | null; n: number }>();
  const prompt = [
    `Alert: ${ruleLabel}: ${incident.summary}`,
    `Environment: ${envName}`,
    incident.context ? `Rule context: ${incident.context}` : null,
    "Last hour, payments by gateway, status and last reason:",
    ...rows.results.map((r) => `- ${r.gateway} ${r.status}${r.last_reason ? ` (${r.last_reason})` : ""}: ${r.n}`),
  ]
    .filter(Boolean)
    .join("\n");
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SUMMARY_TIMEOUT_MS));
  return Promise.race([complete(env, { system: SYSTEM, prompt }), timeout]);
}
