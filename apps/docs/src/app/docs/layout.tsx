import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function Layout({ children }: { children: any }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: "Motebit" }}
    >
      {children}
    </DocsLayout>
  );
}
