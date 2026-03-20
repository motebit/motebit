# NIST NCCoE Comment — Software and AI Agent Identity and Authorization

**To:** AI-Identity@nist.gov
**From:** Daniel Hakim, Motebit, Inc.
**Date:** March 2026
**Re:** Comment on NCCoE Concept Paper — Accelerating the Adoption of Software and AI Agent Identity and Authorization

---

## Summary

Motebit is a cryptographic identity and authorization runtime for AI agents: 40 packages, 164,000 lines of TypeScript (94,000 production, 70,000 tests), 3,500+ tests, three open specifications. Agents carry persistent Ed25519 identities, accumulate verifiable trust through signed execution receipts, and enforce policy at every tool boundary. Receipts embed the signer's public key — they are self-verifiable offline, without contacting any relay or authority. Key rotation uses signed succession chains verifiable end-to-end from genesis key to current key, with no centralized revocation.

The protocol layer is MIT licensed and the verification library has zero dependencies — any system can verify a Motebit agent's identity, execution receipts, and credential chain without running Motebit software. This is a working implementation, not a proposal.

We offer Motebit as a reference implementation and potential NCCoE technology collaborator. This comment responds directly to the six question categories in the Note to Reviewers.

---

## 1. General — Use Cases and Architecture

**What enterprise use cases are organizations currently using agents for?**

Motebit is deployed across five surfaces (`apps/desktop/`, `apps/cli/`, `apps/mobile/`, `apps/web/`, `apps/admin/`), demonstrating agent architectures applicable to all three use cases identified in the concept paper: workforce efficiency (conversational agents with memory and tool use), security operations (audit-logged tool execution with sensitivity classification), and software development (MCP-integrated tool orchestration with signed execution receipts).

**Which use-cases are in the near future?**

Agent-to-agent delegation across organizational boundaries. Today, an enterprise agent calls tools within its own trust domain. The near-future shift is agents delegating tasks to agents operated by other organizations — a procurement agent requesting quotes from a vendor's agent, a compliance agent querying a regulator's agent. This requires cryptographic identity that is portable across trust domains, delegation receipts that prove chain-of-custody, and budget-gated settlement between parties. Motebit's relay federation specification (`motebit/relay-federation@1.0`) addresses this directly: cross-relay task routing via semiring-algebraic graph traversal, settlement chains with receipt co-signing, and circuit breakers for forward-path health. This is implemented — not planned — in `services/api/src/federation.ts`, `packages/market/src/graph-routing.ts`, and `packages/market/src/settlement.ts`, with end-to-end federation tests.

**What opportunities do agents present?**

The core opportunity is compounding capability. An agent with persistent identity, accumulated trust, and governed memory becomes more useful over time — it knows the user's context, has earned trust from other agents, and carries verifiable credentials proving its track record. This is fundamentally different from stateless automation. The economic opportunity follows: agents that can prove their identity and execution history to third parties can participate in marketplaces, receive delegated work, and settle payments — an agentic economy built on cryptographic trust rather than platform lock-in. Motebit implements this today: W3C VC 2.0 credential issuance (`packages/crypto/src/credentials.ts`), credential-weighted routing (`packages/market/src/credential-weight.ts`), and budget allocation with settlement (`packages/market/src/budget.ts`).

**What are the core characteristics of agentic architectures?**

Motebit implements the agentic architecture depicted in Figure 1 of the concept paper:

- **User Prompt** → runtime message handler
- **Agent** (agentic loop) → `MotebitRuntime` orchestrator with streaming, tool calls, and reflection
- **Reasoning Model** → pluggable AI providers (Anthropic, Ollama, Hybrid fallback). The intelligence is a commodity; the identity, authorization, and audit infrastructure is the constant.
- **Tools and Resources** → MCP client/server with PolicyGate enforcement at every tool boundary
- **Output / Response / Action** → signed execution receipt with delegation chain
- **Trust Domain** → PolicyGate + MemoryGovernor + privacy layer + injection defense

**What support are you seeing for MCP?**

Motebit includes both an MCP client and an MCP server:

