---
"@motebit/sdk": minor
---

Vision-1 — pixel governance composes three gates instead of always
stripping. The previous `projectForAi` rule ("AI never sees pixel
bytes") was a safe floor mistakenly comment-elevated to doctrine; the
endgame is provider-mode + sensitivity + consent-aware passthrough.

Pixels are governed evidence, not automatic external context.

New exports from `@motebit/sdk`:

- `PixelConsentState` — `"denied" | "session"`. Per-session consent
  for pixel passthrough to external AI providers. Default `"denied"`
  is fail-closed; the user grants for a session via the `/vision
grant` slash command on web (and the future VisionConsentBand).
  Sovereign (`on-device`) providers bypass this gate entirely — bytes
  never cross a network boundary.
- `DEFAULT_PIXEL_CONSENT` — `"denied"`. The fail-closed default for
  fresh sessions.
- `PixelOmittedReason` — `"consent_required" | "sensitivity_blocked" |
"no_capability"`. Carried on the `bytes_omitted` directive when
  pixels are stripped, so the AI's perception doctrine routes to
  the right typed remediation surface (`/vision grant`,
  `/sensitivity none`, switch-providers) rather than parsing human
  text. Future variants are additive — consumers route on the cases
  they care about and ignore the rest.

Composition (in `@motebit/ai-core`'s `projectForAi`):

```text
sovereign provider                   → bytes pass (private)
external + sensitivity > none        → strip, reason: sensitivity_blocked
external + sensitivity = none + !consent → strip, reason: consent_required
external + sensitivity = none + consent  → bytes pass (governed)
```

Sensitivity composition matches `assertSensitivityPermitsAiCall` for
outbound text — the same primitive now governs pixels at the same
boundary. The receipts trail (`ToolInvocationReceipt` per
`@motebit/mcp-client`) records every visual transfer; no new
receipt infrastructure.

Doctrine: `motebit-computer.md` §"Mode contract" composes pixels
through the same three-axis decision (provider, sensitivity,
consent) the rest of the runtime uses for outbound governance.
`surface-determinism.md` (#90) forbids the AI from asking "may I
see?" via prompt — consent is granted via the typed
`/vision grant` affordance.

Open string-literal unions — additive new states (e.g.
`{ kind: "domain"; domains: string[] }` for per-domain remembered
consent) land without breaking existing consumers.
