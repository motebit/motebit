# Drift defenses

Every architectural drift this codebase has suffered has the same shape: the canonical source of truth was invisible, unenforced, or ambiguous, so sibling copies emerged and drifted independently. The response is systematized:

1. **Name it.**
2. **Identify the canonical source of truth.**
3. **Name the sync owner, trigger, and mismatch response.**
4. **Add a defense** — CI gate, lint rule, or explicit doctrine principle in [CLAUDE.md](../CLAUDE.md).
5. **Cross-reference the defense** from any affected package or service comment.

Fifteen invariants are enforced today. Fourteen run as hard CI gates via `pnpm check`; one is advisory (`check-sibling-boundaries`, PR-diff scoped).

## Inventory

| #   | Invariant                                              | Defense                                           | Landed     |
| --- | ------------------------------------------------------ | ------------------------------------------------- | ---------- |
| 1   | Protocol primitives ↔ service implementations          | `check-service-primitives.ts`                     | —          |
| 2   | Architectural layers ↔ dependencies                    | `check-deps.ts`                                   | —          |
| 3   | Spec filenames ↔ implementation references             | `check-spec-references.ts` (`--strict`)           | —          |
| 4   | Sibling boundaries ↔ each other                        | `check-sibling-boundaries.ts` (advisory, PR-diff) | —          |
| 5   | Coverage thresholds ↔ measurements                     | `turbo run test:coverage`                         | —          |
| 6   | Capability rings ↔ surfaces                            | `check-app-primitives.ts`                         | —          |
| 7   | Deps declarations ↔ actual use                         | `knip` (soft signal)                              | —          |
| 8   | Published API ↔ consumer contract                      | `check-api-surface.ts`                            | —          |
| 9   | Spec Wire format types ↔ `@motebit/protocol` exports   | `check-spec-coverage.ts` (`--strict`)             | 2026-04-13 |
| 10  | Spec Wire format signatures ↔ cryptosuite declarations | `check-suite-declared.ts`                         | 2026-04-13 |
| 11  | `@motebit/crypto` verify paths ↔ suite dispatcher      | `check-suite-dispatch.ts`                         | 2026-04-13 |
| 12  | Published binaries ↔ dist-boot smoke                   | `check-dist-smoke.ts`                             | 2026-04-13 |
| 13  | Architecture-docs tree ↔ filesystem + `check-deps.ts`  | `check-docs-tree.ts`                              | 2026-04-14 |
| 14  | Spec callables ↔ MIT package exports                   | `check-spec-mit-boundary.ts`                      | 2026-04-14 |
| 15  | Surface affordances ↔ deterministic invocation path    | `check-affordance-routing.ts`                     | 2026-04-14 |

## Incident histories

Each defense exists because something drifted. These are the stories. They are not binding doctrine; they exist so future maintainers understand _why_ the check exists before they consider weakening it.

### 9. Spec Wire format types ↔ `@motebit/protocol` exports

Landed in warning mode after the `settlement_modes: string` vs `string[]` drift in `discovery-v1.md`. The spec said one thing, the protocol types said another, and neither was obviously wrong. Flipped to strict on 2026-04-13 once all twelve specs adopted the wire-vs-storage split — specs declare `#### Wire format (foundation law)` subsections separately from `#### Storage` subsections, and every type named under Wire format must be exported from `@motebit/protocol`.

### 10. Spec Wire format signatures ↔ cryptosuite declarations

Every signed wire artifact declares `suite: SuiteId` alongside `signature`, and the value must appear in `@motebit/protocol`'s `SUITE_REGISTRY`. Landed 2026-04-13 alongside cryptosuite agility.

### 11. `@motebit/crypto` verify paths ↔ suite dispatcher

Every signature primitive call lives in `packages/crypto/src/suite-dispatch.ts`, with an optional `// crypto-suite: intentional-primitive-call — <reason>` waiver for explicit escape hatches. Together with `check-suite-declared` this closes the PQ-migration trap where a spec declares a suite but the code still hardcodes Ed25519. Scope widened the same day (2026-04-13) from `packages/crypto/src/` only to also cover `services/` and `apps/`, after the Vercel Edge proxy's `ed.verifyAsync` was found outside the original scan. The reason text (anything after the em-dash / hyphen on the waiver line) is parsed and printed by the gate so waivers are self-documenting in CI output — one way to express a waiver, no parallel exception table (2026-04-16).

**Active waivers.** Each one must pass the protocol test ("is this a motebit wire artifact?") and name a revisit trigger.

| File                               | Pattern          | Reason                                                                               | Revisit trigger                                                                                     |
| ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `services/proxy/src/validation.ts` | `ed.verifyAsync` | Vercel Edge bundle budget; ProxyToken is service-local, not a protocol wire artifact | `@motebit/crypto` ships an edge-friendly subpath build → route through `verifyBySuite`, drop waiver |

