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
  out.push("");
  return out.join("\n");
}
