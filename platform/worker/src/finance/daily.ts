// The finance part of the daily cron: status rollups and retention (SPEC-v2 4.6) and credit note numbering (4.7).
import { DAY } from "../lib/util.ts";
import { PROBES, rollupStatus } from "../status/aggregate.ts";
import { captureAll } from "./credit-notes.ts";

export async function financeDaily(env: Env, t: number): Promise<Record<string, number>> {
  const [status, probes, credit_notes] = await Promise.all([rollupStatus(env, t), rollupStatus(env, t, PROBES), captureAll(env, t - 3 * DAY, t)]);
  return { ...status, probe_days: probes.days, probe_incidents: probes.incidents, credit_notes };
}
