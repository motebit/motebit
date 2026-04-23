# README as glass

The motebit README is a surface. The interior — derivations, incident histories, mathematical justifications, six-paper chains of reasoning — lives behind it.

An external reader traced the pattern precisely:

> _Maximum interiority, minimum display. The glass transmits. The README is the glass._

That reading was correct. This file makes the rule explicit so future edits preserve it.

## The test

When adding or editing a line in the root `README.md`, ask: **is this display, or is this interior?**

**Display — keep in README:**

- What the project is, in one paragraph.
- Who it serves and how they start (the `Try it` ladder, the command invocations).
- Concrete facts that change behavior for a first-time reader (package names, URLs, surface availability).
- One-paragraph _theses_ that reframe a large chunk of the document. The algebra-vs-judgment paragraph qualifies because it turns the permissive-floor / BSL package table from inventory into argument — one paragraph changes how the reader sees ten bullets.

**Interior — link out, don't paste in:**

- Derivations (why Ed25519, why HKDF, why semiring).
- Incident histories (_"added after the …"_ stories belong in `docs/drift-defenses.md`).
- Long proofs or cryptographic justifications (→ `docs/doctrine/protocol-model.md`, `docs/doctrine/security-boundaries.md`).
- Package-by-package walkthroughs (→ `apps/docs/content/docs/operator/architecture.mdx`).
- License mechanics (→ `LICENSING.md`).
- Thesis papers (→ `DROPLET.md`, `THE_SOVEREIGN_INTERIOR.md`, `THE_METABOLIC_PRINCIPLE.md`, `THE_CONFERENCE.md`, …).

## Why glass

The README inherits the physics of the artifact it describes. A motebit is a droplet under surface tension: body passive, interior active. The README does the same. It transmits; it does not store. If every claim has a derivation chain six papers deep, the README must not include those papers — it must trust the link.

Under-explaining is the feature. A reader who wants to verify the claim will follow the link. A reader who doesn't is not the reader the document is optimizing for.

## Growth rule

The README grows only when a **compressible claim** appears that cannot be linked to in a shorter form. Most candidate additions fail this test. The algebra-vs-judgment paragraph passed it because:

1. It reframes a large block of the document (the permissive-floor / BSL table) from inventory into argument.
2. The claim compresses: _"algebra vs. judgment"_ is shorter than the derivation but lossless for the reader's mental model.
3. No existing link satisfies it: `LICENSING.md` describes the license mechanics, `docs/doctrine/protocol-model.md` describes the three-layer model in detail, but neither captures _this particular compression_.

When in doubt, link. Paragraph-length justifications belong in `docs/doctrine/*.md`, not in the README.

## What this isn't

- **Not a word count rule.** The README can be long — it just has to be dense. Each paragraph should feel like a compression of a larger idea, not an expansion of a smaller one. If editing a section makes it feel more balanced at the cost of dilution, the edit is wrong.
- **Not a monopoly on brevity.** Subdirectory `CLAUDE.md` files, per-package `README.md` files on npm, `apps/docs/*`, and thesis papers all follow their own forms. `README as glass` applies to the project root `README.md` only.
- **Not a licence to be cryptic.** Terse is not obscure. A first-time reader should finish the README knowing what motebit is, what's in the repo, how to start, and what not to expect. The sovereign interior is reached by following links, not by decoding allusions.

## How to use this rule

Before opening a README PR, re-read the change with the display/interior test. If the new content belongs in a thesis paper or a doctrine file, move it there and add a link. If it's a one-paragraph compression that reframes a table or section, it probably belongs in the README — and the PR description should name which table or section it reframes.

The README sits at the mouth of the repo. Every line readers encounter there sets the tension of the surface. The tension is the feature.
