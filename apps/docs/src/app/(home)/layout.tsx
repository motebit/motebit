import { Nav } from "../components/nav";
import { Footer } from "../components/footer";
import { FloatingCreature } from "../components/floating-creature";
import { MotionConfig } from "framer-motion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function HomeLayout({ children }: { children: any }) {
  return (
    <MotionConfig reducedMotion="never">
      <FloatingCreature />
      <Nav />
      <main className="relative z-10">{children}</main>
      <Footer />
    </MotionConfig>
  );
}
