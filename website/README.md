# Website

The docs and landing page for the skill, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

- `/` is the landing page (`src/pages/index.astro`).
- `/docs/` is Starlight. Getting started and reference pages are hand-written in `src/content/docs/docs/`.
- Providers and Guides are generated from `skills/nepal-payments/references/*.md` by `scripts/sync-docs.mjs` on every `dev` and `build`, so the site always matches what the agent reads. Edit the reference file, not the generated page.
- Shared copy (providers, languages, test counts, snippets, FAQ) lives in `src/data/site.ts`.

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # static site in dist/
node scripts/og.mjs  # re-render public/og.png after changing the social card copy
```

Set `SITE_URL` to the production origin when building (default `https://skill.discerns.app`). It feeds canonical links, the sitemap, `robots.txt`, Open Graph URLs and `llms.txt`.

The output is static. It deploys as a static-assets Worker on `skill.discerns.app` (`wrangler.jsonc`): `SITE_URL=https://skill.discerns.app npm run build && npx wrangler deploy`. Any other static host works too (output `dist`).
