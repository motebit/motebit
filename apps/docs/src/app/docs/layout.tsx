import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function Layout({ children }: { children: any }) {
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
