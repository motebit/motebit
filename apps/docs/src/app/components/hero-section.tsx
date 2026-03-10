"use client";

import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";

export function HeroSection() {
  const { scrollY } = useScroll();

  const textOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const textY = useTransform(scrollY, [0, 400], [0, 60]);

  return (
    <section className="relative min-h-screen">
      {/* Gradient overlay — fade creature to page background for text contrast */}
      <div
        className="absolute inset-x-0 bottom-0 h-[50vh] pointer-events-none z-[1]"
        style={{
          background: "linear-gradient(to bottom, transparent, var(--hero-fade) 85%)",
        }}
      />

      {/* Hero copy — anchored at bottom on the fade */}
      <motion.div
        style={{ opacity: textOpacity, y: textY }}
        className="absolute inset-x-0 bottom-0 z-[2] pb-[8vh] px-6"
      >
        <div className="flex flex-col items-center text-center hero-enter">
          <h1 className="text-[clamp(2.2rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.0] max-w-3xl text-zinc-900 dark:text-zinc-100">
            A droplet of intelligence
            <br />
            under surface tension.
          </h1>
          <p className="mt-5 text-[clamp(0.95rem,1.8vw,1.15rem)] text-zinc-500 dark:text-zinc-400 max-w-md leading-relaxed">
            You own the identity. The intelligence is pluggable.
            <br className="hidden md:block" />
            The body is yours.
          </p>
          <div className="mt-8 flex gap-3 hero-enter-buttons">
            <Link
              href="/docs/get-your-agent"
              className="px-6 py-2.5 rounded-full bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200 transition-colors"
            >
              Get Started
            </Link>
            <Link
              href="/docs/introduction"
              className="px-6 py-2.5 rounded-full border border-zinc-200 text-zinc-500 text-sm hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-200 transition-all"
            >
              Documentation
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
