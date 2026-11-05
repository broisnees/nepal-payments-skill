// Generates the Providers and Guides docs, so the website and the skill can never drift:
//   docs/providers/index.mdx              overview of every provider
//   docs/providers/<p>/index.mdx          step-by-step integration guide (src/data/provider-guides.ts + integrations/*.ts)
//   docs/providers/<p>/reference.md       skills/nepal-payments/references/<p>.md
//   docs/guides/*.md                      the cross-provider references
// Runs before `astro dev` and `astro build`; the output is gitignored. Needs Node 23.6+ (imports .ts data).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const refs = join(root, "skills", "nepal-payments", "references");
const out = join(root, "website", "src", "content", "docs", "docs");
const data = join(root, "website", "src", "data");
const repo = "https://github.com/broisnees/nepal-payments-skill";

const { providerGuides } = await import(pathToFileURL(join(data, "provider-guides.ts")).href);
const { signing, providers } = await import(pathToFileURL(join(data, "site.ts")).href);
const { architectureFlow, providerFlows } = await import(pathToFileURL(join(data, "flows.ts")).href);
const { sequenceSvg, stateMachineSvg } = await import(pathToFileURL(join(here, "diagrams.mjs")).href);
const LANGS = ["ts", "python", "go", "java", "kotlin", "php"];
const snippets = [];
for (const lang of LANGS) {
  const file = join(data, "integrations", `${lang}.ts`);
  if (existsSync(file)) snippets.push((await import(pathToFileURL(file).href)).default);
  else console.warn(`sync-docs: no integrations/${lang}.ts yet, skipping that tab`);
}

/** Reference file -> where it lands. Provider references sit under their guide. */
const REFERENCES = {
  "esewa.md": { path: "providers/esewa/reference", title: "eSewa reference" },
  "khalti.md": { path: "providers/khalti/reference", title: "Khalti reference" },
  "fonepay.md": { path: "providers/fonepay/reference", title: "Fonepay reference" },
  "connectips.md": { path: "providers/connectips/reference", title: "connectIPS reference" },
  "cybersource.md": { path: "providers/cybersource/reference", title: "CyberSource reference" },
  "nps.md": { path: "providers/nps/reference", title: "NPS OnePG reference" },
  "imepay.md": { path: "providers/imepay/reference", title: "IME Pay reference" },
  "others.md": {
    path: "providers/others",
    title: "Other gateways",
    description: "Notes for HBL (2C2P PACO), Prabhu Pay, Moru, CellPay and Namaste Pay, and how to build them on the same adapter interface.",
  },
  "architecture.md": {
    path: "guides/architecture",
    title: "Production architecture",
    description: "Payment attempts, a tested state machine, exactly-once fulfilment and reconciliation: what keeps a Nepali payment integration correct under real traffic.",
  },
  "web.md": { path: "guides/web", title: "Web frameworks", description: "Wire the payment routes into Express, Hono, Next.js, FastAPI, Django, Laravel, Spring Boot and Ktor." },
  "mobile.md": { path: "guides/mobile", title: "Mobile apps", description: "Take Nepali payments from Flutter, React Native, Expo, Android and iOS apps without putting secrets on the device." },
  "env.md": { path: "guides/env", title: "Environment variables", description: "Every environment variable the adapters read, per provider, and which ones enable each gateway." },
  "testing.md": { path: "guides/testing", title: "Testing and go-live", description: "Sandbox credentials for every provider, the bundled test suites, integration checks and a go-live checklist." },
};
const blogSlug = Object.fromEntries(providers.map((p) => [p.slug, p.blog]));
const guideByKey = Object.fromEntries(providerGuides.map((g) => [g.key, g]));
const urlOf = (file) => `/docs/${REFERENCES[file].path}/`;

