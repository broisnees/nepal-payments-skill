// Collects the shared app code (one module per language in ./shared) and the gateway modules for the posts.
// Missing languages are skipped, so a post renders whatever has been written so far.
import type { Block } from "../stacks";

export interface GatewayNames {
  id: string;
  name: string;
  ts: string;
  py: string;
  php: string;
  go: string;
  java: string;
  kotlin: string;
}

/** Names each language uses for a gateway: esewa.ts, esewa.py, EsewaGateway.php, NewEsewa(), ... */
export const gatewayNames = (id: string, name: string, base: string): GatewayNames => ({
  id,
  name,
  ts: id,
  py: id,
  php: `${base}Gateway`,
  go: `New${base}`,
  java: `${base}Gateway`,
  kotlin: `${base}Gateway`,
});

type Value = Block | Block[];
type Shared = {
  types: Value | ((g: GatewayNames) => Value);
  store: Value | ((g: GatewayNames) => Value);
  reconcile: Value | ((g: GatewayNames) => Value);
  routes: (g: GatewayNames) => Record<string, Value>;
  setup: Record<string, Value> | ((g: GatewayNames) => Record<string, Value>);
};

const shared = Object.fromEntries(
  Object.entries(import.meta.glob<Shared>("./shared/*.ts", { eager: true })).map(([path, mod]) => [
    path.replace(/^.*\/|\.ts$/g, ""),
    mod,
  ]),
);

const call = <T,>(v: T | ((g: GatewayNames) => T), g: GatewayNames): T => (typeof v === "function" ? (v as (g: GatewayNames) => T)(g) : v);
const perLang = (pick: (m: Shared) => Value) => Object.fromEntries(Object.entries(shared).map(([lang, m]) => [lang, pick(m)]));
const perFw = (pick: (m: Shared) => Record<string, Value>) => Object.assign({}, ...Object.values(shared).map(pick)) as Record<string, Value>;

/** Everything a gateway post shows besides its own module, keyed the way CodeGroup expects. */
export const app = (g: GatewayNames) => ({
  types: perLang((m) => call(m.types, g)),
  store: perLang((m) => call(m.store, g)),
  reconcile: perLang((m) => call(m.reconcile, g)),
  routes: perFw((m) => m.routes(g)),
  setup: perFw((m) => call(m.setup, g)),
});

export interface GatewayCode {
  file: string;
  lang: string;
  parts: Record<string, string>;
}

/** One part of a gateway module per language, ready for CodeGroup. The file name shows on every part. */
export const part = (code: Record<string, GatewayCode>, name: string) =>
  Object.fromEntries(Object.entries(code).map(([lang, c]) => [lang, { file: c.file, lang: c.lang, code: c.parts[name] }]));

/** The whole gateway module per language, for the "full file" block. */
export const whole = (code: Record<string, GatewayCode>, order: string[]) =>
  Object.fromEntries(
    Object.entries(code).map(([lang, c]) => [lang, { file: c.file, lang: c.lang, code: order.map((p) => c.parts[p]).join("\n\n") }]),
  );
