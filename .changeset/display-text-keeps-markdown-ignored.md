---
"@motebit/ai-core": patch
"@motebit/desktop": patch
"@motebit/web": patch
"@motebit/mobile": patch
"@motebit/spatial": patch
---

`stripTags` and `stripPartialActionTag` no longer delete `*…*` spans or collapse whitespace. That behaviour was left over from creature `*action*` syntax, which the system prompt now forbids in favour of `<state>` tags, and it erased Markdown emphasis and flattened lists and code in every reply (#1076: 4.2 vs 7.7 for byte-identical requests). Internal tags are still stripped, and space runs left inside a line by a removed tag are squeezed while leading indentation is kept. New `stripForSpeech` keeps the words of Markdown and drops the marks; desktop and spatial voice now speak through it, where they used to skip bold words entirely.
