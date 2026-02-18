"use client";

import { useRef, useEffect, useState } from "react";
import type { InteriorColor } from "@motebit/render-engine";

interface CreatureConfig {
  label: string;
  description: string;
  env: "desktop" | "dark";
  interior?: InteriorColor;
}

function CreatureCanvas({ config }: { config: CreatureConfig }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let animId: number | undefined;

    (async () => {
      const { ThreeJSAdapter } = await import("@motebit/render-engine");
      if (disposed) return;

      const adapter = new ThreeJSAdapter();
      await adapter.init(canvas);

      if (config.env === "dark") {
        adapter.setDarkEnvironment();
      }

      if (config.interior) {
        adapter.setInteriorColor(config.interior);
      }

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            adapter.resize(width * devicePixelRatio, height * devicePixelRatio);
          }
        }
      });
      observer.observe(canvas);

      setLoaded(true);

      let lastTime = performance.now();
      const startTime = lastTime;

      function loop() {
        if (disposed) return;
        const now = performance.now();
        const delta = (now - lastTime) / 1000;
        const time = (now - startTime) / 1000;
        lastTime = now;

        adapter.render({
          cues: {
            hover_distance: 0.4,
            drift_amplitude: 0.015,
            glow_intensity: 0.35,
            eye_dilation: 0.35,
            smile_curvature: 0.3,
          },
          delta_time: delta,
          time,
        });

        animId = requestAnimationFrame(loop);
      }
      animId = requestAnimationFrame(loop);

      (canvas as unknown as Record<string, unknown>).__cleanup = () => {
        observer.disconnect();
        adapter.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (animId !== undefined) cancelAnimationFrame(animId);
      const cleanup = (canvas as unknown as Record<string, unknown>).__cleanup as (() => void) | undefined;
      if (cleanup) cleanup();
    };
  }, [config]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{
        opacity: loaded ? 1 : 0,
        transition: "opacity 1.2s ease-out",
      }}
    />
  );
}

// ── Color Variants ──
// Glass stays glass. Color lives inside — tint (what light looks like
// passing through the body) and glow (the interior luminance).

const GLOW = 0.04; // subtle resting glow — interior is active

const variants: CreatureConfig[] = [
  {
    label: "Borosilicate",
    description: "Default — faint cool blue, laboratory glass",
    env: "dark",
    interior: { tint: [0.9, 0.92, 1.0], glow: [0.6, 0.7, 0.9], glowIntensity: GLOW },
  },
  {
    label: "Amber",
    description: "Warm gold — aged glass, candlelight interior",
    env: "dark",
    interior: { tint: [1.0, 0.85, 0.6], glow: [0.9, 0.7, 0.3], glowIntensity: GLOW },
  },
  {
    label: "Rose",
    description: "Soft pink — warmth, empathy",
    env: "dark",
    interior: { tint: [1.0, 0.82, 0.88], glow: [0.9, 0.5, 0.6], glowIntensity: GLOW },
  },
  {
    label: "Violet",
    description: "Deep purple — mystery, intuition",
    env: "dark",
    interior: { tint: [0.88, 0.8, 1.0], glow: [0.6, 0.4, 0.9], glowIntensity: GLOW },
  },
  {
    label: "Cyan",
    description: "Electric teal — alertness, precision",
    env: "dark",
    interior: { tint: [0.8, 0.95, 1.0], glow: [0.3, 0.8, 0.9], glowIntensity: GLOW },
  },
  {
    label: "Ember",
    description: "Deep red-orange — intensity, focus",
    env: "dark",
    interior: { tint: [1.0, 0.75, 0.65], glow: [0.9, 0.35, 0.2], glowIntensity: GLOW },
  },
  {
    label: "Sage",
    description: "Muted green — calm, nature, grounding",
    env: "dark",
    interior: { tint: [0.82, 0.95, 0.85], glow: [0.4, 0.75, 0.5], glowIntensity: GLOW },
  },
  {
    label: "Moonlight",
    description: "Pure cool white — neutral, clarity",
    env: "dark",
    interior: { tint: [0.95, 0.95, 1.0], glow: [0.8, 0.85, 1.0], glowIntensity: GLOW },
  },
];

// Also show the canonical desktop form for reference
const desktopRef: CreatureConfig = {
  label: "Desktop (canonical)",
  description: "Full warm environment — the reference form",
  env: "desktop",
};

export function CreatureCompare() {
  return (
    <div className="min-h-screen bg-[#09090b] text-white p-8 pb-24">
      <h1 className="text-3xl font-bold text-center mb-2">Interior Color Variants</h1>
      <p className="text-zinc-500 text-center mb-4">
        Glass stays glass. Color lives inside.
      </p>
      <p className="text-zinc-600 text-center text-sm mb-12">
        Same glass body, same physics — only the interior tint and glow change.
        <br />
        Dark environment on all variants so you see how they look on obsidian.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
        {/* Desktop reference first */}
        <div className="flex flex-col items-center">
          <div className="w-full aspect-square overflow-hidden rounded-2xl border border-zinc-700">
            <CreatureCanvas config={desktopRef} />
          </div>
          <h2 className="mt-3 text-sm font-semibold">{desktopRef.label}</h2>
          <p className="mt-0.5 text-xs text-zinc-500 text-center">{desktopRef.description}</p>
        </div>

        {/* Color variants */}
        {variants.map((config, i) => (
          <div key={i} className="flex flex-col items-center">
            <div className="w-full aspect-square overflow-hidden rounded-2xl border border-zinc-800">
              <CreatureCanvas config={config} />
            </div>
            <h2 className="mt-3 text-sm font-semibold">{config.label}</h2>
            <p className="mt-0.5 text-xs text-zinc-500 text-center">{config.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
