# Deprecation lifecycle

Removal has a doctrine — `migration-cleanup.md` gives the state-holder analysis for stripping dead compat. Addition needs a matching doctrine. Post-GA, every breaking change either ships as a coordinated major or as a disciplined deprecation; there is no third option.

## The three signals

When an API, wire format, or runtime behavior needs to change in a breaking way, exactly one of three moves applies:

| Signal                      | When to use                                                                                                                             | Cost                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Coordinated major**       | Protocol-shaped break with wide blast radius (wire-format version, cryptographic primitive swap, multi-surface vocabulary shift). Rare. | Every downstream consumer coordinates a version bump. Forces the ecosystem to move.           |
| **Deprecate + sunset**      | Additive breaks on an API surface with a known replacement. The default move.                                                           | Old + new coexist for a deprecation window; removal graduates through `migration-cleanup.md`. |
| **Silent permanent compat** | **Forbidden.**                                                                                                                          | The Shopify trap. 2000 migrations later, nothing ever strips.                                 |

Anonymous compat code — "kept for backward compatibility" with no named sunset — is the failure mode this doctrine exists to prevent.

## The deprecation contract

Every `@deprecated` annotation at motebit MUST carry four fields. No exceptions for "obvious" cases — the drift defense is that every reader sees the same shape.

```ts
/**
 * @deprecated since 1.0.0, removed in 2.0.0. Use `newThing` instead.
 *
 * Reason: three-mode architecture replaces the flat discriminator;
 * see packages/sdk/CLAUDE.md for the transition rationale.
 */
export function oldThing() {
  /* ... */
}
```

Required:

- **`since <version>`** — the release this symbol was first marked deprecated.
- **`removed in <version>`** — the release slated to strip it. Named explicitly, not "one release cycle" or "soon."
- **Replacement pointer** — what the caller should use instead. If there is no replacement, say so (`no replacement; rework the caller`).

Optional but strongly encouraged:

- **Reason** — one-line why. Points at the doctrine / incident / design decision that forced the break. Gives future readers context.

Precedent: Rust's `#[deprecated(since, note)]`, JSDoc's `@deprecated` convention, Python's PEP 387, Kubernetes' versioned deprecation markers. Every mature language ecosystem converges on roughly this shape.

## Minimum sunset windows

