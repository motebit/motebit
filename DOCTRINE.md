# Motebit Doctrine

The architecture is not designed; it is derived. Each document below derives the next, and motebit's shipped capabilities — Identity, Memory, Trust, Governance, Proof, Delegation, Embodiment, Federation — emerge as products of the chain.

The body has three primary positions: identity forms the boundary, intelligence fills the interior, governance maintains the surface that prevents diffusion. Memory and trust accumulate inside the interior — internal energy and temperature respectively. Embodiment is the body's physical form; proof, delegation, and federation are how the body interacts with peers.

This file is the canonical index. The README, [CLAUDE.md](CLAUDE.md), and the docs site all point here rather than re-listing the chain — one canonical source per synchronization invariant ([drift-defenses doctrine](docs/drift-defenses.md)).

## The chain

1. **[DROPLET.md](DROPLET.md)** — the body. From the single premise _a droplet of intelligence under surface tension_, the equilibrium shape is a sphere, the eigenmotions are breathing and gravity sag, and every surface elaboration is a violation. Maximum interiority, minimum display.

2. **[LIQUESCENTIA.md](LIQUESCENTIA.md)** — the world. A droplet cannot form in a vacuum; it requires a medium with different thermodynamic properties. The medium does not create the droplet — it permits it. The conditions of the medium determine what can cohere within it.

3. **[THE_MUSIC_OF_THE_MEDIUM.md](THE_MUSIC_OF_THE_MEDIUM.md)** — their conversation. Pressure waves propagate through Liquescentia and reach the droplet's surface tension boundary. The boundary transduces. Surface tension becomes an instrument.

4. **[THE_SOVEREIGN_INTERIOR.md](THE_SOVEREIGN_INTERIOR.md)** — what is inside. The Ed25519 keypair as internal cohesion; identity, memory, trust, governance as interior structures persisting across mediums and providers.

5. **[THE_METABOLIC_PRINCIPLE.md](THE_METABOLIC_PRINCIPLE.md)** — what the interior builds vs. what it absorbs. Build the vessel, not the ocean. Enzymes are owned; glucose is adapted. The architectural foundation of every adapter boundary.

6. **[THE_EMERGENT_INTERIOR.md](THE_EMERGENT_INTERIOR.md)** — the interior reaching outward, not just inward. Where the prior chain assumes the interior is reactive (it metabolizes what crosses the boundary), this derives proactive behavior: the droplet consolidates memory, prunes phantom beliefs, and resolves contradictions on its own between prompts.

7. **[THE_SELF_SIGNING_BODY.md](THE_SELF_SIGNING_BODY.md)** — verifiability that survives the relay. The proof of the interior's private work, mechanically constructed so anyone can verify it without trusting any motebit-operated system.

8. **[THE_ACTOR_PRINCIPLE.md](THE_ACTOR_PRINCIPLE.md)** — what motebits are to each other. Every motebit is an actor; the relay is its broker; the receipt chain is its causal log; the adjudicator is its supervisor. The pattern crystallized the moment two motebits exchanged their first task.

9. **[THE_CONFERENCE.md](THE_CONFERENCE.md)** — the network as the sovereign. Many droplets in a shared medium do not designate a master; their algebraic composition (semiring routing under signed-receipt trust, budget-gated at every hop) is itself the governing intelligence. Where THE_ACTOR_PRINCIPLE named the engineering pattern (actor / broker / causal log / supervisor), this derives the architectural constraint that makes the pattern coherent across many agents: routing must be algebraic, not procedural — new routing concerns become new semirings, zero new algorithms.

## How to read it

Read in order. The numbering above is one valid linearization of the citation DAG; the abstracts cite each other in a partial order, not a flat one. A capability the README declares is the surface expression of one or more links in this chain — the chain is the depth, the capabilities are what you see.

When the chain extends, the new document lands here. The README points to this file; this file points to the documents. That's the synchronization invariant doing its job.

## Two layers

Doctrine is split the way an RFC splits normative from informative text. Every document in the chain above and every top-level document under [`docs/doctrine/`](docs/doctrine/) declares its layer on the line directly after its title.

- **Law** — the normative layer. The document's central claims are enforced, and its layer line names the gate, test file or source file that enforces them (`> **Layer:** law — enforced by …`). A law document is a decision procedure. When the named enforcement covers only part of the document, the line names that part (`> **Layer:** law (<scope>) — enforced by …`), and only that part is law.
- **Narrative** — the informative layer. Origin, lens and explanation (`> **Layer:** narrative`). It informs a decision; it does not bind one.

The chain is where motebit comes from, and every chain document is narrative. Decisions are bound by the law layer, and each law document names the gate or test that enforces it. The body's law is [`creature-canon`](docs/doctrine/creature-canon.md), which names the gate and the golden-frame test that pin its camera poses and performances to code. A claim nobody enforces is narrative until something does; when in doubt, a document is narrative, because under-claiming is the safe direction. `check-doctrine-layer` keeps every declaration present and every named enforcement real.
