import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Search-intent posts at /blog/<slug>/, one per gateway plus the overview. Rendered by src/pages/blog/.
  blog: defineCollection({
    loader: glob({ base: "./src/content/blog", pattern: "*.{md,mdx}" }),
    schema: z.object({
      title: z.string(),
      /** Meta description, under 160 characters. */
      description: z.string().max(160),
      /** Short label for the blog sidebar and index. */
      label: z.string(),
      /** Provider slug, links the post to /docs/providers/<provider>/. Absent on cross-provider posts. */
      provider: z.string().optional(),
      published: z.coerce.date(),
      updated: z.coerce.date().optional(),
      order: z.number().default(100),
      /** Shows the stack picker; the post's code blocks swap per framework. */
      stack: z.boolean().default(false),
      /** Title and description for each framework's page; "{stack}" becomes the framework name. */
      stackTitle: z.string().optional(),
      stackDescription: z.string().max(160).optional(),
      faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    }),
  }),
};