- **MCP Client:** Tool discovery, manifest pinning (SHA-256 hash on first connect, trust revoked on mismatch), per-server trust levels, `EXTERNAL_DATA` boundary marking on all tool results
- **MCP Server:** Exposes the agent as a callable service with synthetic tools (`motebit_query`, `motebit_task`, `motebit_remember`, `motebit_recall`, `motebit_identity`, `motebit_tools`). Supports stdio and StreamableHTTP transports. Bearer token authentication on all HTTP connections (fail-closed).

**What risks worry you about agents?**

Three risks, in order of severity: (1) **Identity vacuum.** Agents acting on behalf of users with no cryptographic proof of who authorized them. When an agent delegates to another agent, there is no chain of custody. (2) **Ambient authority.** Most agent frameworks grant all-or-nothing tool access. An agent with write access to a database has the same access whether the user asked it to read a record or drop a table. (3) **Memory without governance.** Agents that persist memory across sessions without sensitivity classification, retention rules, or deletion mechanisms create uncontrolled data stores that grow indefinitely.

**How do AI agents differ from other forms of software agents?**

AI agents differ from traditional software agents (e.g., scheduled jobs, bots, RPA) in three ways relevant to identity and authorization: (1) **Non-deterministic behavior.** An AI agent's actions depend on model reasoning — the same input may produce different tool calls on different runs. This makes static authorization policies insufficient; the authorization system must evaluate each action at execution time, not at deployment time. (2) **Tool-augmented scope.** AI agents dynamically discover and invoke tools, potentially expanding their effective capabilities beyond what was anticipated at provisioning. (3) **Natural language attack surface.** AI agents process unstructured input (prompts, tool results) that can contain embedded directives — prompt injection is an identity and authorization problem, not just a model safety problem.

**How are agentic architectures different from current microservices architectures?**

In a microservices architecture, each service has a fixed API contract, deterministic behavior, and infrastructure-level identity (mTLS, SPIFFE). In an agentic architecture: the "API" is a natural language prompt with non-deterministic routing through tools; the agent may call tools that were not known at deployment time (MCP discovery); and the agent acts on behalf of a human whose intent must be traceable through delegation chains. The identity challenge shifts from "which service is calling" to "which agent, authorized by which human, with what scope, is performing what action, and can that chain be verified after the fact."

**How do agentic architectures introduce identity and authorization challenges?**

No major agent product or framework today — commercial or open source — ships persistent cryptographic identity. Agents are session tokens: they reset on every interaction, cannot prove who they are to third parties, and accumulate no verifiable trust history. When the provider changes its API or the session ends, the agent ceases to exist. This is an architectural absence, not a feature gap.

**Relevant artifacts:**

- Runtime orchestrator: `packages/runtime/`
- MCP client: `packages/mcp-client/`
- MCP server: `packages/mcp-server/`

---

## 2. Identification

**How might agents be identified in an enterprise architecture?**

Each Motebit agent has a persistent cryptographic identity: an Ed25519 keypair generating a `did:key` URI (W3C DID-Core) and a unique agent ID (UUID v7, time-ordered). Identity is declared in a human-readable, cryptographically signed file (`motebit.md`) that any system can verify without the Motebit runtime.

The identity specification (`motebit/identity@1.0`) is an open standard (MIT licensed). A zero-dependency verification library (`@motebit/verify`) is published on npm. A scaffolder (`npm create motebit`) generates a signed identity in 30 seconds.

**What metadata is essential for an AI agent's identity?**

The `motebit.md` file includes: agent ID, creation timestamp, owner ID, Ed25519 public key, governance thresholds (trust mode, risk-level bands, operator mode), privacy policy (sensitivity levels, retention periods, fail-closed flag), memory configuration (decay half-life, confidence threshold), device registrations (each with its own Ed25519 public key), and optional service identity (type, capabilities, service URL).

The governance and privacy metadata travel with the identity — they are not configuration at the infrastructure level but declarations by the agent's owner, signed into the identity file and tamper-evident via Ed25519 signature.

**Should agent identity metadata be ephemeral or fixed?**

Fixed and persistent. Agent identities in Motebit survive across sessions, devices, providers, and time. The identity file is versioned in git — governance changes produce readable diffs, and each change requires re-signing with the private key, providing a cryptographic audit trail.

