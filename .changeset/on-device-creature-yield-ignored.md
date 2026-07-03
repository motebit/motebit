---
"@motebit/web": patch
---

Stop the on-device creature freeze — GPU-yield during WebLLM inference + honest main-thread fallback.

**The bug (valid, not "weak models"):** on `motebit.com` plugged into WebLLM, the creature freezes while a prompt processes and unfreezes when it finishes. WebLLM runs inference on WebGPU; the creature renders on WebGL/Three.js — both hit the one physical GPU, so during an on-device turn the render loop is starved and stutters into a visible freeze. Weak models give slow/bad answers, not freezes; this was pure GPU contention.

**A — GPU-yield (the real fix).** `WebLLMProvider` raises an `isOnDeviceInferenceActive()` gauge for the duration of the WebGPU drain (depth-counted, `finally`-lowered even on early break). The render loop reads it and throttles the creature to a calm ~12fps while inference runs — asking for fewer frames means each one actually lands, so the creature reads as smooth-but-slow ("thinking inward") instead of frozen-then-janky. `deltaTime` tracks real elapsed time since the last draw, so motion stays wall-clock-correct at any cadence. Only WebLLM raises the gauge; cloud/BYOK (network-bound) render full-rate. This is a rendering concern, deliberately NOT the `responsive | tending | idle` presence machine — the motebit is `responsive` throughout.

**B — honest main-thread fallback.** When no background worker is available and the engine falls back to main-thread inference (which hard-blocks the whole page — the GPU-yield can't help because the thread itself is held), the provider fires `onMainThreadFallback` once; the UI warns the owner and points them at cloud/BYOK, rather than leaving an unexplained freeze. "Failures degrade honestly, not gracefully."

Pairs with the render-coalescing change (Cause C) that removed the O(n²) per-token re-render amplifying all of this.
