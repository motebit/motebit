# Agility as role

Every architectural axis where motebit reserves the right to swap concretes follows the same shape: name the **role** in code, gates, types, and prose; treat the **instance** as a registry entry whose value can change without touching consumers. Migration becomes a registry append, not a wire-format break or a codebase rewrite.

The pattern is unstated but load-bearing. Seven instances run through it today, with a typed admission predicate layered atop the intelligence-source pair. Future architectural decisions involving a chosen technology should ask the test in [§ When to apply](#when-to-apply) on day one — the cost of indirection is one type alias, the cost of retrofitting later is the migration that motivates the decision.

## The pattern

- **Role** is a stable, abstract name in code: `SuiteId`, `permissive floor`, `GuestRail`, `SovereignRail`. It appears in protocol types, gate-script logic, doctrine prose, and changeset titles.
- **Instance** is the replaceable concrete value: `Ed25519`, `Apache-2.0`, `Stripe`, `SolanaWalletRail`. It lives in a registry the role consults at runtime / verify time / publish time.
- **Migration** is one entry added or substituted in the registry. Consumers continue to consume the role; the registry resolves to the new instance. No callsite changes.
- **Drift defenses** check the role, never the literal instance. A gate that hardcodes `Ed25519` would fire spuriously the moment ML-DSA-65 is added; a gate that asks "every signed artifact carries a registered `SuiteId`" survives the migration unchanged.

## Seven instances in motebit

### Cryptosuite agility

- **Role:** `SuiteId` in `@motebit/protocol`. Every signed artifact carries `suite`. Every verifier dispatches via `verifyBySuite` in `@motebit/crypto`. No verifier path is allowed to assume Ed25519.
- **Instance today:** `Ed25519` (one of five entries; `crypto-suite.ts`).
- **Migration shape:** PQ migration (ML-DSA-44, ML-DSA-65, SLH-DSA) is a `SuiteId` registry entry plus a `verifyBySuite` dispatch arm. The wire format does not break — every artifact already carries an explicit `suite` discriminator. Every verifier already routes through dispatch.
- **Defenses:** `check-suite-declared` (#10) — wire formats; `check-suite-dispatch` (#11) — verifier dispatch.
- **Memory:** `architecture_cryptosuite_agility`.

### License-floor agility

- **Role:** "permissive floor" — the open-license layer that defines the protocol's interoperability surface. Every consumer of the protocol's wire format types (third parties standing up alternate implementations) reads from the permissive floor; nothing in the BSL upper layer is required to interoperate.
- **Instance today:** `Apache-2.0` (flipped from MIT on commit `2d8b91a9`, 2026-04-23). Convergence target: one license at the BSL Change Date.
- **Migration shape:** the role is named in `package.json` `license` fields, in `LICENSE` headers, in `LICENSING.md` tables, and in CLAUDE.md doctrine prose. Replacing the instance is a sweep across declared values + a doctrine update — no consumer has to re-link, because consumers depend on _what the floor permits_, not on the literal SPDX identifier. Drift defense `check-license-doc-sync` verifies every permissive-floor package's `license` field carries the role's instance + that `LICENSING.md` / `CONTRIBUTING.md` prose agrees on membership.
- **Memory:** `architecture_license_floor_apache`.

### Settlement-rail registry

- **Role:** `SettlementRail` in `@motebit/protocol`, split into `GuestRail` (relay-custody) and `SovereignRail` (agent-custody). The registry decides which rails the relay accepts; the type system enforces that custody-relay code only ever sees `GuestRail`.
- **Instances today:** `StripeSettlementRail`, `X402SettlementRail`, `BridgeSettlementRail` (guest); `SolanaWalletRail` (sovereign).
- **Migration shape:** new rails are registry additions. Identity, signing, custody-mode, and accounting all read the role's interface; the rail's specific protocol is contained behind the rail adapter. Adding a fifth guest rail or a second sovereign rail is one new file in `@motebit/settlement-rails` plus one registry append.
- **Defenses:** type-level enforcement of the custody split (`@ts-expect-error` negative-proof in `custody-boundary.test.ts`); `check-deps` (#2) — package-layer purity.
- **Memory:** `architecture_rail_custody_split`.

### Foundation-model agility

- **Role:** `ByokVendor` in `@motebit/sdk` (`packages/sdk/src/provider-mode.ts`). The role is "foundation-model vendor accessible via OpenAI-compatible (or Anthropic's) wire protocol." Every BYOK config carries `vendor`; the provider resolver dispatches via exhaustive switches in `defaultModelForVendor`, `canonicalVendorBaseUrl`, and `resolveProviderSpec`'s `byok` arm. No surface is allowed to assume a specific vendor — all four chat surfaces (web, desktop, mobile, CLI) consume the role through the same registry shape.
- **Instances today:** `anthropic`, `openai`, `google`, `groq`, `deepseek` (five entries). Registry order groups the four American-hosted vendors first, with DeepSeek (the sole Chinese-hosted instance) listed last so the geographic outlier-ness reads as intentional structural asymmetry rather than oversight. The DeepSeek instance (shipped 2026-05-13) closed the doctrinal asymmetry where motebit's founding "intelligence is pluggable" claim (`CLAUDE.md` opening) was contradicted by a 3-vendor registry of exclusively-expensive Big Tech providers. The Groq instance (shipped 2026-05-13) adds the American-hosted open-source counterpart, completing the cross-geography parity. The two open-source-via-API additions land on different distinguishing axes: DeepSeek is cheapest ($0.27/M input, Chinese-hosted), Groq is fastest (~280 tok/sec American-hosted, $0.59/M input). Notable Groq context: in December 2025 NVIDIA entered a $20B non-exclusive licensing agreement with Groq and hired the founding leadership; Groq remains operationally independent under CEO Simon Edwards and continues serving the BYOK API. The closed-registry pattern absorbs this kind of vendor-orbit-shift cleanly — agility-as-role means the role survives the instance's corporate relationships. The role stays closed at the wire-vocab boundary; affordability + speed + sovereignty optionality all land via additive registry shape.
- **Migration shape:** adding a new vendor is a registry append + three dispatch arms + a default model entry + a `*_MODELS` constant + parallel surface UI tile additions. Closure is enforced by exhaustive-switch typechecks (any missing case is a compile error) and by the `check-api-surface` baseline gate (the union's serialized signature in `sdk.api.md`). The wire format does not break — every BYOK config carries an explicit `vendor` discriminator.
- **Defenses:** TypeScript exhaustive-dispatch (compile-time); `check-api-surface` (the SDK baseline mirrors the union); the provider-resolver tests (one describe block per vendor). No standalone drift gate needed — the existing discipline closes the loop.
- **Memory:** `byok_deepseek_first_open_source`.
- **What this enables for "intelligence is pluggable":** the founding doctrine claim becomes structurally true rather than aspirational. A user uncomfortable with US Big Tech picks DeepSeek; a user uncomfortable with Chinese hosting picks Anthropic; a user with sovereignty requirements picks on-device. Motebit is the constant; the vendor is the registry entry. Future open-source-via-API additions (OpenRouter as meta-vendor, Groq, Together, Fireworks) are sibling registry appends with the same shape.

### Inference-host agility

- **Role:** `InferenceHost` in `services/proxy/src/validation.ts`. The role names the data-flow destination — the entity whose servers receive the prompt bytes when motebit-cloud (`services/proxy`) routes a request. Every `MODEL_CONFIG` entry carries `host`; routing, pricing, and transparency disclosure (`services/relay/src/transparency.ts`'s third-party-processors list) all read from this axis. `InferenceHost` is a sibling registry to `ByokVendor` above — both encode "inference destination" but live behind different admission policies (BYOK passes user keys directly; motebit-cloud applies the jurisdiction predicate below).
- **Instances today:** `anthropic`, `openai`, `google`, `groq` (four entries). Anthropic/OpenAI/Google are vertically integrated (each is also a `ModelLab`); Groq is host-only (runs Meta's Llama 3.3 70B + OpenAI's open-source gpt-oss-120b on LPU hardware).
- **Migration shape:** adding a new host (Together AI, Fireworks, Cerebras, Replicate, DeepInfra) is a registry append + one `getProviderApiKey` arm + one `buildProviderRequest` arm. Most hosts speak OpenAI-compatible HTTP, so dispatch arms collapse onto the same shape; the registry entry's `host` discriminator drives selection.
- **Defenses:** `check-transparency-processors-canonical` (#92) — every host hostname the proxy/relay contacts must be disclosed as a processor in the operator-transparency declaration. TypeScript exhaustive switches catch missing dispatch arms.

### Model-lab agility

- **Role:** `ModelLab` in `services/proxy/src/validation.ts`. The role names the weight-training origin — who trained the weights running on the host. Decoupled from `InferenceHost` because the same model can run on multiple hosts (Llama 3.3 70B runs on Groq, Together, Fireworks, DeepInfra; same weights, same lab, different hosts). The decoupling is the structural proof that the doctrine claim _"intelligence is pluggable"_ is load-bearing rather than aspirational.
- **Instances today:** `anthropic`, `openai`, `google`, `meta` (four entries). Anthropic/OpenAI/Google each appear in both `InferenceHost` and `ModelLab` because vertical integration — the same company trains and hosts. Meta appears in `ModelLab` only (publishes Llama weights, doesn't run hosted inference). OpenAI appears twice: as `host` for proprietary GPT-5.4 hosted at api.openai.com, and as `lab` for gpt-oss-120b which they released as open weights and Groq hosts.
- **Migration shape:** adding a new lab (Mistral, Cohere, Qwen) is a registry append. `ModelLab` is currently a data-field axis without a shipping consumer (Path C auto-routing by model-family preference and surface-level UI attribution would be future consumers) — the field is populated because the property is factually true of every entry, not because code branches on it today. _Data fields document reality; behavior fields commit to future code branches._ The asymmetry is intentional: facts don't need consumers to justify their existence; abstractions do. See `feedback_data_fields_vs_behavior_fields` for the meta-principle.
- **Defenses:** TypeScript exhaustive enforcement (every `MODEL_CONFIG` entry must declare a `lab` value drawn from the closed union).

### TaskShape agility (the 7th instance)

- **Role:** `TaskShape` in `@motebit/protocol/src/routing.ts` — closed union of task categories the auto-router branches on (`"quick" | "chat" | "reasoning" | "code" | "research" | "creative" | "math"` today). Every consumer of `dispatchRouting` (`@motebit/policy`) accepts a `TaskShape` as input and returns a `RoutingDecision`. No consumer is allowed to inline its own routing logic outside the dispatcher.
- **Instances today:** seven task categories lifted from `services/proxy/src/validation.ts`'s `TASK_MODEL_MAP` (the production set since the intelligence-source-agility refactor). Each shape maps to a preferred model in `REFERENCE_ROUTING_POLICY` (the reference default in `@motebit/policy`).
- **Migration shape:** adding a shape (`"voice-conversation"`, `"image-generation"`, `"agentic"`, etc.) is a registry append in `@motebit/protocol` + a new arm in `REFERENCE_ROUTING_POLICY` + drift-gate-induced coverage in every CONSUMER. Compile-time enforced via the dispatcher's exhaustive switch with `never` fallthrough — the type system refuses to ship until every arm is added.
- **Defenses:** `check-routing-decision-coverage` (#95) — CONSUMERS-registry coverage (motebit-cloud proxy at PR 1; BYOK at PR 2; on-device at PR 3). Sibling-alignment: gate's `TASK_SHAPES_REFERENCE` mirrors `ALL_TASK_SHAPES` from protocol. **TaskShape literal scanning is NOT in the gate** — the dispatcher's exhaustive switch enforces per-shape coverage structurally; a textual gate would be redundant ceremony.
- **Critical distinction — TaskShape is the role; routing-policy is a consumer-side function, NOT a role.** A routing-policy (`Record<TaskShape, string>` today, potentially a learned function of the same signature in the future) is **dependency-injected** at the `dispatchRouting` call site. New policies are new function implementations, not closed-registry entries. Distinguishing role (registry-shape) from policy (function-shape) avoids the same vocabulary conflation the codebase corrected for `Provider → InferenceHost`. The 2026-05-13 plan-review session caught this exact misframe in an earlier draft of the auto-router doctrine; the correction is preserved here as a doctrinal anchor.
- **Doctrine:** `docs/doctrine/auto-routing-as-protocol-primitive.md` (`f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`).

### Jurisdiction admission predicate (not a role)

`Jurisdiction` is **not** a third agility-as-role instance — it's a typed admission predicate layered atop `InferenceHost` instances. The distinction matters: roles enumerate swappable implementations (you can append a new `SuiteId`, a new `ByokVendor`, a new `InferenceHost`), but jurisdictions reflect legal reality (you can't "swap" a host's jurisdiction — Groq is US-based; that's a fact of the physical world, not a pluggable implementation choice). Adding `"EU"` to the `Jurisdiction` union doesn't enable a migration; it documents that a host operating from the EU now exists.

- **Role-like surface:** `Jurisdiction = "US" | "CN" | "EU"` typed union; every `InferenceHost` entry carries a `jurisdiction` field; `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS: ReadonlySet<Jurisdiction>` is the set motebit-cloud admits; `isModelAllowedInMotebitCloud(model)` is the admission predicate.
- **What this closes:** the previously-tribal "DeepSeek-is-BYOK-only-because-Chinese-hosted" decision (`feedback_intelligence_commodity`, `feedback_sovereignty_orthogonal`). Pre-this-commit the policy was enforced by absence — engineers were trusted to remember not to add Chinese-hosted vendors to motebit-cloud. Post-this-commit the type system + admission predicate refuse the route at runtime if a future `MODEL_CONFIG` entry has `jurisdiction !== "US"` until policy is intentionally widened.
- **Orthogonality preserved:** BYOK mode bypasses the predicate. The user's own key, the user's own choice; sovereignty doctrine stays orthogonal to tier policy per `feedback_sovereignty_orthogonal`.
- **Pattern this lands:** the synchronization-invariants meta-principle applied to a previously-implicit policy. Same shape as `check-suite-declared` lifting "every artifact carries a suite" from convention to type-enforced fact, or `check-audience-canonical` lifting token-audience strings from free text to closed registry. The predicate doesn't require a drift gate today — TypeScript enforces the union, and a future drift mode (e.g., contributor casts `jurisdiction: undefined as any`) would justify a gate then. Premature gates dilute the gate-bar; observed drift earns gates (per `feedback_data_fields_vs_behavior_fields`'s sibling: gates earn slots by closing observed drift, not theoretical drift).

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