**Should agent identities be tied to specific hardware, software, or organizational boundaries?**

Motebit supports multi-device registration. Each device has its own Ed25519 keypair registered in the identity file. The agent identity is not tied to a single device — it is portable across hardware — but each device binding is cryptographically anchored and auditable.

**Relationship to SPIFFE:** Motebit's identity model is complementary to SPIFFE. SPIFFE provides workload identity within a trust domain (e.g., a Kubernetes cluster). Motebit provides agent identity that persists across trust domains, providers, and time. In an enterprise deployment, a SPIFFE SVID could attest the workload running the Motebit agent, while the Motebit identity attests the agent itself. The two layers compose.

**Relevant artifacts:**

- Specification: `spec/identity-v1.md` (MIT licensed, stable)
- Verification library: `@motebit/verify` (npm, MIT, zero dependencies) — verifies identity files, execution receipts, verifiable credentials, and presentations with a single function call
- Identity scaffolder: `npm create motebit`
- DID interoperability: Section 10 of `spec/identity-v1.md`

---

## 3. Authentication

**What constitutes strong authentication for an AI agent?**

Motebit uses Ed25519 signed tokens for agent-to-service authentication. When an agent connects to a sync relay or delegates a task, it signs a JWT with its private key. Tokens carry explicit scope sets and a 5-minute expiry. The receiving service verifies the signature against the agent's pinned public key (established on first contact).

This is analogous to mutual TLS but at the agent identity layer rather than the transport layer. The authentication proof is: "the entity presenting this token holds the private key corresponding to the public key declared in this agent's identity file."

**How do we handle key management for agents?**

- **Generation:** Ed25519 keypair generated on first launch via the platform's cryptographic RNG
- **Storage:** Private keys stored in the OS secure keychain (macOS Keychain via Tauri, expo-secure-store on mobile) or encrypted at rest with PBKDF2 (600,000 iterations for identity files, 100,000 for relay keys). Private keys never appear in configuration files or identity files.
- **Per-device keys:** Each registered device has its own Ed25519 keypair. Device compromise does not compromise the agent identity — only the device key needs rotation.
- **Rotation:** Key rotation uses signed succession records (identity specification §3.8). The old keypair signs a tombstone declaring the new keypair as successor — both keys sign the canonical payload, providing non-repudiation and acknowledgment. The `motebit_id` persists across rotations. Succession chains are verifiable end-to-end: any party can prove identity continuity from genesis key to current key without trusting any intermediary. No centralized revocation authority.
- **Revocation:** No centralized revocation authority by design. Trust is accumulated at the application layer — a compromised identity is abandoned, and trust records for the old identity do not transfer. This avoids single points of failure in revocation infrastructure.

**Relationship to OAuth 2.0 / OIDC:** Motebit's Ed25519 signed tokens serve a similar role to OAuth 2.0 access tokens but are self-verifiable without a token introspection endpoint. The MCP server's HTTP bearer auth is compatible with OAuth flows — an enterprise could layer OIDC on top for user-to-agent identity binding while the agent-to-agent layer uses Ed25519 signatures directly.

**Relevant artifacts:**

- Signed token issuance/verification: `packages/crypto/`
- Key storage: OS keyring integration in `apps/desktop/`, `apps/mobile/`
- PBKDF2 key derivation: `packages/crypto/src/index.ts`

---

## 4. Authorization

**How can zero-trust principles be applied to agent authorization?**

Motebit implements zero-trust authorization through a PolicyGate that evaluates every tool call before execution, consistent with SP 800-207 principles:

- **Never trust, always verify.** Every tool invocation — including tools the agent has used before — passes through the PolicyGate. There is no ambient authority.
- **Least privilege.** Risk levels are assigned per tool (R0_READ / R1_DRAFT / R2_WRITE / R3_EXECUTE / R4_MONEY). The identity file declares three governance thresholds that form an ordered constraint: `max_risk_auto ≤ require_approval_above ≤ deny_above`.
- **Assume breach.** All authorization decisions (allowed / denied / requires_approval) are logged to an immutable audit trail with tool name, arguments (sensitive values redacted), result, duration, and timestamp.

