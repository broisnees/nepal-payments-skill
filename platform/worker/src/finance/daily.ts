// The finance part of the daily cron: status rollups and retention (SPEC-v2 4.6) and credit note numbering (4.7).
import { DAY } from "../lib/util.ts";
import { rollupStatus } from "../status/aggregate.ts";
import { captureAll } from "./credit-notes.ts";

export async function financeDaily(env: Env, t: number): Promise<Record<string, number>> {
  const [status, credit_notes] = await Promise.all([rollupStatus(env, t), captureAll(env, t - 3 * DAY, t)]);
  return { ...status, credit_notes };
}