function transformReference(md, file) {
  // Starlight renders the title from frontmatter; drop the H1 and the hand-made table of contents.
  let body = md.replace(/^# .*\n+/, "").replace(/^## Contents\n[\s\S]*?(?=^## )/m, "");
  if (file === "architecture.md") {
    // The agent reads the ASCII versions; people get SVG. Fail loudly if the source diagrams move.
    const before = body;
    body = body.replace(/^```\ninitiated ──►[\s\S]*?^```$/m, () => stateMachineSvg("d-state"));
    body = body.replace(/^```\nClient \(web\/mobile\)[\s\S]*?^```$/m, () => sequenceSvg("d-flow", architectureFlow));
    if ((before.match(/<figure/g) ?? []).length + 2 !== (body.match(/<figure/g) ?? []).length) {
      throw new Error("sync-docs: architecture.md diagrams not found; update the patterns in transformReference");
    }
  }
  body = body.replace(/`(?:references\/)?([a-z]+\.md)`/g, (m, name) => (REFERENCES[name] ? `[\`${name}\`](${urlOf(name)})` : m));
  body = body.replace(/^```gradle$/gm, "```groovy"); // Shiki has no gradle grammar
  body = body.replace(/`(scripts\/[^`\s]+)`/g, (_m, p) => `[\`${p}\`](${repo}/blob/main/skills/nepal-payments/${p.replace(/\/$/, "")})`);
  return body;
}

/** MDX treats `{`, `}` and `<` in prose as JSX. Escape them outside inline code spans. */
const prose = (s) =>
  s
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}<>]/g, (c) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[c])))
    .join("");

const fence = (lang, code) => {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code.trim()}\n${ticks}`;
};

const tabs = (pick) =>
  [
    '<Tabs syncKey="lang">',
    ...snippets.flatMap((s) => {
      const part = pick(s);
      if (!part) return [];
      return [`<TabItem label="${s.label}">`, "", part, "", "</TabItem>"];
    }),
    "</Tabs>",
  ].join("\n");

const frontmatter = (fields) =>
  ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", ""].join("\n");
const q = JSON.stringify;

const proof = {
  esewa: "Status API",
  khalti: "Lookup by `pidx`",
  fonepay: "txnVerification",
  connectips: "`validatetxn`",
  cybersource: "Signed response POST",
  nps: "`CheckTransactionStatus`",
  imepay: "`Recheck`",
};

function guidePage(g) {
  const lines = [
    frontmatter({
      title: q(`Integrate ${g.name}`),
      description: q(g.description),
      sidebar: '{ label: "Integrate", order: 0 }',
      editUrl: q(`${repo}/edit/main/website/src/data/provider-guides.ts`),
    }),
    'import { Tabs, TabItem, Steps, Aside, LinkCard, CardGrid } from "@astrojs/starlight/components";',
    'import Diagram from "../../../../../components/Diagram.astro";',
    'import GatewayLogo from "../../../../../components/GatewayLogo.astro";',
    "",
    `<div class="np-gw-logo"><GatewayLogo slug="${g.key}" name="${g.name}" height={32} /></div>`,
    "",
    prose(g.summary),
    "",
    "## How the payment flows",
    "",
    `<Diagram html={${JSON.stringify(sequenceSvg(`d-${g.key}`, providerFlows[g.key]))}} />`,
    "",
    "<Steps>",
    "",
    ...g.flow.map((f, i) => `${i + 1}. ${prose(f)}\n`),
    "</Steps>",
    "",
    "## 1. Set the environment variables",
    "",
    "| | Variables |",
    "|---|---|",
    `| Required | ${g.env.required.map((v) => `\`${v}\``).join(", ")} |`,
    `| Optional | ${g.env.optional.map((v) => `\`${v}\``).join(", ") || "none"} |`,
    "",
    g.sandboxEnv ? `For the sandbox:\n\n${fence("bash", g.sandboxEnv)}\n` : "",
    "The full list for every provider is in [Environment variables](/docs/guides/env/).",
    "",
  ];
  if (g.extraSetup) {
    lines.push(`### ${g.extraSetup.title}`, "", prose(g.extraSetup.body), "");
    if (g.extraSetup.code) lines.push(fence(g.extraSetup.code.lang, g.extraSetup.code.text), "");
  }
  lines.push(
    "## 2. Create the payments client",
    "",
    "Build it once at startup from the environment. Every provider whose required variables are set is enabled.",
    "",
    tabs((s) => fence(s.lang, s.setup)),
    "",
    "## 3. Start a payment",
    "",
    "Create a payment attempt in your database first (its id is the order id the provider sees), then:",
    "",
    tabs((s) => {
      const p = s.providers[g.key];
      if (!p) return null;
      const notes = (p.notes ?? []).map((n) => `- ${prose(n)}`).join("\n");
      return fence(s.lang, p.initiate) + (notes ? `\n\n${notes}` : "");
    }),
    "",
    "## 4. Verify on return",
    "",
    prose(g.callback),
    "",
    tabs((s) => (s.providers[g.key] ? fence(s.lang, s.providers[g.key].verify) : null)),
    "",
    '<Aside type="caution" title="Fulfil only on paid">',
    "Apply `next` with a conditional `UPDATE ... WHERE status = prev`, and fulfil only when it is `paid`. The same handler serves retries, duplicate callbacks and the reconciliation job. See [Production architecture](/docs/guides/architecture/).",
    "</Aside>",
    "",
    "## 5. Test in the sandbox",
    "",
    ...g.sandbox.map((s) => `- ${prose(s)}`),
    "",
    "## Gotchas",
    "",
    ...g.gotchas.map((s) => `- ${prose(s)}`),
    "",
    "## Go-live checklist",
    "",
    ...g.goLive.map((s) => `- ${prose(s)}`),
    "- Run one real low-value payment end to end, then refund it.",
    "- Keep the reconciliation job and its alerts running.",
    "",
    "## Next",
    "",
    "<CardGrid>",
    `  <LinkCard title="${g.name} reference" description="Every field, status code and test vector, as the agent reads it." href="/docs/providers/${g.key}/reference/" />`,
    '  <LinkCard title="Wire your framework" description="Express, Hono, Next.js, FastAPI, Django, Laravel, Spring Boot and Ktor routes." href="/docs/guides/web/" />',
    `  <LinkCard title="${g.name} without the adapters" description="Raw signing and verification in Node.js, Laravel and Django, plus the common error codes." href="/blog/${blogSlug[g.key]}/" />`,
    "</CardGrid>",
    "",
  );
  return lines.join("\n");
}