The three-band governance model:

| Band                 | Behavior                                            | Example                                 |
| -------------------- | --------------------------------------------------- | --------------------------------------- |
| **Auto-allow**       | Tool executes without human intervention            | Read-only file access (R0)              |
| **Require approval** | Execution pauses for human-in-the-loop confirmation | File write (R2), API call (R3)          |
| **Hard deny**        | Blocked regardless of context                       | Financial transactions (R4) when denied |

**Can authorization policies be dynamically updated when an agent context changes?**

Yes. Governance thresholds are declared in the identity file and enforced at runtime. When the identity is updated (e.g., elevating `max_risk_auto` for a trusted agent), the file is re-signed and the runtime picks up the new policy. An operator mode (PIN-protected, rate-limited with exponential lockout) gates temporary privilege elevation without modifying the identity file.

Sensitivity levels (none / personal / medical / financial / secret) dynamically affect authorization: the MemoryGovernor classifies data sensitivity and applies retention rules per level. When an agent aggregates data across tools, the highest sensitivity level governs — consistent with the data aggregation concern raised in the concept paper.

**How do we establish "least privilege" for an agent, especially when its required actions might not be fully predictable when deployed?**

This is the central design challenge. Motebit addresses it with the three-band governance model: the identity file declares thresholds that constrain the agent _regardless_ of what the model decides to do. Even if the model reasons that dropping a database is the correct action, the PolicyGate denies it if that risk level exceeds the agent's governance threshold. The agent's privilege boundary is declared by the owner at identity creation time and enforced at runtime — the model's unpredictability operates _within_ those bounds, not outside them.

For dynamically discovered tools (MCP), each new tool is assigned a risk level before first use. Unknown tools default to the highest risk level (R4_MONEY) — fail-closed, not fail-open.

**How might an agent convey the intent of its actions?**

Motebit's execution ledger (`packages/runtime/src/execution-ledger.ts`) records not just _what_ the agent did, but _why_. Each step in a goal execution includes the agent's reasoning summary (generated by the reflection engine in `packages/planner/src/reflect.ts`), the tool arguments, and the delegation context. The signed execution manifest bundles this into a tamper-evident document per `spec/execution-ledger-v1.md`. Additionally, the precision feedback loop (`packages/runtime/src/gradient.ts`, `buildPrecisionContext`) modulates the system prompt based on the agent's self-assessed confidence — low confidence agents are instructed to be explicit about their uncertainty and reasoning, making intent more transparent in the output.

**What are the mechanisms for an agent to prove its authority to perform a specific action?**

The agent's signed JWT (Ed25519, 5-minute expiry) carries explicit scope sets. The receiving service verifies: (1) the signature matches the agent's pinned public key, (2) the requested action falls within the token's scope, (3) the token has not expired. For delegation, the execution receipt proves the delegating agent authorized the action — the receipt is self-verifiable using only the embedded public key.

**How do we handle delegation of authority for "on behalf of" scenarios?**

Agents delegate tasks to other agents through MCP. Delegation tokens carry explicit scope sets — the receiving agent cannot exceed the delegated scope. Each delegation produces a signed execution receipt containing:

- The delegating agent's identity and embedded public key (for portable verification)
- SHA-256 hashes of the prompt and result (privacy-preserving — content is not disclosed)
- Ed25519 signature over canonical JSON (deterministic serialization for tamper evidence)
- Nested delegation receipts for chain-of-custody (multi-hop delegation produces a verifiable tree)

Receipts are self-verifiable: any system can verify the signature using only the receipt data and the embedded public key, without contacting the issuing infrastructure.

**How do we bind agent identity with human identity for human-in-the-loop?**

The identity file's `owner_id` field binds the agent to a human identity. The operator mode requires PIN authentication (SHA-256 hashed, stored in OS keyring) before granting elevated privileges. Every approval decision records both the agent identity and the approval context in the audit log.

**Relationship to NGAC:** Motebit's PolicyGate implements attribute-based access control with risk-level attributes on tools and sensitivity-level attributes on data. NGAC's graph-based policy representation and native delegation support are architecturally aligned — a Motebit deployment could use NGAC as an upstream policy source while the PolicyGate enforces decisions at the agent boundary.

