---
"@motebit/protocol": minor
---

`computer-use@1.0`: `navigate(url)` action lands as the tenth action kind.

Cloud-browser dispatcher (`services/browser-sandbox`, headless Playwright)
has no address-bar UI for `key` / `type` to drive — the spec's promotion
path (§"v1 limits — No new wire-format actions… real-usage-driven, not
speculative") fired when the AI hit `navigate to tesla.com` against the
sandbox surface. Real consumer demand, real action.

Wire shape:

```ts
interface NavigateAction {
  readonly kind: "navigate";
  readonly url: string;
}
```

Implementations SHOULD normalize relative-looking inputs (`example.com`
→ `https://example.com`) but MAY reject malformed URLs with
`not_supported`.

Cloud-browser dispatcher implements via `page.goto(url, { waitUntil:
"domcontentloaded" })`. Desktop dispatcher (Tauri Rust + xcap +
enigo) does NOT implement — OS-level computer-use has no notion of "the
active browser context"; the user controls which app is focused. The
dispatcher-parity check (`scripts/check-computer-use-dispatcher-parity`)
carries an explicit ALLOWLIST entry naming desktop as deferred until
an OS-level navigation use-case proves itself.

Stays within `@alpha` annotations on the `computer-use@1.0` types —
spec-shaped wire format, additive change, JSON Schema regenerated.
Companion ignored-package work in
`computer-use-navigate-action-ignored.md`.
