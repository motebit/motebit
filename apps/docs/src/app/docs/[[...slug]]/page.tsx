import { source } from "@/lib/source";
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import type { MDXComponents } from "mdx/types";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXContent } from "mdx/types";
import type { TOCItemType } from "fumadocs-core/toc";

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
        <MDX components={{ ...(defaultMdxComponents as MDXComponents) }} />
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

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
