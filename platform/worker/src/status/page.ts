// Server-rendered public status pages: no scripts, inline CSS and SVG, light and dark from prefers-color-scheme.
import { GATEWAY_LOGOS, NEPAL_OFFSET_MS, type GatewayState, type GatewayStatus, type StatusIncident, type StatusReport } from "@paynp/shared";
import { BAD_P95_MS, MIN_PROJECTS } from "./aggregate.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATE_LABEL: Record<GatewayState, string> = { operational: "Operational", degraded: "Degraded", down: "Down", no_data: "Not enough traffic" };

export const pct = (r: number | null, digits = 1) => (r === null ? "n/a" : `${(r * 100).toFixed(r > 0 && r < 0.001 ? 2 : digits).replace(/\.0+$/, "")}%`);
export function ms(v: number | null): string {
  if (v === null) return "n/a";
  if (v > 10_000) return "over 10 s";
  return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, "")} s` : `${Math.round(v)} ms`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function npt(t: number, withDate = true): string {
  const d = new Date(t + NEPAL_OFFSET_MS);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hm}` : hm;
}
const duration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ""}`.trim());

const CSS = `
:root{--bg:#fbfbfa;--fg:#16181d;--muted:#5d6370;--faint:#8b909a;--line:#e3e4e8;--card:#ffffff;--ok:#178a4c;--ok-bg:#e5f4ec;--warn:#a86400;--warn-bg:#fbf0dc;--bad:#c62828;--bad-bg:#fbe6e6;--none:#c9ccd3;--accent:#1f5fd6;--chart:#1f5fd6;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--fg:#e9eaee;--muted:#a3a8b3;--faint:#727885;--line:#262a31;--card:#14171c;--ok:#3ccf7f;--ok-bg:#0f2a1c;--warn:#f0a83a;--warn-bg:#2d2110;--bad:#ff6b6b;--bad-bg:#331617;--none:#353a43;--accent:#7aa7ff;--chart:#7aa7ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"tnum"}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 48px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:28px;font-size:14px}
.brand{font-weight:650;color:var(--fg);letter-spacing:-.01em}.brand span{color:var(--muted);font-weight:450}
h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px;font-weight:650;text-wrap:balance}
h2{font-size:15px;margin:32px 0 12px;font-weight:600}
.lede{color:var(--muted);margin:0 0 20px;max-width:640px;text-wrap:pretty}
.summary{border:1px solid var(--line);background:var(--card);padding:14px 16px;display:flex;gap:10px;align-items:center;font-weight:550}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--none)}
.s-operational .dot,.dot.s-operational{background:var(--ok)}.s-degraded .dot,.dot.s-degraded{background:var(--warn)}.s-down .dot,.dot.s-down{background:var(--bad)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:550;padding:2px 8px;border:1px solid var(--line);white-space:nowrap}
.pill.s-operational{color:var(--ok);background:var(--ok-bg);border-color:transparent}.pill.s-degraded{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.pill.s-down{color:var(--bad);background:var(--bad-bg);border-color:transparent}.pill.s-no_data{color:var(--muted)}
.list{border:1px solid var(--line);background:var(--card);margin-top:16px}
.gw{display:grid;grid-template-columns:minmax(150px,1.1fr) 1fr 1.4fr;gap:8px 20px;align-items:center;padding:16px;border-top:1px solid var(--line)}
.gw:first-child{border-top:0}
.gw .name{font-weight:600;font-size:16px;color:var(--fg);display:inline-flex;align-items:center;gap:10px;text-decoration:none}.logo{display:inline-flex;line-height:0}.logo img{width:auto}.hero-logo{margin:4px 0 14px}@media (prefers-color-scheme:dark){.logo.chip{padding:2px 5px;background:#fff;border-radius:2px}}.gw .meta{color:var(--muted);font-size:13px;margin-top:2px}
.label{font-size:12px;color:var(--faint);margin-bottom:4px}
svg{display:block;width:100%;height:auto;overflow:visible}
.bars rect.u-ok{fill:var(--ok)}.bars rect.u-warn{fill:var(--warn)}.bars rect.u-bad{fill:var(--bad)}.bars rect.u-none{fill:var(--none)}
.spark path.line{fill:none;stroke:var(--chart);stroke-width:1.5;vector-effect:non-scaling-stroke}
.spark rect.err{fill:var(--bad);opacity:.75}.spark line.base{stroke:var(--line);vector-effect:non-scaling-stroke}
.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--faint);margin-top:4px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);background:var(--card)}
.tile{padding:14px 16px;border-left:1px solid var(--line)}.tile:first-child{border-left:0}
.tile .v{font-size:22px;font-weight:600;letter-spacing:-.01em}.tile .k{font-size:12px;color:var(--muted)}
.panel{border:1px solid var(--line);background:var(--card);padding:16px}
.peak rect.avg{fill:var(--chart);opacity:.35}.peak rect.p95{fill:var(--chart)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 10px;border-top:1px solid var(--line)}
th{font-weight:550;color:var(--muted);font-size:12px;border-top:0}
.empty{color:var(--muted);font-size:14px;padding:4px 0}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}.legend i{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.others{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px}
@media (max-width:720px){.gw{grid-template-columns:1fr 1fr}.gw .uptime{grid-column:1/-1}h1{font-size:24px}.tiles{grid-template-columns:1fr}.tile{border-left:0;border-top:1px solid var(--line)}.tile:first-child{border-top:0}
.hide-sm{display:none}th,td{padding:8px 6px}}
`;

/** The gateway's official logo, switching to its dark file (or a light chip) under a dark system theme. */
function logo(gateway: string, name: string, height: number): string {
  const l = GATEWAY_LOGOS[gateway];
  if (!l) return "";
  const h = Math.round(height * (l.scale ?? 1));
  const w = Math.round(h * l.ratio);
  const dark = l.dark ? `<source media="(prefers-color-scheme: dark)" srcset="${esc(l.dark)}">` : "";
  return `<picture class="logo${l.chip ? " chip" : ""}">${dark}<img src="${esc(l.light)}" alt="${esc(name)}" width="${w}" height="${h}"></picture>`;
}

function layout(o: { title: string; description: string; canonical: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(o.canonical)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/json" href="/status.json">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/status">paynp <span>status</span></a><a href="/status.json">status.json</a></header>
${o.body}
<footer>
<p>Built from live gateway calls made by merchants who use paynp. A minute counts only when at least ${MIN_PROJECTS} different merchants called the gateway in it; with less traffic the page says "not enough traffic". Only error rates and latency are shown, never volumes. An incident is 5 or more minutes with more than 20% errors or p95 latency over ${BAD_P95_MS / 1000} s. Times are Nepal time (UTC+05:45).</p>
</footer>
</div>
</body>
</html>
`;
}

