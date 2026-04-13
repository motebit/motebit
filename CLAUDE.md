# Motebit

A motebit is a droplet of intelligence under surface tension.

Every AI product owns the intelligence and rents you a session. Motebit inverts that. You own the identity. The intelligence is pluggable. The body is yours.

The body is passive. The interior is active. The agent lives inside the droplet — memory, trust, identity, tool use are interior structures. The policy gate, the privacy layer, the governance — these are the surface tension. The form doesn't change. The interior accumulates. Maximum interiority, minimum display.

Read `DROPLET.md` for the physics of form. Read `THE_SOVEREIGN_INTERIOR.md` for the identity thesis. Read `THE_METABOLIC_PRINCIPLE.md` for what to build vs. what to absorb. Every visual and behavioral decision derives from droplet physics. If it can't be traced to surface tension, it doesn't belong.

## The Three Things No One Else Is Building Together

1. **Persistent sovereign identity** — not a session token, a cryptographic entity that exists across time and devices
2. **Accumulated trust** — memory, state history, audit trails that make the agent more capable the longer it runs
3. **Governance at the boundary** — sensitivity-aware privacy and policy that controls what crosses the surface

MCP defines capability but says nothing about who the agent is. A2A defines communication but has no trust accumulation. x402/AP2 defines payment but has no identity. Motebit is the missing layer underneath all three. The relay bridges all four protocols (MCP, A2A, x402, AP2) through a single economic checkpoint — identity resolved, execution verified, money finalized.

## Architecture

pnpm monorepo, Turborepo orchestration, TypeScript throughout. Node >= 20, pnpm 9.15.

**7-layer dependency enforcement** validated by `pnpm check-deps` in CI. Layer violations break the build.

```
apps/
  cli/         Operator console (npm: motebit). REPL, daemon, delegation, MCP server mode
  desktop/     Tauri glass droplet. Three.js creature, identity, operator mode
  mobile/      React Native + Expo. Full-featured, tab-based UI
  web/         Browser entry point. IndexedDB identity, free proxy, zero install
  admin/       React + Vite dashboard. 15-tab real-time monitoring
  spatial/     AR/VR. 6DOF orbital dynamics, WebXR, gesture recognition
  docs/        Next.js documentation portal (docs.motebit.com)
  identity/    Identity management app. Vite, TypeScript

packages/
  protocol/           Network protocol types + semiring algebra (Layer 0, MIT, 0 deps)
  sdk/                Full type vocabulary, re-exports protocol (Layer 0, MIT)
  crypto/             Protocol cryptography — sign and verify all artifacts (Layer 0, MIT, 0 monorepo deps)
  create-motebit/     CLI scaffolder: npm create motebit (Layer 0, MIT)
  encryption/         Product security: AES-256-GCM, PBKDF2, sync keys, deletion certificates (re-exports signing from crypto)
  gradient/           Self-measurement: "What am I?" Pure narrative from gradient data (Layer 1, BSL)
  semiring/           Agent network judgment layer — routing wiring, provenance, trust transitions (BSL)
  policy/             PolicyGate, MemoryGovernor, injection defense
  policy-invariants/  Clamping rules, state bounds validation
  event-log/          Append-only event sourcing with version clocks
  tools/              ToolRegistry, builtin tools, MCP tool merge
  core-identity/      UUID v7, multi-device registration, Ed25519 binding
  memory-graph/       Semantic memory, cosine similarity, half-life decay, graph edges
  state-vector/       Tick-based EMA smoothing, hysteresis, 60 FPS interpolation
  behavior-engine/    State → BehaviorCues (deterministic, pure)
  render-engine/      Droplet geometry, glass material, ThreeJS adapter
  sync-engine/        Multi-device sync: HTTP/WebSocket, conflict detection, backoff
  mcp-client/         MCP stdio/HTTP client, tool discovery
  mcp-server/         MCP server adapter, synthetic tools, bearer auth
  identity-file/      Generate, parse, verify motebit.md identity files
  ai-core/            Pluggable providers (Cloud, Ollama, Hybrid), agentic turn loop
  privacy-layer/      Retention rules, deletion certificates, data export
  persistence/        SQLite (WAL mode), adapters for all storage types
  browser-persistence/ IndexedDB adapters for web/spatial
  planner/            PlanEngine: goal decomposition, plan-level reflection
  reflection/         Adaptive intelligence: "What should I change?" LLM reflection engine (Layer 4, BSL)
  voice/              VAD, STT, TTS adapters
  wallet-solana/      Sovereign Solana USDC rail — Ed25519 identity key IS the Solana address
  runtime/            Agent orchestrator: agentic turn loop, delegation, execution ledger (BSL)
  market/             Budget, settlement, graph-based routing, credential weighting
  github-action/      GitHub Action for identity verification

spec/
  identity-v1.md           motebit/identity@1.0 — file format, signing, succession
  execution-ledger-v1.md   motebit/execution-ledger@1.0 — timeline, signed manifests
  relay-federation-v1.md   motebit/relay-federation@1.0 — peering, discovery, routing
  market-v1.md             motebit/market@1.0 — budget, settlement, fees, trust, routing
  credential-v1.md         motebit/credential@1.0 — W3C VC 2.0, issuance, weighting, revocation
  settlement-v1.md         motebit/settlement@1.0 — foundation law, rail taxonomy, sovereign rail, receipts, security model
  auth-token-v1.md         motebit/auth-token@1.0 — signed bearer tokens, audience binding, replay prevention
  credential-anchor-v1.md  motebit/credential-anchor@1.0 — Merkle batch anchoring, self-verifiable proofs, chain-agnostic
  delegation-v1.md         motebit/delegation@1.0 — task submission, receipt exchange, budget lifecycle, routing scores
  discovery-v1.md          motebit/discovery@1.0 — well-known endpoint, DNS SRV, agent resolution, relay metadata
  migration-v1.md          motebit/migration@1.0 — departure attestation, credential export, trust bootstrapping
  dispute-v1.md            motebit/dispute@1.0 — evidence, adjudication, fund handling, appeal, sybil defense

services/
  api/          Relay server (modules: index, federation, task-routing,
                credentials, pairing, data-sync, accounts, a2a-bridge, logger,
                discovery, migration, disputes)
  code-review/  Code review agent ($0.50/review, Claude-powered, signed receipts)
  web-search/   Reference MCP service (single-hop + multi-hop delegation proof)
  read-url/     Minimal read-url service (second hop in multi-hop proof)
  proxy/        Vercel edge CORS proxy for web app (Anthropic API, fetch, embed)
  summarize/    Conversation summarization
  embed/        ONNX embedding service
```

