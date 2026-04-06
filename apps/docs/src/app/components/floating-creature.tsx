"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";

const HeroCreature = dynamic(() => import("./hero-creature").then((m) => m.HeroCreature), {
  ssr: false,
});

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    setMobile(window.matchMedia("(max-width: 768px)").matches);
  }, []);
  return mobile;
}

export function FloatingCreature() {
  const mobile = useIsMobile();

  if (mobile) {
    // Static image on mobile — Three.js WebGL exceeds mobile GPU memory and crashes the tab.
    return (
      <div className="fixed inset-0 pointer-events-none z-0 creature-enter flex items-center justify-center">
        <img
          src="/creature.png"
          alt=""
          className="w-full max-w-[500px] opacity-90 mt-[-10vh]"
          draggable={false}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-0 creature-enter">
      <HeroCreature />
    </div>
  );
}
