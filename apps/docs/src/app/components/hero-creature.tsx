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
    let resizeObserver: ResizeObserver | undefined;
    let adapter:
      | {
          render: (opts: unknown) => void;
          resize: (w: number, h: number) => void;
          dispose: () => void;
          setLightEnvironment: () => void;
        }
      | undefined;

    void (async () => {
      try {
        const { ThreeJSAdapter } = await import("@motebit/render-engine");
        if (disposed) return;

        const a = new ThreeJSAdapter();
        await a.init(canvas);
        adapter = a as typeof adapter;

        // Always light environment — glass needs chromatic variation to refract.
        // Dark mode only changes UI chrome, never the creature's world.
        a.setLightEnvironment();

        resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const { width, height } = entry.contentRect;
            if (width > 0 && height > 0) {
              a.resize(width * devicePixelRatio, height * devicePixelRatio);
            }
          }
        });
        resizeObserver.observe(canvas);

        setLoaded(true);

        let lastTime = performance.now();
        const startTime = lastTime;

        const loop = (): void => {
          if (disposed) return;
          const now = performance.now();
          const delta = (now - lastTime) / 1000;
          const time = (now - startTime) / 1000;
          lastTime = now;

          // Canonical calm cues — identical to desktop app
          a.render({
            cues: {
              hover_distance: 0.4,
              drift_amplitude: 0.02,
              glow_intensity: 0.3,
              eye_dilation: 0.3,
              smile_curvature: 0.04,
              speaking_activity: 0,
            },
            delta_time: delta,
            time,
          });

          animId = requestAnimationFrame(loop);
        };
        animId = requestAnimationFrame(loop);
      } catch {
        // WebGL unavailable or chunk load failure — canvas stays hidden
      }
    })();

    return () => {
      disposed = true;
      if (animId !== undefined) cancelAnimationFrame(animId);
      resizeObserver?.disconnect();
      adapter?.dispose();
    };
  }, []);

  return (
    <div className="w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{
          opacity: loaded ? 1 : 0,
          transition: "opacity 1.2s ease-out",
        }}
      />
    </div>
  );
}
