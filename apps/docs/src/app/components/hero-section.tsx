"use client";

import Link from "next/link";
import { motion, useScroll, useTransform, useReducedMotion } from "framer-motion";

export function HeroSection() {
  const { scrollY } = useScroll();
  const reduceMotion = useReducedMotion();

  const textOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const textY = useTransform(scrollY, [0, 400], [0, 60]);

  return (
    <section className="relative md:min-h-screen">
      {/* Gradient overlay — subtle ground fade for content sections below */}
      <div
        className="absolute inset-x-0 bottom-0 h-[20vh] pointer-events-none z-[1]"
        style={{
          background: "linear-gradient(to bottom, transparent, var(--hero-fade))",
        }}
      />

      {/* Hero copy — left-aligned on desktop, centered below on mobile */}
      <motion.div
        style={{ opacity: reduceMotion ? 1 : textOpacity, y: reduceMotion ? 0 : textY }}
        className="relative md:absolute inset-0 z-[2] flex items-center pointer-events-none"
      >
        <div className="w-full px-6 md:px-12 lg:px-20 pointer-events-auto">
          <div className="flex flex-col items-center text-center md:items-start md:text-left md:max-w-md lg:max-w-lg hero-enter">
            {/* The hero sits over the creature's LIGHT 3D environment in BOTH
                themes (hero-creature.tsx calls setLightEnvironment()
                unconditionally), so the copy is dark in both modes — a `dark:`
                light variant here is light-on-light and disappears (the
                dark-mode invisibility bug). Subtle white text-shadow keeps it
                legible over the warm gradient's brighter bands. */}
            <h1 className="text-[clamp(2rem,4.5vw,3.5rem)] font-bold tracking-[-0.04em] leading-[1.05] text-zinc-900 [text-shadow:0_1px_16px_rgb(255_255_255/0.35)]">
              A droplet of intelligence under surface tension.
            </h1>
            <p className="mt-5 text-[clamp(0.9rem,1.6vw,1.1rem)] text-zinc-700 leading-relaxed [text-shadow:0_1px_12px_rgb(255_255_255/0.45)]">
              Identity at the boundary. Intelligence in the interior. Governance at the surface.
            </p>
            <p className="mt-2 text-[clamp(0.85rem,1.4vw,1rem)] text-zinc-600 leading-relaxed [text-shadow:0_1px_12px_rgb(255_255_255/0.45)]">
              You own the identity. The intelligence is pluggable. The body is yours.
            </p>
            {/* Two labeled doors — the consumer path (get an agent) and the
                build path (sign & verify a receipt). One golden path each,
                consistent with the intro + Next steps cards. */}
            <div className="mt-8 flex gap-3 hero-enter-buttons">
              <Link
                href="/docs/get-your-agent"
                className="px-6 py-2.5 rounded-full bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors"
              >
                Get Your Agent
              </Link>
              <Link
                href="/docs/developer/quickstart"
                className="px-6 py-2.5 rounded-full border border-zinc-400/80 text-zinc-700 text-sm hover:border-zinc-600 hover:text-zinc-900 transition-all"
              >
                Developer Quickstart
              </Link>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
