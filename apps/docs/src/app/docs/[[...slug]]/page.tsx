import { source } from "@/lib/source";
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import type { MDXComponents } from "mdx/types";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXContent } from "mdx/types";
import type { TOCItemType } from "fumadocs-core/toc";
import { DiagramFigure } from "@/components/diagram-figure";
import { ReferenceExample } from "@/components/reference-example";

/** Extended page data from fumadocs-mdx — body and toc are compiled by the MDX loader. */
interface DocsPageData {
  title?: string;
  description?: string;
  body: MDXContent;
  toc: TOCItemType[];
}

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // fumadocs-mdx compiled page data includes body + toc; the generic is lost
  // through the @ts-nocheck generated source file.
  const data = page.data as unknown as DocsPageData;
  const MDX = data.body;

  return (
    <DocsPage toc={data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={{
            ...(defaultMdxComponents as MDXComponents),
            DiagramFigure,
            ReferenceExample,
          }}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // Per-page OpenGraph + Twitter card. Without these, sharing
  // /docs/X surfaces only the root site preview from layout.tsx;
  // with them, social embeds and chat tools (Slack, iMessage,
  // Discord) render the page-specific title and description.
  const title = page.data.title ?? "Motebit docs";
  const description =
    page.data.description ?? "Sovereign agent infrastructure — identity, trust, governance.";
  const url = `https://docs.motebit.com${page.url}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: "Motebit docs",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    alternates: {
      canonical: url,
    },
  };
}