## Principles

These are not suggestions. They are the architectural invariants that make the monorepo coherent. Violating them breaks CI, breaks the product, or breaks the thesis.

**Metabolic principle.** Do not build what the medium already carries. Absorb solved problems (VAD, STT, embeddings, inference) through adapter boundaries with fallback chains. Build the enzymes (identity, memory, trust, governance, agentic loops), not the glucose (raw capabilities).

**Adapter pattern everywhere.** All I/O abstracted. In-memory for tests, SQLite/Tauri/Expo/IndexedDB for production. The adapter is the surface tension boundary in code: the interior must not bind to a specific provider.

**Fail-closed privacy.** Deny on error. Sensitivity levels (none/personal/medical/financial/secret) enforced at storage, retrieval, sync, and context boundaries. Medical/financial/secret memories never reach external AI providers. Relay sync redacts sensitive content. Retention rules enforced in housekeeping with deletion certificates.

**Proof composability.** Canonical JSON → SHA-256 → Ed25519 verify. Always. External anchoring (blockchain, IPFS, x402) is additive, never gatekeeping. `@motebit/crypto` works standalone with zero monorepo deps. Do not add verification paths that require external systems.

**Semiring algebra for routing.** Agent network routing is algebraic. The algebra (the protocol's language) lives in MIT `@motebit/protocol`: `Semiring<T>` interface, concrete semirings (Trust, Cost, Latency, Reliability, RegulatoryRisk), product combinators, `WeightedDigraph<T>`, generic traversal, trust scoring constants. The judgment (the product's value) lives in BSL `@motebit/semiring`: agent network graph construction, multi-objective ranking, provenance tracking, trust state transitions, delegation trust composition. The boundary: protocol defines how trust computes; semiring defines how Motebit applies it. Swap the semiring to change what "best path" means. New routing concerns require only a new semiring definition — zero new algorithms.

**Economic loop principle.** The relay is the economy's ledger, the rails are the membrane, and agents are the workers and spenders inside the loop. Users fund at the edges (Stripe, Bridge, wallet deposit). Agents transact inside the relay via virtual accounts — allocate, execute, settle, earn, delegate, earn again. The 5% platform fee is extracted at each settlement checkpoint. Settlement rails (fiat, protocol, direct asset, orchestration) are on/off ramps only — they never hold economic truth. The internal ledger is the circulation system. The ideal endgame: user funds a droplet once, the agent earns its own way forward. Not every agent will be self-sustaining immediately, but the architecture must never prevent it. Do not build flows that require human intervention inside the loop. Deposits and withdrawals are edge operations. Everything between is agent-to-agent.

**Adversarial onboarding.** Embed adversarial probes in the happy path. `--self-test` submits a self-delegation task (the exact sybil attack vector) through the live relay. If the security boundary breaks, onboarding breaks. When building new boundaries, ask: can the onboarding path exercise this?

**Sibling boundary rule.** When you fix a boundary (auth, policy, validation, rendering), audit all sibling boundaries for the same gap in the same pass. A fix applied to one path but not its siblings is incomplete. Docs are siblings of code.

**One-pass delivery.** When a core primitive ships, implement across all surfaces in the same pass. Do not defer UI if the package boundary is stable.

**Synchronization invariants are the meta-principle.** Every architectural drift the codebase has suffered has the same shape: the canonical source of truth was invisible, unenforced, or ambiguous, so sibling copies emerged and drifted independently. The codebase maintains thirteen invariants — protocol primitives ↔ service implementations, architectural layers ↔ dependencies, spec filenames ↔ implementation references, memory ↔ code, sibling boundaries ↔ each other, coverage thresholds ↔ measurements, capability rings ↔ surfaces, deps declarations ↔ actual use, published API ↔ consumer contract, spec Wire format types ↔ `@motebit/protocol` exports (enforced by `check-spec-coverage` in strict mode since 2026-04-13; originally landed in warning mode after the `settlement_modes: string` vs `string[]` drift in discovery-v1.md, flipped to strict once all twelve specs adopted the split — specs declare `#### Wire format (foundation law)` subsections separately from `#### Storage` subsections, and every type named under Wire format must be exported from `@motebit/protocol`), spec Wire format signatures ↔ cryptosuite declarations (`check-suite-declared`, 2026-04-13: every signed wire artifact declares `suite: SuiteId` alongside `signature`, and the value must appear in `@motebit/protocol`'s `SUITE_REGISTRY`), and `@motebit/crypto` verify paths ↔ suite dispatcher (`check-suite-dispatch`, 2026-04-13: every signature primitive call lives in `packages/crypto/src/suite-dispatch.ts`, with an optional `// crypto-suite: intentional-primitive-call` waiver for explicit escape hatches — together with `check-suite-declared` this closes the PQ-migration trap where a spec declares a suite but the code still hardcodes Ed25519; scope widened the same day from `packages/crypto/src/` only to also cover `services/` and `apps/`, after the Vercel Edge proxy's `ed.verifyAsync` was found outside the original scan), and published binaries ↔ dist-boot smoke (`check-dist-smoke`, 2026-04-13: every `package.json` with a `bin` entry must successfully execute `node <bin> --help` in CI — catches bundling regressions class CJS-in-ESM, wrong subpath export, missing transitive dep before they ship to npm, after `apps/cli/dist/index.js` was discovered crashing with `ERR_PACKAGE_PATH_NOT_EXPORTED` during a cold-install walkthrough). For each, there is a canonical source, a sync owner, a when-to-check trigger, and a defense (CI gate, lint rule, script, or explicit doctrine). Never let divergence persist: if spec says X and code does Y, either fix the code or update the spec — same commit, same PR. When a new drift pattern is observed, name it and add a defense; don't just fix the instance. The response to any observed drift is systematized: (1) name it, (2) identify the canonical source of truth, (3) identify sync owner / trigger / mismatch response, (4) add a defense (CI check, lint rule, or explicit doctrine principle here), (5) cross-reference the defense from any affected package or service comment.

**Protocol primitives belong in packages, never inline in services.** Before writing any protocol-shaped plumbing (signing, token minting, MCP transport, receipt construction, relay task submission, crypto verification, delegation) inside a service, audit the package layer in this order:

