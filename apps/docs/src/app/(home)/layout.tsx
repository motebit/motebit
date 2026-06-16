import type React from "react";
import { Nav } from "../components/nav";
import { Footer } from "../components/footer";
import { FloatingCreature } from "../components/floating-creature";

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-full focus:bg-fd-foreground focus:px-4 focus:py-2 focus:text-sm focus:text-fd-background"
      >
        Skip to content
      </a>
      <FloatingCreature />
      <Nav />
      <main id="main" className="relative z-10">
        {children}
      </main>
      <Footer />
    </>
  );
}
