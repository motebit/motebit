import type React from "react";
import { Nav } from "../components/nav";
import { Footer } from "../components/footer";
import { FloatingCreature } from "../components/floating-creature";

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FloatingCreature />
      <Nav />
      <main className="relative z-10">{children}</main>
      <Footer />
    </>
  );
}