1. `@motebit/protocol` — types, algebra, deterministic math
2. `@motebit/crypto` — signing/verifying artifacts (sign, verify, succession, credential anchor)
3. `@motebit/encryption` — at-rest encryption, KDF, X25519, signed bearer tokens
4. `@motebit/mcp-client` — calling another motebit as a client (`McpClientAdapter` handles bearer tokens + MCP handshake + automatic `delegation_receipts` capture)
5. `@motebit/mcp-server` — exposing this motebit as a server, including building signed service receipts (`wireServerDeps`, `startServiceServer`, `buildServiceReceipt`)
6. `@motebit/runtime` — agentic-loop orchestration
7. `@motebit/core-identity` — identity bootstrap, multi-device, pairing
8. `@motebit/identity-file` — generating/parsing/verifying motebit.md

If none match, **that is the signal that a protocol primitive is missing.** Pause. Decide which package is the right home (closest existing scope). Add the primitive there with its own tests. Consume it from the service. Never ship protocol plumbing inline — it becomes "the convention" by the time the third sibling service copies it, and the real primitive gets hidden behind the copies. Smells to catch in code review: `fetch(...)` to motebit endpoints inside services, JSON-RPC method strings (`"initialize"`, `"tools/call"`) in service code, `signExecutionReceipt` called directly in service `handleAgentTask`, `canonicalJson`/`sha256` constructing protocol-shaped payloads in services.

**Capability rings, not feature parity.** Ring 1 (core, identical everywhere): runtime, sdk, crypto, policy. Ring 2 (platform adapters): persistence, keyring, voice. Ring 3 (platform capabilities): MCP stdio (CLI/desktop only), 3D creature (desktop/mobile/web/spatial), daemon (CLI/desktop). The anti-pattern is shimming platform-impossible capabilities. Each surface maximizes what its platform offers. Ring 1 is about **capability**, not **form** — "operator can see their balance" is Ring 1; "balance renders in a rectangular panel" is Ring 3. A surface may express the same Ring 1 capability through a different form if that form is native to its medium.

**Spatial rejects the panel metaphor.** The spatial surface (`apps/spatial`) is AR/VR/WebXR-first. Porting 2D panels to a headset is cargo-cult parity and surrenders the medium's only advantage. Doctrine: spatial ships a **functional HUD** for read-only essentials (connection state, balance, active task) and expresses structured data as **spatial objects** (credentials as satellites orbiting the creature, other agents as creatures in the scene, memory as environment, goals as attractors). The HUD is the non-negotiable safety floor; spatial semantics is where the surface earns its medium. Panel parity with desktop/web/mobile is explicitly an anti-goal — operators expecting to read a rectangular balance panel on a headset is the wrong expectation to satisfy. When the vision documents (`vision_spatial_canvas.md`, `vision_endgame_interface.md`, `vision_interactive_artifacts.md`) say "the creature is the last interface," they mean spatial should stop imitating the web surface. The minimum HUD in `apps/spatial/src/hud.ts` is the policy floor; anything richer should land as spatial objects, not as a panel. **Doctrine is compile-time** as of 2026-04-13: `apps/spatial/src/spatial-expression.ts` declares `SpatialExpression = Satellite | Creature | Environment | Attractor`, and every structured-data module in spatial registers its kind via `registerSpatialDataModule<K extends SpatialKind>(...)`. Widening the union or passing `"panel"` / `"list"` / `"card"` as a kind is a tsc error, locked by the `@ts-expect-error` assertions in `apps/spatial/src/__tests__/spatial-expression.neg.test.ts` (same pattern as `custody-boundary.test.ts` for the GuestRail/SovereignRail split). Credentials are the first shipping expression — `apps/spatial/src/credential-satellites.ts` mounts a `CredentialSatelliteRenderer` under the creature group, orbiting a small glass orb per credential. The 2D credential list in settings stays for configuration; the canonical "I have N credentials from M issuers" lives in the scene.
**Deletion policy.** Three classifications before removing anything flagged by tooling or review. (1) Internal workspace dependencies (`@motebit/*`): never remove from import analysis alone — they encode layer membership and protocol contracts, not just usage. Remove only when the layer contract itself changes. (2) Exports and capabilities: if it is published API, intentional vocabulary (e.g. semantic color aliases), or scaffolding for a sibling surface, preserve it. (3) Dead code: remove only when there are zero callers, it is not part of an intended API surface, it is not staged for near-term cross-surface use, and typecheck/tests pass after deletion. When uncertain, do not delete. `check-deps` (hard CI gate) governs architecture. `check-unused` (soft signal) governs external dependency hygiene. The two tools govern different domains and must not be conflated.

## Protocol Doctrine

Motebit is a protocol, not a platform. This has concrete architectural consequences that bend every design decision.

**The three-layer model.** Every function the relay performs lives in exactly one of three layers, and each layer has a different shape of ownership:

1. **Protocol** — the open spec anyone can implement. Published in `spec/*.md`. Consumed via the MIT type packages (`@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`). A third party reading only the specs and the MIT types can build an interoperating alternative implementation without permission.
2. **Reference implementation** — Motebit, Inc.'s code that implements the protocol. BSL-1.1 licensed: source-available, commercially restricted during the early phase, automatically converting to a permissive license after the conversion date. Same pattern as MariaDB, CockroachDB, Stripe, Confluent, and Ethereum's commercial clients.
3. **Accumulated state** — trust history, federation graph, network effects, operational data. Never licensed; private to the canonical relay operator. The long-term moat that makes the reference implementation commercially defensible.

A function is "protocol-shaped" only when its rules live in an open spec. A rule that exists only in BSL implementation code is not yet part of the protocol — it is part of the canonical implementation.

**The MIT/BSL boundary test.** For every package, module, or function, ask which question it answers:

MIT if it answers: What is the artifact? How is it encoded? How is it signed? How is it verified? What deterministic math defines interoperability? What interface must another implementation satisfy?

BSL if it answers: How does the system decide? How does the system adapt over time? How does the system monetize, route, prioritize, govern, or operationalize? How does the product behave in practice?

MIT defines the interoperable protocol: artifacts, cryptography, deterministic algebra, and abstract interfaces. BSL contains the stateful runtime, orchestration, governance, memory, routing, and product implementations that make Motebit commercially differentiated. Accumulated state (trust data, federation graph, settlement history) is never licensed — it is the permanent moat.

**The operational test.** For any relay function, ask: _can a third party stand up a competing implementation today, using only the published specs and the MIT type packages, without permission?_ If yes, the function has crossed from platform into protocol. If no, it is still platform-shaped regardless of how the codebase is organized internally. This test is the honest measure of "how protocol-shaped is motebit right now" and should be applied to every new architectural decision.

