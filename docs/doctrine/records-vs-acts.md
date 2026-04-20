# Records vs acts

A motebit is a droplet of intelligence under surface tension. The body presents what the motebit is _doing right now_. Everything the motebit _has_ — credentials, settled receipts, memory entries, balances — lives in panels, summoned on demand. Mixing the two collapses the metaphor: a droplet with permanent accessories stops being one cohesive thing.

## The category test

Before any element renders on the body (creature surface, scene satellite, ambient field, attractor), ask:

> Is this an **act** the motebit is performing, or a **record** the motebit holds?

- **Act** — ephemeral, presented then reabsorbed. Belongs on the body. Examples: a delegation arc emerging during execution, a receipt orb materializing the instant a signature lands, a TTS waveform while the motebit speaks, an attention vector while it listens. The body shows the act, then returns to rest.
- **Record** — accumulated, signed, durable. Belongs in a panel. Examples: the credential list, the settled-receipt history, the memory index, the balance ledger, the agent registry. Records are summoned by explicit user action (panel open, sovereign tab, memory query).

Acts come **from** the motebit. Records come **with** the motebit. Painting records onto the body confuses the two.

## What the body renders

The creature surface (DOM, RN, WebXR scene) renders only the motebit's **live state**:

- Attention, mood, speaking — derived from the current turn.
- Ephemeral act objects — delegation arcs, receipt emergences, voice waveform, the brief orbit of a credential _that is being used right now_ (not all credentials, all the time).
- Ambient atmosphere — light/dark, conversational tone. Never record counts.

## What panels render

The sovereign / memory / agents / settings panels are the canonical record views. Lists, counts, histories, chains, deltas — all of it. The 2D credential list in the sovereign panel is the canonical "what credentials does this motebit hold." Spatial keeps the same rule by summoning the list as an opt-in HUD overlay, not by orbiting the creature.

## The 2026-04-19 pure-droplet correction

The doctrine here is anchored by an actual revert. Earlier in April, every surface (web, desktop, mobile, spatial) shipped permanent credential satellites — small glass orbs orbiting the creature, mounted at boot from the relay's credential list, kept in flight for the rest of the session. The shape was beautiful and the metaphor was wrong: the motebit became droplet-plus-accessories.

Reverts:

- `d9c77c7c` — `revert(web, desktop, mobile): credential satellites off by default`
- `7505c199` — `revert(spatial): credential satellites off — 4-of-4 surfaces pure droplet`

What stayed:

- The renderer primitive `CredentialSatelliteRenderer` in `@motebit/render-engine`. Preserved for the _correct_ trigger: a credential briefly orbits during the delegation that uses it, then fades. The shape was right; the default was wrong.
- `ReceiptSatelliteCoordinator` and the receipt-orb mount in spatial. **Receipts are acts** — each signed delegation is an event the motebit just performed; orbiting-as-signed-event matches the metaphor. Untouched.
- The 2D credential list in every sovereign / settings panel. Records belong here.

The inline anchor at `apps/spatial/src/app.ts:100` and `:1044` carries the same note for future readers.

## How to apply

When a new domain object lands (a new credential type, a new memory shape, a new agent class), the first design question is the category test. Three failure modes to watch:

1. **Boot-time mounting on the body.** If the trigger is "the relay returned data," it's a record. Render in a panel, not on the creature.
2. **Permanent orbit / glow / accessory.** If the visual stays after the act ends, it's drifted into record territory. Add a fade.
3. **"It looks cool" defending a mount.** Aesthetic appeal is not a category argument. The metaphor is the spec; the satellite renderer existed before the doctrine and was used wrong anyway.

When the category is genuinely ambiguous (a delegation receipt that the user pinned for review — is it still an act, or is it now a record?), default to **record**. Records are explicit; acts are presented. Erring toward records keeps the body legible.

## What this is not

This doctrine does not say "the body cannot show structured data." Acts can be richly structured — a receipt-orb's hue tracks chain-verification state (amber → green / orange / red), a delegation arc's path encodes which agent. The constraint is on **persistence**, not richness: an act may be visually complex; it must be temporally bounded.

It also does not deprecate the satellite primitive. `CredentialSatelliteRenderer`, `mountCredentialSatellites`, the satellite-sink abstraction — all preserved. They wait for the correct trigger.
