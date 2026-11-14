# Doctrine status

This file is the record of what is built, shipped, deferred or measured for each doctrine doc in [`docs/doctrine/`](../doctrine/). Doctrine states law; this file states state. Every entry is dated and cites code. Correct an entry when it goes stale; never move status back into doctrine. Sections are one per doctrine doc, in alphabetical order; a new doc gets a new `## <doc-name>.md` section in its sorted place, and its doc carries one `**Status:**` pointer line to that section.

## agency-proof-integration.md

[`agency-proof-integration.md`](../doctrine/agency-proof-integration.md)

- As of 2026-11-13: `@motebit/state-export-client`'s `verifyReceiptDocument` computes the offline `sovereign` rung through `verifySovereignBinding` (`packages/state-export-client/src/receipt-document.ts`). It formerly reported `integrity-only` offline; the gap was surfaced by `check-receipt-conformance` and closed, so receipt.computer's offline render shows `sovereign` for sovereign receipts.
- As of 2026-11-13: the token-ceiling tamper/strip/graft property is written in `spec/standing-delegation-v1.md` §3.3; `packages/crypto/src/__tests__/standing-delegation.test.ts` enforced all three vectors before the spec text existed.

## agent-archetypes.md

[`agent-archetypes.md`](../doctrine/agent-archetypes.md)

- As of 2026-11-13: the multi-hop settlement arc's Inc 1/2 has landed, and the atoms are priced in `scripts/deploy-archetype-slate.ts` (`MOTEBIT_UNIT_COST`): web-search $0.003, read-url $0.002, summarize $0, research $0.25, auditor $0.01, clerk $0.01.
- As of 2026-11-13: the service-code default listing prices do NOT all match the deploy script, which the doctrine says they do ("with service-code defaults matching"): `services/web-search/src/pricing.ts` lists $0.05 (deploy $0.003) and `services/read-url/src/pricing.ts` lists $0 (deploy $0.002). The deployed price wins because `MOTEBIT_UNIT_COST` overrides the code default.
- As of 2026-11-13: the Researcher's money seam (`MOTEBIT_SOLANA_RPC_URL` + `MOTEBIT_RELAY_PUBLIC_KEY`, read in `services/research/src/helpers.ts`) is not flipped by `scripts/deploy-archetype-slate.ts`, which sets `MOTEBIT_RELAY_PUBLIC_KEY` for task admission but no `MOTEBIT_SOLANA_RPC_URL` for research. Whether the operator set it by hand on the Fly app is (unverified).
- As of 2026-11-13: `check-money-authority` carries the assertions on `MotebitRuntime.executeGrantedDelegation`, the Clerk's deterministic spend path, and the Clerk defaults to `DRY_RUN` (`services/clerk/src/index.ts`).

## agents-as-first-person-trust-graph.md

[`agents-as-first-person-trust-graph.md`](../doctrine/agents-as-first-person-trust-graph.md)

- As of 2026-11-13: the sigil renders byte-identically on web (`apps/web/src/identity-sigil-svg.ts`, used by `apps/web/src/ui/gated-panels.ts`), desktop (`apps/desktop/src/ui/agent-sigil.ts`) and mobile (`apps/mobile/src/components/agent-sigil.tsx`, react-native-svg `SvgXml`, first shipped 2026-06-04), locked by `check-sigil-renderer-parity`. No spatial or CLI sigil renderer exists (no `deriveAgentSigil` caller in `apps/spatial/src` or `apps/cli/src`).
- As of 2026-11-13: the Ring-1 sigil params `deriveAgentSigil`, `oklchToRgb`, `shortFingerprint` and the BIP-39 `wordFingerprint` live in `packages/sdk/src/identity-sigil.ts`.
- As of 2026-11-13: the web hire is live end to end (first shipped 2026-06-05): the Discover card's priced-capability affordance in `apps/web/src/ui/gated-panels.ts` raises `onHire`, composed by `apps/web/src/ui/hire-chip.ts`. Desktop, mobile and spatial have no hire affordance (no `targetWorkerId` caller in `apps/desktop/src` or `apps/mobile/src`). Whether Known cards carry a pricing row for re-hire is (unverified).
- As of 2026-11-13: the per-peer money line (`verifiedSettlementSummaryFetch` + `AgentEconomicSummary`, first shipped 2026-06-04) is wired on web (`apps/web/src/ui/gated-panels.ts`), desktop (`apps/desktop/src/ui/agents.ts`) **and mobile** (`apps/mobile/src/components/AgentsPanel.tsx`). The doctrine's former "mobile is the contained follow-on" was stale.
- As of 2026-11-13: the petname field is `AgentTrustRecord.petname` (`packages/protocol/src/index.ts`), absent from `packages/wire-schemas/src` and `spec/`; `runtime.setAgentPetname` is called on web (`gated-panels.ts`) and desktop (`apps/desktop/src/ui/agents.ts`, `apps/desktop/src/index.ts`). Mobile has no petname editor. Petname auto-suggestion is not built.

## agility-as-role.md

[`agility-as-role.md`](../doctrine/agility-as-role.md)

- As of 2026-11-13: seven agility-as-role instances (cryptosuite, license-floor, settlement-rail, foundation-model, inference-host, model-lab, TaskShape), plus the jurisdiction admission predicate, which is not a role.
- As of 2026-11-13: `SuiteId` (`packages/protocol/src/crypto-suite.ts`) has five entries, all Ed25519: `motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`, `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`, `eddsa-jcs-2022`.
- As of 2026-11-13: the permissive floor is `Apache-2.0`, flipped from MIT in commit `2d8b91a9` (2026-04-23).
- As of 2026-11-13: settlement rails are `StripeSettlementRail`, `X402SettlementRail`, `BridgeSettlementRail` (guest, `packages/settlement-rails/src/`) and `SolanaWalletRail` (sovereign, `packages/wallet-solana/src/rail.ts`).
- As of 2026-11-13: `ByokVendor` (`packages/sdk/src/provider-mode.ts`) is `anthropic`, `openai`, `google`, `groq`, `deepseek`. DeepSeek and Groq both shipped 2026-05-13; DeepSeek is the only Chinese-hosted vendor. At the time of the doctrine text, DeepSeek was the cheapest ($0.27/M input) and Groq the fastest (~280 tok/sec, $0.59/M input) (unverified, pricing is external). Groq context recorded in doctrine: NVIDIA's December 2025 $20B non-exclusive licensing agreement with Groq (unverified, external).
- As of 2026-11-13: `InferenceHost` (`packages/protocol/src/routing.ts`) is `anthropic`, `openai`, `google`, `groq`, `local-server`. Groq is host-only and serves `llama-3.3-70b-versatile` and `openai/gpt-oss-120b` (`services/proxy/src/validation.ts` `MODEL_CONFIG`).
- As of 2026-11-13: `ModelLab` is `anthropic`, `openai`, `google`, `meta`, `mistral`, `microsoft`, `alibaba`. It has no shipping consumer: `getModelLab` in `services/proxy/src/validation.ts` has no caller outside tests.
- As of 2026-11-13: `TaskShape` is `quick`, `chat`, `reasoning`, `code`, `research`, `creative`, `math`.
- As of 2026-11-13: `check-routing-decision-coverage` registers five consumers: `motebit-cloud-proxy`, `byok-runtime-web`, `byok-runtime-desktop`, `byok-runtime-mobile`, `on-device-runtime-desktop` (rolled out as PR 1 proxy, PR 2 BYOK, PR 3 on-device).
- As of 2026-11-13: `Jurisdiction` is `"US" | "CN" | "EU"`; `MOTEBIT_CLOUD_ALLOWED_JURISDICTIONS` (`services/proxy/src/validation.ts`) is `{"US"}`. No drift gate guards the predicate.