function overviewPage() {
  const scheme = Object.fromEntries(signing.map((s) => [s.provider, `${s.scheme} (${s.encoding})`]));
  return [
    frontmatter({
      title: q("Providers"),
      description: q("Compare eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS and IME Pay, then follow the step-by-step guide for each."),
      sidebar: '{ label: "Overview", order: 0 }',
    }),
    'import GatewayLogo from "../../../../components/GatewayLogo.astro";',
    "",
    '<div class="np-gw-logos">',
    ...providerGuides.map((g) => `  <a href="/docs/providers/${g.key}/" title="${g.name}"><GatewayLogo slug="${g.key}" name="${g.name}" height={26} /></a>`),
    "</div>",
    "",
    "Every provider implements the same `initiate` and `verify` interface in all six languages. Each one has a step-by-step integration guide and a full reference.",
    "",
    "| Provider | Type | Signing | Proof of payment | Docs |",
    "|---|---|---|---|---|",
    ...providerGuides.map(
      (g) =>
        `| **${g.name}** | ${g.kind} | ${scheme[g.name] ?? ""} | ${proof[g.key]} | [Integrate](/docs/providers/${g.key}/) · [Reference](/docs/providers/${g.key}/reference/) |`,
    ),
    "",
    "## Which to start with",
    "",
    "- **eSewa and Khalti** cover the largest wallets.",
    "- **NPS or Fonepay** reach most banks through one integration.",
    "- **connectIPS** debits bank accounts directly.",
    "- **CyberSource** only if a bank is acquiring cards for you.",
    "- **IME Pay** only for existing IME Pay merchants; new builds use Khalti.",
    "",
    "HBL (2C2P PACO), Prabhu Pay, Moru, CellPay and Namaste Pay have notes in [Other gateways](/docs/providers/others/) but no bundled adapter.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- write
for (const dir of ["providers", "guides"]) rmSync(join(out, dir), { recursive: true, force: true });

const write = (rel, text) => {
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

Object.entries(REFERENCES).forEach(([file, page], i) => {
  const md = readFileSync(join(refs, file), "utf8");
  const guide = guideByKey[file.replace(/\.md$/, "")];
  const fm = frontmatter({
    title: q(page.title),
    description: q(
      page.description ?? `Full ${guide.name} reference: endpoints, fields, statuses, signature test vectors and gotchas, as the coding agent reads it.`,
    ),
    editUrl: q(`${repo}/edit/main/skills/nepal-payments/references/${file}`),
    sidebar: guide ? '{ label: "Reference", order: 1 }' : `{ order: ${i} }`,
  });
  const source = `> Source: [\`references/${file}\`](${repo}/blob/main/skills/nepal-payments/references/${file}). This is the same file the agent reads.\n\n`;
  write(`${page.path}.md`, fm + source + transformReference(md, file));
});

for (const g of providerGuides) write(`providers/${g.key}/index.mdx`, guidePage(g));
write("providers/index.mdx", overviewPage());

console.log(`sync-docs: ${Object.keys(REFERENCES).length} references, ${providerGuides.length} guides, ${snippets.length} languages`);
