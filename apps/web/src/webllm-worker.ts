/**
 * WebLLM Web Worker entry point.
 *
 * All model loading and inference runs in this worker thread.
 * The main thread stays free for Three.js rendering and DOM updates.
 *
 * CDN import: @mlc-ai/web-llm is not a bundled dependency (metabolic principle).
 * It's downloaded at runtime only when the user activates WebLLM. Zero cost
 * for the 95% of users who use cloud or local providers.
 */

// @ts-expect-error — CDN dynamic import, no type declarations available
import { WebWorkerMLCEngineHandler } from "https://esm.run/@mlc-ai/web-llm";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => {
  handler.onmessage(msg);
};
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
