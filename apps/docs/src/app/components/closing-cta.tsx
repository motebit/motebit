"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";

export function ClosingCTA() {
  const ref = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });

  // Fade in and hold — this is the final word, it doesn't leave
  const opacity = useTransform(scrollYProgress, [0, 0.3], [0, 1]);
  const y = useTransform(scrollYProgress, [0, 0.3], [40, 0]);

  return (
    <motion.div
      ref={ref}
      style={{ opacity, y }}
      className="mx-auto max-w-2xl text-center"
    >
      <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.03em]">
        Begin.
      </h2>
      <div className="mt-10">
        <Link
          href="/docs/introduction"
          className="inline-block px-8 py-3 rounded-full bg-white text-[#09090b] text-sm font-medium hover:bg-zinc-200 transition-colors"
        >
          Read the Documentation
        </Link>
      </div>
    </motion.div>
  );
}
