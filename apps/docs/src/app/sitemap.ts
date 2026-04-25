import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

const BASE_URL = "https://docs.motebit.com";

/**
 * Generates `sitemap.xml` from the fumadocs source loader. Every
 * `.mdx` page under `apps/docs/content/docs/` becomes a sitemap
 * entry; the docs site root is the only non-docs entry today.
 *
 * Static URLs only — the docs app is fully prerendered at build
 * time (Next.js SSG) so each page has a stable, public URL.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const docPages = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  return [
    {
      url: BASE_URL,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
    },
    ...docPages,
  ];
}
