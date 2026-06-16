import type React from "react";
import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";

const DESCRIPTION =
  "A persistent, cryptographically-anchored, sovereign agent. You own the identity. The intelligence is pluggable. The body is yours.";

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.motebit.com"),
  title: { template: "%s — Motebit", default: "Motebit — Sovereign Agent Infrastructure" },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Motebit",
    url: "https://docs.motebit.com",
    title: "Motebit — Sovereign Agent Infrastructure",
    description: DESCRIPTION,
    // og:image is supplied by app/opengraph-image.tsx (auto-wired by Next).
  },
  twitter: {
    card: "summary_large_image",
    title: "Motebit — Sovereign Agent Infrastructure",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