**Sync is the floor of legitimate centralization.** Multi-device sync is the only relay function with a legitimate centralization premium, because devices are intermittently online and NAT/offline/push notifications are genuinely hard to do peer-to-peer. Every other relay function (discovery, trust aggregation, multi-hop orchestration, settlement, federation, sybil defense, credential verification) can exist as a service so long as it is optional, replaceable, and spec-governed. The relay may offer these services — and should, because they are how the commercial entity earns — but they must not be the only path.

**The dual license is correct.** The MIT/BSL split does not contradict the protocol position; it is the standard pattern for protocol-shaped businesses. MIT on the vocabulary and verification primitives lets anyone implement against the protocol. BSL on the reference implementation provides commercial protection during the early phase. The accumulated state stays private as the long-term moat. All three layers work together; the split is a feature, not a tension.

**Foundation law vs implementation convention.** Protocol specs must distinguish what every implementation must preserve (foundation law) from what one particular implementation happens to be elegant at (convention). Foundation law should survive chain change, hardware upgrades, multisig wrappers, and hot/cold key splits without breaking. Conventions are how a specific reference implementation chooses to satisfy the foundation law, not binding on alternative implementations. When writing a spec, if a rule cannot survive swapping the chain or the wallet topology, it does not belong in foundation law — it belongs in the reference implementation section, clearly marked as convention.

