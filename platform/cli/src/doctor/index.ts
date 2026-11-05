// `paynp doctor`: local go-live checks, then the findings paynp computed from live traffic (GET /doctor) when this
// folder is linked and I'm logged in. Exit code 1 when anything is critical.
import type { DoctorFinding, DoctorReport } from "../../../shared/src/ops.ts";
import { DEFAULT_ENDPOINT, NAME } from "../../../shared/src/brand.ts";
import { Api, ApiError } from "../api.ts";
import { readCredentials, readLink } from "../config.ts";
import { detectStack } from "../stacks.ts";
import { paint, type Color, type Io } from "../ui.ts";
import { localDoctor, type LocalReport } from "./static.ts";

export interface DoctorCtx {
  cwd: string;
  io: Io;
  endpoint: string;
  flags: Record<string, string | boolean | undefined>;
}

export type ServerPart =
  | { state: "ok"; project: string; report: DoctorReport }
  | { state: "skipped"; reason: string }
  | { state: "error"; reason: string };

export interface DoctorResult {
  local: LocalReport;
  server: ServerPart;
  critical: number;
  warnings: number;
}

async function serverPart(ctx: DoctorCtx, env: "test" | "live"): Promise<ServerPart> {
  const link = readLink(ctx.cwd);
  const token = readCredentials().tokens[ctx.endpoint]?.token;
  const login = `${NAME} login${ctx.endpoint === DEFAULT_ENDPOINT ? "" : ` --endpoint ${ctx.endpoint}`}`;
  if (!token && !link) return { state: "skipped", reason: `not logged in and this folder is not linked. Run ${login}, then ${NAME} init.` };
  if (!token) return { state: "skipped", reason: `not logged in to ${ctx.endpoint}. Run ${login}.` };
  if (!link) return { state: "skipped", reason: `this folder is not linked to a project. Run ${NAME} init.` };
  try {
    const report = await new Api(ctx.endpoint, token).get<DoctorReport>(`/api/projects/${encodeURIComponent(link.project)}/doctor?env=${env}`);
    if (!report || !Array.isArray(report.findings)) return { state: "error", reason: "the server's answer has no findings list" };
    return { state: "ok", project: link.project, report: { ...report, passed: Array.isArray(report.passed) ? report.passed : [] } };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return { state: "error", reason: `the server did not accept the saved token. Run ${login}.` };
      if (err.status === 404) return { state: "error", reason: `no doctor on ${ctx.endpoint} for project ${link.project} (HTTP 404: ${err.message}).` };
      return { state: "error", reason: err.status ? `HTTP ${err.status}: ${err.message}` : err.message };
    }
    return { state: "error", reason: (err as Error).message };
  }
}

export async function runDoctor(ctx: DoctorCtx): Promise<DoctorResult> {
  const env = ctx.flags.env === "test" ? "test" : "live";
  const local = localDoctor(ctx.cwd, detectStack(ctx.cwd));
  const server = ctx.flags.local ? ({ state: "skipped", reason: "--local" } as const) : await serverPart(ctx, env);
  const open = server.state === "ok" ? server.report.findings.filter((f) => !f.resolved_at) : [];
  const critical = local.findings.filter((f) => f.severity === "critical").length + open.filter((f) => f.severity === "critical").length;
  const warnings = local.findings.filter((f) => f.severity === "warning").length + open.filter((f) => f.severity === "warning").length;
  return { local, server, critical, warnings };
}

// ---------------------------------------------------------------- output

const ago = (ms: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const LABEL: Record<string, [string, Color]> = { critical: ["CRITICAL", "red"], warning: ["WARNING ", "yellow"], ok: ["ok      ", "green"], skip: ["skipped ", "gray"] };

export function renderDoctor(r: DoctorResult, opts: { color: boolean; cwd: string; endpoint: string; now?: number }): string {
  const c = (color: Color, s: string) => paint(opts.color, color, s);
  const out: string[] = [];
  const pad = " ".repeat(12);
  const tag = (k: string) => c(LABEL[k][1], LABEL[k][0]);
  const block = (k: string, title: string, lines: [string, string][]) => {
    out.push(`  ${tag(k)}  ${c("bold", title)}`);
    for (const [label, text] of lines) if (text) out.push(`${pad}${label ? c("gray", `${label} `) : ""}${text}`);
  };

  out.push(c("bold", `${NAME} doctor`) + c("gray", `  ${opts.cwd}`));
  out.push("");
  out.push(c("bold", "Config and code") + c("gray", r.local.sources.length ? `  (${r.local.sources.join(", ")})` : "  (no env files or wrangler config)"));
  for (const f of r.local.findings) block(f.severity, `${f.title}  ${c("gray", `${f.code}, ${f.where}`)}`, [["", f.detail], ["fix:", f.fix]]);
  for (const p of r.local.passed) out.push(`  ${tag("ok")}  ${p.line}`);
  for (const s of r.local.skipped) if (s.line) out.push(`  ${tag("skip")}  ${c("gray", s.line)}`);

  out.push("");
  if (r.server.state === "ok") {
    const rep = r.server.report;
    out.push(c("bold", `Live traffic`) + c("gray", `  (project ${r.server.project}, ${rep.env} env, ${opts.endpoint})`));
    const open = rep.findings.filter((f) => !f.resolved_at);
    for (const f of open) {
      const meta = [`${f.count} time${f.count === 1 ? "" : "s"}`, `last ${ago(f.last_seen, opts.now)}`, f.gateway ? `gateway ${f.gateway}` : "", f.example_attempt ? `e.g. attempt ${f.example_attempt}` : ""].filter(Boolean).join(", ");
      block(f.severity, `${f.title}  ${c("gray", f.code)}`, [["", meta], ["", f.why], ["fix:", f.fix], ["docs:", f.docs_url]]);
    }
    for (const p of rep.passed) out.push(`  ${p.status === "passed" ? tag("ok") : tag("skip")}  ${p.status === "passed" ? p.line : c("gray", p.line)}`);
    if (!open.length && !rep.passed.length) out.push(`  ${c("gray", "No findings and no checks reported yet.")}`);
  } else {
    out.push(c("bold", "Live traffic") + c("gray", r.server.state === "error" ? "  (could not load)" : "  (skipped)"));
    out.push(`  ${tag("skip")}  ${c("gray", r.server.reason)}`);
  }

  out.push("");
  const counts = `${r.critical} critical, ${r.warnings} warning${r.warnings === 1 ? "" : "s"}`;
  if (r.critical) out.push(c("red", `${counts}. Fix the critical ones before going live.`));
  else if (r.warnings) out.push(c("yellow", `${counts}. Nothing blocks a go-live; the warnings are worth a look.`));
  else out.push(c("green", "No problems found."));
  return out.join("\n");
}

/** The --json shape: everything, plus the counts and the exit code it implies. */
export function doctorJson(r: DoctorResult): unknown {
  return {
    critical: r.critical,
    warnings: r.warnings,
    ok: r.critical === 0,
    local: r.local,
    server: r.server.state === "ok" ? { state: "ok", project: r.server.project, ...r.server.report } : r.server,
  };
}

export type { DoctorFinding };
