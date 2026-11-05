// The paynp.ts (or .js) file init writes next to the payment code.

export const MARKER = "Written by `paynp init`";

export const GATEWAY_NAMES: Record<string, string> = {
  esewa: "eSewa",
  khalti: "Khalti",
  fonepay: "Fonepay",
  connectips: "connectIPS",
  cybersource: "CyberSource",
  nps: "NPS",
  imepay: "IME Pay",
};

export interface Style {
  q: string; // quote
  semi: string; // ";" or ""
  ts: boolean;
  workers: boolean; // Cloudflare Workers: no process.env, read the binding from cloudflare:workers
}

function client(s: Style): string[] {
  const { q, semi } = s;
  if (!s.workers) return [`export const paynp = createPaynp({ key: process.env.PAYNP_KEY })${semi}`];
  const read = (k: string) => (s.ts ? `(env as { ${k}?: string }).${k}` : `env.${k}`);
  return [`export const paynp = createPaynp({ key: ${read("PAYNP_KEY")}, endpoint: ${read("PAYNP_ENDPOINT")} })${semi}`].map((l) => l.replaceAll('"', q));
}

function imports(s: Style, lines: string[]): string[] {
  const { q, semi } = s;
  const head = [`import { createPaynp } from ${q}@paynp/sdk${q}${semi}`];
  if (s.workers) head.push(`import { env } from ${q}cloudflare:workers${q}${semi}`);
  return [...head, ...lines];
}

/** Blog gateway modules (startPayment / confirmPayment): one wrapped export per module. */
export function gatewayFile(s: Style, modules: { id: string; spec: string; exportName: string }[]): string {
  const { q, semi } = s;
  const single = modules.length === 1;
  const names = modules.map((m) => GATEWAY_NAMES[m.id] ?? m.id).join(", ");
  const local = (m: { id: string }) => (single ? m.id : `${m.id}Module`);
  const routesNote = single
    ? `The routes import \`${modules[0].exportName}\` from here instead of ${q}${modules[0].spec}${q}.`
    : `The routes import ${modules.map((m) => `\`${m.exportName}\``).join(", ")} from here instead of the gateway modules.`;
  return [
    `// Reports every ${names} payment step to paynp: start, return, status checks, errors.`,
    `// ${MARKER}. ${routesNote}`,
    ...imports(s, modules.map((m) => `import * as ${local(m)} from ${q}${m.spec}${q}${semi}`)),
    "",
    ...client(s),
    ...modules.map((m) => `export const ${m.exportName} = paynp.wrapGateway(${q}${m.id}${q}, ${local(m)})${semi}`),
    "",
    `// To find payments by the buyer's phone or email in the dashboard, pass who paid (paynp keeps both only hashed):`,
    `// export const ${modules[0].exportName} = paynp.wrapGateway(${q}${modules[0].id}${q}, ${local(modules[0])}, { customer: (input) => ({ phone: input.phone, email: input.email }) })${semi}`,
    "",
  ].join("\n");
}

/** Skill adapters (initiate / verify): the library's exports, with each adapter factory and createPayments wrapped. */
export function adapterFile(s: Style, libSpec: string, factories: string[], hasCreatePayments: boolean): string {
  const { q, semi } = s;
  const out = [
    `// Reports every payment step of the nepal-payments adapters to paynp: initiate, verify, errors.`,
    `// ${MARKER}. Same exports as ${q}${libSpec}${q}, with every adapter wrapped.`,
    ...imports(s, [`import * as lib from ${q}${libSpec}${q}${semi}`]),
    "",
    `export * from ${q}${libSpec}${q}${semi}`,
    "",
    ...client(s),
    "",
  ];
  for (const f of factories) {
    out.push(
      s.ts
        ? `export const ${f} = (...args: Parameters<typeof lib.${f}>) => paynp.wrapAdapter(lib.${f}(...args))${semi}`
        : `export const ${f} = (...args) => paynp.wrapAdapter(lib.${f}(...args))${semi}`,
    );
  }
  if (hasCreatePayments) {
    out.push(
      "",
      s.ts ? `export function createPayments(cfg: lib.PaymentsConfig): ReturnType<typeof lib.createPayments> {` : `export function createPayments(cfg) {`,
      `  const payments = lib.createPayments(cfg)${semi}`,
      `  return {`,
      `    ...payments,`,
      `    get: (id) => paynp.wrapAdapter(payments.get(id)),`,
      `    adapter: (id) => paynp.wrapAdapter(payments.adapter(id)),`,
      `  }${semi}`,
      `}`,
    );
  }
  out.push(
    "",
    `// To find payments by the buyer's phone or email in the dashboard, pass who paid (paynp keeps both only hashed):`,
    `// paynp.wrapAdapter(adapter, { customer: (input) => input.customer })${semi}`,
    "",
  );
  return out.join("\n");
}

