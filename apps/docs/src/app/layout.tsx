import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { template: "%s — Motebit", default: "Motebit — Sovereign Agent Infrastructure" },
  description:
    "A persistent, cryptographically-anchored, sovereign agent. You own the identity. The intelligence is pluggable. The body is yours.",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function RootLayout({ children }: { children: any }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <RootProvider
          theme={{
            enabled: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
