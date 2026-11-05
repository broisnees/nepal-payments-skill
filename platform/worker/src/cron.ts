// Scheduled work: every minute alerts; daily at 09:00 Asia/Kathmandu the digest and retention cleanup.
import { runAlertCron } from "./alerts/engine.ts";
import { NPT_OFFSET } from "./api/data.ts";
import { htmlMail, sendMail } from "./email.ts";
import { DAY, MINUTE, appOrigin, now } from "./lib/util.ts";
import { financeDaily } from "./finance/daily.ts";
import { opsCleanup, runDoctorCron } from "./ops/cron-ops.ts";

export const DAILY_CRON = "15 3 * * *";

export const RETENTION = { events: 30 * DAY, payments: 400 * DAY, minute_stats: 400 * DAY };

const rs = (paisa: number) => `Rs ${(paisa / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface DigestSection {
  project: string;
  env: string;
  started: number;
  paid: number;
  failed: number;
  revenue: number;
  reasons: { reason: string; count: number }[];
  open: number;
}

/** Yesterday (Nepali calendar day) for every org, mailed to owners and admins who have not opted out. */
export async function sendDigests(env: Env, t = now()): Promise<number> {
  const dayEnd = Math.floor((t + NPT_OFFSET) / DAY) * DAY - NPT_OFFSET;
  const dayStart = dayEnd - DAY;
  const label = new Date(dayStart + NPT_OFFSET).toISOString().slice(0, 10);
  const recipients = (
    await env.DB.prepare(
      "SELECT u.email, m.org_id, o.name AS org_name FROM members m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id WHERE m.role IN ('owner','admin') AND u.digest_opt_out = 0 ORDER BY m.org_id",
    ).all<{ email: string; org_id: string; org_name: string }>()
  ).results;
  const byOrg = new Map<string, { name: string; emails: string[] }>();
  for (const r of recipients) {
    if (!byOrg.has(r.org_id)) byOrg.set(r.org_id, { name: r.org_name, emails: [] });
    byOrg.get(r.org_id)!.emails.push(r.email);
  }

  let sent = 0;
  for (const [orgId, org] of byOrg) {
    const projects = (await env.DB.prepare("SELECT id, name FROM projects WHERE org_id = ?").bind(orgId).all<{ id: string; name: string }>()).results;
    const sections: DigestSection[] = [];
    for (const p of projects) {
      for (const envName of ["live", "test"]) {
        const [stats, reasons, open] = await env.DB.batch([
          env.DB.prepare(
            "SELECT COALESCE(SUM(started),0) AS started, COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(failed),0) AS failed, COALESCE(SUM(paid_amount_paisa),0) AS revenue FROM minute_stats WHERE project_id = ? AND env = ? AND minute >= ? AND minute < ?",
          ).bind(p.id, envName, dayStart / MINUTE, dayEnd / MINUTE),
          env.DB.prepare(
            "SELECT COALESCE(last_reason, 'unknown') AS reason, COUNT(*) AS count FROM payments WHERE project_id = ? AND env = ? AND status = 'failed' AND started_at >= ? AND started_at < ? GROUP BY reason ORDER BY count DESC LIMIT 3",
          ).bind(p.id, envName, dayStart, dayEnd),
          env.DB.prepare("SELECT COUNT(*) AS n FROM alert_incidents WHERE project_id = ? AND env = ? AND state = 'firing'").bind(p.id, envName),
        ]);
        const s = stats.results[0] as { started: number; paid: number; failed: number; revenue: number };
        const openN = (open.results[0] as { n: number }).n;
        if (!s.started && !s.paid && !s.failed && !openN) continue;
        sections.push({ project: p.name, env: envName, ...s, reasons: reasons.results as DigestSection["reasons"], open: openN });
      }
    }
    if (!sections.length) continue;
    const lines: string[] = [];
    for (const s of sections) {
      const done = s.paid + s.failed;
      const rate = done ? `${Math.round((s.paid / done) * 1000) / 10}%` : "n/a";
      lines.push(
        `${s.project} (${s.env}): ${s.started} payments, ${rate} success, ${rs(s.revenue)} revenue` +
          (s.reasons.length ? `. Top failures: ${s.reasons.map((r) => `${r.reason} (${r.count})`).join(", ")}` : "") +
          (s.open ? `. ${s.open} open incident${s.open === 1 ? "" : "s"}` : ""),
      );
    }
    const title = `${org.name}: payments on ${label}`;
    const link = appOrigin(env);
    await sendMail(env, {
      to: org.emails,
      subject: `[paynp] ${title}`,
      text: [title, "", ...lines, "", link, "", "Turn this email off in Settings."].join("\n"),
      html: htmlMail(title, [...lines, "Turn this email off in Settings."], { href: link, label: "Open paynp" }),
    }).catch((e: unknown) => console.error(JSON.stringify({ msg: "digest failed", org: orgId, error: String(e) })));
    sent++;
  }
  return sent;
}

async function deleteInChunks(env: Env, table: string, where: string, arg: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const r = await env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 5000)`).bind(arg).run();
    total += r.meta.changes ?? 0;
    if ((r.meta.changes ?? 0) < 5000) break;
  }
  return total;
}

/** Retention v1: events 30 days, payments and minute_stats 400 days; expired auth rows. */
export async function cleanup(env: Env, t = now()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  out.events = await deleteInChunks(env, "events", "received_at < ?", t - RETENTION.events);
  out.payments = await deleteInChunks(env, "payments", "updated_at < ?", t - RETENTION.payments);
  out.minute_stats = await deleteInChunks(env, "minute_stats", "minute < ?", Math.floor((t - RETENTION.minute_stats) / MINUTE));
  out.login_tokens = await deleteInChunks(env, "login_tokens", "expires_at < ?", t - DAY);
  out.device_codes = await deleteInChunks(env, "device_codes", "expires_at < ?", t - DAY);
  out.sessions = await deleteInChunks(env, "sessions", "expires_at < ?", t - DAY);
  out.invites = await deleteInChunks(env, "invites", "expires_at < ?", t - DAY);
  out.notify_slots = await deleteInChunks(env, "notify_slots", "minute < ?", Math.floor((t - DAY) / MINUTE));
  out.notifications = await deleteInChunks(env, "notifications", "sent_at < ?", t - RETENTION.payments);
  return out;
}

export async function scheduled(controller: ScheduledController, env: Env, _ctx?: ExecutionContext): Promise<void> {
  const t = controller.scheduledTime || now();
  if (controller.cron === DAILY_CRON) {
    const [digests, removed, ops] = await Promise.all([sendDigests(env, t), cleanup(env, t), opsCleanup(env, t)]);
    Object.assign(removed, ops);
    Object.assign(removed, await financeDaily(env, t).catch((e: unknown) => (console.error(JSON.stringify({ msg: "finance daily failed", error: String(e) })), {})));
    console.log(JSON.stringify({ msg: "daily cron", digests, removed }));
    return;
  }
  const counts = await runAlertCron(env, t);
  Object.assign(counts, await runDoctorCron(env, t).catch((e: unknown) => (console.error(JSON.stringify({ msg: "doctor cron failed", error: String(e) })), {})));
  if (Object.values(counts).some(Boolean)) console.log(JSON.stringify({ msg: "alert cron", ...counts }));
}
