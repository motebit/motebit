# Motebit — agent instructions

**The canonical instructions live in [`CLAUDE.md`](CLAUDE.md). Read that file.**

This is a pointer, deliberately, not a copy.

`AGENTS.md` is the emerging cross-tool convention for agent instructions, and
several tools look for it by name. But maintaining a second copy of the doctrine
index is the exact drift shape this repo gates against everywhere else: two
files holding the same truth, diverging silently, with no sync owner.

The first version of this file was a mechanical find-replace of `CLAUDE.md`, and
it demonstrates the problem better than any argument. Within one pass it had:

- links to `packages/*/AGENTS.md`, `services/*/AGENTS.md` and
  `apps/*/AGENTS.md` — **none of which exist**; the per-directory doctrine files
  are all named `CLAUDE.md`
- a reference to a drift gate that does not exist and never has — the real one
  is `check-claude-md`, and the same blind substitution that rewrote the paths
  also rewrote the gate's name into a phantom

A copy that ships broken links and a phantom gate on day one is not a
convenience — it is a second source of truth that is already wrong. Per
`docs/doctrine/agentic-era-engineering.md`, an instruction surface asserting
enforcement that does not exist stops an audit instead of failing it.

So: one file holds the doctrine, and this one points at it. If a tool needs
`AGENTS.md` to exist, it does — and it immediately redirects to the file that is
actually maintained, gated, and correct.

`scripts/check-gate-references.ts` now scans `AGENTS.md` alongside every
`CLAUDE.md`, so a phantom gate name reintroduced here fails CI the same way it
would in the canonical index.
