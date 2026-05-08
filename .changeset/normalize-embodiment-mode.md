---
"@motebit/render-engine": minor
"@motebit/runtime": patch
---

Hardening for v1.1 of the virtual_browser arc: `normalizeEmbodimentMode`
runtime validator closes the gap a TypeScript cast was leaving open.

After v1.1 landed (`per-dispatcher-mode-stamping`), the runtime's
`projectSlabForTurn` consumed `chunk.mode` via `(chunk.mode ??
policy.mode) as typeof policy.mode` — TypeScript theater, not a
runtime check. The drift gate `check-computer-dispatcher-modes`
covers static registration sites; it offers nothing for runtime-
supplied modes (a typo, a federation peer's MCP-imported `computer`
tool with a freeform mode field, any future loose caller).

`@motebit/render-engine` exports:

- `EMBODIMENT_MODES` — readonly array, the closed union as
  runtime-iterable values, declared with `satisfies
ReadonlyArray<EmbodimentMode>` so the type and the array stay
  locked at the source.
- `normalizeEmbodimentMode(mode, fallback)` — accepts only the
  closed union; returns `fallback` for `undefined` / `null` /
  empty / typo / invented modes.

`@motebit/runtime` swaps the cast for the validator. Three new
runtime tests cover: valid `virtual_browser` overrides
`tool_result`; missing mode falls back; invalid mode (`virtual-
broswer` typo) falls back. Plus seven render-engine tests for the
validator itself.

Doctrine: motebit-computer.md §"Mode contract" — under-claiming
is correct, mis-claiming is the failure mode the gate-and-validator
pair closes together.
