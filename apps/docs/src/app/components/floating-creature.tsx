"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { HeroCreature } from "./hero-creature";

export function FloatingCreature() {
  const { scrollY } = useScroll();

  // Hero → ambient companion transition over first ~600px of scroll
  const scale = useTransform(scrollY, [0, 600], [1, 0.28]);
  const opacity = useTransform(scrollY, [0, 500], [1, 0.18]);
  // Upper third of viewport; drift up further as it shrinks
  const y = useTransform(scrollY, [0, 600], [-180, -220]);

  return (
    <div className="fixed inset-0 flex items-center justify-center pointer-events-none z-0">
      <motion.div
        style={{ scale, opacity, y }}
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <HeroCreature />
      </motion.div>
    </div>
  );
}
