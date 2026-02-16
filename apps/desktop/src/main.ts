import { DesktopApp } from "./index";

const canvas = document.getElementById("motebit-canvas") as HTMLCanvasElement;
if (!canvas) {
  throw new Error("Canvas element #motebit-canvas not found");
}

const app = new DesktopApp();

async function bootstrap(): Promise<void> {
  await app.init(canvas);
  app.start();

  // Resize handler
  const onResize = (): void => {
    app.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", onResize);
  onResize();

  // Animation loop
  let lastTime = 0;
  const loop = (timestamp: number): void => {
    const time = timestamp / 1000; // Convert ms to seconds
    const deltaTime = lastTime === 0 ? 1 / 60 : time - lastTime;
    lastTime = time;

    app.renderFrame(deltaTime, time);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

bootstrap().catch((err: unknown) => {
  console.error("Motebit bootstrap failed:", err);
});
