// Every docs page as plain Markdown at /docs/<page>.md, for "Copy page", "View as Markdown" and AI tools.
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { REPO, faqs, languages, prompts, providers, snippets, totalTests } from "../data/site";

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs", (e) => e.id.startsWith("docs"));
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}) satisfies GetStaticPaths;

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** One MDX component line as plain Markdown; undefined when the line isn't a component. */
function componentToMarkdown(line: string, site: URL | undefined): string | undefined {
  const t = line.trim();
  if (/^import\s/.test(t)) return "";
  if (/^<\/?(Steps|Tabs|CardGrid)\b[^>]*>$/.test(t) || /^<\/(TabItem|Aside)>$/.test(t)) return "";
  if (t.includes("<GatewayLogo")) return "";
  if (t.startsWith("<TabItem")) return `**${attr(t, "label") ?? ""}**`;
  if (t.startsWith("<Aside")) return `**${attr(t, "title") ?? (attr(t, "type") ?? "note").replace(/^./, (c) => c.toUpperCase())}**`;
  if (t.startsWith("<LinkCard")) {
    const href = new URL(attr(t, "href") ?? "/", site).href;
    const desc = attr(t, "description");
    return `- [${attr(t, "title") ?? href}](${href})${desc ? `: ${desc}` : ""}`;
  }
  if (t.startsWith("<Diagram")) {
    // The SVG carries its own text version: <title> and a numbered <desc>.
    const html = t.replace(/\\"/g, '"');
    const title = unescape(html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "Diagram");
    const desc = unescape(html.match(/<desc[^>]*>([^<]*)<\/desc>/)?.[1] ?? "");
    const steps = desc.split(/\s(?=\d+\.\s)/).filter(Boolean);
    return [`*${title}:*`, "", ...steps].join("\n");
  }
  return undefined;
}

/** Values the MDX pages print with {expressions}, and how their {name.map(...)} blocks read as Markdown. */
const scope: Record<string, unknown> = { REPO, faqs, languages, prompts, providers, snippets, totalTests };
const lists: Record<string, (site: URL | undefined) => string> = {
  snippets: () => snippets.map((s) => `**${s.label}**\n\n\`\`\`${s.lang}\n${s.code}\n\`\`\``).join("\n\n"),
  providers: (site) => providers.map((p) => `- [${p.name}](${new URL(`/docs/providers/${p.slug}/`, site).href}) (${p.kind}): ${p.flows}`).join("\n"),
  languages: () =>
    ["| Language | Runtime | Dependencies | Tests | Code |", "|---|---|---|---|---|",
      ...languages.map((l) => `| ${l.name} | ${l.runtime} | ${l.deps} | ${l.tests} | [\`${l.path}\`](${REPO}/tree/main/skills/nepal-payments/${l.path}) |`)].join("\n"),
  faqs: () => faqs.map((f) => `## ${f.q}\n\n${f.a}`).join("\n\n"),
  prompts: () => prompts.map((p) => `- "${p}"`).join("\n"),
};

/** {totalTests}, {languages.length}: the value, when it is a plain string or number. */
const fillInline = (line: string) =>
  line.replace(/\{([A-Za-z_]\w*(?:\.\w+)*)\}/g, (m, path: string) => {
    const v = path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), scope);
    return typeof v === "string" || typeof v === "number" ? String(v) : m;
  });

const braceDepth = (line: string) => [...line].reduce((d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);
const htmlOnly = (line: string) => /^\s*<\/?[a-z][\w-]*(\s[^>]*)?>.*$/.test(line) && !/^\s*<(https?:|br\b)/.test(line);

/** MDX components mean nothing outside the site: turn them into plain Markdown, leaving code blocks untouched. */
function clean(body: string, site: URL | undefined): string {
  let fence: string | null = null;
  let block = 0; // brace depth inside a {name.map(...)} block being replaced
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const f = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (f) fence = fence === null ? f : line.trim().startsWith(fence) ? null : fence;
    if (fence !== null || f) {
      out.push(line);
      continue;
    }
    if (block > 0) {
      block += braceDepth(line);
      continue;
    }
    const map = line.match(/^\s*\{(\w+)\.map\(/);
    if (map) {
      out.push(lists[map[1]]?.(site) ?? "");
      block = braceDepth(line);
      continue;
    }
    const md = componentToMarkdown(line, site);
    if (md !== undefined) out.push(md);
    else if (!htmlOnly(line)) out.push(fillInline(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const GET: APIRoute = ({ props, site }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };
  const url = new URL(`/${entry.id}/`, site).href;
  const text = `# ${entry.data.title}\n\n> ${entry.data.description ?? ""}\n\nSource: ${url}\n\n${clean(entry.body ?? "", site)}\n`;
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
