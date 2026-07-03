---
"@motebit/web": patch
---

Close the in-browser on-device reasoning gap. `WebLLMProvider` (WebGPU/MLC) was the last provider still `stripTags`-ping `<thinking>` and capturing nothing — the pre-arc "strip and destroy" behavior every other provider was fixed for. It now captures reasoning the same way: native `reasoning_content` deltas (in-browser reasoning models like DeepSeek-R1 distills) + the `<thinking>`-tag convention, merged via `mergeReasoning` into `AIResponse.reasoning`, on both the streaming and no-`done` fallback paths. Interior-only — accumulated raw off the stream, never into the visible text. With this, the reasoning disclosure is universal across every path that can produce reasoning: motebit cloud, BYOK, and on-device (local-server AND in-browser).
