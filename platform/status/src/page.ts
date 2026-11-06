// status.discerns.app pages: server-rendered, inline CSS and SVG, light and dark from prefers-color-scheme. One small
// inline script refreshes the states every minute; without it the pages still read correctly.
import { DISPLAY_NAME, GATEWAY_LOGOS, NEPAL_OFFSET_MS, SKILL_SITE_URL, STATUS_SITE_NAME, type GatewayState, type GatewayStatus, type StatusIncident, type StatusReport } from "@paynp/shared";
import { BAD_P95_MS } from "../../worker/src/status/aggregate.ts";
import { ACTION, buyerMessage } from "./api.ts";
import { PROBES, PROBE_TIMEOUT_MS, UNMONITORED } from "./probe.ts";

/** Where gateway logos and the platform live (the paynp Worker serves /logos). */
let PLATFORM = "https://discerns.app";
export function setPlatform(url: string): void {
  PLATFORM = url.replace(/\/+$/, "");
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const STATE_LABEL: Record<GatewayState, string> = { operational: "Operational", degraded: "Degraded", down: "Down", no_data: "No data" };

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
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#5c5c5c;--faint:#8a8a8a;--line:#e8e8e8;--line2:#dcdcdc;--card:#ffffff;--hover:#f4f4f5;--ok:#16a34a;--ok-bg:#dcfce7;--warn:#c2410c;--warn-bg:#ffedd5;--bad:#dc2626;--bad-bg:#fee2e2;--none:#d4d4d8;--accent:#2563eb;--chart:#2563eb;--shadow:0 1px 2px rgb(0 0 0/.04),0 4px 16px rgb(0 0 0/.04);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--faint:#71717a;--line:#1f1f23;--line2:#2a2a30;--card:#111113;--hover:#18181b;--ok:#34d399;--ok-bg:rgb(52 211 153/.12);--warn:#fb923c;--warn-bg:rgb(251 146 60/.12);--bad:#f87171;--bad-bg:rgb(248 113 113/.12);--none:#2a2a30;--accent:#60a5fa;--chart:#60a5fa;--shadow:none}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"tnum","cv11";-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px 64px}
header.top{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:12px;height:60px;margin:0 -20px 32px;padding:0 20px;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:saturate(1.5) blur(12px);border-bottom:1px solid var(--line)}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:650;color:var(--fg);letter-spacing:-.01em;font-size:15px}.brand:hover{text-decoration:none}.brand::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px var(--ok-bg)}.brand span{color:var(--muted);font-weight:450}
nav.links{display:flex;gap:2px;flex-wrap:wrap}nav.links a{color:var(--muted);font-size:14px;padding:6px 12px;}nav.links a:hover{background:var(--hover);color:var(--fg);text-decoration:none}nav.links a[aria-current]{color:var(--fg);background:var(--hover)}
h1{font-size:clamp(28px,4.4vw,40px);line-height:1.1;letter-spacing:-.035em;margin:0 0 12px;font-weight:700;text-wrap:balance}
h2{font-size:17px;margin:44px 0 14px;font-weight:650;letter-spacing:-.015em}
.lede{color:var(--muted);margin:0 0 28px;max-width:660px;text-wrap:pretty;font-size:16px}
.summary{position:relative;overflow:hidden;border:1px solid var(--line);background:var(--card);padding:22px 24px;display:flex;gap:14px;align-items:center;font-weight:600;font-size:17px;box-shadow:var(--shadow)}
.summary .dot{width:12px;height:12px}
.summary.s-operational{background:linear-gradient(90deg,var(--ok-bg),var(--card) 60%)}.summary.s-degraded{background:linear-gradient(90deg,var(--warn-bg),var(--card) 60%)}.summary.s-down{background:linear-gradient(90deg,var(--bad-bg),var(--card) 60%)}
.summary .when{margin-left:auto;font-size:13px;font-weight:450;color:var(--faint);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--none)}
.s-operational .dot,.dot.s-operational{background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}.s-degraded .dot,.dot.s-degraded{background:var(--warn);box-shadow:0 0 0 3px var(--warn-bg)}.s-down .dot,.dot.s-down{background:var(--bad);box-shadow:0 0 0 3px var(--bad-bg);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 6px transparent}}@media (prefers-reduced-motion:reduce){.dot{animation:none!important}}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:550;padding:3px 10px 3px 9px;border:1px solid var(--line);white-space:nowrap;color:var(--muted)}
.pill .dot{box-shadow:none}
.pill.s-operational{color:var(--ok);background:var(--ok-bg);border-color:transparent}.pill.s-degraded{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.pill.s-down{color:var(--bad);background:var(--bad-bg);border-color:transparent}.pill.s-no_data{color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-top:20px}
.gwcard{display:grid;gap:14px;padding:18px 18px 16px;border:1px solid var(--line);background:var(--card);color:inherit;box-shadow:var(--shadow);transition:border-color .15s,transform .15s}
.gwcard:hover{text-decoration:none;border-color:var(--line2);transform:translateY(-1px)}
.gwcard .row{display:flex;align-items:center;gap:10px}.gwcard .nm{font-weight:650;font-size:16px;color:var(--fg);flex:1;min-width:0}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stat .k{font-size:12px;color:var(--faint)}.stat .v{font-size:18px;font-weight:650;letter-spacing:-.01em;color:var(--fg)}
.label{font-size:12px;color:var(--faint);margin-bottom:6px;display:flex;justify-content:space-between}
.logo{display:inline-flex;line-height:0}.gw-tile{display:inline-grid;place-items:center;width:34px;height:34px;padding:0;background:#fff;border:1px solid var(--line);flex:none}.gw-tile img{width:22px;height:22px;display:block}.logo img{width:auto}.hero-logo{margin:4px 0 16px}@media (prefers-color-scheme:dark){.logo.chip{padding:3px 6px;background:#fff;}}
svg{display:block;width:100%;height:auto;overflow:visible}
.bars rect.u-ok{fill:var(--ok)}.bars rect.u-warn{fill:var(--warn)}.bars rect.u-bad{fill:var(--bad)}.bars rect.u-none{fill:var(--none)}
.spark path.line{fill:none;stroke:var(--chart);stroke-width:1.75;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.spark rect.err{fill:var(--bad);opacity:.7}.spark line.base{stroke:var(--line);vector-effect:non-scaling-stroke}
.axis{display:flex;justify-content:space-between;font-size:11.5px;color:var(--faint);margin-top:6px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{padding:16px 18px;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}
.tile .v{font-size:24px;font-weight:650;letter-spacing:-.02em;margin-top:4px}.tile .k{font-size:12.5px;color:var(--muted)}
.panel{border:1px solid var(--line);background:var(--card);padding:18px;box-shadow:var(--shadow)}
.peak rect.avg{fill:var(--chart);opacity:.3}.peak rect.p95{fill:var(--chart)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-top:1px solid var(--line)}
th{font-weight:550;color:var(--faint);font-size:12px;border-top:0}
.empty{color:var(--muted);font-size:14px;padding:4px 0}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:10px}.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}footer p{max-width:760px}
.others{display:flex;flex-wrap:wrap;gap:8px}.others a{display:inline-flex;align-items:center;padding:6px 12px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:13.5px}.others a:hover{text-decoration:none;border-color:var(--line2)}
pre{margin:0;padding:14px 16px;background:var(--hover);border:1px solid var(--line);overflow-x:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.advice{display:grid;gap:10px}.advice b{font-weight:650}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.dev{margin-top:48px;padding:24px;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}.dev h2{margin-top:0}.dev p{color:var(--muted);margin:0 0 14px}.fine{font-size:13px;color:var(--muted)}
footer nav{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px}
@media (max-width:720px){.tiles{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}.cards{grid-template-columns:1fr}.summary{flex-wrap:wrap}.summary .when{margin-left:0;width:100%}nav.links a{padding:6px 8px}.hide-sm{display:none}th,td{padding:8px 6px}}
`;

/** The gateway's official logo, switching to its dark file (or a light chip) under a dark system theme. */
function logo(gateway: string, name: string, height: number): string {
  const l = GATEWAY_LOGOS[gateway];
  if (!l) return "";
  const h = Math.round(height * (l.scale ?? 1));
  const w = Math.round(h * l.ratio);
  const dark = l.dark ? `<source media="(prefers-color-scheme: dark)" srcset="${esc(PLATFORM + l.dark)}">` : "";
  return `<picture class="logo${l.chip ? " chip" : ""}">${dark}<img src="${esc(PLATFORM + l.light)}" alt="${esc(name)}" width="${w}" height="${h}"></picture>`;
}

/** The gateway's square icon on a light tile, for list rows. */
function icon(gateway: string): string {
  const l = GATEWAY_LOGOS[gateway];
  return l ? `<span class="gw-tile"><img src="${esc(PLATFORM + l.icon)}" alt="" width="18" height="18"></span>` : "";
}


/** Refreshes the state pills every minute without reloading; the server-rendered page is complete without it. */
const LIVE_SCRIPT = `<script>
(function () {
  var L = { operational: "Operational", degraded: "Degraded", down: "Down", no_data: "No data" };
  function tick() {
    fetch("/v1/status").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      d.gateways.forEach(function (g) {
        document.querySelectorAll('[data-pill="' + g.gateway + '"]').forEach(function (p) {
          p.className = "pill s-" + g.state;
          p.innerHTML = '<span class="dot s-' + g.state + '"></span>' + L[g.state];
        });
      });
    }).catch(function () {});
  }
  setInterval(function () { if (!document.hidden) tick(); }, 60000);
})();
</script>`;

function layout(o: { title: string; description: string; canonical: string; body: string; current?: "gateways" | "developers" }): string {
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
<link rel="alternate" type="application/json" href="/v1/status">
<link rel="alternate" type="application/atom+xml" title="Gateway incidents" href="/feed.xml">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/">${esc(DISPLAY_NAME)} <span>status</span></a><nav class="links"><a href="/"${o.current === "gateways" ? ' aria-current="page"' : ""}>Gateways</a><a href="/developers"${o.current === "developers" ? ' aria-current="page"' : ""}>Developers</a><a href="${esc(PLATFORM)}">${esc(DISPLAY_NAME)}</a></nav></header>
${o.body}
<footer>
<p>Every minute this site calls each gateway's production API from Cloudflare's network and records whether it answered and how fast. A check passes when the gateway answers with anything but a 5xx within ${PROBE_TIMEOUT_MS / 1000} s; no credentials and no transactions are involved. An incident is 5 or more minutes with more than 20% failed checks or p95 latency over ${BAD_P95_MS / 1000} s. Times are Nepal time (UTC+05:45). <a href="/developers#method">How each gateway is checked</a>.</p>
<nav><a href="/developers">Status API</a><a href="/feed.xml">Incident feed</a><a href="${esc(PLATFORM)}">${esc(DISPLAY_NAME)}: payment observability</a><a href="${esc(SKILL_SITE_URL)}">Nepal Payments skill</a></nav>
</footer>
${LIVE_SCRIPT}
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
      const tip = d.uptime === null ? `${d.date}: no data` : `${d.date}: ${pct(d.uptime, 2)} healthy minutes`;
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
  if (!withData.length) return "no data in the last 7 days";
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
  return UNMONITORED[g.gateway] ?? `No checks in the last 15 minutes yet.`;
}

function summary(r: StatusReport): { state: GatewayState; text: string } {
  const bad = r.gateways.filter((g) => g.state === "down" || g.state === "degraded");
  const known = r.gateways.filter((g) => g.state !== "no_data");
  if (bad.length) {
    const worst = bad.some((g) => g.state === "down") ? "down" : "degraded";
    return { state: worst, text: bad.map((g) => `${g.name} ${g.state === "down" ? "looks down" : "is degraded"}`).join(", ") };
  }
  if (!known.length) return { state: "no_data", text: "No checks in the last 15 minutes yet" };
  return { state: "operational", text: `${known.map((g) => g.name).join(", ")} ${known.length === 1 ? "is" : "are"} working normally` };
}

export function renderOverview(r: StatusReport, origin: string): string {
  const s = summary(r);
  const rows = r.gateways
    .map(
      (g) => `<a class="gwcard s-${g.state}" href="/${esc(g.gateway)}" data-gw="${esc(g.gateway)}">
<div class="row">${icon(g.gateway)}<span class="nm">${esc(g.name)}</span><span class="pill s-${g.state}" data-pill="${esc(g.gateway)}"><span class="dot s-${g.state}"></span>${STATE_LABEL[g.state]}</span></div>
<div class="stats"><div class="stat"><div class="k">Failed checks, 15 min</div><div class="v">${esc(pct(g.error_rate))}</div></div><div class="stat"><div class="k">p95 latency</div><div class="v">${esc(ms(g.p95_ms))}</div></div></div>
<div><div class="label"><span>Last 24 hours</span></div>${sparkline(g, 36)}</div>
<div><div class="label"><span>90 days</span><span>${g.uptime_90d_pct !== null ? `${esc(pct(g.uptime_90d_pct, 2))} healthy` : "no data yet"}</span></div>${uptimeBars(g, 24)}</div>
</a>`,
    )
    .join("\n");
  const body = `<h1>Is eSewa down? Nepali payment gateway status</h1>
<p class="lede">Is eSewa, Khalti, Fonepay or connectIPS answering right now? Each gateway's production API is checked every minute: availability, response time, 90-day uptime and incidents.</p>
<div class="summary s-${s.state}" data-summary><span class="dot"></span><span>${esc(s.text)}</span><span class="when">Updated ${esc(npt(r.generated_at))} NPT</span></div>
<div class="cards">${rows}</div>
<section class="dev">
<h2>Status API</h2>
<p>The same data as JSON, free and without a key: decide on the server whether to offer a gateway, warn while it is slow, or route buyers to another one.</p>
<pre>${esc(`curl ${origin}/v1/status/esewa`)}</pre>
<p class="fine" style="margin-top:10px"><a href="/developers">API reference</a> · <a href="/v1/openapi.json">OpenAPI</a></p>
</section>`;
  return layout({
    title: "Is eSewa down? Live status of Nepali payment gateways",
    description: "Is eSewa, Khalti, Fonepay or connectIPS down right now? Live error rates, latency, 90-day uptime and incidents for Nepali payment gateways, checked every minute.",
    canonical: `${origin}/`,
    body,
    current: "gateways",
  });
}

const ADVICE: Record<string, string> = {
  show: "Offer it as usual.",
  warn: "Offer it, with a note that it may be slow.",
  disable: "Switch its button off and point buyers to another method.",
};

/** Which endpoint is called for a gateway, or why it is not checked. */
function probeLine(gateway: string): string {
  const p = PROBES.find((x) => x.gateway === gateway);
  if (!p) return esc(UNMONITORED[gateway] ?? "Not checked yet.");
  return `Checked every minute with <code>${esc(`${p.method} ${new URL(p.url).host}${new URL(p.url).pathname}`)}</code>.`;
}

export function renderGateway(r: StatusReport, g: GatewayStatus, origin: string): string {
  const others = r.gateways
    .filter((o) => o.gateway !== g.gateway)
    .map((o) => `<a href="/${esc(o.gateway)}"><span class="dot s-${o.state}" style="display:inline-block;margin-right:6px"></span>Is ${esc(o.name)} down?</a>`)
    .join("");
  const body = `<p style="margin:0 0 8px;font-size:14px"><a href="/">All gateways</a></p>
<div class="hero-logo">${logo(g.gateway, g.name, 34)}</div>
<h1>Is ${esc(g.name)} down?</h1>
<p class="lede">${esc(stateLine(g))} Last update ${esc(npt(r.generated_at))} NPT.</p>
<div class="tiles">
<div class="tile"><div class="k">Status</div><div class="v"><span class="pill s-${g.state}" style="font-size:15px" data-pill="${esc(g.gateway)}"><span class="dot s-${g.state}"></span>${STATE_LABEL[g.state]}</span></div></div>
<div class="tile"><div class="k">Failed checks, last 15 min</div><div class="v">${esc(pct(g.error_rate))}</div></div>
<div class="tile"><div class="k">p95 latency, last 15 min</div><div class="v">${esc(ms(g.p95_ms))}</div></div>
</div>
<h2>What the API says right now</h2>
<div class="panel advice">
<div><code>action: "${ACTION[g.state]}"</code>. ${esc(ADVICE[ACTION[g.state]])}${buyerMessage(g) ? ` Suggested buyer message: &ldquo;${esc(buyerMessage(g)!)}&rdquo;` : ""}</div>
<pre>${esc(`curl ${origin}/v1/status/${g.gateway}`)}</pre>
<div class="fine">${probeLine(g.gateway)} Badge: <img src="/badge/${esc(g.gateway)}.svg" alt="${esc(g.name)} status badge" height="20" style="vertical-align:middle"></div>
</div>
<h2>Last 24 hours</h2>
<div class="panel">${sparkline(g, 80)}<div class="axis"><span>${esc(npt(g.last_24h[0].t, false))}</span><span>${esc(npt(g.last_24h[12].t, false))}</span><span>now</span></div>
<div class="legend"><span><i style="background:var(--chart);height:2px;vertical-align:3px"></i>p95 latency</span><span><i style="background:var(--bad);opacity:.75"></i>Failed checks</span></div></div>
<h2>Uptime, last 90 days${g.uptime_90d_pct !== null ? `: ${esc(pct(g.uptime_90d_pct, 2))}` : ""}</h2>
<div class="panel">${uptimeBars(g, 36)}<div class="axis"><span>90 days ago</span><span>today</span></div>
<div class="legend"><span><i style="background:var(--ok)"></i>99.5% or more</span><span><i style="background:var(--warn)"></i>95% to 99.5%</span><span><i style="background:var(--bad)"></i>under 95%</span><span><i style="background:var(--none)"></i>no data</span></div></div>
<h2>Latency by hour of day (Nepal time, last 7 days)</h2>
<div class="panel">${peakChart(g)}</div>
<h2>Incidents</h2>
<div class="panel">${incidentsTable(g.incidents)}</div>
<h2>Other gateways</h2>
<div class="others">${others}</div>`;
  return layout({
    title: `Is ${g.name} down? Live ${g.name} status`,
    description: `Is ${g.name} down right now? Live ${g.name} error rate, p95 latency, 90-day uptime, busiest hours and recent incidents, checked every minute.`,
    canonical: `${origin}/${g.gateway}`,
    body,
  });
}

export function renderNotFound(r: StatusReport, origin: string): string {
  const links = r.gateways.map((g) => `<a href="/${esc(g.gateway)}">Is ${esc(g.name)} down?</a>`).join("");
  return layout({
    title: `Gateway not found | ${STATUS_SITE_NAME}`,
    description: "Live status of Nepali payment gateways.",
    canonical: `${origin}/`,
    body: `<h1>No status page for that gateway</h1><p class="lede">These gateways have one:</p><div class="others">${links}</div>`,
  });
}


// ---- /developers: the Status API reference ----

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const table = (head: string[], rows: string[][]) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table>`;
const code = (s: string) => `<code>${esc(s)}</code>`;

const SAMPLE_LIST = `{
  "generated_at": 1793960000000,
  "window_minutes": 15,
  "overall": { "state": "degraded", "operational": 7, "degraded": 1, "down": 0, "no_data": 2 },
  "gateways": [
    {
      "gateway": "esewa",
      "name": "eSewa",
      "state": "degraded",
      "action": "warn",
      "message": "eSewa is slow right now. Your payment may take longer than usual.",
      "error_rate": 0.0667,
      "p95_ms": 6200,
      "uptime_90d_pct": 0.9971,
      "ongoing_incident": null,
      "url": "https://status.discerns.app/esewa"
    }
  ]
}`;

const SAMPLE_CHECKOUT = `{
  "generated_at": 1793960000000,
  "order": ["khalti", "fonepay", "esewa"],
  "available": ["khalti", "fonepay", "esewa"],
  "gateways": [ { "gateway": "khalti", "state": "operational", "action": "show", ... } ]
}`;

const SAMPLE_ERROR = `{ "error": { "code": "unknown_gateway", "message": "unknown gateway; one of esewa, khalti, ..." } }`;

const TS_GUARD = `// Before sending a buyer to the gateway. Fails open: no answer means carry on.
async function gatewayAction(gateway: string): Promise<"show" | "warn" | "disable"> {
  try {
    const res = await fetch(\`https://status.discerns.app/v1/status/\${gateway}\`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return "show";
    return (await res.json()).action;
  } catch {
    return "show";
  }
}

if ((await gatewayAction("esewa")) === "disable") {
  return Response.json({ error: "gateway_down", message: "eSewa is not answering. Try another method." }, { status: 503 });
}`;

const PY_POLL = `# Poll once a minute; an unchanged answer costs a 304 with no body.
import requests, time

etag = None
while True:
    headers = {"If-None-Match": etag} if etag else {}
    r = requests.get("https://status.discerns.app/v1/status", headers=headers, timeout=5)
    if r.status_code == 200:
        etag = r.headers.get("ETag")
        for g in r.json()["gateways"]:
            if g["state"] == "down":
                print(g["name"], "is down since", g["ongoing_incident"] and g["ongoing_incident"]["started_at"])
    time.sleep(60)`;

const CURL_304 = `curl -i https://status.discerns.app/v1/status
# ETag: W/"5f1c9e0a2b7d4c33e811"

curl -i https://status.discerns.app/v1/status -H 'If-None-Match: W/"5f1c9e0a2b7d4c33e811"'
# HTTP/2 304`;

export function renderDevelopers(r: StatusReport, origin: string): string {
  const ids = r.gateways.map((g) => code(g.gateway)).join(", ");
  const method = PROBES.map((p) => {
    const g = r.gateways.find((x) => x.gateway === p.gateway);
    const u = new URL(p.url);
    return [esc(g?.name ?? p.gateway), code(`${p.method} ${u.host}${u.pathname}`)];
  });
  for (const [gw, why] of Object.entries(UNMONITORED)) method.push([esc(r.gateways.find((x) => x.gateway === gw)?.name ?? gw), esc(`Not checked. ${why}`)]);

  const body = `<h1>Status API</h1>
<p class="lede">Gateway availability and response times as JSON, for servers that choose which Nepali payment gateways to offer, warn about, or route around. Free, no key, versioned, and checked against each gateway's production API every minute.</p>
<nav class="others" aria-label="On this page" style="margin-bottom:8px"><a href="#conventions">Conventions</a><a href="#status">GET /v1/status</a><a href="#gateway">GET /v1/status/{gateway}</a><a href="#checkout">GET /v1/checkout</a><a href="#incidents">GET /v1/incidents</a><a href="#objects">Objects</a><a href="#errors">Errors</a><a href="#production">In production</a><a href="#method">Method</a></nav>

<h2 id="conventions">Conventions</h2>
<div class="panel">${table(
    ["", ""],
    [
      ["Base URL", code(`${origin}/v1`)],
      ["Authentication", "None. Every endpoint is public and read-only (GET)."],
      ["Format", "JSON, UTF-8. Times are epoch milliseconds; rates are fractions from 0 to 1; latency is milliseconds."],
      ["Freshness", "Gateways are checked every minute. Responses are cached for 30 seconds (" + code("Cache-Control: public, max-age=30") + ")."],
      ["Conditional requests", "Every 200 carries an " + code("ETag") + ". Send it back as " + code("If-None-Match") + " to get an empty " + code("304") + " when nothing changed."],
      ["CORS", code("Access-Control-Allow-Origin: *") + ", so browsers can call it directly."],
      ["Errors", "Non-2xx answers have one shape: " + code('{ "error": { "code", "message" } }') + ". See <a href=\"#errors\">Errors</a>."],
      ["Versioning", "Within " + code("v1") + " fields are only added, never renamed or removed. Ignore fields you do not know."],
      ["Limits", "No key and no hard rate limit. Poll at most once every 30 seconds; faster polling only returns the cached answer."],
      ["Machine-readable", `<a href="/v1/openapi.json">${code("/v1/openapi.json")}</a> (OpenAPI 3.1).`],
    ],
  )}</div>

<h2 id="status">GET /v1/status</h2>
<div class="panel advice">
<p class="fine" style="margin:0">Every gateway with its current state, what a checkout should do with it, and a suggested buyer message.</p>
<pre>${esc(`curl ${origin}/v1/status`)}</pre>
<pre>${esc(SAMPLE_LIST)}</pre>
</div>

<h2 id="gateway">GET /v1/status/{gateway}</h2>
<div class="panel advice">
<p class="fine" style="margin:0">One gateway: the summary fields above plus ${code("detail")}, which holds 24 hourly points, 90 daily uptime values, latency by Nepal hour of day and every incident in the last 90 days. Gateway ids: ${ids}.</p>
<pre>${esc(`curl ${origin}/v1/status/khalti`)}</pre>
</div>

<h2 id="checkout">GET /v1/checkout</h2>
<div class="panel advice">
${table(["Query", "Required", "Meaning"], [[code("gateways"), "yes", "Comma-separated gateway ids, in the order the checkout shows them. Up to 20."]])}
<p class="fine" style="margin:0">Returns the same gateways reordered: working ones first in the original order, then ones with no data, then slow ones, then down ones. ${code("available")} lists every gateway that is not down. Unknown ids come back in ${code("unknown")}.</p>
<pre>${esc(`curl "${origin}/v1/checkout?gateways=esewa,khalti,fonepay"`)}</pre>
<pre>${esc(SAMPLE_CHECKOUT)}</pre>
</div>

<h2 id="incidents">GET /v1/incidents</h2>
<div class="panel advice">
${table(
    ["Query", "Required", "Meaning"],
    [
      [code("gateway"), "no", "Only this gateway's incidents."],
      [code("ongoing"), "no", code("true") + " for open incidents only, " + code("false") + " for finished ones."],
      [code("limit"), "no", "1 to 200, default 50. Newest first."],
    ],
  )}
<pre>${esc(`curl "${origin}/v1/incidents?ongoing=true"`)}</pre>
<p class="fine" style="margin:0">Also available: ${code("GET /feed.xml")} (Atom, for feed readers and Slack) and ${code("GET /badge/{gateway}.svg")}.</p>
</div>

<h2 id="objects">Objects</h2>
<div class="panel">${table(
    ["Gateway field", "Type", "Meaning"],
    [
      [code("gateway"), "string", "Id: " + ids + "."],
      [code("name"), "string", "Display name."],
      [code("state"), "string", code("operational") + ", " + code("degraded") + ", " + code("down") + " or " + code("no_data") + "."],
      [code("action"), "string", code("show") + ", " + code("warn") + " or " + code("disable") + ". " + code("no_data") + " is always " + code("show") + ", so missing data never blocks a payment."],
      [code("message"), "string | null", "A short sentence for the buyer when the gateway is slow or down."],
      [code("error_rate"), "number | null", "Share of failed checks over the last 15 minutes."],
      [code("p95_ms"), "number | null", "95th percentile response time over the last 15 minutes."],
      [code("uptime_90d_pct"), "number | null", "Share of healthy minutes over 90 Nepal days."],
      [code("ongoing_incident"), "object | null", "The open incident, if any: " + code("started_at") + ", " + code("kind") + " (errors, latency, errors_and_latency), " + code("peak_error_rate") + ", " + code("peak_p95_ms") + "."],
      [code("url"), "string", "This gateway's status page."],
    ],
  )}
<div style="height:14px"></div>
${table(
    ["state", "When", "action"],
    [
      [code("operational"), "Under 10% failed checks and p95 under " + BAD_P95_MS / 1000 + " s over 15 minutes.", code("show")],
      [code("degraded"), "10% or more failed checks, or p95 over " + BAD_P95_MS / 1000 + " s.", code("warn")],
      [code("down"), "Half or more of the checks in 15 minutes failed.", code("disable")],
      [code("no_data"), "No checks yet, or the gateway is not checked.", code("show")],
    ],
  )}</div>

<h2 id="errors">Errors</h2>
<div class="panel advice">
${table(
    ["HTTP", "code", "When"],
    [
      ["400", code("missing_gateways"), code("/v1/checkout") + " without " + code("gateways") + "."],
      ["400", code("bad_ongoing"), code("ongoing") + " is not " + code("true") + " or " + code("false") + "."],
      ["404", code("unknown_gateway"), "The gateway id is not one of the ids above."],
      ["404", code("not_found"), "No such endpoint."],
      ["405", code("method_not_allowed"), "Anything but GET."],
    ],
  )}
<pre>${esc(SAMPLE_ERROR)}</pre>
</div>

<h2 id="production">In production</h2>
<div class="panel advice">
<p class="fine" style="margin:0">Treat the API as a hint that improves the checkout, never as a dependency: give the call a short timeout, cache the answer for 30 seconds, and offer the gateway when the API cannot be reached. Never block a payment on ${code("no_data")}.</p>
<pre>${esc(TS_GUARD)}</pre>
<pre>${esc(PY_POLL)}</pre>
<pre>${esc(CURL_304)}</pre>
</div>

<h2 id="method">Method</h2>
<div class="panel advice">
<p class="fine" style="margin:0">Every minute, from Cloudflare's network, each gateway's production API is called once with no credentials and no transaction. A check passes when the gateway answers with anything but a 5xx within ${PROBE_TIMEOUT_MS / 1000} seconds: a 400 or 401 to an empty request proves the API is up. Response time is measured to the first byte of the answer. An incident is 5 or more minutes with over 20% failed checks or p95 over ${BAD_P95_MS / 1000} s; days roll up at 09:05 Nepal time.</p>
${table(["Gateway", "Checked with"], method)}
</div>`;
  return layout({
    title: `Status API reference | ${STATUS_SITE_NAME}`,
    description: "Free JSON API for the live availability and response times of eSewa, Khalti, Fonepay, connectIPS and other Nepali payment gateways, checked every minute.",
    canonical: `${origin}/developers`,
    body,
    current: "developers",
  });
}
