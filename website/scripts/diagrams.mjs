// Build-time SVG diagrams for the docs. Colors come from CSS variables (src/styles/docs.css),
// so one SVG works in light and dark. Each diagram is a single line of HTML so it can sit
// inside a Markdown HTML block or be passed to an MDX component.

const SANS = 7.1; // average advance at 13px, Inter
const MONO = 7.9; // average advance at 13px, JetBrains Mono

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s) => s.replace(/`/g, "");

/** Estimated rendered width of a label; `code` spans are wider. */
const width = (s) => s.split(/(`[^`]*`)/).reduce((w, part, i) => w + plain(part).length * (i % 2 ? MONO : SANS), 0);

/** Label text with `code` spans as monospace tspans. */
const spans = (s) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? `<tspan class="d-code">${esc(plain(part))}</tspan>` : esc(part)))
    .join("");

const figure = (id, title, desc, w, h, body, kind) =>
  `<figure class="np-diagram" data-kind="${kind}"><div class="np-diagram-scroll"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="${id}-t ${id}-d" style="--d-min:${Math.min(w, 600)}px"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc><defs><marker id="${id}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="d-head" d="M0 0 10 5 0 10z"/></marker><marker id="${id}-r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="d-head-reply" d="M0 0 10 5 0 10z"/></marker></defs>${body}</svg></div><figcaption>${esc(title)}</figcaption></figure>`;

export function sequenceSvg(id, flow) {
  const { actors, steps, title } = flow;
  const index = Object.fromEntries(actors.map((a, i) => [a.id, i]));
  const pad = 16;
  const headerW = actors.map((a) => Math.max(124, width(a.label) + 28));

  // Gap between neighbouring lifelines: wide enough for every label that spans exactly that pair,
  // half of any note centred on either side, and the header boxes.
  const gaps = actors.slice(1).map((_, i) => Math.max(180, (headerW[i] + headerW[i + 1]) / 2 + 24));
  for (const s of steps) {
    if ("note" in s) {
      const i = index[s.note];
      const half = (width(s.text) + 28) / 2 + 16;
      if (i > 0) gaps[i - 1] = Math.max(gaps[i - 1], half + 30);
      if (i < actors.length - 1) gaps[i] = Math.max(gaps[i], half + 30);
    } else {
      const [a, b] = [index[s.from], index[s.to]].sort((x, y) => x - y);
      const need = width(s.text) + 48;
      const have = gaps.slice(a, b).reduce((x, y) => x + y, 0);
      if (need > have) for (let g = a; g < b; g++) gaps[g] += (need - have) / (b - a);
    }
  }
  const xs = [Math.max(headerW[0] / 2, (width(steps.find((s) => "note" in s && index[s.note] === 0)?.text ?? "") + 28) / 2) + pad];
  for (const g of gaps) xs.push(xs[xs.length - 1] + g);
  const lastNote = steps.filter((s) => "note" in s && index[s.note] === actors.length - 1).map((s) => (width(s.text) + 28) / 2);
  const w = Math.ceil(xs[xs.length - 1] + Math.max(headerW[actors.length - 1] / 2, ...lastNote) + pad);

  const top = 64;
  const row = 40;
  const h = top + steps.length * row + 20;
  const out = [];

  actors.forEach((a, i) => {
    out.push(`<line class="d-life" x1="${xs[i]}" y1="48" x2="${xs[i]}" y2="${h - 8}"/>`);
    out.push(`<rect class="d-actor" x="${xs[i] - headerW[i] / 2}" y="10" width="${headerW[i]}" height="38" rx="8"/>`);
    out.push(`<text class="d-actor-t" x="${xs[i]}" y="34" text-anchor="middle">${esc(a.label)}</text>`);
  });

  steps.forEach((s, n) => {
    const y = top + n * row;
    if ("note" in s) {
      const x = xs[index[s.note]];
      const nw = width(s.text) + 28;
      out.push(`<rect class="d-note" x="${x - nw / 2}" y="${y + 6}" width="${nw}" height="28" rx="6"/>`);
      out.push(`<text class="d-note-t" x="${x}" y="${y + 24.5}" text-anchor="middle">${spans(s.text)}</text>`);
      return;
    }
    const x1 = xs[index[s.from]];
    const x2 = xs[index[s.to]];
    const dir = Math.sign(x2 - x1);
    const cls = s.reply ? "d-reply" : "d-msg";
    out.push(`<line class="${cls}" x1="${x1 + dir * 2}" y1="${y + 28}" x2="${x2 - dir * 3}" y2="${y + 28}" marker-end="url(#${id}-${s.reply ? "r" : "a"})"/>`);
    out.push(`<text class="d-label" x="${(x1 + x2) / 2}" y="${y + 20}" text-anchor="middle">${spans(s.text)}</text>`);
    out.push(`<text class="d-num" x="${Math.min(x1, x2) + 10}" y="${y + 20}">${n + 1}</text>`);
  });

  const label = (k) => actors[index[k]].label;
  const desc = steps
    .map((s, n) => `${n + 1}. ${"note" in s ? `${label(s.note)}: ${plain(s.text)}` : `${label(s.from)} to ${label(s.to)}: ${plain(s.text)}`}`)
    .join(" ");
  return figure(id, title, desc, w, h, out.join(""), "sequence");
}

/** The payment-attempt state machine from architecture.md section 2. */
export function stateMachineSvg(id) {
  const node = (x, y, w, label, cls = "d-state", sub) =>
    `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${sub ? 52 : 40}" rx="20"/>` +
    `<text class="d-state-t" x="${x + w / 2}" y="${y + (sub ? 22 : 25)}" text-anchor="middle">${label}</text>` +
    (sub ? `<text class="d-state-sub" x="${x + w / 2}" y="${y + 39}" text-anchor="middle">${sub}</text>` : "");
  const arrow = (d, cls = "d-msg", head = "a") => `<path class="${cls}" d="${d}" fill="none" marker-end="url(#${id}-${head})"/>`;
  const label = (x, y, t, anchor = "middle", cls = "d-label") => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${spans(t)}</text>`;

  const body = [
    node(24, 40, 120, "initiated"),
    node(214, 40, 120, "pending"),
    node(404, 40, 110, "paid", "d-state d-good"),
    node(584, 34, 196, "refunded", "d-state", "or partially_refunded"),
    node(214, 196, 300, "failed · canceled · expired", "d-state d-bad"),
    arrow("M146 60H210"),
    arrow("M336 60H400"),
    arrow("M516 60H580"),
    label(548, 52, "refund flow", "middle", "d-small"),
    arrow("M84 82V216H210"),
    arrow("M274 82V192"),
    arrow("M460 194V86", "d-reply", "r"),
    label(472, 146, "late payment: recover + alert", "start"),
    label(372, 274, "`not_found` writes nothing until the session window ends, then `expired`", "middle", "d-small"),
  ].join("");
  const desc =
    "initiated moves to pending, pending to paid, paid to refunded or partially_refunded through the refund flow. initiated and pending can close as failed, canceled or expired. A provider saying paid after the attempt closed moves it to paid (late payment: recover and alert). not_found writes nothing until the session window ends, then expired.";
  return figure(id, "Payment attempt state machine", desc, 804, 292, body, "state");
}