**Relevant artifacts:**

- PolicyGate: `packages/policy/src/policy-gate.ts`
- Privacy layer: `packages/privacy-layer/`
- MemoryGovernor: `packages/policy/src/memory-governance.ts`
- Governance thresholds: Section 3.3 of `spec/identity-v1.md`
- Execution receipts: `packages/runtime/src/execution-ledger.ts`
- Delegation via MCP: `packages/mcp-server/`, `services/api/src/task-routing.ts`

---

## 5. Auditing and Non-Repudiation

**How can we ensure that agents log their actions in a tamper-proof and verifiable manner?**

Three layers of audit:

1. **Event log.** An append-only, immutable event log with version clocks. Supports compaction, replay, and multi-device conflict detection via event sourcing. Every state change, tool call, memory operation, and policy decision is recorded.

2. **Tool audit trail.** Every tool call produces an audit entry recording: tool name, arguments (with sensitive values redacted per sensitivity classification), authorization decision (allowed / denied / requires_approval), execution result, duration, and timestamp. The audit trail is queryable by turn, by run, or globally.

3. **Signed execution ledgers.** Goal executions produce signed manifests per the `motebit/execution-ledger@1.0` specification. A ledger contains: a complete timeline of typed execution events (tool calls, delegations, reflections, adjustments), per-step summaries, delegation receipt metadata, and a SHA-256 content hash of the canonical timeline — all signed with Ed25519 for non-repudiation. The content hash covers the timeline bytes; any modification invalidates the signature.

**How do we ensure non-repudiation and binding back to human authorization?**

The execution receipt chain provides cryptographic non-repudiation:

- Each receipt is signed by the executing agent's Ed25519 private key — the signer cannot deny having produced it.
- The delegation chain links back to the originating human's agent identity (`owner_id`).
- Nested delegation receipts preserve chain-of-custody for multi-hop delegations.
- The execution ledger binds the complete execution history (what tools were called, what delegations occurred, in what order) to a single tamper-evident signed document.

The system also issues W3C Verifiable Credentials (VC 2.0) with `eddsa-jcs-2022` cryptosuite:

| Credential Type               | Issuer                  | Trigger                    |
| ----------------------------- | ----------------------- | -------------------------- |
| **AgentReputationCredential** | Peer (delegating agent) | Verified execution receipt |
| **AgentGradientCredential**   | Self (agent)            | Periodic housekeeping      |
| **AgentTrustCredential**      | Peer (agent)            | Trust level transition     |

Reputation credentials follow a peer attestation model: the agent that delegated the task attests to the result, not the relay. This aligns with the principle that trust should be grounded in direct interaction, not mediated by a central authority. The relay may optionally co-sign reputation credentials for additional assurance, but the primary attestation is peer-to-peer. This design avoids single-point-of-failure trust and enables credential portability across relays.

Credentials bundle into signed Verifiable Presentations for third-party verification. The credential lifecycle creates a compounding trust history — agents accumulate verifiable records of successful execution over time.

**Relevant artifacts:**

- Event log: `packages/event-log/`
- Tool audit: `packages/policy/src/audit.ts`
- Execution ledger specification: `spec/execution-ledger-v1.md`
- W3C VC issuance: `packages/crypto/src/credentials.ts`

---

## 6. Prompt Injection Prevention and Mitigation

**What controls help prevent both direct and indirect prompt injections?**

All tool results from external sources are wrapped in `[EXTERNAL_DATA]` boundary markers before entering the agent's context. This maintains provenance: the agent, the audit system, and any reviewer can distinguish between user input, agent reasoning, and externally sourced data. The boundary is enforced at the MCP client layer — every tool result from every external server is marked, regardless of server trust level.

A triple-layer injection defense operates at this boundary:

1. **Pattern matching.** 16 regex signatures for known attack vectors (role injection, system prompt override, instruction delimiters, base64-encoded payloads)
2. **Directive density analysis.** Detects anomalous instruction-like language ratio in tool results — a web search result containing imperative directives triggers a warning
3. **Structural anomaly detection.** Identifies chat template markers, role injection (`<|system|>`, `### System:`), and conversation format manipulation in external data

