---
"@motebit/protocol": minor
---

Co-browse Slice 2d — user-side address-bar navigation.

When `controlState.kind === "user"`, the user can type a URL into
an address-bar surface and navigate the slab's cloud Chromium.
Click + type + paste + scroll (Slice 2c-wheel) plus this gives
honest browser-driveability inside the slab. Genuine search
("best laptops 2026" → search engine) deferred — Slice 2d is URL
navigation only.

**New `navigate` variant on `UserInputEvent`** — `{ kind:
"navigate"; url: string }`. The wire carries the normalized URL.
Address-bar surfaces SHOULD normalize bare hostnames (`example.com`
→ `https://example.com`) before forwarding, mirroring the
server-side regex (`^[a-z][a-z0-9+.-]*:\/\/`). Server-side dispatch
is `page.goto(url, { waitUntil: "domcontentloaded" })`. The
screencast surfaces the new page; navigate returns 204 (no inline
screenshot like motebit-side `ComputerAction.navigate`).

**URL-redacted audit shape** — `UserInputForwardedDetail.navigate`:
`{ kind: "navigate"; scheme; host; has_path; has_query }`. URL host
preserved; **path and query stripped**. URLs commonly carry session
tokens, bearer tokens, or sensitive identifiers (`?reset_token=...`,
`/patient/12345`); the user's signed audit log is more permanent
than a browser history, so conservative redaction is correct.
`has_path` / `has_query` retain "did the user submit a deep link"
without leaking the contents. Malformed URLs collapse to all-`unknown`.

**Spec** — `spec/computer-use-v1.md` §5.5 documents the wire +
audit shapes and the URL-redaction contract (mirrors browser-history
privacy: origin retained, path/query gone).
