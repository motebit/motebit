---
"@motebit/protocol": minor
---

element-1 — structurally-addressed element actions for the
`computer` tool. Closes the action-truth gap witnessed 2026-05-08:
AI couldn't reliably click the search box on google.com because it
had no way to address page elements except by coordinate, and the
coordinate inference path required vision (gated by default + UX
friction). Production browser-agent platforms (Browserbase,
Playwright codegen, Anthropic's computer-use cookbook) converge on
the same primitive — durable structural element addressing,
coordinates as fallback for visual-only tasks.

New types:

- `ReadPageInput` — typeable input field with server-issued
  `element_id`, `tag` (input/textarea), `input_type`, optional
  `name`/`placeholder`/`aria_label`/`value`. Capped at 100 entries
  in the read_page response; values capped at 256 chars.
- `ReadPageButton` — button-shaped clickable element with
  `element_id`, `tag` (button/input/a), visible `text` (or
  aria-label fallback for icon-only buttons), optional `input_type`
  for `<input type="submit/button/reset">`. Capped at 100 entries.

`ReadPageResult` extended with `inputs: ReadPageInput[]` and
`buttons: ReadPageButton[]` arrays. Backward compatible — existing
consumers reading `text` / `headings` / `links` ignore the new
fields.

Three new actions in `ComputerAction`:

- `ClickElementAction` — `{ kind: "click_element", element_id }`.
  Server resolves the stamped `data-motebit-id`, scrolls into view,
  clicks center. Returns truth-feedback on the result envelope:
  `clicked_tag`, `focused_typeable`, `navigation_triggered`.
- `FocusElementAction` — `{ kind: "focus_element", element_id }`.
  Focus without the click side-effects (no dropdown opens, no
  modal triggers). Truth: `tag`, `focused`.
- `TypeIntoAction` — `{ kind: "type_into", element_id, text,
per_char_delay_ms?, clear_first? }`. Composes focus + clear +
  type into one semantic action. Default `clear_first: true`
  (mirrors human "type fresh into this field" intent). Same truth-
  feedback shape as the lower-level `type` action: `focused`,
  `active_element`, `value`, `text_appeared`.

On staleness — page navigated since read_page, page reloaded,
element removed by JS — actions return
`{ ok: false, reason: "element_not_found", message }` so the AI
knows to re-read.

Server-side strategy (`services/browser-sandbox`):

- `extractStructuredPageContent` walks the DOM, clears prior stamps,
  and stamps each interactive element with
  `data-motebit-id="motebit-N"`. Per-extraction counter; ids are
  scoped to the response that issued them.
- `click_element` / `focus_element` / `type_into` resolve the
  stamped attribute via `page.locator('[data-motebit-id="..."]')`,
  scroll-into-view, then act. Element*id format is validated server-
  side (regex `^[a-zA-Z0-9*-]+$`) to defend against selector
  injection.

PERCEPTION_DOCTRINE update teaches the AI to prefer element-
addressed actions over coordinates when the target was discovered
via read_page; coordinate `click` / `type` remain available for
purely-visual tasks (drag a slider to a position seen in pixels).

Dispatcher parity — desktop_drive's `ComputerPlatformDispatcher`
does NOT yet implement these three kinds. The
`check-computer-use-dispatcher-parity` allowlist gains entries for
each, naming the deferred state: desktop's equivalent primitive
needs an accessibility-tree adapter (macOS AXUIElement, Windows
UIA, Linux AT-SPI) so click_element resolves an AX node id instead
of a DOM data-attribute. Same wire shape, different resolver.
Lands in a follow-up.

Open-ended on the type union — additive new actions land without
breaking existing consumers; the `default: never` exhaustive arm
in the cloud dispatcher catches missing handlers at compile time.