## auto-routing-as-protocol-primitive.md

[`auto-routing-as-protocol-primitive.md`](../doctrine/auto-routing-as-protocol-primitive.md)

- As of 2026-11-13: all three consumer classes are built. PR 1 (proxy, `services/proxy/src/app/v1/messages/route.ts`); PR 2 (BYOK, primitive `4762229d` in `packages/policy/src/byok-router.ts`, web wire-up in PR 2b, desktop + mobile mirrors 2026-05-14); PR 3 (on-device, primitive `f1d3308e` in `packages/policy/src/on-device-router.ts`, desktop wire-up in PR 3b); PR 4 (chrome narration, 2026-05-14; PR 4b cloud reason surfacing 2026-05-16). `check-routing-decision-coverage` registers five consumers × three decision kinds: `motebit-cloud-proxy`, `byok-runtime-web`, `byok-runtime-desktop`, `byok-runtime-mobile`, `on-device-runtime-desktop`.
- As of 2026-11-13: `REFERENCE_ROUTING_POLICY` (`packages/policy/src/auto-router.ts`) maps `quick` → `claude-haiku-4-5-20251001`, `chat` → `claude-sonnet-4-6`, `reasoning` → `claude-opus-4-6`, `code` → `gpt-5.4`, `research` → `gemini-2.5-pro`, `creative` → `claude-sonnet-4-6`, `math` → `claude-opus-4-6`. The seven `TaskShape` values are the production set as of 2026-05-13.
- As of 2026-11-13: `MODEL_CONFIG` in `services/proxy/src/validation.ts` holds 11 production models. `ON_DEVICE_MODEL_CATALOG["local-server"]` holds 8 entries; the pure-function tests added with it numbered 11. The registry memberships are listed under [agility-as-role.md](#agility-as-rolemd).
- As of 2026-11-13: on-device routing uses `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` (`packages/policy/src/on-device-router.ts`, shipped 2026-05-14 in the post-PR-4 audit fix), so on-device turns land in `kind: "route"`. The doctrine's PR 3 validation table formerly listed `REFERENCE_ROUTING_POLICY` for on-device, which was stale; the table is corrected.
- As of 2026-11-13: only web renders the routing chip (`apps/web/src/ui/slab-chrome.ts`, `apps/web/src/web-app.ts`); desktop and mobile have no `routingNarration` / `formatRoutingChip` use. The cloud-mode reason (`X-Motebit-Routing-Reason`, read in `packages/ai-core/src/core.ts` via `onRoutingReason`) is wired on web only (`apps/web/src/providers.ts`). Hover-reveal of `decision.reason` and a chat-log routing chip are not built.
- As of 2026-11-13: no surface exposes an `autoRoute` settings toggle (`autoRoute` appears only in `apps/web/src/web-app.ts`, `apps/desktop/src/index.ts`, `apps/mobile/src/mobile-app.ts`, none in a settings UI). The intercept logic remains duplicated across those three files. Web and mobile have no on-device consumer (`dispatchOnDeviceRouting` is called only from `apps/desktop/src/index.ts`). Only web has the BYOK auto-routing integration test (`apps/web/src/__tests__/web-app.test.ts`).

## chrome-as-state-render.md

[`chrome-as-state-render.md`](../doctrine/chrome-as-state-render.md)

- As of 2026-11-13: PR 1 (web) is built; the motebit register is the default and the user register is entered (`apps/web/src/ui/slab-chrome.ts`). The de-browsered rest cell for `user × virtual_browser` (ingress line + watermark, URL bar only after a URL commits) was realized 2026-07-09.
- As of 2026-11-13: PR 2 (mobile, `apps/mobile/src/slab-chrome.ts`) and PR 3 (spatial, `apps/spatial/src/slab-chrome.ts`) shipped 2026-05-13. `check-slab-chrome-coverage` registers three surfaces (web, mobile, spatial) × four control states + five deferred embodiments (`mind`, `tool_result`, `shared_gaze`, `desktop_drive`, `peer_viewport`). Desktop is not a registered slab surface.
- As of 2026-11-13: mobile has no live cobrowse session (`apps/mobile/src/App.tsx` defaults the control state to `{kind: "motebit"}`), so its user / handoff_pending / paused × virtual_browser cells are inert at runtime.

## clearing-house-not-thin-waist.md

[`clearing-house-not-thin-waist.md`](../doctrine/clearing-house-not-thin-waist.md)

- As of 2026-11-13: the floor-law gate's second trigger (a second first-party priced capability) has fired. The non-zero code-default listing prices in `services/<name>/src/pricing.ts` are research $0.25, code-review $0.20, web-search $0.05, auditor $0.01, clerk $0.01 (read-url and summarize list $0). The gate is not built: no script compares logged `cost_estimate_usd` (written only in `services/research/src/`) to the listed price.

## commitment-bond.md

[`commitment-bond.md`](../doctrine/commitment-bond.md)

- As of 2026-11-13: phase 1 (eligibility-unlock) Inc 0–4 is built. Inc 1: `BondCommitment` (`packages/protocol/src/bond.ts`) + `signBondCommitment` / `verifyBondCommitment` (`packages/crypto/src/artifacts.ts`) + `check-bond-address-binding`. Inc 2: `getUsdcBalanceOf` (`packages/wallet-solana/src/adapter.ts`, `web3js-adapter.ts`) + `startBondVerifierLoop` (`services/relay/src/bond-verifier.ts`, started from `services/relay/src/index.ts`) + the as-of/staleness bound. Inc 3: the bonded branch in `evaluateSettlementEligibility`, accept-time re-verification, the cross-ticket defense (`workerInFlightP2pCostMicro`, `services/relay/src/bond-store.ts`, used in `services/relay/src/task-routing.ts`) + `check-bond-surface-honesty`. Inc 4: `GET`/`POST /api/v1/agents/:motebitId/bond` (`services/relay/src/agents.ts`, registered in `services/relay/src/middleware.ts`) + the decision-time re-verification adapter in the live submission gate.
- As of 2026-11-13: the recourse half (`BondCall` / `BondDefault`), the per-bond reservation ledger and the hard-guarantee fork are not built; `packages/protocol/src/bond.ts` states that the recourse artifacts are deliberately not defined.

## composition-preserves-enforcement.md

[`composition-preserves-enforcement.md`](../doctrine/composition-preserves-enforcement.md)

The bar: reintroduced `#357`, `#358`, `#359` each turn the activation-conformance pass red against the real deployable.

- As of 2026-11-13: `#357` is met at the composition root (`packages/molecule-runner/src/__tests__/money-runtime-activation.test.ts`: severing the builder's `signingKeys` line reds the positive test). The producer's caller surface is two compositions: the molecule-runner spend handle (guarded) and the CLI `delegate.ts` subcommand (wires keys from identity). The CLI `runtime-factory` runtime has no `signingKeys` and no granted-spend caller.
- As of 2026-11-13: `#358` is met at the consumed seam (Inc 3a: severing `mintedTranscript = transcript` while keeping the buffer push reds the result-seam assertion).
- As of 2026-11-13: `#359` is met at every tier. Source: `services/relay/src/__tests__/booted-entry-activation.test.ts` boots `server.ts` as a child process and runs `probeSecurityBoundaries` from outside; the static needle `check-security-default-wiring` stayed green under the same severing. Compiled artifact (Inc 4): the same test boots `node dist/server.js`; a shadow applied to `dist/server.js` only reds the compiled rung while the source rung stays green. Container image: `.github/workflows/publish-images.yml` boots the built image and runs `services/relay/scripts/probe-image.mjs` before any push; a severed image probed red.
- As of 2026-11-13: the image probe is amd64-only (the arm64 half of the multi-arch manifest is never booted) and runs on main pushes and release tags, so it is a publish gate, not a PR gate (`.github/workflows/publish-images.yml`). The `#357` / `#358` proofs run their compositions in-process.
- As of 2026-11-13: every pipeline link has a behavioral-severing pair. identity→authz: seam-reduction `mintAudienceToken` + `check-token-mint-canonical`; booted pair `services/relay/src/__tests__/booted-authz-activation.test.ts` (accept-half reproduces the f9d875b1 fix; severing proved both directions). policy→action: seam-reduction in `PolicyGate.validate` steps 8b/8c + `check-money-authority`; composition-root negatives (revoked, out-of-scope, ceiling-tampered grant) and the wallet-gate positive (`sendUsdcBatch` fires only under authority, via the `walletOverride` seam on `defaultCreateMoneyRuntime`) in `money-runtime-activation.test.ts`; booted rung not reachable (different artifact). action→receipt: `services/relay/src/__tests__/booted-receipt-activation.test.ts` (forgery-half flips to 200 when verification is severed). receipt→settlement: `services/relay/src/__tests__/booted-settlement-activation.test.ts` for the P2P lane (fee recording and `TASK_P2P_FEE_ADDRESS_MISMATCH`). settlement→trust: `services/relay/src/__tests__/booted-trust-activation.test.ts` (accrual-half and self-dealing-half).
- As of 2026-11-13: not booted-reachable, kept in-process: the relay-custody `settlementFunded = grossAmount === 0 || allocationClaimed` gate in `services/relay/src/tasks.ts` (funding a virtual account has no HTTP route since `/deposit` was removed), and the P2P verifier's failure path (`markFailed` in `services/relay/src/p2p-verifier.ts`, covered by `p2p-verifier-downgrade.test.ts` and `p2p-payee-959.test.ts`; #959 removed `downgradeP2pTrust`).
- As of 2026-11-13: the relay-custody split threads the injected `platformFeeRate` at both `settleOnReceipt` call sites (main settlement and multi-hop sub-hop) in `services/relay/src/tasks.ts`, guarded by an in-process 10%-rate readback test. Found by the receipt→settlement scouting and fixed with its guard.
- As of 2026-11-13: the whole-pipeline single-flow rung for the relay span is built (`services/relay/src/__tests__/booted-pipeline-activation.test.ts`: one worker-authenticated receipt traverses authz → receipt → settlement → trust; three severings collapse the flow at each link). The two-artifact bridge is built (`services/relay/src/__tests__/booted-bridge-activation.test.ts`: the real `defaultCreateMoneyRuntime` in-process submits over HTTP to the booted relay, which dispatches to a fake worker MCP endpoint). The runtime side is driven in-process; there is no standalone runtime `server.js` entry.
- As of 2026-11-13: `check-activation-effective` probes `booted-receipt-activation`, `booted-settlement-activation`, `booted-trust-activation`, `booted-pipeline-activation`, `booted-federation-authority-activation`, and exempts (with reasons) `booted-entry-activation`, `booted-authz-activation`, `booted-bridge-activation` (`scripts/check-activation-effective.ts` `PROBES` / `EXEMPT`). It runs as the `activation-effectiveness` CI job (`.github/workflows/ci.yml`).
- As of 2026-11-13: the embedded-key heal hijack in `handleReceiptIngestion` is closed: the heal is bound to a registered device of `receipt.motebit_id`, else the receipt fails closed (`services/relay/src/__tests__/receipt-key-hijack.test.ts`). The naive `receipt.motebit_id === task.motebit_id` binding was rejected because routed delegation separates target from executor.
- As of 2026-11-13: the named deferrals are open. `check-money-authority` has no revocation-threading needle (`revocations ?? []` remains at `packages/runtime/src/motebit-runtime.ts`); the relay `agent_trust` key is unchanged; no gate covers the market-candidates two-site desync (`check-agent-route-auth` covers `/api/v1/agents/:id/*` middleware ordering, a different class; the doctrine formerly cited it by the wrong file, `check-admin-route-auth.ts`).

## coverage-graduation.md

[`coverage-graduation.md`](../doctrine/coverage-graduation.md)

- As of 2026-11-13: `coverage-graduation.json` carries six entries, added by the money/identity coverage slate: `@motebit/core-identity` and `@motebit/crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn` (all graduated 2026-08-13) and `@motebit/verify` (graduated 2026-10-31). Each is retained as a closed record whose `rationale` begins `GRADUATED`, although the doctrine's rule is to remove an entry once all targets are met.
- As of 2026-11-13: `check-gates-effective` injects a synthetic past-date entry to prove `check-coverage-graduation` fires (`scripts/check-gates-effective.ts`).
- As of 2026-11-13: `@motebit/wallet-solana` graduated earlier: 42/86/58/42 at the 2026-04-16 baseline, raised in three passes (memo-submitter → rail.ts → jupiter.ts) to 97/96/100/97 by 2026-04-20, then removed from the manifest ahead of its 2026-06-01 date (`packages/wallet-solana/vitest.config.ts`).

## creature-canon.md

[`creature-canon.md`](../doctrine/creature-canon.md)

- As of 2026-11-13: the dark-environment acceptance criterion passed on 2026-07-07. `ENV_DARK` (`packages/render-engine/src/creature.ts`) was redesigned in place as the designed night (moon key panel, moonlit horizon band, cool fill), and its golden frames `front-resting-dark` and `front-thinking-dark` (`apps/web/e2e/golden/golden-matrix.ts`, committed under `apps/web/e2e/golden/__screenshots__/`) show the face, catch-lights, material character and interior glow. The original near-black `ENV_DARK` proved the criterion: the body read dead in it.
- As of 2026-11-13: the web environment follows the UI theme (`apps/web/src/main.ts`, `apps/web/src/web-app.ts`); mobile switches via settings (`apps/mobile/src/creature-webview.ts`).
- As of 2026-11-13: both proof layers exist: the golden-frame harness (`apps/web/e2e/golden/golden.spec.ts`, CI e2e job) and `check-creature-canon`, which is invariant #138 in `docs/drift-defenses.md` (added 2026-07-07 with the creature-endgame arc).

## daemon-desktop-unification.md

[`daemon-desktop-unification.md`](../doctrine/daemon-desktop-unification.md)

- As of 2026-11-13: increments 1–6 are built. Increment 1: `packages/runtime-host/src/` (election, lockfile, protocol, server, client). Increment 2 (CLI) and 3 (desktop) shipped 2026-06-11; increments 4, 5 and 6 shipped 2026-06-12, along with `motebit serve` attach mode (which closed increment 2's residual) and the bridged-organs-as-tools consumer step (`packages/runtime-host/src/bridged-tools.ts`).
- As of 2026-11-13: the runtime-host protocol is version 2 (`RUNTIME_HOST_PROTOCOL_VERSION` in `packages/runtime-host/src/protocol.ts`), bumped for increment 6's `query` / `act` frames.
- As of 2026-11-13: `check-runtime-host-election` registers `apps/cli/src/subcommands/delegate.ts` as `elected`; it was registered exempt at gate-landing and flipped to elected on 2026-06-12 (`scripts/check-runtime-host-election.ts`).
- As of 2026-11-13: an interim honesty layer (attached panels showing "the interior lives in the coordinator (pid named)", data exports marked `partial_export`) shipped 2026-06-12 and was superseded the same day by increment 6's live parity; the Settings runtime-host row and `runtimeHostStatus()` remain.
- As of 2026-11-13: Windows named-pipe transport is not built in the desktop's Rust pipe (`apps/desktop/src-tauri/src/runtime_host.rs`: non-unix stubs, "a recorded residual"); the node platform supports named pipes (`packages/runtime-host/src/node-platform.ts`). Full single-writer storage is not built.

## delegation.md

[`delegation.md`](../doctrine/delegation.md)

- As of 2026-11-13: `spec/delegation-v1.md` is **Draft** (its header `**Status:** Draft`). When it graduates to Stable, record it here.
- As of 2026-11-13: whether the public tagline has swapped "permissions" → "delegation" is (unverified); `README.md` describes delegation but carries no "identity, trust, delegation, receipts, and settlement" tagline. `packages/policy/CLAUDE.md` does not exist, so the planned policy-to-delegation discoverability paragraph is not written.

## deprecation-lifecycle.md

[`deprecation-lifecycle.md`](../doctrine/deprecation-lifecycle.md)

- As of 2026-11-13: 13 workspace packages carry a non-`0.0.0-private` version: `@motebit/crypto`, `@motebit/crypto-android-keystore`, `@motebit/crypto-appattest`, `@motebit/crypto-openpgp`, `@motebit/crypto-tpm`, `@motebit/crypto-webauthn`, `@motebit/protocol`, `@motebit/sdk`, `@motebit/state-export-client`, `@motebit/verifier`, `@motebit/verify`, `create-motebit`, `motebit` (root `CLAUDE.md` counts 12 published to npm). 62 packages carry `0.0.0-private`. The doctrine's former published list named `@motebit/wire-schemas`, which is `0.0.0-private`; that was false.
- As of 2026-11-13: the 2026-04-23 classification pass is complete. None of the markers it listed survive: `LegacyVerifyResult` + `verifyIdentityFile` were removed in the `@motebit/crypto` 3.0.0 major (2026-06-06) after a zero-holder check, and no `@deprecated` remains in `packages/ai-core/src`, `packages/market/src`, `packages/mcp-client/src` or `apps/cli/src/args.ts`. `@deprecated` annotations remain only in `packages/wallet-solana/src/operator-treasury-reconciler.ts`, `packages/sdk/src/models.ts`, `packages/crypto-tpm/src/tpm-roots.ts`, `apps/web/src/storage.ts` and `apps/cli/src/config.ts`.
- As of 2026-11-13: `MotebitRuntime.housekeeping()` and `runHousekeeping()`, the doctrine's case-3 example, no longer exist in `packages/runtime/src` (only a comment in `packages/runtime/src/consolidation-cycle.ts` names `runHousekeeping`).
- As of 2026-11-13: `check-deprecation-discipline` (invariant #39) landed 2026-04-24; `check-private-deprecation-shape` (invariant #59) landed 2026-04-28.

## dissolution-spectrum.md

[`dissolution-spectrum.md`](../doctrine/dissolution-spectrum.md)

- As of 2026-11-13: only the CLI supplies an `auditChainStore` (`apps/cli/src/runtime-factory.ts`), so only the CLI's PolicyGate audit is hash-chained through `ChainedAuditSink` (`packages/runtime/src/motebit-runtime.ts`); desktop, mobile and web write an unchained storage-backed sink. The doctrine's former "PolicyGate doesn't write to `AuditChainStore`" was stale given the CLI wiring.

## evals-as-attestations.md

[`evals-as-attestations.md`](../doctrine/evals-as-attestations.md)

- As of 2026-11-13: the promotion trigger fired 2026-07-08 (trigger #1, with #2: the fee-bearing Auditor) and the primitive is built: `EvalAttestation` + `EvalKind` in `packages/protocol/src/eval-attestation.ts`, gated by `check-eval-kind-canonical`. `ALL_EVAL_KINDS` has a single member, `verification_audit`.
- As of 2026-11-13: the `@motebit/evals` runner is not built (no `packages/evals`); the Auditor is consumer #1 of the wire shape.
- As of 2026-11-13: the testing discipline is in place: the virtual-accounts property suite (commit `08aea3db`); `properties.test.ts` in `packages/crypto-appattest`, `crypto-android-keystore`, `crypto-tpm`, `crypto-webauthn`; `packages/skills/src/__tests__/parse-properties.test.ts`; the cross-model behavioral equivalence suite in `@motebit/runtime` (commit `57091d2f`). Real-fixture capture for a hardware-attestation platform is (unverified).

## evidence-provenance.md

[`evidence-provenance.md`](../doctrine/evidence-provenance.md)

- As of 2026-11-13: `DigestAlgorithm` has one member, `sha-256` (`packages/protocol/src/evidence-provenance.ts`).
- As of 2026-11-13: built: the `EvidenceProvenance` / `EvidenceRef` vocabulary in `@motebit/protocol` (graduated from `@motebit/crypto`'s free `{kind,ref}`); `verifyEvidenceProvenance` with the injected projection seam in `@motebit/crypto` and its hostile corpus (`packages/crypto/src/__tests__/evidence-provenance.test.ts`); the law re-exported through `@motebit/verifier`; the wire spec `spec/evidence-provenance-v1.md` (`motebit/evidence-provenance@1.0`) with a zod schema and committed `spec/schemas/evidence-provenance-v1.json`; the `projectionClass` field (`ALL_PROJECTION_CLASSES` + `isProjectionClass`) in protocol, schema and spec §7.1 / §7-tool.
- As of 2026-11-13: agency.computer publishes `agency.html-text.v1` as a world-public spec (`github.com/agency-computer/html-text-spec` @ `01b475be`; reachability recorded as verified in 2026-06, not re-checked here: no network) (unverified). `packages/crypto/src/__tests__/evidence-provenance-conformance.test.ts` reproduces its 7 vectors byte-for-byte from the spec alone, including the single-pass-decode canary.
- As of 2026-11-13: agency.computer is a live producer (research + monitor engine populating `EvidenceProvenance` on signed briefs, proven end-to-end on a Fed/BLS release in 2026-06) (unverified: external system).
- As of 2026-11-13: motebit is a producer: `read_url` attests `source_digest` (+ `source_projection` on the HTML recipe path) into the signed `ExecutionReceipt`, and the research engine copies it into `Citation.provenance`; `projectAgencyHtmlTextV1` lives in `packages/tools/src/builtins/read-url.ts`.
- As of 2026-11-13: no `tool-pinned` recipe exists in-tree. The cross-language corpus (`spec/conformance/evidence-provenance/corpus.json`, six vectors) runs in CI with `REQUIRE_PYTHON=1` (`.github/workflows/ci.yml`).

## exploration-as-market-vitality.md

[`exploration-as-market-vitality.md`](../doctrine/exploration-as-market-vitality.md)

- As of 2026-11-13: Inc 0–4 are built. Inc 1: `packages/semiring/src/thompson.ts` + explore mode in `packages/semiring/src/worker-selection.ts`. Inc 2: `RankableWorker.bonded` + `BOND_EXPLORE_BOOST` (= 2, capped at strength 1). Inc 3: the runtime `WorkerSelector` passes `explore: { seed, strength }` on every unpinned delegation, seeded from the tick token's signature, with `explorationStrengthForStakes` (`packages/runtime/src/motebit-runtime.ts`). Inc 4: `packages/semiring/src/__tests__/worker-selection-simulation.test.ts`.
- As of 2026-11-13: bond-live-wiring is built (Inc 1 of the routing-decision-transcript arc): the relay's discover response carries `bonded: true` via `enrichWithBondStatus` (`services/relay/src/agents.ts`), so the sybil-swarm bound applies on real hops.
- As of 2026-11-13: capability-scoped posteriors are built (`AgentTrustRecord.capability_stats`, `packages/protocol/src/index.ts`). The signed routing-decision transcript arc is open; its trigger fired (the archetype probe is consumer #1), and `RoutingDecisionTranscript` is minted in `packages/runtime/src/relay-delegation.ts` / `motebit-runtime.ts`.
- Measured 2026-09-15: the staging Researcher was unpinned with a second `web_search` provider; over five paid runs the Unknown newcomer was never hired. Pinned in `packages/semiring/src/__tests__/onramp-probability.test.ts` (2000 seeded draws per cell, micro stakes ⇒ strength 1): against a Trusted incumbent with a 60/2 record the newcomer out-draws it in 4.7% of draws; against 50/0, 1.7%; against 50/10, 18%. Zero hires in five draws is therefore the expected outcome (≈77%); at three `web_search` hires per scheduled day the first hire lands within a week with ≈65% probability and within two with ≈88%.

## felt-accumulation.md

[`felt-accumulation.md`](../doctrine/felt-accumulation.md)

- As of 2026-11-13: built: `AccrualBasis` / `AccrualKind` in `@motebit/protocol` (Inc 1); production in the memory-graph accrual source (`recalledMemoryBasis`, `packages/memory-graph/src/accrual.ts`) threaded onto the turn result (Inc 2); render on all four surfaces: in-flow attribution on web (`apps/web/src/ui/chat.ts`), desktop (`apps/desktop/src/ui/chat.ts`), mobile (`apps/mobile/src/use-chat-stream.ts`), and the satellite orbit on spatial (`packages/render-engine/src/accrual-satellites.ts`, `apps/spatial/src/spatial-app.ts`) (Inc 3); `check-accrual-basis-canonical` (Inc 5). The felt-interior `Felt*` records are shipped across surfaces.
- As of 2026-11-13: `recalled_memory` and `consolidated_fact` are produced. `standing_delegation` is not yet produced (it is the next increment). `trust_edge` and `prior_approval_pattern` have no real decision to attach to: trust is display-only plus an inbound approval-band nudge (no outbound trust-gated skip), and every approval is asked fresh (no pattern memory).

## felt-interior.md

[`felt-interior.md`](../doctrine/felt-interior.md)

- As of 2026-11-13: the act-side felt signal (the `tending` cue via `renderFrame`) is shipped ([proactive-interior.md](../doctrine/proactive-interior.md)).
- As of 2026-11-13: the felt consolidation record (`resolveFeltConsolidation`) renders on desktop (`apps/desktop/src/ui/memory.ts`), web (`apps/web/src/ui/gated-panels.ts`) and mobile (`apps/mobile/src/components/MemoryPanel.tsx`); desktop and web shipped first. Spatial has no felt consolidation record yet. `resolveFeltMemory` and `resolveFeltTrust` are consumed on the same three flat surfaces (`apps/desktop/src/ui/agents.ts`, `apps/mobile/src/components/AgentsPanel.tsx`).
- As of 2026-11-13: succession-chain verification of felt consolidation records is not built (verification is current-key only).

## first-person-worker-routing.md

[`first-person-worker-routing.md`](../doctrine/first-person-worker-routing.md)

- As of 2026-11-13: a ranked hire mints a signed `RoutingDecisionTranscript` (`signRoutingTranscript` in `packages/runtime/src/motebit-runtime.ts`), so the deferred "why" is surfaced. `paid-failure-recourse.md`'s `paid_failure_penalty` closed 2026-09-15.
- As of 2026-11-13: the production Researcher pins its atoms. `scripts/deploy-archetype-slate.ts` sets `MOTEBIT_WEB_SEARCH_TARGET_ID` / `MOTEBIT_READ_URL_TARGET_ID` for research on every target whenever the atoms are discovered, so a slate redeploy re-pins staging too. Whether staging is unpinned now (it was unpinned by hand with `fly secrets unset` on 2026-09-15) is (unverified).
- As of 2026-11-13: the staging second provider is prepared: `services/web-search/fly.staging-b.toml` (`motebit-web-search-b-stg`, own volume ⇒ own identity, no Brave key ⇒ DuckDuckGo). Procedure recorded 2026-09-15: create app + volume, set `MOTEBIT_SYNC_URL` / `MOTEBIT_UNIT_COST=0.003` / `MOTEBIT_SETTLEMENT_MODES=relay,p2p` / `MOTEBIT_PUBLIC_URL` / `MOTEBIT_RELAY_PUBLIC_KEY`, deploy with that config, `fly secrets unset MOTEBIT_WEB_SEARCH_TARGET_ID -a motebit-research-stg`, run the paid conformance workflow (`target=staging`); the proof is `routing_transcripts` on the Researcher's result.
- Measured 2026-09-15 (B atom live, staging Researcher unpinned, five paid conformance runs): 14 ranked hires, 14/14 routing transcripts verified on both rungs, every sub-hop paid P2P. `web_search` (2 candidates): incumbent A won 5/5, `explored: false` every time; the cold newcomer B received no task. `read_url` (3 candidates): incumbent A won 6, the dedicated read-url atom 3, all 3 of those `explored: true`. The newcomer's per-draw win probability against that incumbent is 4.7% (see [exploration-as-market-vitality.md](#exploration-as-market-vitalitymd)), so zero hires in five draws was the expected outcome. The latent trust-blind, non-deterministic selection defect is closed the moment a second provider registers.

## gate-repair-instructions.md

[`gate-repair-instructions.md`](../doctrine/gate-repair-instructions.md)

- Measured 2026-09-02 by `scripts/measure-gate-aperture.ts`: 107 of 137 passing gates stated their aperture (78%). The named cluster worth fixing was the seven `check-*-primitives` gates, which reported their allowlist size but not how much source they scanned. Not re-measured for this entry; there are now ten `scripts/check-*-primitives.ts` files (unverified whether they disclose).

## goal-results.md

[`goal-results.md`](../doctrine/goal-results.md)

- As of 2026-11-13: all three phases are built. Commitment and receipt categories render on the flat surfaces. Phase 2 keeps the full content as `last_response_full` beside the 160-char preview (`ScheduledGoal` in `@motebit/panels`, persisted by the web, desktop and mobile goal schedulers). Phase 3 shipped 2026-05-14 across runtime + panels + web + desktop (commits `6522d6bc`, `44e942c4`, `8aef52a8` + the manifest-signing close); `projectSlabForTurn` and `signGoalArtifact` live in `packages/runtime/src/motebit-runtime.ts`.
- As of 2026-11-13: the receipt-summary row shipped 2026-05-14 on web, desktop and mobile. It closed a Phase-3 assumption error: the doctrine had assumed web showed a "Signed" indicator, but web only persisted the manifest in localStorage. Desktop (`tauri-migrations` v4) and mobile (`expo-sqlite-migrations` v24) added `goal_outcomes.signed_manifest`.
- As of 2026-11-13: the CLI daemon signs and keeps the whole result (`apps/cli/src/scheduler.ts` calls `signGoalArtifact`; shared-schema migration #47 adds `response_full` + `signed_manifest`, `packages/persistence/src/migrations-registry.ts`), corrected 2026-09-16 after the daemon had been left out of "all surfaces". `check-goal-artifact-signing` registers four surfaces: web, desktop, mobile, cli daemon. `GOAL_RESULT_ARTIFACT` therefore has four signing consumers.
- As of 2026-11-13: mobile has no slab handoff, and mobile's adapter projection carries no `last_turn_id` (no match in `apps/mobile/src`). Plan-mode goals still produce N inner slab items.

## hardware-attestation.md

[`hardware-attestation.md`](../doctrine/hardware-attestation.md)

- As of 2026-11-13: the desktop identity key lives in an owner-only plaintext file (`~/.motebit/dev-keyring.json`); moving it to the OS keychain is the pending arc [#764](https://github.com/motebit/motebit/issues/764).
- As of 2026-11-13: the hardware claim is embedded in the self-signed `AgentTrustCredential`; peer-issued `TrustCredential`s carrying it are not yet produced (unverified).
- As of 2026-11-13: hardware platform coverage: Apple Secure Enclave (desktop macOS + iOS Secure Enclave receipt), Apple App Attest (iOS, Apple-CA-signed chain), Android Hardware-Backed Keystore Attestation (`crypto-android-keystore`), TPM 2.0 (Windows / Linux, verification only), W3C WebAuthn (browsers, FIDO-vendor batch root). No surface mints a TPM claim: `apps/desktop/src-tauri/src/tpm.rs` returns `not_supported` on every platform because `tss-esapi` is not in `apps/desktop/src-tauri/Cargo.toml`.
- As of 2026-11-13: the TPM verifier has synthetic test coverage only (`packages/crypto-tpm/src/__tests__/`); no real EK-backed fixture is committed.
- As of 2026-11-13: the live consumers (every path below exists on disk except `packages/crypto-play-integrity/`, removed 2026-05-03):
  - `packages/crypto/src/hardware-attestation.ts` — verifier, pure permissive-floor (Apache-2.0) algebra.
  - `packages/crypto/src/index.ts` — `verify()` dispatcher lifts `hardware_attestation` onto `CredentialVerifyResult`.
  - `packages/semiring/src/hardware-attestation.ts` — `HardwareAttestationSemiring` + `scoreAttestation`.
  - `packages/market/src/graph-routing.ts` — `HARDWARE_ATTESTATION_BOOST` applied to the trust edge during agent ranking.
  - `packages/market/src/scoring.ts` — `CandidateProfile.hardware_attestation?` field.
  - `packages/encryption/src/hardware-attestation-credential.ts` — canonical VC composer; CLI + desktop + mobile + web all delegate.
  - `packages/crypto-appattest/` — Apple App Attest chain verifier (pinned Apple root).
  - `packages/crypto-android-keystore/` — Android Hardware-Backed Keystore Attestation verifier (pinned Google attestation roots — RSA + ECDSA P-384). The canonical sovereign-verifiable Android primitive.
  - `packages/crypto-play-integrity/` — REMOVED 2026-05-03. Was a Google Play Integrity JWT verifier (pinned Google JWKS, ES256 / RS256 dispatch). Structurally miscategorized as a sovereign-verifiable leaf — Google publishes no global JWKS; replaced by `crypto-android-keystore`. Final published artifact is `@motebit/crypto-play-integrity@1.1.3` on npm with a registry-level deprecation; the source tree is gone.
  - `packages/crypto-tpm/src/verify.ts` — TPM 2.0 quote verifier; pinned vendor roots (Infineon, Nuvoton, STMicro, Intel PTT).
  - `packages/crypto-tpm/src/tpm-parse.ts` — minimal `TPMS_ATTEST` marshaling; hand-rolled over dep explosion.
  - `packages/crypto-webauthn/src/verify.ts` — browser-platform-authenticator packed-attestation verifier; pinned FIDO roots (Apple, Yubico, Microsoft) + self-attestation path.
  - `apps/mobile/modules/expo-app-attest/` — iOS native App Attest bridge.
  - `apps/mobile/modules/expo-android-keystore/` — Android native Hardware-Backed Keystore Attestation bridge.
  - `apps/mobile/src/mint-hardware-credential.ts` — mobile surface; per-OS cascade (App Attest → SE on iOS; Android Keystore on Android; software sentinel everywhere).
  - `apps/web/src/mint-hardware-credential.ts` — Web surface; cascades WebAuthn → software via `navigator.credentials.create`.
  - `apps/desktop/src-tauri/src/secure_enclave.rs` — Rust SE bridge (macOS-gated).
  - `apps/desktop/src-tauri/src/tpm.rs` — Rust TPM bridge (Windows / Linux; `not_supported` pending `tss-esapi` link).
  - `apps/desktop/src/secure-enclave-bridge.ts` — typed TS wrapper with `SecureEnclaveError` taxonomy.
  - `apps/desktop/src/secure-enclave-attest.ts` — high-level `mintAttestationClaim` with software fallback.
  - `apps/desktop/src/tpm-bridge.ts` — typed TS wrapper with `TpmError` taxonomy mirroring SE shape.
  - `apps/desktop/src/tpm-attest.ts` — high-level `mintTpmAttestationClaim`; returns `null` to defer to the cascade.
  - `apps/desktop/src/mint-hardware-credential.ts` — `mintHardwareCredential` — desktop surface; cascade SE → TPM → software.
  - `apps/cli/src/subcommands/attest.ts` — `motebit attest` — software-claim surface.
  - `apps/cli/src/subcommands/doctor.ts` — `detectSecureEnclaveAvailability()` diagnostic.
  - `packages/verifier/src/lib.ts` — `formatHuman` surfaces `hardware: <platform> ✓/✗`.

## identity-binding-verification.md

[`identity-binding-verification.md`](../doctrine/identity-binding-verification.md)

- As of 2026-11-13: the integrity-only floor, the pinned rung and the anchored rung are built end-to-end: `services/relay/src/identity-log.ts`, `identity-log-anchoring.ts`, `GET /api/v1/identity/:motebitId`, `verifyIdentityBindingAnchored` (`@motebit/crypto`), `lookupIdentityLogAnchor` and `verifyReceiptDocument` (`packages/state-export-client/src/receipt-document.ts`). receipt.computer surfaces all four rungs; its anchored path depends on the production relay being deployed.
- As of 2026-11-13: the motebit relay does not produce recovery links. Guardian recovery is suspended (P0 containment, 2026-10-13; `GUARDIAN_RECOVERY_ENABLED = false` in `services/relay/src/guardian-recovery-containment.ts`), so every succession with `recovery` set is refused 503 at both relay doors. The relay path stays off until the permanent guardian-provenance fix passes review.
- As of 2026-11-13: the rotated-after-anchor edge remains open; it shrinks as more identities are sovereign-minted.
- As of 2026-11-13: sovereign minting is the default since commit `cd697f4e` (the verifier and commitment primitive shipped first as opt-in). `create-motebit` (`packages/create-motebit/src/generate.ts`) and `core-identity`'s first-launch bootstrap derive `motebit_id` via `deriveSovereignMotebitId`; seed-only restore re-derives it on web, desktop and mobile.
- As of 2026-11-13: anchored-but-not-sovereign workers are not a settlement-eligibility tier (`evaluateSettlementEligibility` in `services/relay/src/task-routing.ts` checks only the sovereign binding offline).

## identity-restore.md

[`identity-restore.md`](../doctrine/identity-restore.md)

- As of 2026-11-13: restore shipped 2026-05-15 on web, desktop and mobile, together with the keystore-probe re-exposure (`BootstrapResult.divergedFromMotebitId` in `packages/core-identity/src/index.ts`; per-surface divergence banner / Alert), the `preserveMemories=true` re-key migration (`packages/browser-persistence/src/migrate-motebit-id.ts`, `migrateMotebitIdSql` in `apps/desktop/src/tauri-storage.ts`, `migrateMotebitIdExpo` in `apps/mobile/src/adapters/expo-sqlite.ts`) and born-date fidelity (`writeRestoredIdentity` in `packages/core-identity/src/index.ts`).
- As of 2026-11-13: `validateRestoreRequest` no longer returns `preserve_not_implemented` (`packages/identity-file/src/index.ts`); the reason remains in the union.
- As of 2026-11-13: the restore preview shows the derived Solana address only, no live balance. Coexisting identities (an identity-list UI) are not built.

## identity-universal-boundary.md

[`identity-universal-boundary.md`](../doctrine/identity-universal-boundary.md)

- As of 2026-11-13 (carried from the doctrine's boundary table, not re-verified per boundary): agent ↔ relay, agent ↔ agent (onchain-proven), agent ↔ user and agent ↔ wallet/rail are shipped; agent ↔ website (Web Bot Auth) and agent ↔ enterprise (IAM / VC presentation) are not built.
- Snapshot, 2026-06 (external, will age) (unverified: no network): an IETF working group is standardizing Web Bot Auth (`draft-meunier-web-bot-auth-architecture`), authored out of Cloudflare + Google, with Amazon/Akamai/OpenAI participating and OpenAI already signing Operator requests; a BCP was targeted ~Aug 2026.

## intelligence-pluggability-contract.md

[`intelligence-pluggability-contract.md`](../doctrine/intelligence-pluggability-contract.md)

- As of 2026-11-13: commitment 1 (pre-flight admission) is not built. `ContextWindowTooSmallError` does not exist in the code, and no surface measures the assembled prompt before invoking a provider. The field the gate would read, `ProviderCapability.contextWindowTokens` (`packages/protocol/src/routing.ts`), is optional and set by no producer. The mitigation for the witnessed failure: the web WebLLM engine is initialized with a 16,384-token window (`WEBLLM_CONTEXT_WINDOW_TOKENS`, `apps/web/src/providers.ts`). An over-long prompt still reaches the provider and fails with the provider's own error. In the worked example, only step 1 (the raised window) is built; steps 2–4 are not.
- As of 2026-11-13: commitment 2 (model-aware prompt assembly) is partly built. `buildSystemPrompt` takes an optional `model` and, below the frontier tier (`modelCapabilityTier`), adds the `TIER_ADAPTED_VOICE` block (`packages/ai-core/src/prompt.ts`). `historyTokenBudget` (`packages/sdk/src/models.ts`) chooses the history budget per model: 64,000 tokens (`LARGE_WINDOW_HISTORY_TOKENS`) for anthropic / openai / google, 8,000 (`DEFAULT_HISTORY_TOKENS`) otherwise. Not built: the system prompt and tool schemas are not budgeted against the model's window; `trimConversation` reserves only `reserveForResponse`; doctrine blocks and tool schemas do not compress. The only control on prompt size is the static `SYSTEM_PROMPT_BUDGET_BYTES` ceiling in `packages/ai-core/src/prompt.ts`, enforced by `check-prompt-budget` (#103).
- As of 2026-11-13: `PERCEPTION_DOCTRINE` was ~2,750 tokens when commitment 3 was written (unverified: not re-measured).

## liquescentia-as-substrate.md

[`liquescentia-as-substrate.md`](../doctrine/liquescentia-as-substrate.md)

- As of 2026-11-13: `WebXRThreeJSAdapter` (`packages/render-engine/src/adapter.ts`) uses `ENV_LIGHT` unconditionally; XR light estimation (`requestLightProbe` / `getEstimatedLight`) is not wired. The renderer is `WebGLRenderer`; no `WebGPURenderer` is used in `packages/render-engine/src`.
- Snapshot recorded in the doctrine (external, unverified: no network): Apple shipped WebGPU in Safari 26 (June 2025) on visionOS / iOS 26 / iPadOS 26 / macOS Tahoe; with Chrome (since 2023), Edge and Firefox (2025), by-default WebGPU availability was ~70% globally, leaving a ~15% long tail on WebGL.

## machine-roster.md

[`machine-roster.md`](../doctrine/machine-roster.md)

- As of 2026-11-13: increment 1 is built: `HostEnrollment` / `HostRetirement` (`packages/protocol/src/host-roster.ts`), sign/verify and `verifyHostRoster` (`packages/crypto/src/host-roster.ts`, `roster-key-chain.ts`), wire schemas (`packages/wire-schemas/src/host-roster.ts`), `spec/machine-roster-v1.md`, and the relay store and routes (`services/relay/src/host-roster-routes.ts`). The client surfaces are built too (part C): the surface-kit controller (`packages/surface-kit/src/machine-roster-*.ts`), the CLI `motebit machines` / `machines retire` (`apps/cli/src/subcommands/machines.ts`, `apps/cli/src/machine-roster.ts`), daemon enrol-on-announce (`apps/cli/src/daemon.ts`), and the mobile Machines section (`apps/mobile/src/components/settings/MachinesSection.tsx`). The root `CLAUDE.md` index line ("NOT built: surfaces (part C)") is stale.
- As of 2026-11-13: increment 2 (#691) is half merged. The delivery half is built (`sendToOne` swaps a verified pick for the newest open verified socket, `services/relay/src/command-route.ts`); the heartbeat is not, and the relay says "no heartbeat yet" (`services/relay/src/host-roster-routes.ts`, `services/relay/src/ws-send.ts`), so a half-open socket still reads as open.
- As of 2026-11-13: increments 3 (`halt-status` over the roster, #687) and 4 (durable halt state, then `halt` / `resume` over the roster, #681) are not built as described (unverified for #687: `halt-status` exists in `services/relay/src/command-route.ts`, whether it is roster-quantified was not checked). The roster-quantifier drift gate is not built. Nothing re-delivers a missed halt.

## memory-architecture.md

[`memory-architecture.md`](../doctrine/memory-architecture.md)

- As of 2026-11-13 (the doctrine's own inventory, spot-checked): built: the typed graph (`packages/memory-graph/src/index.ts`), episodic/semantic nodes, the eight-edge `RelationType` taxonomy (`DerivedFrom` is the eighth, `packages/sdk/src/index.ts`), confidence + exponential decay reinforced on access, recency×importance×relevance + Hebbian retrieval, ADD/UPDATE/REINFORCE/NOOP consolidation, reflection + curiosity, the notability self-audit, sensitivity + retention + deletion certificates, the idle consolidation cycle, and episodic-eager extraction.
- As of 2026-11-13: bi-temporal validity is end-to-end: `valid_from` / `valid_until` on `MemoryContent`, stamped at formation, set on supersession; emitted on the `memory_formed` / `memory_consolidated` wire (`spec/memory-delta-v1.md` §3.5/§5.1/§5.5, incl. `superseded_valid_until`); and as-of-`T` retrieval (`recallRelevantCore`'s `asOf` + `isValidAt`).
- As of 2026-11-13: default-on bounded consolidation is built (`inferenceIsFreeToUser` in `packages/sdk/src/provider-mode.ts`; the reflection gate reads `_lastConsolidationCycleAt` and catch-up is `catchUpConsolidationIfOverdue`, both in `packages/runtime/src/motebit-runtime.ts`), as is `DerivedFrom` provenance.
- As of 2026-11-13: the end-game shape is realized end-to-end and no named delta remains open. Further work deepens within the shape (richer provenance granularity, a per-fire `ExecutionReceipt`-sourced ledger, bounded consolidation tuning), not new legs of the skeleton.

## memory-never-confers-authority.md

[`memory-never-confers-authority.md`](../doctrine/memory-never-confers-authority.md)

- As of 2026-11-13: the invariant and its producer seam are built (shipped 2026-06-10): policy-gate step 8b (`packages/policy/src/policy-gate.ts`), `verifyGrantForTurn` (`packages/runtime/src/grant-verifier.ts`), gated by `check-money-authority`.
- As of 2026-11-13: grants are stored and presented. The grant store is `~/.motebit/grants/` (`motebit grant`, `apps/cli/src/subcommands/grant.ts`); `motebit --grant`, `motebit serve --direct --grant` and the molecule-runner self-grant present grants to the runtime; the CLI callers read revocations from the relay's `/api/v1/delegations/revocations` cache; the molecule-runner self-grant presents none (`packages/molecule-runner/src/index.ts`).
