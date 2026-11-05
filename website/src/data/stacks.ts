// The stacks a reader can pick on the blog. Every framework belongs to one language, and the gateway module
// for that language is shared by all of its frameworks.
export const langs = [
  { id: "ts", name: "TypeScript" },
  { id: "python", name: "Python" },
  { id: "php", name: "PHP" },
  { id: "go", name: "Go" },
  { id: "java", name: "Java" },
  { id: "kotlin", name: "Kotlin" },
] as const;

export const frameworks = [
  { id: "express", name: "Express", lang: "ts" },
  { id: "hono", name: "Hono", lang: "ts" },
  { id: "nextjs", name: "Next.js", lang: "ts" },
  { id: "fastify", name: "Fastify", lang: "ts" },
  { id: "laravel", name: "Laravel", lang: "php" },
  { id: "php", name: "Plain PHP", lang: "php" },
  { id: "django", name: "Django", lang: "python" },
  { id: "fastapi", name: "FastAPI", lang: "python" },
  { id: "flask", name: "Flask", lang: "python" },
  { id: "go", name: "Go net/http", lang: "go" },
  { id: "spring", name: "Spring Boot", lang: "java" },
  { id: "ktor", name: "Ktor", lang: "kotlin" },
] as const;

export type LangId = (typeof langs)[number]["id"];
export type FwId = (typeof frameworks)[number]["id"];
export const DEFAULT_FW: FwId = "express";

/** A code block as the data modules export it. */
export interface Block {
  file: string;
  lang: string;
  code: string;
}

export const fwName = (id: string) => frameworks.find((f) => f.id === id)?.name ?? id;
export const fwLang = (id: string) => frameworks.find((f) => f.id === id)?.lang ?? "ts";

/** Each framework has its own page; the default one lives at the post's own URL. */
export const stackUrl = (postId: string, fw: string) => (fw === DEFAULT_FW ? `/blog/${postId}/` : `/blog/${postId}/${fw}/`);

/**
 * On a post's default page, send a returning reader to the framework they picked last time.
 * Runs in <head> before paint. Crawlers have no saved choice, so they always get the default page.
 */
export const stackRedirectScript = (postId: string) => `(() => {
  let fw = null;
  try { fw = localStorage.getItem("np-stack"); } catch {}
  const known = ${JSON.stringify(frameworks.map((f) => f.id))};
  if (fw && fw !== ${JSON.stringify(DEFAULT_FW)} && known.includes(fw)) location.replace("/blog/${postId}/" + fw + "/" + location.hash);
})();`;