**After prompt injection occurs, what controls minimize impact?**

- **Fail-closed authorization.** Even if injection manipulates the agent's reasoning, the PolicyGate still evaluates every tool call. A prompt injection cannot escalate privileges — tools above the agent's governance threshold are denied regardless of the agent's intent.
- **MCP manifest pinning.** SHA-256 hash of the tool manifest is computed on first connection. If the manifest changes (e.g., a compromised MCP server adds new tools), trust is revoked and all tool calls are denied until the user re-trusts.
- **Audit trail.** Injection detection events are logged with the triggering content, detection method, and confidence score — enabling post-incident analysis.
- **Sensitivity-aware data handling.** Even if injected instructions attempt to exfiltrate data, the MemoryGovernor's sensitivity classification and retention rules limit what data is available in the agent's context.

**Relevant artifacts:**

- Content sanitizer: `packages/policy/src/sanitizer.ts`
- Agentic loop with boundary enforcement: `packages/ai-core/src/loop.ts`
- MCP manifest pinning: `packages/mcp-client/`

---

## Standards Alignment

Motebit's architecture engages with several standards referenced in the concept paper:

| Standard             | Alignment                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP**              | Native client + server implementation. MCP is the tool interop layer; Motebit adds the identity and authorization layer MCP does not define.                                                                                                                                                                                            |
| **OAuth 2.0 / OIDC** | MCP server bearer auth is compatible with OAuth token flows. Ed25519 signed tokens serve a similar role but are self-verifiable without introspection endpoints. Enterprise deployments can layer OIDC for user authentication.                                                                                                         |
| **SPIFFE / SPIRE**   | Complementary. SPIFFE attests workloads; Motebit attests agents. Both use cryptographic identity. In Kubernetes, a SPIFFE SVID attests the pod; the Motebit identity attests the agent running in the pod.                                                                                                                              |
| **SCIM**             | Agent lifecycle (creation, device registration, governance updates) maps to SCIM provisioning patterns. The identity file serves as the canonical identity document.                                                                                                                                                                    |
| **NGAC**             | PolicyGate implements attribute-based access control (risk-level × sensitivity-level). NGAC's graph-based policy and delegation support are architecturally aligned for enterprise policy federation.                                                                                                                                   |
| **SP 800-207**       | Zero trust at every tool boundary. No ambient authority. Every call verified. All decisions logged.                                                                                                                                                                                                                                     |
| **SP 800-63-4**      | Ed25519 cryptographic verification maps to AAL2/AAL3 assurance levels. Key storage in hardware-backed OS keychain (when available) provides phishing-resistant authentication. Key rotation via signed succession records preserves identity continuity without centralized revocation.                                                 |
| **NISTIR 8587**      | Ed25519 signed tokens use 5-minute expiry and explicit scope sets to limit theft window. Tokens are bound to a specific agent identity (public key pinning on first contact) — a stolen token cannot be replayed from a different agent. Scope binding ensures a token issued for task delegation cannot authorize identity operations. |
| **W3C DID / VC**     | Native `did:key` derivation from Ed25519 public keys. W3C VC 2.0 credentials with `eddsa-jcs-2022` cryptosuite for reputation, gradient, and trust attestations.                                                                                                                                                                        |

---

## Availability

- **Source code:** [github.com/motebit/motebit](https://github.com/motebit/motebit) (source-available, BSL 1.1)
- **Protocol layer:** MIT licensed — specifications, SDK, verification library, scaffolder
- **Specifications:** `motebit/identity@1.0` (stable), `motebit/execution-ledger@1.0` (stable), `motebit/relay-federation@1.0` (draft)
- **npm packages:** `@motebit/sdk`, `@motebit/verify`, `create-motebit`, `motebit`
- **Live demo:** [motebit.com](https://motebit.com)

The identity and receipt primitives are designed to compose with external proof anchoring systems (e.g., on-chain timestamping for trust permanence) without requiring changes to the core verification path.

We welcome the opportunity to collaborate with the NCCoE as a technology partner in demonstrating these capabilities in laboratory environments.

---

Daniel Hakim
Motebit, Inc.
daniel@motebit.com
