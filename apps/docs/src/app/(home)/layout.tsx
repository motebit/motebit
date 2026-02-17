import { Nav } from "../components/nav";
import { Footer } from "../components/footer";
import { MotionConfig } from "framer-motion";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function HomeLayout({ children }: { children: any }) {
  return (
    <MotionConfig reducedMotion="never">
      <Nav />
      <main>{children}</main>
      <Footer />
    </MotionConfig>
  );
}
