---
"motebit": patch
---

The `<narration>` tag no longer leaks into visible chat text (witnessed on the first live Opus round: the raw tag rendered above its own dim echo). The narration contract promises the typed `task_step_narration` chunk is the tag's only carrier; the display-strip now keeps that promise, including holding back partially streamed tags.
