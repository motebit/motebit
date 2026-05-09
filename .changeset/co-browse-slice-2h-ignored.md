---
"@motebit/runtime": minor
"@motebit/tools": minor
---

Co-browse Slice 2h — runtime + tools wiring for the first ax-tier
tool. Companion to the protocol changeset that pinned the wire
shape.

**Tools** — `readPageDefinition` (`mode: "ax"`, `outbound: true`,
`embodimentMode: "virtual_browser"`) + `createReadPageHandler({
dispatcher })` factory. Re-exported from `@motebit/tools/web-safe`.
Registry sort lands this above `computer({kind:"screenshot"})`
automatically because `ax (1) < pixels (2)` in `toolModePriority`.

**Runtime** — `CloudBrowserDispatcher.readPage()` POSTs to
`/sessions/:id/read-page` and returns the wire-format
`ReadPageResult`. Sibling of `execute()` for the structured-read
path. Tool-policy.ts gains a `read_page` entry: `kind: "fetch"`,
`mode: "virtual_browser"`, `endState: "rest"` — same family as
`read_url` (motebit's eye on a page) but on a live session
returning DOM text rather than a fresh URL fetch.

**Smoke that drove this slice:** the post-2g end-to-end test
showed motebit successfully driving the cloud browser to Hacker
News but reporting "I can act on the page but the actual pixels
aren't piped to me — I'm flying blind on visuals." The
architecture already named the answer (`mode: "ax"`); the middle
tier just had no tenant. Now it does.

3 new tests on `read_page` (registers alongside computer +
request_control; declares mode/outbound/embodiment correctly;
returns the dispatcher's structured result). 3 new tests on the
endpoint (structured shape, session_closed for unknown ids,
401 without bearer). All 41 sandbox + 28 web tests pass; all 69
drift gates clean.
