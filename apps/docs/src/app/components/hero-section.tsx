"use client";

import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";

const ease = [0.16, 1, 0.3, 1] as const;

export function HeroSection() {
  const { scrollY } = useScroll();

  const textOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const textY = useTransform(scrollY, [0, 400], [0, 80]);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-end pb-[10vh] px-6">
      <motion.div style={{ opacity: textOpacity, y: textY }}>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, ease, delay: 0.4 }}
          className="flex flex-col items-center text-center"
        >
          <h1 className="text-[clamp(2.2rem,6vw,5rem)] font-bold tracking-[-0.045em] leading-[1.0] text-center max-w-3xl text-white">
            A droplet of intelligence
            <br />
            under surface tension.
          </h1>
          <p className="mt-5 text-[clamp(1rem,2vw,1.25rem)] text-zinc-500 text-center max-w-md leading-relaxed">
            You own the identity. The intelligence is pluggable.
            <br className="hidden md:block" />
            The body is yours.
          </p>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, ease, delay: 0.9 }}
            className="mt-10 flex gap-4"
          >
            <Link
              href="/docs/introduction"
              className="px-7 py-2.5 rounded-full bg-white text-[#09090b] text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Get Started
            </Link>
            <Link
              href="/docs/introduction"
              className="px-7 py-2.5 rounded-full border border-zinc-800 text-zinc-400 text-sm hover:border-zinc-600 hover:text-zinc-200 transition-colors"
            >
              Documentation
            </Link>
          </motion.div>
        </motion.div>
      </motion.div>
    </section>
  );
}
