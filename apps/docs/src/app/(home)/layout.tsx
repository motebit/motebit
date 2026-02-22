import { Nav } from "../components/nav";
import { Footer } from "../components/footer";
import { FloatingCreature } from "../components/floating-creature";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function HomeLayout({ children }: { children: any }) {
  return (
    <>
      <FloatingCreature />
      <Nav />
      <main className="relative z-10">{children}</main>
      <Footer />
    </>
  );
}
