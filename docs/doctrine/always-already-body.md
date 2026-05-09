# Always-already body

The body is the body's first-person perceptual field. It exists before its content. Content composes into the body via the body's own slots, never as adjacent decoration. Empty states are READY states — the body announces itself, never goes silent.

A body that requires content to exist is not a body. It is a tooltip — appearing on demand, vanishing when not needed. Motebit's slab is the workspace itself; a workspace exists before its work.

## The principle

> Surfaces precede content. Content embeds into the body's slots, never adjacent. Empty is READY, not absent.

Three coordinated assertions, each implied by the others:

1. **Temporal — the body precedes content.** The body exists before content arrives, persists when content departs, and never depends on content for its existence. Lazy-render-on-first-content is wrong by default. The body's permanence is its identity.

2. **Spatial — content embeds, never adjacent.** Every content kind (acts, records, ambient) composes into the body's typed slots. Adjacent mounts — decorations alongside the body, fallback positions outside its silhouette — violate body coherence. The body has slots; content uses them.

3. **Modal — empty is READY.** When the body has no content, the body shows a sympathetic-breathing affordance announcing readiness. The body is never literally silent — only ever ready or live. Presence is the constant, content is the variable.

## Why

The body's permanence is what makes content visit it, rather than the other way around. The same physics that makes the creature persist whether or not it speaks, and the substrate persist whether or not the body moves: the body persists whether or not work is happening. Permanence at every scale is the same property.

A body whose existence is contingent on content is two surfaces — the absence-surface and the presence-surface — held together by stitching the user can perceive. A body whose existence is constant is one surface in two registers (READY and LIVE). One body, two registers, no seam.

## Composition rules

The body is the constant; content is the visitor.

- **Acts** (motebit doing something) compose into the body's primary surface. They embed via the body's typed content slot, which is part of the body's geometry, not a child of an adjacent host.
- **Records** (panels of accumulated state) live outside the body's silhouette by design (per [`records-vs-acts.md`](records-vs-acts.md)). Records are NOT body content; they are a different category and a different surface.
- **Empty** is the body's READY register. A body's empty state is not "no content" — it is "ready for content." The substrate's quiescence rhythm carries through into the READY register, making the empty body quietly alive rather than silent.

The asymmetry between acts and records is load-bearing: acts pass through the body, records sit alongside it. Both are first-class, but only acts compose into the body. The READY register applies only to the body's act surface, never to record surfaces.

## Cross-cuts

- [`liquescentia-as-substrate.md`](liquescentia-as-substrate.md) — the medium every surface inherits. The body always-already inhabits the medium; the substrate's permanence and the body's permanence are the same property at different scales.
- [`motebit-computer.md`](motebit-computer.md) — the slab is the body's first-person perceptual field. This doctrine names the body's temporal property (always-already) and spatial property (content embeds, never adjacent).
- [`records-vs-acts.md`](records-vs-acts.md) — the body shows acts; panels hold records. This doctrine adds the empty-act rule: between acts, the body shows the READY register. The body persists between acts, not only during them.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke typed capabilities. The body's READY-state affordances inherit determinism: every input routes through a typed path, never through AI-loop interpretation. The empty register is not a prompt; it is a typed capability invitation.

## What this is NOT

- Not "eager initialization everywhere." Records and panels appropriately render when their data arrives. The principle applies to the body — the act-surface — because the body exists before its acts.
- Not "no empty states." Empty states are first-class. The principle forbids LITERAL emptiness (silence, void, blank), not the existence of an empty register.
- Not "fight a renderer for visual continuity." Honest absence on real failure (lost graphics context, init error) remains correct. The principle governs design intent, not failure modes.

## Recognition test

For any new mount or surface adjacent to a body:

1. Does the body exist before its content? If the surface waits for content to be visible, and the surface IS a body, that is a violation.
2. Does content embed into the body's slots, or float adjacent? Adjacency is a violation; embedding is composition.
3. Are empty states READY, not absent? Literal silence is a violation; sympathetic-breathing readiness is composition.