/** Gateways with a refund API (references/khalti.md, cybersource.md); the rest get a manual checklist in the dashboard. */
const REFUND_API: Record<string, string> = {
  khalti: "Khalti has a refund API: the @paynp/sdk README has a working refund callback to paste here.",
  cybersource: "CyberSource has a REST refund API (POST /pts/v2/payments/{id}/refunds) that needs REST keys; see the @paynp/sdk README.",
};

/** paynp-actions.ts: what the dashboard's Re-check and Send refund buttons run on this server. */
export function actionsFile(
  s: Style,
  o: { gateway: string; gatewaySpec: string; exportName: string; settle?: { spec: string }; store?: { spec: string } },
): string {
  const { q, semi } = s;
  const name = GATEWAY_NAMES[o.gateway] ?? o.gateway;
  const typed = s.ts ? ": ActionHandlerOptions" : "";
  const lines = [
    `// What the paynp dashboard's "Re-check" and "Send refund" buttons run on this server. ${MARKER}.`,
    `// paynp signs each request with PAYNP_ACTION_SECRET (dashboard: Settings, Action endpoint); the route checks the`,
    `// signature, the timestamp and replays before it calls these.`,
    ...(s.ts ? [`import type { ActionHandlerOptions } from ${q}@paynp/sdk${q}${semi}`] : []),
    `import { ${o.exportName} } from ${q}${o.gatewaySpec}${q}${semi}`,
    ...(o.settle ? [`import { settle } from ${q}${o.settle.spec}${q}${semi}`] : []),
    ...(o.store ? [`import { getAttempt } from ${q}${o.store.spec}${q}${semi}`] : []),
    "",
    `export const actions${typed} = {`,
    `  // Re-check: ask ${name} again, the same call the reconcile job makes.`,
    `  async recheck(a) {`,
  ];
  if (o.settle && o.store) {
    lines.push(
      `    const attempt = getAttempt(a.attemptId)${semi}`,
      `    if (!attempt) return { ok: false, error: ${q}no such payment attempt on this server${q} }${semi}`,
      `    const outcome = await ${o.exportName}.confirmPayment({ attemptId: attempt.id, amountPaisa: attempt.amountPaisa, providerRef: attempt.providerRef, params: {} })${semi}`,
      `    settle(attempt, outcome)${semi}`,
      `    return { status: outcome.status }${semi}`,
    );
  } else {
    lines.push(
      `    const outcome = await ${o.exportName}.confirmPayment({ attemptId: a.attemptId, amountPaisa: a.amountPaisa ?? 0, providerRef: a.providerRef ?? null, params: {} })${semi}`,
      `    return { status: outcome.status }${semi}`,
    );
  }
  lines.push(`  },`);
  lines.push(
    REFUND_API[o.gateway]
      ? `  // Send refund: ${REFUND_API[o.gateway]}`
      : `  // Send refund: ${name} has no refund API, so the dashboard shows a manual checklist instead and this stays out.`,
    `  // async refund(a) { /* refund a.refund?.amountPaisa of a.providerRef */ return { refundRef: ${q}...${q} }${semi} },`,
    `}${semi}`,
    "",
  );
  // `a` is typed through ActionHandlerOptions in TS; plain JS has no annotation to add.
  return lines.join("\n");
}

/** app/paynp/actions/route.ts for Next.js. */
export function nextActionRoute(s: Style, paynpSpec: string, actionsSpec: string): string {
  const { q, semi } = s;
  return [
    `// POST /paynp/actions: refunds and re-checks from the paynp dashboard, signed with PAYNP_ACTION_SECRET. ${MARKER}.`,
    `import { paynp } from ${q}${paynpSpec}${q}${semi}`,
    `import { actions } from ${q}${actionsSpec}${q}${semi}`,
    "",
    `export const POST = paynp.actionHandler(actions)${semi}`,
    "",
  ].join("\n");
}
