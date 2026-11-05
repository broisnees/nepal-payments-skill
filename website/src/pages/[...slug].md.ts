// Every docs page as plain Markdown at /docs/<page>.md, for "Copy page", "View as Markdown" and AI tools.
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs", (e) => e.id.startsWith("docs"));
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}) satisfies GetStaticPaths;

/** MDX import lines mean nothing outside the site; drop them. */
const clean = (body: string) => body.replace(/^import .*$\n?/gm, "").replace(/\n{3,}/g, "\n\n").trim();

export const GET: APIRoute = ({ props, site }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };
  const url = new URL(`/${entry.id}/`, site).href;
  const text = `# ${entry.data.title}\n\n> ${entry.data.description ?? ""}\n\nSource: ${url}\n\n${clean(entry.body ?? "")}\n`;
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
