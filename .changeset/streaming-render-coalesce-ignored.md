---
"@motebit/web": patch
---

Coalesce streaming markdown re-renders to one paint per animation frame. The chat stream re-ran the full markdown parse + a `textEl.innerHTML =` DOM write on **every** streamed token — O(n²) in message length, and hundreds of synchronous reflows a second under a fast token burst (on-device WebLLM, cached cloud replies). That is the lag felt while a reply streams, and it amplifies the GPU contention on the on-device path where the WebGL creature and WebGPU inference already share one device.

New `StreamingRenderer` decouples token-arrival rate from DOM-render rate: tokens arriving within one frame collapse into a single markdown render + one DOM write + one scroll, capping re-renders at the display refresh rate. `flush()` forces the final paint at turn end so the last mid-frame tokens are always shown. Wired across all four streaming sites (main send, approval-resume, plan steps, chip invocation). TTS chunking is untouched; only the DOM render coalesces. Universal win — helps cloud and BYOK too, not just on-device.
