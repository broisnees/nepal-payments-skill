// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

// Canonical origin for sitemap, canonical links and Open Graph URLs. Set SITE_URL in the deploy env.
const site = process.env.SITE_URL ?? "https://nepal-payments-skill.pages.dev";
const repo = "https://github.com/broisnees/nepal-payments-skill";
const providerNav = [
  ["eSewa", "esewa"],
  ["Khalti", "khalti"],
  ["Fonepay", "fonepay"],
  ["connectIPS", "connectips"],
  ["CyberSource", "cybersource"],
  ["NPS OnePG", "nps"],
  ["IME Pay", "imepay"],
];
const description =
  "Agent skill and tested adapters for Nepali payment gateways: eSewa, Khalti, Fonepay, connectIPS, CyberSource, NPS and IME Pay, in TypeScript, Python, Java, Kotlin, PHP and Go.";

export default defineConfig({
  site,
  trailingSlash: "always",
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  build: { inlineStylesheets: "auto" },
  integrations: [
    starlight({
      title: "Nepal Payments",
      description,
      logo: { src: "./src/assets/logo.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/website/` },
      lastUpdated: true,
      titleDelimiter: "·",
      customCss: [
        "@fontsource-variable/inter/opsz.css",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/docs.css",
        "./src/styles/logos.css",
      ],
      components: {
        Head: "./src/components/DocsHead.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/SettingsMenu.astro",
      },
      head: [
        { tag: "meta", attrs: { name: "theme-color", content: "#ffffff" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: `${site}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${site}/og.png` } },
      ],
      expressiveCode: {
        themes: ["vitesse-dark", "vitesse-light"],
        defaultProps: { wrap: true, preserveIndent: true },
        styleOverrides: {
          borderRadius: "0",
          borderColor: "var(--sl-color-hairline)",
          codeFontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
          codeFontSize: "0.8125rem",
          frames: { shadowColor: "transparent" },
        },
      },
      sidebar: [
        {
          label: "Getting started",
          collapsed: true,
          items: [
            { label: "Introduction", slug: "docs" },
            { label: "Install the skill", slug: "docs/install" },
            { label: "Use it with your agent", slug: "docs/usage" },
            { label: "Use the adapters directly", slug: "docs/adapters" },
            { label: "Docs for AI tools", slug: "docs/ai" },
          ],
        },
        {
          label: "Providers",
          collapsed: true,
          items: [
            { label: "Overview", slug: "docs/providers" },
            ...providerNav.map(([label, key]) => ({
              label,
              collapsed: true,
              items: [
                { label: "Integrate", slug: `docs/providers/${key}` },
                { label: "Reference", slug: `docs/providers/${key}/reference` },
              ],
            })),
            { label: "Other gateways", slug: "docs/providers/others" },
          ],
        },
        { label: "Guides", collapsed: true, items: [{ autogenerate: { directory: "docs/guides" } }] },
        { label: "Blog", link: "/blog/" },
        {
          label: "Reference",
          collapsed: true,
          items: [
            { label: "Adapter API", slug: "docs/api" },
            { label: "Languages", slug: "docs/languages" },
            { label: "FAQ", slug: "docs/faq" },
          ],
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Nepal Payments",
          description,
          details:
            "The skill lives at skills/nepal-payments in the GitHub repo. Each provider has an integration guide (code in TypeScript, Python, Go, Java, Kotlin and PHP) and a reference generated from the skill's references/ folder. Every page is also available as Markdown by adding .md to its path, for example /docs/providers/esewa.md.",
          promote: ["docs", "docs/install", "docs/adapters", "docs/providers*"],
        }),
      ],
    }),
  ],
});
