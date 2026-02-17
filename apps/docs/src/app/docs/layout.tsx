import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

function MotebitMark() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
    >
      {/* Glass body — faint fill, surface tension visible through transmission */}
      <circle cx="11" cy="11" r="9.5" fill="#38bdf8" opacity="0.08" />
      {/* Surface tension — the governance boundary */}
      <circle
        cx="11"
        cy="11"
        r="9.5"
        stroke="#38bdf8"
        strokeWidth="1.2"
        opacity="0.45"
      />
      {/* The intelligence — offset by gravity sag, alive inside the droplet */}
      <circle cx="11" cy="12.2" r="3" fill="#38bdf8" opacity="0.9" />
    </svg>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function Layout({ children }: { children: any }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <>
            <MotebitMark />
            Motebit
          </>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
