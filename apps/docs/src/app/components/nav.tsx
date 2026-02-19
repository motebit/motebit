"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled
          ? "bg-white/80 backdrop-blur-xl border-b border-black/[0.04]"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="mx-auto max-w-5xl px-6 h-12 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-zinc-900/90 text-[13px] font-medium tracking-tight">
          <img
            src="/motebit-mark.svg"
            alt=""
            width={20}
            height={20}
          />
          Motebit
        </Link>
        <div className="flex items-center gap-5">
          <Link
            href="/docs/introduction"
            className="text-[13px] text-zinc-500 hover:text-zinc-800 transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://github.com/motebit"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-zinc-500 hover:text-zinc-800 transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