**Cryptosuite agility is protocol-shaped as of 2026-04-13.** The verification recipe — not the primitive name — is foundation law. Every signed wire-format artifact carries a `suite: SuiteId` field alongside its `signature`; `SuiteId` is a closed string-literal union in `@motebit/protocol/crypto-suite.ts`. The suite bundles algorithm + canonicalization + signature encoding + key encoding into one identifier (the pattern matches W3C VC 2.0's `cryptosuite: "eddsa-jcs-2022"` and COSE/JOSE algorithm registries — one ID per full recipe, not just "which primitive"). Five suites ship today: `motebit-jcs-ed25519-b64-v1` (receipts, delegation, migration, dispute), `motebit-jcs-ed25519-hex-v1` (identity, succession, anchors, relay metadata), `motebit-jwt-ed25519-v1` (signed bearer tokens), `motebit-concat-ed25519-hex-v1` (federation handshake + heartbeat), and the W3C `eddsa-jcs-2022` for VCs/VPs. Verifiers dispatch primitive verification through `verifyBySuite` in `packages/crypto/src/suite-dispatch.ts` — the one file in `@motebit/crypto` permitted to call `@noble/ed25519` directly (enforced by the `check-suite-dispatch` gate). Missing or unknown suite values are rejected fail-closed at every verifier; no legacy-no-suite acceptance path exists. Post-quantum migration (ML-DSA-44, ML-DSA-65, SLH-DSA-SHA2-128s — NIST FIPS 204/205) becomes a new `SuiteId` entry plus a new dispatch arm, not a wire-format break. The protocol plane is crypto-agile; the Solana settlement rail remains Ed25519-bound because Solana's native signer is Ed25519 — the architectural decoupling in `spec/settlement-v1.md §3.3` (identity signs the receipt, wallet transaction is referenced as data) lets these two planes evolve independently.

**Settlement is protocol-shaped as of 2026-04-08.** The settlement spec (`spec/settlement-v1.md`) establishes the first protocol layer where the operational test passes without any relay dependency. The foundation law lives at the receipt / verification / sovereign-floor / relay-optional / plural-rails layer — not at the wallet topology layer. The Ed25519/Solana curve coincidence (where a motebit's identity public key is natively a valid Solana address) is documented as the **default reference implementation**, not as protocol law. Multi-hop sovereign settlement is first-class under the foundation law, even though only relay-mediated multi-hop is currently wired in the runtime; three additional patterns (pay-forward, onchain escrow, hybrid) are specified as compliant alternatives. Compatible implementations (multisig treasuries at the Solana program layer, hardware-backed identity storage, separate identity/wallet keys with binding attestation, different Ed25519-native chains, post-quantum migration) are explicitly first-class citizens of the protocol, not deviations. The sovereign payment receipt format anchors receipts to onchain proofs via `task_id = "{rail}:tx:{txHash}"` and is signed by the motebit's identity key — _the wallet transaction is referenced as data, not as the signing authority_, which is the structural decoupling that lets every alternative wallet topology coexist under the same receipt format.

**Credential anchoring is protocol-shaped as of 2026-04-10.** The credential anchor spec (`spec/credential-anchor-v1.md`) extends the settlement precedent to trust proof. Payment proof was already onchain (settlement spec §6); now credential proof is too. The operational test passes: a third party can verify a credential anchor proof using only `@motebit/crypto` (`verifyCredentialAnchor`) and the relay's public key — no relay contact, no permission. Foundation law: leaf hash format (SHA-256 of canonical JSON including VC proof), Merkle batch structure (binary tree, odd-leaf promotion), batch signature payload (`{batch_id, merkle_root, leaf_count, first_issued_at, last_issued_at, relay_id}`), verification algorithm (4 steps). Convention: Solana Memo program as the reference chain anchor (Ed25519 curve coincidence reused from settlement). The chain is additive — credentials are valid without an anchor. The anchor prevents the relay from denying a credential existed.

**Revocation anchoring is protocol-shaped as of 2026-04-11.** Key revocation events (`agent_revoked`, `key_rotated`) are anchored onchain immediately via Solana Memo (`motebit:revocation:v1:{revoked_public_key_hex}:{timestamp}`). No batching — revocations are rare and urgent. Any party can verify a key was revoked by looking up the memo transaction without contacting any relay. This closes the NIST SP 800-63 revocation gap: no CA, no CRL, no OCSP — the chain is the revocation registry. Verification: `verifyRevocationAnchor` in `@motebit/crypto` (MIT). The relay is a convenience layer for real-time propagation (federation heartbeat), not the trust root for revocation truth. The chain is the trust root.

**Discovery, migration, and dispute are code-complete as of 2026-04-11.** Three protocol specs that were previously spec-only now have working implementations. Discovery (`services/api/src/discovery.ts`): `GET /.well-known/motebit.json` signed relay metadata, `GET /api/v1/discover/:motebitId` agent resolution with federation propagation, hop limits, loop prevention. Migration (`services/api/src/migration.ts`): MigrationToken issuance, DepartureAttestation, CredentialBundle export, accept-migration with signature verification and replay prevention, cancel/depart lifecycle. Dispute (`services/api/src/disputes.ts`): allocation→disputed transition, evidence submission with party validation, signed operator resolution with fund action execution (refund/release/split), appeal with one-appeal-per-dispute guard, trust-layer disputes for p2p tasks (amount_locked=0, no fund movement), admin view. CLI commands: `motebit discover [motebitId]` (relay metadata or agent resolution), `motebit migrate --destination <url>` (full 5-step lifecycle with cancel/status). Protocol types (MIT) for all three in `@motebit/protocol`.

**P2P settlement path as of 2026-04-11.** Policy-based rail selection via `evaluateSettlementEligibility` in `task-routing.ts`: both parties opt in via `settlement_modes`, worker declares `settlement_address`, trust ≥ 0.6, interaction count ≥ 5, no active disputes between pair. P2p tasks skip virtual account allocation — money moves onchain, relay records audit with `settlement_mode='p2p'`, `payment_verification_status='pending'`. Async verifier loop (`startP2pVerifierLoop` in `p2p-verifier.ts`) checks Solana RPC, transitions to verified/failed, downgrades trust on failure. Admin reporting: `GET /api/v1/admin/settlements` groups by mode. Fee: zero for p2p (explicit product policy — relay monetizes routing and credentials).

**Withdrawal hold during dispute window.** `computeDisputeWindowHold` in `accounts.ts` sums recent relay settlements (< 24h, not yet disputed). `requestWithdrawal` pre-checks available balance (balance - hold) before atomic debit. Visible in balance endpoint as `dispute_window_hold` and `available_for_withdrawal`. P2p settlements explicitly excluded (amount_settled=0, settlement_mode filter).

**The relay is a convenience layer, not a trust root.** The relay provides real-time speed: federation heartbeat for revocations, discovery for agents, routing for tasks. But every truth the relay asserts is independently verifiable onchain without relay contact. Credentials via Merkle batch anchoring (credential-anchor-v1.md §5.2). Revocations via individual memo anchoring (credential-anchor-v1.md §10). Settlements via payment receipts (settlement-v1.md §6). The chain is the permanent record. The relay is the fast path. If the relay disappears, every assertion it made survives on the chain.

## Security Boundaries

**Sybil defense (five layers).** Self-delegation must not farm trust. Layer 1: skip trust record update when delegator === worker. Layer 2: aggregation ignores self-issued credentials. Layer 3: minimum issuer trust threshold (0.05) excludes new sybil identities. Layer 4: credential revocation check excludes compromised issuers. Layer 5: reject self-issued credentials at submission endpoint. Self-delegation executes and settles budget — it just produces no trust signal.

**Memory injection defense (two layers).** Layer 1 — formation gate: `ContentSanitizer` scans candidates, injection-flagged get confidence capped to 0.3 (fast decay, not rejected outright). Layer 2 — context boundary: two canonical boundary markers, `[EXTERNAL_DATA source="..."]...[/EXTERNAL_DATA]` for tool results (emitted by `ContentSanitizer`) and `[MEMORY_DATA]...[/MEMORY_DATA]` for recalled memories (emitted by `ai-core` context packing). `stripBoundaryMarkers` escapes both marker types in external content to prevent cross-boundary impersonation. System prompt treats both boundary types identically as data, never directives.

**Receipt economic binding.** `relay_task_id` in every `ExecutionReceipt`, inside the Ed25519 signature. Relay verifies binding at settlement. Prevents cross-task replay. Required — no legacy fallback.

**Token audience binding.** `aud` is required on `SignedTokenPayload` (compile-time) and enforced by `verifySignedToken` (runtime). `expectedAudience` is required on all `verifySignedTokenForDevice` calls. Tokens without `aud` are rejected at both layers. Canonical audience values: `sync`, `task:submit`, `admin:query`, `rotate-key`, `pair`, `register-device`. Prevents cross-endpoint replay.

**Budget-gated delegation.** estimateCost → allocateBudget → settleOnReceipt. HTTP 402 if insufficient. Per-submitter task queue limit (1000/agent, HTTP 429) prevents fair-share starvation. Multi-hop: each hop settled independently from nested `delegation_receipts`.

**Rate limiting.** 5-tier fixed-window per IP (auth 30/min, read 60/min, write 30/min, public 20/min, expensive 10/min). Per-connection WebSocket (100 msg/10s). Per-peer federation (30 req/min). Task queue hard-capped at 100K.

**PBKDF2 iterations.** 600K for user-provided passphrases (CLI identity, relay key encryption). 100K for operator PIN (rate-limiting is primary defense, PIN entry is frequent).

**Signed succession.** Key rotation without centralized revocation. Old keypair signs tombstone declaring new keypair. Both keys sign canonical payload. Chains verify end-to-end. Succession records must be within 15-minute freshness window (±1 min clock skew) at the relay.

**Guardian attestation.** Organizational custody via Ed25519 guardian key. Guardian key MUST NOT equal identity key (enforced at generation and registration). Registration with `guardian_public_key` requires `guardian_attestation` — a signature by the guardian's private key over `{action:"guardian_attestation",guardian_public_key,motebit_id}`. Prevents fake organizational claims. Same guardian key = organizational trust baseline (0.35) in semiring routing — identity is necessary, not sufficient.

**Federation circuit breaker.** Per-peer forward tracking with automatic suspension at 50% failure rate over 6+ samples. Heartbeat handles liveness (3 missed → suspend, 5 → remove). Circuit breaker handles forward-path health.

**Onchain revocation registry.** Key-level revocation events (`agent_revoked`, `key_rotated`) are anchored to Solana immediately via `SolanaMemoSubmitter.submitRevocation()`. Memo format: `motebit:revocation:v1:{revoked_public_key_hex}:{timestamp}`. No batching — revocations are rare and urgent. Fire-and-forget: chain submission failure does not block the revocation itself. Federation heartbeat remains the primary propagation; the chain is the permanent fallback. `setRevocationAnchorSubmitter()` in `federation.ts` configures the submitter at relay startup. `verifyRevocationAnchor()` in `@motebit/crypto` (MIT) provides offline verification. Credential-level revocations are not individually anchored — credentials already have batch anchoring.

**Credential source boundary.** Third-party MCP server auth uses `CredentialSource` adapter (`getCredential(CredentialRequest) → string | null`), not static bearer tokens. Credentials resolve **per HTTP request** via custom `fetch` injection — not at connect time. JSON-RPC body is parsed to extract `toolName` from `tools/call` requests, enabling per-tool scoped credentials. `CredentialRequest` carries `serverUrl`, `toolName?`, `scope?`, `agentId?`. Two built-in implementations: `StaticCredentialSource` (wraps legacy `authToken`), `KeyringCredentialSource` (reads from `KeyringAdapter` at call time, default key `mcp_credential:{hostname}:{port}`). Fail-closed: thrown errors propagate per-request, null skips auth header. Motebit-to-motebit auth (`createCallerToken`) uses static `requestInit` — highest precedence, unaffected. The `CredentialSource` interface lives in `@motebit/sdk` (MIT, Layer 0) so consumers across layers bind to the contract without pulling in BSL code; implementations live in `@motebit/mcp-client` (BSL, Layer 2) and are re-exported from it for ergonomic consumption. Vault implementations belong in higher-layer adapters. The MCP client does not persist, rotate, or cache credentials.

**Server verification boundary.** Third-party MCP servers are verified via `ServerVerifier` adapter (`verify(config, tools) → VerificationResult`), run automatically during `connect()` after tool discovery. Fail-closed: `ok:false` or thrown errors disconnect. Four built-in implementations: `ManifestPinningVerifier` (fail-closed, rejects on manifest change), `AdvisoryManifestVerifier` (always accepts, revokes trust on change — used by desktop/web/mobile/spatial), `TlsCertificateVerifier` (pins server TLS cert SHA-256 fingerprint, Node-only via `node:tls` probe, separate file `tls-verifier.ts`), `CompositeServerVerifier` (chains multiple verifiers, all must pass, merges `configUpdates`). `tlsCertFingerprint` on `McpServerConfig` stores the pinned value. Cert lifecycle doctrine: (1) trust-on-first-use is acceptable only for first contact — once pinned, the pin is law; (2) unexpected cert change must never silently pass — fail-closed, always; (3) continuity of trust after rotation requires explicit operator approval, alternate cryptographic proof, or a defined grace rule — never automatic silent repin; (4) certificate rotation is an operational continuity event, not an identity reset — the server's accumulated trust survives rotation if the operator attests continuity; (5) policy must be explicit and auditable per integration — no global "trust all rotations" escape hatch. Exact repin mechanism, grace semantics, and operator UX crystallize when real production rotation forces the final shape. Proven end-to-end against GitHub's remote MCP server (`api.githubcopilot.com`). All 5 surface apps use ServerVerifier instead of manual `checkManifest()` boilerplate. The `ServerVerifier` interface lives in `@motebit/sdk` (MIT, Layer 0) — same placement rule as `CredentialSource`; implementations live in `@motebit/mcp-client` (BSL, Layer 2) and are re-exported from it.

**WebSocket post-connect auth.** Sync-engine WebSocket adapter sends auth tokens as a post-connect frame (`{ type: "auth", token }`) instead of URL query params. Relay validates and responds with `{ type: "auth_result", ok }`. Fail-closed: rejection or 5-second timeout disconnects. Legacy `?token=` query param still accepted by relay for backwards compat. Unauthenticated connections (no token configured) skip the auth frame.

**MCP server credential verification.** Inbound non-motebit auth uses `InboundCredentialVerifier` adapter (`verify(token) → boolean`), not hardcoded string comparison. The "Inbound" qualifier distinguishes it from `mcp-client`'s outbound `CredentialSource` (per-call supplier) and `ServerVerifier` (server identity check) — see `packages/sdk/src/credential-types-doc.ts` for the full credential-shaped type family. `StaticTokenVerifier` wraps legacy `authToken` for backwards compat. `credentialVerifier` takes precedence over `authToken`. Fail-closed: false or thrown error = 401. Motebit signed token path (`verifySignedToken`, `resolveCallerKey`, `onCallerVerified`) is untouched.

**Sync-engine credential source.** All 4 sync adapters (HTTP, WebSocket, PlanSync, ConversationSync) accept `credentialSource?: CredentialSource` alongside legacy `authToken`. HTTP adapters resolve per-request via async `headers()`. WebSocket resolves on each connect/reconnect. Sync-engine re-exports `CredentialSource` / `CredentialRequest` from `@motebit/sdk` (the canonical MIT home) — no cross-layer dep on mcp-client, and no duplicate interface to drift.

**Settlement rails boundary — custody split.** External money movement uses three interfaces in `@motebit/protocol` (Layer 0), split by custody as a compile-time discriminant. `SettlementRail` is the base marker (`name`, `custody`, `isAvailable`). `GuestRail extends SettlementRail` is relay-custody — the relay holds the user's money in a virtual account and the rail moves it across the membrane. `SovereignRail extends SettlementRail` is agent-custody — the agent's identity key signs and the rail is the agent's own wallet. `custody: "relay" | "agent"` is the discriminating literal.

GuestRail has three types: `fiat` (Stripe), `protocol` (x402, MPP), `orchestration` (Bridge). There is no "direct_asset" GuestRail — direct onchain transfer is always sovereign. `DepositableGuestRail extends GuestRail` adds `deposit()`; `isDepositableRail()` type-guards the narrowing. Protocol rails are pay-per-request — money moves at the HTTP boundary.

SovereignRail exposes `chain`, `asset`, `address`, `getBalance`. Reference implementation: `SolanaWalletRail` in `@motebit/wallet-solana`. Future Ed25519-native chains (Aptos, Sui) satisfy the same interface.

**Doctrine enforced at the type level.** `SettlementRailRegistry.register()` accepts only `GuestRail`. The compiler rejects attempts to register a `SovereignRail` at the relay — "relay is a convenience layer, not a trust root" stops being prose and becomes a type error. The negative proof lives in `services/api/src/__tests__/custody-boundary.test.ts` with a `@ts-expect-error` assertion; if someone widens the registry to accept any rail, that file stops compiling. The `/health/ready` rail manifest advertises only guest rails, never sovereign ones, because sovereign settlement has no mediator to advertise.

Three concrete GuestRails: `StripeSettlementRail` (fiat, depositable, Stripe Checkout + webhook), `X402SettlementRail` (protocol, non-depositable, x402 facilitator), `BridgeSettlementRail` (orchestration, non-depositable, Bridge.xyz transfers). One concrete SovereignRail: `SolanaWalletRail` (see below). `PaymentProof.railType` retains `"direct_asset"` since payment proofs span both custody boundaries — only the rail registration is split.

**SolanaWalletRail (sovereign onchain).** The reference `SovereignRail` implementation. Lives in `packages/wallet-solana` (Layer 1 adapter). Declares `custody: "agent"`, `name: "solana-wallet"`, `chain: "solana"`, `asset: "USDC"`. Solana uses Ed25519 — the same curve we already chose for sovereign identity — so the motebit's identity public key IS its Solana address by mathematical accident. No second key, no custodial provider, no vendor approval. `Keypair.fromSeed(identitySeed)` derives the wallet from the existing 32-byte Ed25519 seed; the resulting address is identical to the motebit identity public key. The rail delegates to a swappable `SolanaRpcAdapter`. Default `Web3JsRpcAdapter` wraps `@solana/web3.js` + `@solana/spl-token`: derives keypair, resolves Associated Token Accounts, auto-creates destination ATA on first send (payer = self), builds/signs/submits SPL transfers, waits for confirmation. Errors mapped to `InsufficientUsdcBalanceError` and `InvalidSolanaAddressError` for predictable handling. The agent pays its own SOL fees — sovereign means you also pay your own gas. Tests run against the `SolanaRpcAdapter` boundary with no network. This is a **runtime-side** rail (the motebit holds the keys, the relay never signs) and the compiler rejects registering it at the `SettlementRailRegistry`. The previous custodial implementation (`DirectAssetRail` + `PrivyWalletProvider`) was deleted on 2026-04-08 — relay does not sign agent transfers.

**BridgeSettlementRail.** First orchestration rail. Wraps Bridge.xyz transfer API behind `GuestRail`. `railType: "orchestration"`, `name: "bridge"`, `supportsDeposit: false`. Two withdrawal paths: (1) crypto→crypto with wallet destination — polls briefly for `payment_processed`, returns confirmed `WithdrawalResult` with `destination_tx_hash` as proof. (2) crypto→fiat or slow paths — returns pending `WithdrawalResult` with `confirmedAt: 0` and Bridge transfer ID as reference (same pattern as Stripe pending withdrawals). Completion via webhook. `BridgeClient` interface injected (glucose): `createTransfer()`, `getTransfer()`, `isReachable()`. Configurable poll attempts and interval. Lives in `services/api/src/settlement-rails/bridge-rail.ts`. Registered at relay startup when `BRIDGE_API_KEY` + `BRIDGE_CUSTOMER_ID` env vars are set. Inline `BridgeClient` implementation in index.ts wraps Bridge's REST API (`POST /transfers`, `GET /transfers/{id}`). Bridge webhook handler at `POST /api/v1/bridge/webhook` auto-completes pending withdrawals when Bridge reports `payment_processed` — looks up withdrawal by `payout_reference` (set to `bridge:{transferId}` via `linkWithdrawalTransfer` at transfer creation), signs receipt, calls `attachProof`. Env vars: `BRIDGE_API_KEY`, `BRIDGE_CUSTOMER_ID`, optional `BRIDGE_SOURCE_RAIL` (default: "base"), `BRIDGE_SOURCE_CURRENCY` (default: "usdc"), `BRIDGE_API_BASE_URL`.

**X402SettlementRail.** Wraps x402 facilitator behind `GuestRail`. `custody: "relay"`, `railType: "protocol"`, `name: "x402"`, `supportsDeposit: false`. x402 is pay-per-request: deposits happen at the HTTP boundary via x402 middleware, not the rail — the base `GuestRail` interface has no `deposit()` method, so no throwing stub needed. `withdraw()` settles via the facilitator client — constructs payment payload, calls `facilitator.settle()`, returns `WithdrawalResult` with tx hash proof. `isAvailable()` checks facilitator `/supported` endpoint. `attachProof()` records x402 tx hash + CAIP-2 network — called by the task submission handler after x402 auto-deposit succeeds, achieving sibling parity with the Stripe webhook → `stripeRail.attachProof()` flow. Constructor takes `X402FacilitatorClient` interface (satisfied by `HTTPFacilitatorClient` from `@x402/core/server`). Lives in `services/api/src/settlement-rails/x402-rail.ts`.

**Settlement proof persistence.** `attachProof()` on both rails persists proofs to `relay_settlement_proofs` table via an `onProofAttached` callback injected at construction. The relay owns storage; rails are adapters. Table schema: `(settlement_id, reference, rail_type, rail_name, network, confirmed_at, created_at)` with composite PK `(settlement_id, reference)`. `storeSettlementProof()` is idempotent (INSERT OR IGNORE). `getSettlementProofs()` queries by settlement ID. Reconciliation check #6: every completed withdrawal with a `payout_reference` must have a matching proof in `relay_settlement_proofs`.

**Withdrawal through rails.** Withdrawals flow through the rail boundary at two points. (1) Admin-complete: when admin marks a withdrawal completed, the admin-complete endpoint accepts optional `rail` and `network` fields — if provided, calls `rail.attachProof()` with the payout reference. Manual/off-rail payouts omit the field; the signed relay receipt is the audit trail. (2) Automated x402 withdrawal: when an agent requests withdrawal to a wallet address (`/^0x[0-9a-fA-F]{40}$/`) and the x402 rail is available, the relay attempts immediate settlement via `x402Rail.withdraw()`. On success, auto-completes the withdrawal with signed receipt and proof attachment. On failure, falls back to manual pending (fail-safe — funds already held by `requestWithdrawal`). This achieves full money-flow parity: deposits, proofs, and withdrawals all flow through the rail boundary.

**VaultCredentialSource.** Implements `CredentialSource` for enterprise deployments where secrets live in external vaults (HashiCorp Vault, AWS Secrets Manager, 1Password Connect). Constructor takes `VaultClient` interface (`{ get(key: string): Promise<string | null> }`) — the vault is glucose, the adapter is the enzyme. Default key format: `mcp/{serverName}`. Custom key resolver injectable. Resolves per-request, never caches. Fail-closed: vault errors propagate. Lives in `packages/mcp-client` alongside `StaticCredentialSource` and `KeyringCredentialSource`. Four built-in `CredentialSource` implementations: `StaticCredentialSource` (static token), `KeyringCredentialSource` (OS keyring), `VaultCredentialSource` (external vault), `OAuthCredentialSource` (OAuth 2.0 with token lifecycle).

**OAuthCredentialSource.** First `CredentialSource` with internal mutable state. Manages the OAuth 2.0 token lifecycle: initial acquisition via `OAuthTokenProvider.getToken()`, refresh via `refresh()`, expiry tracking, refresh-ahead (configurable buffer, default 60s). Concurrent callers share a single in-flight refresh (dedup via promise). Fail-closed: refresh errors propagate. When no refresh token is available, falls back to re-acquisition via `getToken()`. The `OAuthTokenProvider` interface is injected — GitHub OAuth, Stripe Connect, generic OIDC implement it. The source manages lifecycle only; it does not know about authorization endpoints, client IDs, or scopes. `OAuthToken` carries `accessToken`, optional `refreshToken`, and `expiresAt` (absolute ms timestamp). Lives in `packages/mcp-client` alongside siblings. First concrete provider: `GitHubOAuthTokenProvider` (`github-oauth.ts`) — wraps GitHub's `POST /login/oauth/access_token` endpoint with refresh token rotation (old token invalidated on each refresh). Converts `expires_in` to absolute `expiresAt`. Injected `fetch` for testability. Config: `clientId`, optional `clientSecret` (not required for device flow), `initialRefreshToken`. Exported from barrel.

**Credential anchoring.** Credential hashes anchored onchain via Merkle batches so agent reputation survives relay death (credential-anchor-v1.md). Full credential stays at the relay (aggregation, routing, privacy); only the SHA-256 hash goes onchain. Three-layer split: MIT `@motebit/crypto` has `computeCredentialLeaf` (leaf hash) and `verifyCredentialAnchor` (4-step self-verification). BSL relay has batch cutting (`cutCredentialBatch`, 50 creds or 1 hour), proof serving (`getCredentialAnchorProof`), and the anchor loop (`startCredentialAnchorLoop`). Chain submission via `ChainAnchorSubmitter` adapter in `@motebit/protocol`; reference implementation is `SolanaMemoSubmitter` in `@motebit/wallet-solana` (Memo program v2, relay identity key = Solana signer). Self-verification algorithm: (1) hash check — `SHA-256(canonicalJson(vc)) === proof.credential_hash`; (2) Merkle inclusion — siblings reconstruct to `merkle_root`; (3) relay attestation — `Ed25519.verify(batch_signature, canonicalJson({batch_id, merkle_root, leaf_count, first_issued_at, last_issued_at, relay_id}), relay_public_key)`; (4) optional onchain lookup via `ChainAnchorVerifier` callback. Steps 1–3 are offline-verifiable. Additive, never gatekeeping: credentials are valid with or without an anchor. Relay endpoint: `GET /api/v1/credentials/:credentialId/anchor-proof` returns `CredentialAnchorProof` (202 if pending batch). Admin endpoint: `GET /api/v1/admin/credential-anchoring` returns stats, batches, anchor address. Relay wiring: `SOLANA_RPC_URL` env var enables chain submission; without it, batches are Ed25519-signed only.

## Commands

```bash
pnpm run build          # Build all packages (turbo)
pnpm run test           # Test all packages
pnpm run typecheck      # Type-check all packages
pnpm run lint           # Lint all packages
pnpm run check-deps     # Validate layer architecture
pnpm --filter @motebit/runtime test   # Test single package
```

## CLI Market Commands

Two-sided market: any motebit can pay for tasks and earn from them.

```bash
# Pay side
motebit fund <amount>                  # Deposit via Stripe Checkout (opens browser)
motebit delegate "<prompt>"            # Discover worker, submit task, get result
  --capability <cap>                   #   Required capability (default: web_search)
  --target <id>                        #   Skip discovery, delegate to specific agent
  --budget <amount>                    #   Max spend in USD
  --plan                               #   Decompose into steps, delegate each to specialists
motebit balance                        # Show account balance + recent transactions
motebit withdraw <amount>              # Request withdrawal

# Earn side
motebit run --price 0.50               # Accept tasks at $0.50/task (daemon mode)
motebit serve --price 0.50             # Accept tasks at $0.50/task (MCP server mode)
```

**Money model.** All amounts stored as integer micro-units (1 USD = 1,000,000 units). API boundary converts: `toMicro(dollars)` on ingest, `fromMicro(micro)` on egress. Zero floating-point arithmetic in the money path.

## Conventions

- All packages export from `src/index.ts`
- Tests in `src/__tests__/` using vitest
- Error rethrows: `throw new Error("description", { cause: err })` — preserves chain
- Error messages: `err instanceof Error ? err.message : String(err)`
- Secrets in OS keyring, never config files. Config: `~/.motebit/config.json`. DB: `~/.motebit/motebit.db`
- CSS inline in HTML (desktop, admin), not separate stylesheets
- Branded ID types (`MotebitId`, `DeviceId`, etc.) enforce compile-time safety
- Relay uses `createLogger(module)` for structured JSON logs with `x-correlation-id`
- Runtime uses pluggable `logger` config (defaults to `console.warn`)
- Dependency overrides must be upper-bounded (`>=4.59.0 <5.0.0`)
- Inline trivial utilities (< 10 lines, no crypto/state/IO) at layer boundaries rather than importing cross-layer
- Event appending uses `appendWithClock()` for atomic version_clock assignment

## UI

Motebit is calm software. Do not confirm what the user can already see.

- **Silent** — modal closes, checkbox toggles, chat populates. No toast.
- **Toast** — async outcomes the user can't observe (sync, pairing). Short-lived, never stacked.
- **System message** — errors with next steps, security warnings. Rare (≤3-4/session), actionable.
- **Anti-patterns** — "Settings saved" after modal close, "Loading…" when content is visibly populating.
- **Settings vs Sovereign panel — identity vs state.** Settings shows what you _are_ (identity, device, keys, configuration). The Sovereign panel shows what you _have, owe, or are doing_ (balances, allocations, credentials, execution ledger). Balances, fund affordances, live RPC reads belong in Sovereign. Static identity fields (address as public-key shadow, motebit_id, device_id) belong in Settings. The split prevents one surface from becoming the Everything Panel. Derived rule: when adding a display field, ask "is this what I am, or what I have?" — the answer names the panel.
- **Audience-aware sequencing** — Features that serve a subset (enterprise, power users, advanced config) go at the end of the page/flow, marked as optional. The sovereign/consumer path is primary and uninterrupted. Don't weave enterprise content into the universal narrative.

## Published Packages

Five npm packages: four MIT (the open protocol), one BSL (the product):

- `@motebit/protocol` — Network protocol: types, semiring algebra, routing. MIT, 0 deps.
- `@motebit/crypto` — Protocol cryptography: sign and verify all artifacts. MIT, 0 monorepo deps (noble bundled).
- `@motebit/sdk` — Product development kit: shared types, config, normalization, adapters. MIT, depends on protocol.
- `create-motebit` — Scaffold signed identity. MIT, zero-deps CLI. `npm create motebit`, `--agent` for runnable project.
- `motebit` — Operator console. BSL-1.1. REPL, daemon, MCP server, delegation, export/verify/rotate.
