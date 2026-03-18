import type React from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <>
            <img
              src="/motebit-mark.svg"
              alt=""
              width={22}
              height={22}
              aria-hidden="true"
              className="dark:hidden"
            />
            <img
              src="/motebit-mark-dark.svg"
              alt=""
              width={22}
              height={22}
              aria-hidden="true"
              className="hidden dark:block"
            />
            Motebit
          </>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
