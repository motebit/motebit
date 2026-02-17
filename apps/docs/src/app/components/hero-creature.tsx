"use client";

import { useRef, useEffect, useState } from "react";

export function HeroCreature() {
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
      adapter.setBackground(null);

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

      (canvas as unknown as Record<string, unknown>).__creatureCleanup = () => {
        observer.disconnect();
        adapter.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (animId !== undefined) cancelAnimationFrame(animId);
      const cleanup = (canvas as unknown as Record<string, unknown>).__creatureCleanup as (() => void) | undefined;
      if (cleanup) cleanup();
    };
  }, []);

  return (
    <div className="relative mx-auto w-[320px] h-[320px] md:w-[480px] md:h-[480px]">
      {/* Outer diffuse glow — the creature illuminates its surroundings */}
      <div
        className="absolute inset-[-80%] rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(56,189,248,0.03) 0%, rgba(56,189,248,0.01) 30%, transparent 60%)",
        }}
      />
      {/* Inner concentrated glow — light source halo */}
      <div
        className="absolute inset-[-25%] rounded-full pointer-events-none"
        style={{
          background: "radial-gradient(circle, rgba(180,210,240,0.07) 0%, rgba(56,189,248,0.03) 40%, transparent 70%)",
        }}
      />
      <canvas
        ref={canvasRef}
        className="relative w-full h-full"
        style={{
          opacity: loaded ? 1 : 0,
          transition: "opacity 1.2s ease-out",
        }}
      />
    </div>
  );
}