### 12. Published binaries ↔ dist-boot smoke

Every `package.json` with a `bin` entry must successfully execute `node <bin> --help` in CI. Catches bundling regressions — CJS-in-ESM, wrong subpath export, missing transitive dep — before they ship to npm. Added 2026-04-13 after `apps/cli/dist/index.js` was discovered crashing with `ERR_PACKAGE_PATH_NOT_EXPORTED` during a cold-install walkthrough (`@noble/hashes` × `@solana/web3.js`).

### 13. Architecture-docs tree ↔ filesystem + `check-deps.ts`

`apps/docs/content/docs/operator/architecture.mdx` contains a directory tree tagging every package with its enforced layer and MIT status. The probe parses the tree and asserts every app/package/service/spec on disk appears in the tree with a correct `[Ln]` / `[MIT]` tag. Added 2026-04-14 after a rewrite found the page had invented a 3-tier Core/Engines/Surface grouping that misplaced nine packages, a stale 13-tab admin count (real: 15), a spatial description that contradicted the compile-time doctrine, and an absent protocol surface (cryptosuite agility, rail custody, credential anchoring).

### 14. Spec callables ↔ MIT package exports

Every backticked callable of the form `` `functionName(...)` `` in any `spec/*.md` file must resolve to a symbol exported from an MIT package (`@motebit/protocol`, `@motebit/crypto`, `@motebit/sdk`) or appear in an explicit waiver list with a one-line reason. The probe excludes all-lowercase identifiers (snake_case SQL DDL, math notation like `trust(A,B)` or `max(x,y)`) which are not repo symbols. Added 2026-04-14 after an external reviewer asked whether protocol-only algorithms could silently drift into BSL. The probe's first run caught `deriveSyncEncryptionKey(privateKey)` in `settlement-v1.md` — a deterministic HKDF recipe that a third party must reproduce to interoperate — living only in BSL `@motebit/encryption`. The fix was to inline the recipe in the spec text (salt, info string, hash, output length) so the spec stands alone without a symbol reference. The waiver list covers documented reference-implementation pointers (e.g., `verifySignedTokenForDevice` in auth-token-v1 §9, `augmentGraphWithFederatedAgents` in relay-federation-v1 Appendix A.2), external library symbols (`getTransaction` from `@solana/web3.js`), and adapter-interface method names. Adding a waiver requires a reason that would survive code review.

### 15. Surface affordances ↔ deterministic invocation path

Every UI affordance that invokes a capability (chip tap, button click, slash command, scene-object click, voice opt-in) must route through `MotebitRuntime.invokeCapability(name, args)`, never by constructing a natural-language prompt and handing it to `handleSend` / `sendMessageStreaming`. The probe scans `apps/*/src/ui/**` and `apps/*/src/commands/**` for AI-loop entry points whose argument list contains a `required_capabilities` literal or a "delegate … remote agent / motebit network" phrase. Added 2026-04-14 after the PR-URL chip showcase: the chip said "Review this PR" but passed an English prompt through the AI loop; on one run the model responded with bullet-point questions instead of calling `delegate_to_agent`, producing no receipt and no audit signal. The chip lied. The drift shape was the same as inlining protocol plumbing in services — a handler pattern that "works most of the time" becoming the convention by the time a second affordance copies it. Fix: extract the submit-and-poll core into `packages/runtime/src/relay-delegation.ts`, add a typed `invokeCapability(capability, prompt, options)` entry point that yields `delegation_start → text → delegation_complete` with `full_receipt` (or a single `invoke_error` chunk on failure — no fall-through to the AI loop), stamp `invocation_origin: "user-tap"` on the relay submission so the outer receipt is signature-bound to the affordance that authorized it. Doctrine: [`docs/doctrine/surface-determinism.md`](doctrine/surface-determinism.md).

## How to add a new defense

When a new drift pattern is observed:

1. **Don't just fix the instance.** Fixing `foo.ts` without a probe means the sibling files will drift the same way next week.
2. **Write the probe before the fix.** Running the probe against the broken state confirms it catches what you intend to catch. Adversarial test: plant a deliberate drift in a file, run the probe, confirm it exits non-zero with a specific message. Then fix and confirm green.
3. **Register in three places:**
   - `package.json` scripts (`"check-foo": "npx tsx scripts/check-foo.ts"`)
   - `scripts/check.ts` `GATES` array (with a `defends:` one-liner naming the invariant, not the mechanism)
   - This file — append a row to the inventory and a paragraph to the incident histories
4. **Link from affected code.** If the probe exists because of a specific file or package, a one-line comment there pointing back (`// see scripts/check-foo.ts`) means the next reader understands the constraint before they trip it.

The probe is cheaper than the incident. Every gate we have exists because an incident was cheaper to enforce than to repeat.
