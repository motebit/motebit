# Agility as role

Every architectural axis where motebit reserves the right to swap concretes follows the same shape: name the **role** in code, gates, types, and prose; treat the **instance** as a registry entry whose value can change without touching consumers. Migration becomes a registry append, not a wire-format break or a codebase rewrite.

The pattern is unstated but load-bearing. Three instances run through it today; a fourth is partially in place. Future architectural decisions involving a chosen technology should ask the test in [§ When to apply](#when-to-apply) on day one — the cost of indirection is one type alias, the cost of retrofitting later is the migration that motivates the decision.

## The pattern

- **Role** is a stable, abstract name in code: `SuiteId`, `permissive floor`, `GuestRail`, `SovereignRail`. It appears in protocol types, gate-script logic, doctrine prose, and changeset titles.
- **Instance** is the replaceable concrete value: `Ed25519`, `Apache-2.0`, `Stripe`, `SolanaWalletRail`. It lives in a registry the role consults at runtime / verify time / publish time.
- **Migration** is one entry added or substituted in the registry. Consumers continue to consume the role; the registry resolves to the new instance. No callsite changes.
- **Drift defenses** check the role, never the literal instance. A gate that hardcodes `Ed25519` would fire spuriously the moment ML-DSA-65 is added; a gate that asks "every signed artifact carries a registered `SuiteId`" survives the migration unchanged.

## Three instances in motebit

### Cryptosuite agility

- **Role:** `SuiteId` in `@motebit/protocol`. Every signed artifact carries `suite`. Every verifier dispatches via `verifyBySuite` in `@motebit/crypto`. No verifier path is allowed to assume Ed25519.
- **Instance today:** `Ed25519` (one of five entries; `crypto-suite.ts`).
- **Migration shape:** PQ migration (ML-DSA-44, ML-DSA-65, SLH-DSA) is a `SuiteId` registry entry plus a `verifyBySuite` dispatch arm. The wire format does not break — every artifact already carries an explicit `suite` discriminator. Every verifier already routes through dispatch.
- **Defenses:** `check-suite-declared` (#10) — wire formats; `check-suite-dispatch` (#11) — verifier dispatch.
- **Memory:** `architecture_cryptosuite_agility`.

### License-floor agility

- **Role:** "permissive floor" — the open-license layer that defines the protocol's interoperability surface. Every consumer of the protocol's wire format types (third parties standing up alternate implementations) reads from the permissive floor; nothing in the BSL upper layer is required to interoperate.
- **Instance today:** `Apache-2.0` (flipped from MIT on commit `2d8b91a9`, 2026-04-23). Convergence target: one license at the BSL Change Date.
- **Migration shape:** the role is named in `package.json` `license` fields, in `LICENSE` headers, in `LICENSING.md` tables, and in CLAUDE.md doctrine prose. Replacing the instance is a sweep across declared values + a doctrine update — no consumer has to re-link, because consumers depend on _what the floor permits_, not on the literal SPDX identifier. Drift defense `check-floor-license` (rule shape, gate via `check-package-license`) verifies every permissive-floor package carries the role's instance, not a hardcoded literal.
- **Memory:** `architecture_license_floor_apache`.

### Settlement-rail registry

- **Role:** `SettlementRail` in `@motebit/protocol`, split into `GuestRail` (relay-custody) and `SovereignRail` (agent-custody). The registry decides which rails the relay accepts; the type system enforces that custody-relay code only ever sees `GuestRail`.
- **Instances today:** `StripeSettlementRail`, `X402SettlementRail`, `BridgeSettlementRail` (guest); `SolanaWalletRail` (sovereign).
- **Migration shape:** new rails are registry additions. Identity, signing, custody-mode, and accounting all read the role's interface; the rail's specific protocol is contained behind the rail adapter. Adding a fifth guest rail or a second sovereign rail is one new file in `@motebit/settlement-rails` plus one registry append.
- **Defenses:** type-level enforcement of the custody split (`@ts-expect-error` negative-proof in `custody-boundary.test.ts`); `check-deps` (#2) — package-layer purity.
- **Memory:** `architecture_rail_custody_split`.

## What this enables

- **PQ migration without wire-format break.** The protocol survives the post-quantum transition because suite-agility was load-bearing from day one.
- **License evolution without code refactor.** The MIT → Apache-2.0 flip was a sweep, not a rewrite, because the role was named.
- **New rails without re-architecture.** A future Lightning rail or a per-jurisdiction fiat rail is a registry entry, not a rebuild.
- **Protocol-neutrality claim survives changing concretes.** "We're not betting on a specific cryptosuite / license / rail / chain" is structurally true, not a marketing slogan.

## When to apply

When designing an architectural decision that selects a specific technology, ask:

> _Is this the only instance the system will ever see, or is it one of an indefinitely-extensible set?_

If the answer is "the only instance, ever" — pick directly, no role abstraction. Premature agility is over-engineering.

If the answer is "one of a set" — even if the second instance is years away — name the role. The cost of doing so on day one is a type alias and a registry. The cost of retrofitting later is the migration that motivates the decision: every consumer was written against the literal instance; every consumer must be rewritten.

The tell: if a future migration is _foreseeably possible_ (PQ migration is foreseeable; license evolution is foreseeable; new payment rails are foreseeable; new hardware-attestation platforms are foreseeable), the role abstraction belongs in the design.

## Anti-patterns

- **Hardcoding the literal instance** — `import { ed25519 } from "@noble/ed25519"` in business logic, `"Apache-2.0"` literals in gate scripts, `if (rail === "stripe")` switches outside the rail registry. Every literal is a future migration cost.
- **Role abstraction without registry** — naming a role but having one consumer read directly through it. The registry is what makes additions cheap; without it, the role is a renamed literal.
- **Coupling drift defenses to the instance** — a gate that asks "does the signature use Ed25519?" fires false-positive the moment ML-DSA lands. A gate that asks "does the signature carry a registered `SuiteId`?" survives.
- **Conflating role with implementation detail** — `SuiteId` is the role; the specific cryptosuite parameters (curve, hash, encoding) are implementation. The role's interface should not leak implementation details.

## Convergence

Some agility is genuinely temporary. The license-floor role exists in part to support BSL → Apache convergence at the Change Date — _one_ license at end-state, the role abstraction collapsing back into the single permissive instance. That is by design: a role can be temporary scaffolding for a planned migration, retired when the migration completes.

The cryptosuite registry, by contrast, is permanent. There will always be more than one signature primitive in flight as PQ deployment laddered over the next decade. A role can be permanent infrastructure.

The settlement-rail registry sits in the middle: rails will proliferate over time but the role itself never collapses to a single instance.

When designing a new role, name which kind it is. A temporary role plans for its own retirement; a permanent role plans for indefinite growth.

## Related doctrine

- [`protocol-model.md`](protocol-model.md) — the three-layer permissive / BSL / accumulated-state model that the license-floor role lives inside.
- [`hardware-attestation.md`](hardware-attestation.md) — the same pattern for platform attestation: one canonical body format + one verifier across Apple SE / App Attest / TPM / Android Keystore / WebAuthn; new platform is one `platform` union entry.
- [`settlement-rails.md`](settlement-rails.md) — the rail registry's custody split.