Adapted from [Kubernetes' deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/) — the reference for "how long between deprecation and removal":

| Stability class                                                | Minimum window                                          | Motebit application                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stable / GA** (post-1.0 published package API)               | One major cycle. Deprecate at `N.0`, remove at `N+1.0`. | `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `@motebit/verify`, `create-motebit`, `motebit` — every deprecation carries at least one major. |
| **Beta** (post-publish but marked experimental)                | Two minor cycles within a major.                        | Anything shipped behind an explicit "beta" / "preview" flag — deprecation window shrinks.                                                                                   |
| **Alpha / internal** (BSL runtime internals, private packages) | Same release cycle permissible.                         | `@motebit/runtime`, `@motebit/market`, etc. — can deprecate and remove in the same minor if no external API exposure.                                                       |
| **Protocol spec surface**                                      | Indefinite. Superseded only by a new spec version.      | `spec/*-v1.md` wire formats, protocol-level migrations. A deprecation here implies a coordinated multi-implementation transition.                                           |

These are _minimums_. Critical APIs with deep consumer integration (receipt signing, identity verification) warrant longer windows judged case-by-case.

## Runtime warnings — shrinking holder count during the window

A deprecation window is wasted if holders don't know they're holders. The runtime should actively signal:

```ts
export function oldThing() {
  if (process.env.NODE_ENV !== "production") {
    logger.warn("oldThing is deprecated since 1.0.0; use newThing. Removed in 2.0.0.");
  }
  return newThing(); // or legacy behavior if non-equivalent
}
```

Signals tell external consumers "you are a holder; move before the removal." Without them, holder count stays opaque and the removal becomes coordinate-in-the-dark.

Guidelines:

- **Warn once per process, not per call.** Cache the warning to avoid log spam.
- **Warn in development, not production.** Unless the deprecation is imminent (removeIn is the next release), production warnings create noise.
- **Named loggers where possible** — use `createLogger("deprecation")` on services; `console.warn` is fine in packages.
- **Never throw for deprecation alone.** Deprecation is a signal, not an enforcement.

The goal: telemetry visible to the operator and to downstream consumers, so the graduation decision (when to actually strip) has data to support it.

## Graduation to removal

When a deprecated symbol reaches its `removed in` version, `migration-cleanup.md` takes over. The state-holder analysis decides whether the deprecation window shrank `N` enough that the symbol is:

- **0 holders** → strip immediately at the target release.
- **1 controlled holder** → verify + strip.
- **Still N-uncontrolled** → extend the deprecation window one more major cycle, update the annotation, document why. (This is the "escape hatch" — if the deprecation window didn't shrink holders enough, be honest and extend rather than break consumers. But the extension must be deliberate, not silent.)

The two doctrines compose: addition writes the contract that future removal relies on.

## Fixed-group coordination

Motebit publishes seven packages (`@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `@motebit/verify`, `create-motebit`, `motebit`) as a **fixed release group** — they bump together. This shapes deprecation mechanics:

- **Every deprecation within the fixed group sunsets at the same major.** A `removed in 2.0.0` on `@motebit/sdk` means the removal happens when all seven hit 2.0.0 — one coordinated release, not seven independent ones.
- **Cross-package replacements are valid.** Deprecating `X` in `@motebit/sdk` in favor of `Y` in `@motebit/verifier` works; consumers migrate imports in the same coordinated major.
- **Non-fixed-group packages deprecate independently.** `@motebit/wire-schemas`, `@motebit/runtime`, etc. can deprecate at any minor; they only cross-coordinate when their API is referenced from a fixed-group package.

## BSL Change Date as implicit sunset ceiling

BSL-1.1 packages convert to Apache-2.0 four years after each version's first public release. This sets an implicit upper bound on any BSL-code deprecation: once the Change Date passes, the code is Apache and whatever deprecation disciplines applied are inherited by every downstream fork.

Practical implication: deprecating BSL code with a `removed in` that falls _after_ the Change Date is fine — the removal itself lands under Apache terms. But don't rely on it to hide a deprecation — the source is still visible and the discipline still applies.

## Forbidden patterns (and what to do instead)

| Anti-pattern                                         | What's wrong                                                                  | Do instead                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/** @deprecated kept for backward compatibility */` | No sunset; this is silent permanent compat wearing a costume.                 | `@deprecated since 1.0.0, removed in 2.0.0. Use X.`                                                                               |
| "One release cycle"                                  | Ambiguous. Release cycles aren't a fixed duration.                            | Name the version: `removed in 1.2.0`.                                                                                             |
| Deprecating without a replacement named              | Forces every consumer to figure out their own path — fractures the ecosystem. | If no replacement exists, name that: `no replacement; the operation is no longer supported as of 2.0.0 — see <link> for context.` |
| Breaking silently at a minor                         | Violates semver. Breaks consumers who trusted `^1.0.0`.                       | Either bump major, or deprecate then remove across a window.                                                                      |
| Deprecating _and_ removing in the same release       | No window for consumers to migrate. Equivalent to breaking without warning.   | Minimum one major cycle for stable APIs; alpha can collapse to same release.                                                      |

## How to apply at motebit (as of 2026-04-23)

The ~15 existing `@deprecated` markers across the codebase land in the grandfathered category — they were added before this doctrine existed. Classification pass in a follow-up commit:

- **`LegacyVerifyResult` + `verifyIdentityFile`** (`@motebit/crypto`) — active API, wide consumption. Needs `since 1.0.0, removed in 2.0.0. Use verify() + VerifyResult.` + a runtime deprecation warning on `verifyIdentityFile` call.
- **`detectLocalInference` / `AnthropicProvider` legacy names** (`@motebit/ai-core`) — BSL runtime-internal, can collapse to the next minor.
- **Market scoring legacy functions** (`@motebit/market`) — BSL internal, same.
- **`@motebit/mcp-client` credential-source backwards-compat** — BSL internal. Named sunset at next minor.
- **Services/api anchoring EVM fields, federation rate-limiter alias** — BSL runtime. Named sunset.
- **`apps/cli/src/args.ts` deprecated flag alias** — belongs to `motebit` fixed-group package. Named sunset at 2.0.0.

Each marker gets rewritten to the four-field contract in a dedicated pass. No behavior change in the classification commit — only annotation fidelity.

## Drift defense

`check-deprecation-discipline.ts` (landed 2026-04-24, invariant #39) enforces the four-field contract mechanically. It scans every `.ts` / `.tsx` file under `packages/**`, `apps/**`, `services/**`, extracts the comment block surrounding each `@deprecated` token (walking both backward to the block opener and forward to the closer — motebit's convention places `Reason:` lines AFTER the annotation), and validates five rules:

- `since <X.Y.Z>` present on the annotation line
- `removed in <X.Y.Z>` present on the annotation line
- `removed in` version strictly greater than the containing package's current version (a past-due sunset shipped unremoved is a broken promise)
- replacement pointer recognizable by one of five hints (`Use {@link X}`, ``Use `X` instead``, `Pass a configured …`, `no replacement; rework the caller`)
- `Reason:` block somewhere in the surrounding comment

Baseline at landing: 19 sites across 8 packages, all passing. The effectiveness probe inserts a deliberately-incomplete `@deprecated` and confirms the gate exits non-zero with specific rule violations.

Together with `check-changeset-discipline` (enforces `## Migration` sections on `major` bumps) and `check-api-surface` (enforces that public-API changes ship a pending changeset), the deprecation pipeline is now mechanically complete: four-field marker → major changeset with migration guide → removal PR that updates api-extractor baselines.

## Cross-references

- [`migration-cleanup.md`](migration-cleanup.md) — the removal partner. The deprecation lifecycle writes the contract; migration-cleanup applies state-holder analysis at the graduation point.
- [`protocol-model.md`](protocol-model.md) — the three-layer model (protocol / implementation / accumulated state). Deprecations on protocol-layer surfaces follow the longest window; implementation layer follows the stable/beta/alpha class.
- [`coverage-graduation.md`](coverage-graduation.md) — the precedent for soft-signal drift gates with raise-by dates. The deprecation-discipline gate would adopt the same shape.
- External: [Semver 2.0](https://semver.org), [Kubernetes deprecation policy](https://kubernetes.io/docs/reference/using-api/deprecation-policy/), [Python PEP 387](https://peps.python.org/pep-0387/), [Rust `#[deprecated]`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-deprecated-attribute), [Keep a Changelog](https://keepachangelog.com).
