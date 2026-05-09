---
"@motebit/web": patch
---

live-browser-gesture-carveout — fix the click+hold+drag-on-
screencast → slab-unmounts collision Daniel surfaced on
production `/computer`.

**The bug.** Every slab card got
`attachSlabGestures(card, actions)` in
`renderSlabItem`, including the `live_browser` card. The
gesture handler reads horizontal pointer-drags past 60px as
swipe-to-dismiss and calls `actions.dismiss()`. Meanwhile,
`cobrowse-input-capture` lives on the inner `<img>` and
forwards clicks/keys to the cloud browser. Same physical
gesture, two interpretations — dismiss won.

What the user saw: clicking and holding then dragging on the
Google homepage in the slab silently emptied the panel
(cloud session stayed alive, slab card unmounted). The empty
rounded panel is the slab's natural empty state once the
live_browser item is gone.

**Fix.** In `renderSlabItem`, skip `attachSlabGestures`
specifically for `kind === "live_browser"`:

- The content area IS the cloud browser — drag, text-
  select, slider scrub, pan all belong to the page.
- Hover-close × stays attached (`attachHoverClose`) so
  desktop dismissal still works.
- Take Back chrome button + `/cobrowse` slash commands
  cover control transfer.
- Mobile force-dissolve for live_browser will need a
  chrome-anchored gesture (header strip, not content area)
  when that gap fires; tracked separately.

Three regression tests in
`apps/web/src/__tests__/slab-items-live-browser-gestures.test.ts`:
non-live_browser items still dismiss on swipe; live_browser
items do not; live_browser items still receive the hover-
close × so desktop dismissal works.

376 web tests pass; all 69 drift defenses clean.
