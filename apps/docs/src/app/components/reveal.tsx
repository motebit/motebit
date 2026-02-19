"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import type { ReactNode } from "react";

export function Reveal({
  children,
  className = "",
  hold = false,
}: {
  children: ReactNode;
  className?: string;
  /** If true, element fades in but never fades out (for final sections). */
  hold?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });

  const opacity = useTransform(
    scrollYProgress,
    hold ? [0, 0.3] : [0, 0.25, 0.75, 1],
    hold ? [0, 1] : [0, 1, 1, 0],
  );
  const y = useTransform(
    scrollYProgress,
    hold ? [0, 0.3] : [0, 0.25, 0.75, 1],
    hold ? [40, 0] : [40, 0, 0, -20],
  );

  return (
    <motion.div
      ref={ref}
      style={{ opacity, y }}
      className={className}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- framer-motion types incompatible with React 19 ReactNode */}
      {children as any}
    </motion.div>
  );
}
