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
              src="/motebit-mark.png"
              alt=""
              width={22}
              height={22}
              aria-hidden="true"
              style={{ borderRadius: "50%" }}
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