/** 90 thin bars, one per Nepal day. */
function uptimeBars(g: GatewayStatus, height = 28): string {
  const n = g.uptime_90d.length;
  const w = 4;
  const gap = 2;
  const width = n * (w + gap) - gap;
  const bars = g.uptime_90d
    .map((d, i) => {
      const cls = d.uptime === null ? "u-none" : d.uptime >= 0.995 ? "u-ok" : d.uptime >= 0.95 ? "u-warn" : "u-bad";
      const tip = d.uptime === null ? `${d.date}: not enough traffic` : `${d.date}: ${pct(d.uptime, 2)} healthy minutes`;
      return `<rect class="${cls}" x="${i * (w + gap)}" y="0" width="${w}" height="${height}"><title>${esc(tip)}</title></rect>`;
    })
    .join("");
  return `<svg class="bars" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(`${g.name} daily uptime, last 90 days: ${pct(g.uptime_90d_pct, 2)}`)}" style="height:${height}px">${bars}</svg>`;
}

/** p95 latency line with error-rate bars underneath, 24 hourly points. */
function sparkline(g: GatewayStatus, height = 40): string {
  const pts = g.last_24h;
  const W = 240;
  const step = W / pts.length;
  const lat = pts.map((p) => p.p95_ms);
  const maxLat = Math.max(1000, ...lat.filter((x): x is number => x !== null).map((x) => Math.min(x, 12_000)));
  let d = "";
  let pen = false;
  pts.forEach((p, i) => {
    if (p.p95_ms === null) {
      pen = false;
      return;
    }
    const x = (i + 0.5) * step;
    const y = height - 2 - (Math.min(p.p95_ms, 12_000) / maxLat) * (height - 8);
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  const errs = pts
    .map((p, i) => (p.error_rate ? `<rect class="err" x="${(i * step + 1).toFixed(1)}" y="${(height - Math.max(1.5, p.error_rate * height)).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${Math.max(1.5, p.error_rate * height).toFixed(1)}"><title>${esc(`${npt(p.t)}: ${pct(p.error_rate)} errors, p95 ${ms(p.p95_ms)}`)}</title></rect>` : ""))
    .join("");
  const dots = pts
    .map((p, i) => (p.p95_ms !== null && (i === 0 || pts[i - 1].p95_ms === null) && (i === pts.length - 1 || pts[i + 1].p95_ms === null) ? `<circle cx="${((i + 0.5) * step).toFixed(1)}" cy="${(height - 2 - (Math.min(p.p95_ms, 12_000) / maxLat) * (height - 8)).toFixed(1)}" r="1.6" fill="var(--chart)"/>` : ""))
    .join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" role="img" aria-label="${esc(`${g.name}, last 24 hours: p95 latency line and error rate bars`)}" style="height:${height}px"><line class="base" x1="0" x2="${W}" y1="${height - 0.5}" y2="${height - 0.5}"/>${errs}${d ? `<path class="line" d="${d}"/>` : ""}${dots}</svg>`;
}

function peakChart(g: GatewayStatus): string {
  const H = 120;
  const W = 480;
  const step = W / 24;
  const vals = g.peak_hours.flatMap((h) => [h.avg_ms ?? 0, Math.min(h.p95_ms ?? 0, 12_000)]);
  const max = Math.max(500, ...vals);
  const y = (v: number) => H - (v / max) * (H - 6);
  const bars = g.peak_hours
    .map((h) => {
      const x = h.hour * step + 2;
      const w = step - 4;
      const tip = `${String(h.hour).padStart(2, "0")}:00 to ${String(h.hour).padStart(2, "0")}:59 NPT: average ${ms(h.avg_ms)}, p95 ${ms(h.p95_ms)}`;
      return (
        `<g><title>${esc(tip)}</title>` +
        (h.p95_ms !== null ? `<rect class="p95" x="${x.toFixed(1)}" y="${y(Math.min(h.p95_ms, 12_000)).toFixed(1)}" width="${w.toFixed(1)}" height="2"/>` : "") +
        (h.avg_ms !== null ? `<rect class="avg" x="${x.toFixed(1)}" y="${y(h.avg_ms).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - y(h.avg_ms)).toFixed(1)}"/>` : "") +
        `</g>`
      );
    })
    .join("");
  return `<svg class="peak" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(`${g.name} latency by Nepal hour of day, last 7 days`)}" style="height:${H}px">${bars}</svg>
<div class="axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
<div class="legend"><span><i style="background:var(--chart);opacity:.35"></i>Average</span><span><i style="background:var(--chart);height:2px;vertical-align:3px"></i>p95</span><span>Peak: ${peakHourText(g)}</span></div>`;
}

function peakHourText(g: GatewayStatus): string {
  const withData = g.peak_hours.filter((h) => h.avg_ms !== null);
  if (!withData.length) return "not enough traffic in the last 7 days";
  const worst = withData.reduce((a, b) => ((b.p95_ms ?? 0) > (a.p95_ms ?? 0) || ((b.p95_ms ?? 0) === (a.p95_ms ?? 0) && (b.avg_ms ?? 0) > (a.avg_ms ?? 0)) ? b : a));
  return `slowest around ${String(worst.hour).padStart(2, "0")}:00 NPT (p95 ${ms(worst.p95_ms)})`;
}

const KIND: Record<StatusIncident["kind"], string> = { errors: "Errors", latency: "Slow responses", errors_and_latency: "Errors and slow responses" };

function incidentsTable(list: StatusIncident[], limit = 20): string {
  if (!list.length) return `<p class="empty">No incidents in the last 90 days.</p>`;
  const rows = list
    .slice(0, limit)
    .map(
      (i) =>
        `<tr><td>${esc(npt(i.started_at))}${i.ongoing ? ` <span class="pill s-down">Ongoing</span>` : ""}</td><td>${esc(duration(i.minutes))}</td><td>${esc(KIND[i.kind])}</td><td class="hide-sm">${esc(pct(i.peak_error_rate))} errors, p95 ${esc(ms(i.peak_p95_ms))}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Started (NPT)</th><th>Lasted</th><th>What</th><th class="hide-sm">Worst minute</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function stateLine(g: GatewayStatus): string {
  if (g.state === "operational") return `No. ${g.name} is working normally.`;
  if (g.state === "degraded") return `${g.name} is having problems right now.`;
  if (g.state === "down") return `Yes. ${g.name} looks down right now.`;
  return `Not enough traffic in the last 15 minutes to say.`;
}

function summary(r: StatusReport): { state: GatewayState; text: string } {
  const bad = r.gateways.filter((g) => g.state === "down" || g.state === "degraded");
  const known = r.gateways.filter((g) => g.state !== "no_data");
  if (bad.length) {
    const worst = bad.some((g) => g.state === "down") ? "down" : "degraded";
    return { state: worst, text: bad.map((g) => `${g.name} ${g.state === "down" ? "looks down" : "is degraded"}`).join(", ") };
  }
  if (!known.length) return { state: "no_data", text: "Not enough traffic in the last 15 minutes to report on any gateway" };
  return { state: "operational", text: `${known.map((g) => g.name).join(", ")} ${known.length === 1 ? "is" : "are"} working normally` };
}

export function renderOverview(r: StatusReport, origin: string): string {
  const s = summary(r);
  const rows = r.gateways
    .map(
      (g) => `<div class="gw s-${g.state}">
<div><a class="name" href="/status/${esc(g.gateway)}">${logo(g.gateway, g.name, 20)}<span>${esc(g.name)}</span></a><div class="meta"><span class="pill s-${g.state}"><span class="dot s-${g.state}"></span>${STATE_LABEL[g.state]}</span></div></div>
<div><div class="label">Last 15 min</div><div>${g.state === "no_data" ? "n/a" : `${esc(pct(g.error_rate))} errors, p95 ${esc(ms(g.p95_ms))}`}</div></div>
<div class="uptime"><div class="label">90 days${g.uptime_90d_pct !== null ? `: ${esc(pct(g.uptime_90d_pct, 2))} healthy` : ""}</div>${uptimeBars(g, 22)}</div>
</div>`,
    )
    .join("\n");
  const body = `<h1>Is eSewa down? Nepali payment gateway status</h1>
<p class="lede">Live error rates and latency for eSewa, Khalti, Fonepay, connectIPS and other Nepali payment gateways, measured from real checkouts. Updated every minute; last update ${esc(npt(r.generated_at))} NPT.</p>
<div class="summary s-${s.state}"><span class="dot"></span>${esc(s.text)}</div>
<div class="list">${rows}</div>`;
  return layout({
    title: "Is eSewa down? Live status of Nepali payment gateways",
    description: "Is eSewa, Khalti, Fonepay or connectIPS down right now? Live error rates, latency, 90-day uptime and incidents for Nepali payment gateways, from real merchant traffic.",
    canonical: `${origin}/status`,
    body,
  });
}

export function renderGateway(r: StatusReport, g: GatewayStatus, origin: string): string {
  const others = r.gateways
    .filter((o) => o.gateway !== g.gateway)
    .map((o) => `<a href="/status/${esc(o.gateway)}"><span class="dot s-${o.state}" style="display:inline-block;margin-right:6px"></span>Is ${esc(o.name)} down?</a>`)
    .join("");
  const body = `<p style="margin:0 0 8px;font-size:14px"><a href="/status">All gateways</a></p>
<div class="hero-logo">${logo(g.gateway, g.name, 34)}</div>
<h1>Is ${esc(g.name)} down?</h1>
<p class="lede">${esc(stateLine(g))} Last update ${esc(npt(r.generated_at))} NPT.</p>
<div class="tiles">
<div class="tile"><div class="k">Status</div><div class="v"><span class="pill s-${g.state}" style="font-size:15px"><span class="dot s-${g.state}"></span>${STATE_LABEL[g.state]}</span></div></div>
<div class="tile"><div class="k">Errors, last 15 min</div><div class="v">${esc(pct(g.error_rate))}</div></div>
<div class="tile"><div class="k">p95 latency, last 15 min</div><div class="v">${esc(ms(g.p95_ms))}</div></div>
</div>
<h2>Last 24 hours</h2>
<div class="panel">${sparkline(g, 80)}<div class="axis"><span>${esc(npt(g.last_24h[0].t, false))}</span><span>${esc(npt(g.last_24h[12].t, false))}</span><span>now</span></div>
<div class="legend"><span><i style="background:var(--chart);height:2px;vertical-align:3px"></i>p95 latency</span><span><i style="background:var(--bad);opacity:.75"></i>Error rate</span></div></div>
<h2>Uptime, last 90 days${g.uptime_90d_pct !== null ? `: ${esc(pct(g.uptime_90d_pct, 2))}` : ""}</h2>
<div class="panel">${uptimeBars(g, 36)}<div class="axis"><span>90 days ago</span><span>today</span></div>
<div class="legend"><span><i style="background:var(--ok)"></i>99.5% or more</span><span><i style="background:var(--warn)"></i>95% to 99.5%</span><span><i style="background:var(--bad)"></i>under 95%</span><span><i style="background:var(--none)"></i>not enough traffic</span></div></div>
<h2>Latency by hour of day (Nepal time, last 7 days)</h2>
<div class="panel">${peakChart(g)}</div>
<h2>Incidents</h2>
<div class="panel">${incidentsTable(g.incidents)}</div>
<h2>Other gateways</h2>
<div class="others">${others}</div>`;
  return layout({
    title: `Is ${g.name} down? Live ${g.name} status`,
    description: `Is ${g.name} down right now? Live ${g.name} error rate, p95 latency, 90-day uptime, busiest hours and recent incidents, from real merchant traffic in Nepal.`,
    canonical: `${origin}/status/${g.gateway}`,
    body,
  });
}

export function renderNotFound(r: StatusReport, origin: string): string {
  const links = r.gateways.map((g) => `<a href="/status/${esc(g.gateway)}">Is ${esc(g.name)} down?</a>`).join("");
  return layout({
    title: "Gateway not found | paynp status",
    description: "Live status of Nepali payment gateways.",
    canonical: `${origin}/status`,
    body: `<h1>No status page for that gateway</h1><p class="lede">These gateways have one:</p><div class="others">${links}</div>`,
  });
}
