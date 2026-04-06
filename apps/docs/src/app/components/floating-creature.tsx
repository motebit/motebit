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
    // Rendered inline (not fixed) so it flows above the hero text naturally.
    return (
      <div className="flex items-center justify-center pt-20 pb-4">
        <img src="/creature.png" alt="" className="w-[80vw] max-w-[400px]" draggable={false} />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 pointer-events-none z-0 creature-enter">
      <HeroCreature />
    </div>
  );
}
