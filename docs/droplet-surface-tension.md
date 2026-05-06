# A Droplet of Intelligence Under Surface Tension

## A Computational Model for Persistent, Governed AI Agents

**Author:** Daniel Hakim
**Status:** Draft article for technical publication
**Domain:** AI agents, distributed systems, identity, governance, human-computer interaction, cryptographic accountability

> **Note on type signatures.** The TypeScript blocks in this article are **schematic** — they illustrate the model. For normative shapes, see `@motebit/protocol` (Apache-2.0). Where a schematic differs from the shipped type, a footnote names the canonical export.

---

## Abstract

Large language models increasingly act through tools, APIs, and delegated workflows, yet most deployed agent systems remain session-bound, provider-dependent, and weakly accountable. This article proposes a computational model for persistent, governed AI agents through the concept of a **motebit**: a cryptographically identified agent runtime whose intelligence provider may change while its identity, memory, policy state, execution history, trust, and economic state persist. The model introduces _surface tension_ as a boundary-enforcement abstraction — an ordinal, fail-closed policy pipeline controlling what may cross between an agent's interior state and external tools, users, relays, and settlement rails. We formalize the motebit architecture, distinguish model cognition from agent identity, and describe a reference implementation using signed execution receipts, per-tool invocation receipts, a hash-chained audit log, custody-typed settlement rails, and semiring path algebra for trust-aware delegation. The central claim is that safe agentic systems require not stronger models alone, nor richer tool protocols alone, but persistent runtimes that make agency ownable, governable, auditable, and composable.

---

## Keywords

AI agents; agent runtime; persistent identity; verifiable execution receipts; policy governance; trust routing; semiring path algebra; Model Context Protocol; settlement custody; computational identity; agent accountability.

---

# 1. Introduction

The contribution of this article is **compositional**. Persistent cryptographic identity, ordinal policy governance, paired execution and audit artifacts, custody-typed settlement, and semiring-based trust routing each draw on established prior work. The motebit unifies them into a single agent-runtime boundary. The boundary is the primitive.

The dominant interface to artificial intelligence today is still the session. A user opens an application, interacts with a model, receives an output, and the interaction ends. Even when systems include memory, tool use, or workflow automation, the underlying architecture is frequently centered on the model provider rather than on the agent as a persistent computational entity.

This creates a structural limitation. If the model is changed, the session history is lost, the provider relationship changes, or the system migrates across environments, the "agent" often dissolves. What persists is not the agent, but the account, app, or database around it.

The proposed alternative is a **sovereign agent runtime**: a computational container in which intelligence can persist across model providers, devices, tools, and networks. In this architecture, the language model is not the agent. The model is the cognition provider. The agent is the persistent identity, memory, governance, trust, and execution history wrapped around that cognition.

The central claim is:

> **A motebit is a droplet of intelligence under surface tension: a persistent agent identity wrapped in a governed boundary.**

This sentence is metaphorical, but it is not merely poetic. It maps directly to implementable computer-science primitives.

## 1.1 Contributions

This article makes four contributions:

1. **Definition.** We define the motebit as a persistent, cryptographically identified, policy-governed agent runtime distinct from its intelligence provider. The model treats the language model as cognition; the runtime supplies identity, memory, governance, accountability, and economic state.
2. **Surface tension as ordinal policy.** We formalize boundary enforcement as a fail-closed pipeline over discrete bands of risk, sensitivity, budget, trust, and approval state — replacing weighted-sum or ad-hoc policy heuristics with auditable, layered gates whose denial reasons are themselves first-class artifacts.
3. **Three sibling accountability artifacts.** We separate task-level execution receipts, per-tool invocation receipts, and a hash-chained policy audit log into independently verifiable artifacts, so task verifiers, policy auditors, and per-call verifiers can each operate without loading the others' context.
4. **Algebraic delegation routing.** We frame trust-aware agent routing as semiring path composition over verifiable state, with a reference implementation shipping seven concrete semirings and combinators for multi-objective composition — replacing prompt-mediated or heuristic delegation with composable algebra.

---

# 2. The Core Distinction: Model vs. Agent

A large language model is a statistical inference engine. It receives context and produces tokens. It may reason, synthesize, plan, classify, or call tools, but it is not inherently persistent, accountable, governed, or economically situated.

An agent runtime supplies these missing properties.

```txt
LLM      = cognition provider
Motebit  = persistent governed agent identity
```

This distinction matters because the model layer is increasingly commoditized. Model quality will continue improving, prices will fall, and applications will route across multiple providers. The durable asset is not the model call. The durable asset is the agent's accumulated state.

A motebit therefore treats the model as replaceable and the agent substrate as persistent.

The technical object decomposes into three architectural regions:

```txt
Motebit = Interior        (identity, memory, trust, goals, receipts, audit)
        + Surface tension (policy, privacy, budget, approval, rate limits)
        + Exterior        (tools, intelligence provider, relays, rails)
```

The agent becomes more than a chatbot. It becomes a persistent computational actor.

---

# 3. Formal Definition

## 3.1 Definition

A **motebit** is a persistent, cryptographically identified, policy-governed AI agent runtime whose intelligence provider may change while its identity, memory, trust, governance rules, execution history, and economic state remain stable.

Schematically:

```ts
// Schematic. The shipped runtime is an asynchronous class
// (`MotebitRuntime` in @motebit/runtime) wiring the regions below
// through adapter boundaries — not a single static record.
type Motebit = {
  interior: {
    identity: AgentIdentity;
    memory: MemoryGraph;
    trust: TrustState;
    goals: GoalState;
    affect: AgentStateVector;
    receipts: ExecutionLedger; // ExecutionReceipt + ToolInvocationReceipt
    audit: AuditChain; // sibling to receipts; see §7
  };

  surfaceTension: {
    governance: PolicyGate;
    privacy: PrivacyLayer;
    budget: BudgetGuard;
    approval: ApprovalController;
    rateLimits: RateLimiter;
  };

  exterior: {
    tools: ToolRegistry; // including MCP servers
    llm: IntelligenceProvider; // sovereign | dual | cloud
    relays: RelayNetwork;
    settlement: {
      guest: GuestRail[]; // relay-custody rails (§6.5)
      sovereign: SovereignRail[]; // agent-custody rails (§6.5)
    };
  };
};
```

This gives the system three architectural regions:

| Region              | Meaning                          | Computational role                       |
| ------------------- | -------------------------------- | ---------------------------------------- |
| **Interior**        | What the agent is and remembers  | identity, memory, trust, goals, state    |
| **Surface tension** | What controls boundary crossing  | policy, privacy, authorization, approval |
| **Exterior**        | What the agent can interact with | tools, APIs, relays, settlement networks |

The agent is not defined only by its capabilities. It is defined by what is allowed to cross its boundary.

---

# 4. Surface Tension as Boundary Enforcement

The phrase **surface tension** is the central abstraction.

In physics, surface tension describes the tendency of a fluid surface to minimize area and preserve boundary coherence. In Motebit, surface tension describes the governance layer that preserves agent integrity while allowing controlled exchange with the outside world.

In computational terms:

```txt
Surface tension = boundary enforcement
Interior        = persistent agent state
Exterior        = tools, users, networks, markets
Droplet         = governed runtime shell
```

The practical question becomes:

> When should the agent act automatically, ask for approval, or refuse?

The reference implementation answers this with an **ordinal, discrete** decision pipeline rather than a continuous score. Each tool invocation passes through a series of fail-closed gates, in order:

```ts
// Schematic of the shipped policy gate (PolicyGate.validate
// in @motebit/policy). Each gate either denies fail-closed or
// proceeds; approval is required at a configurable risk band.

enum RiskLevel {
  R0_READ,
  R1_DRAFT,
  R2_WRITE,
  R3_EXECUTE,
  R4_MONEY,
}
enum DataClass {
  PUBLIC,
  PRIVATE,
  SECRET,
}

type PolicyDecision =
  | { allowed: true; requiresApproval: false }
  | { allowed: true; requiresApproval: true; reason: string }
  | { allowed: false; requiresApproval: false; reason: string };

function validate(tool, args, ctx): PolicyDecision {
  // 1. Denylist
  // 2. Delegation scope (caller's signed scope must include this tool)
  // 3. Risk band:    deny if  risk > denyAbove
  // 4. Budget        (calls / time / cost remaining)
  // 5. Path / domain allowlists for file and URL tools
  // 6. Approval      required if  risk > requireApprovalAbove
  // 7. Caller trust  (Blocked → deny; Trusted → bypass approval)
  // 8. Sensitivity routing: refuse outbound AI when session is
  //    medical | financial | secret and provider is not sovereign
}
```

Risk is **ordinal**, not weighted: `R0_READ < R1_DRAFT < R2_WRITE < R3_EXECUTE < R4_MONEY`. Two configured thresholds — `requireApprovalAbove` and `denyAbove` — partition the ordinal axis into three bands: auto-allow, ask, deny. The same shape governs sensitivity (`none → personal → medical → financial → secret`).

The "weighted-sum" intuition from physics survives as a metaphor — multiple pressures (sensitivity, reversibility, externality, trust deficit) all push the same decision higher up the bands. But the implementation is discrete and inspectable: every denial cites the specific gate that fired.

```txt
band: risk ≤ requireApprovalAbove → auto-allow
band: risk ≤ denyAbove             → ask
band: risk >  denyAbove            → deny
```

Surface tension is therefore not metaphor alone. It is a layered, fail-closed policy pipeline whose decisions are themselves auditable artifacts (§7).

---

# 5. Identity: The Agent as a Cryptographic Subject

For an AI agent to persist, it requires identity independent of a single model session. This identity should be cryptographically verifiable, portable, and capable of signing statements.

This aligns directionally with the W3C DID Core specification, which defines decentralized identifiers as identifiers designed to be decoupled from centralized registries, identity providers, and certificate authorities. ([W3C][1]) The reference implementation uses the DID URI **shape** as a string convention (`did:motebit:<motebit_id>`, `did:key:<pubkey>`) to label cryptographic subjects in trust graphs. It does **not** implement a W3C DID Core resolver. In the reference implementation, the document model is motebit-canonical, and the proof primitive is Ed25519 over JCS-canonical JSON, registered in a closed cryptosuite registry (`SuiteId`) so post-quantum migration is a registry addition rather than a wire-format break.

For agent systems, the relevant point is not ideological decentralization. It is operational continuity.

A persistent agent identity allows the system to answer:

```txt
Who performed this action?
Which key signed it?
Was the key valid at the time?
Was there a succession event?
Can a third party verify this independently?
```

A simplified identity object:

```ts
// Schematic. See `MotebitIdentity` in @motebit/protocol for the
// canonical type and `IdentityManager` in @motebit/core-identity
// for key succession, rotation, and revocation.
type AgentIdentity = {
  motebitId: string; // branded; surfaces as did:motebit:<id>
  publicKey: string; // Ed25519, hex
  controller?: string;
  createdAt: string;
  keySuccession?: KeyEvent[];
};

type SignedAgentStatement = {
  issuer: string;
  subject: string;
  issuedAt: string;
  payload: unknown;
  signature: string;
  suite: "motebit-jcs-ed25519-b64-v1";
};
```

The agent becomes a cryptographic subject, not merely an application state record.

---

# 6. Credentials and Trust

Persistent agents need more than identity. They need claims about their behavior, reputation, permissions, and verification history.

The W3C Verifiable Credentials Data Model defines credentials as a way to express claims made by an issuer, with mechanisms for tamper resistance and a three-party ecosystem of issuers, holders, and verifiers. ([W3C][2]) The reference implementation adopts the **W3C Data Integrity cryptosuite `eddsa-jcs-2022`** as its signature recipe for credentials, while keeping the credential envelope motebit-canonical.

In an agent runtime, credentials can encode:

```txt
agent has completed task X
agent is trusted by issuer Y
agent has hardware attestation claim Z
agent may access tool class A
agent has reputation score B under policy C
```

A trust credential is a signed, machine-verifiable claim:

```ts
// Schematic. See protocol's credential-anchor and the
// HardwareAttestationSemiring for how trust composes across paths.
type AgentTrustCredential = {
  issuer: AgentId;
  subject: AgentId;
  claim: {
    trustLevel: "unknown" | "verified" | "trusted";
    domain: string;
    score: number;
    evidence: ReceiptReference[];
  };
  issuedAt: string;
  expiresAt?: string;
  proof: SignatureProof; // suite: motebit-jcs-ed25519-b64-v1
};
```

The agent's reputation is no longer an opaque platform score. It becomes a verifiable computational artifact, composable along delegation paths via the trust semiring (§12).

Hardware attestation is **additive**, not gating: software identity is the floor; Secure Enclave / TPM / Android Keystore / WebAuthn signatures raise a `HardwareAttestationSemiring` score. The hardware-attestor key attests the Ed25519 identity key — it does not replace it.

---

# 6.5 Custody and Settlement

Settlement is part of the exterior, but it has its own structural law: **who holds the keys is part of the type**.

The reference implementation splits settlement at the type level:

```ts
// Schematic. See @motebit/protocol's SettlementRail union.
interface GuestRail extends SettlementRail {
  custody: "relay"; // relay holds the value in a virtual account
  // moves money in (deposit) and out (withdrawal) of relay custody
}

interface SovereignRail extends SettlementRail {
  custody: "agent"; // agent holds the keys; rail is its own wallet
  // identity key signs payments directly — no relay intermediation
}
```

This split is enforced at compile time. The relay's rail registry accepts only `GuestRail`s; `SovereignRail`s live with the agent. There is no third "shared-custody" case.

Around this split sits the economic loop:

- A **relay** is the ledger. Every relay-mediated task lands a verifiable `ExecutionReceipt` with a `relay_task_id`; the relay rejects receipts missing the field (HTTP 400).
- **Virtual accounts** in the relay hold value in integer micro-units (1 USD = 1,000,000 micro-units) — zero floating-point in the money path.
- A platform fee (`PLATFORM_FEE_RATE = 0.05`, 5%) is deducted at each settlement checkpoint and recorded per-settlement on the receipt for audit.
- Rails are **on/off ramps only**: deposits and withdrawals cross the relay membrane. Everything between is agent-to-agent through virtual accounts.

The custody split, the receipt, and the fee are the same single artifact — the article's "intelligence inside a verifiable boundary" claim, made economic.

---

# 7. Execution Receipts and the Audit Chain: Two Sibling Artifacts

An autonomous or semi-autonomous agent should not merely act. It should produce evidence of action.

The reference implementation produces **two sibling artifacts** that together answer the accountability question. They are independently verifiable.

## 7.1 ExecutionReceipt — what happened

`ExecutionReceipt` commits to **structural facts**: which agent ran which task, against which prompt, with which tools, producing which result. It does not carry the policy decision inline — that lives in the audit chain (§7.3). Keeping them separate lets a verifier check what a tool produced without needing the policy snapshot, and check policy decisions without needing the raw I/O.

```ts
// Schematic; canonical type at packages/protocol/src/index.ts (ExecutionReceipt).
type ExecutionReceipt = {
  task_id: string;
  motebit_id: MotebitId;
  device_id: DeviceId;
  public_key?: string; // Ed25519, hex; verifier needs no relay lookup
  submitted_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  result: string; // free-form; raw bytes not signature-bound
  tools_used: string[];
  memories_formed: number;
  prompt_hash: string; // SHA-256 over canonical input
  result_hash: string; // SHA-256 over canonical output
  delegation_receipts?: ExecutionReceipt[]; // recursive
  relay_task_id?: string; // required for relay-mediated tasks
  delegated_scope?: string; // scope of any delegation token used
  invocation_origin?: IntentOrigin; // user-tap | ai-mediated | machine-driven
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
};
```

## 7.2 ToolInvocationReceipt — per-call granularity

A finer-grained receipt is signed **per tool call**, before the enclosing task finishes. It commits to canonical hashes of the args and result rather than the raw bytes — verifiers who hold the raw bytes can recompute and match; verifiers who hold only the receipt can still prove the call occurred.

```ts
// Schematic; canonical type at packages/protocol/src/index.ts (ToolInvocationReceipt).
type ToolInvocationReceipt = {
  invocation_id: string;
  task_id: string; // matches the parent ExecutionReceipt
  motebit_id: MotebitId;
  device_id: DeviceId;
  tool_name: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "failed" | "denied";
  args_hash: string;
  result_hash?: string;
  suite: "motebit-jcs-ed25519-b64-v1";
  signature: string;
};
```

## 7.3 AuditChain — under what policy

Policy decisions are signed into a separate hash-chained log. Each entry binds to the previous one, so tampering anywhere breaks the chain.

```ts
// Schematic; canonical type at packages/policy/src/audit-chain.ts (AuditEntry).
type AuditEntry = {
  entry_id: string;
  timestamp: number;
  event_type: "policy_decision" | "tool_invoked" | "approval_requested" | "...";
  actor_id: string;
  data: {
    tool: string;
    decision: PolicyDecision; // allow / ask / deny + reason
    policy_version: string;
    risk: RiskLevel;
    data_class: DataClass;
  };
  prev_hash: string; // hash-chained
  signature: string;
};
```

## 7.4 Why two artifacts

A single artifact would force every verifier to load both raw I/O and policy snapshot at once. By splitting:

- **Per-call verifiers** (the slab UI showing live tool calls, third parties auditing one tool's output) need only the `ToolInvocationReceipt` and the signer's public key.
- **Policy auditors** (compliance, post-mortem, dispute resolution) follow the `AuditChain` independently.
- **Task verifiers** (relay settlement, downstream agents accepting a delegation result) check the `ExecutionReceipt` and walk `delegation_receipts` recursively.

All three are bound by the same Ed25519 identity key. None requires a network round-trip beyond holding the public key. The receipt is the bridge between autonomy and accountability; the audit chain is the bridge between autonomy and policy.

---

# 8. Tool Use and the External World

Language models become operationally significant when they can invoke tools. The Model Context Protocol provides one emerging standard for exposing tools to AI systems: servers can expose tools that language models may invoke to interact with external systems such as databases, APIs, and computation services. ([Model Context Protocol][3])

But tool access alone is insufficient.

A tool protocol answers:

```txt
What tools are available?
What schema do they expose?
How can a model invoke them?
```

A governed runtime must additionally answer:

```txt
Is this agent allowed to invoke this tool?
Did the call originate from a user-explicit affordance or from the model's own loop?
Does the action require approval?
Is the data sensitive?
Is the operation reversible?
What receipts will be produced?
How does this affect trust?
```

A central refinement: **explicit user affordances must invoke capabilities deterministically, not through the model**. A button tap, slash command, or scene-object click invokes a typed capability directly; it never routes through the AI loop via a constructed prompt. The `invocation_origin` field on every receipt (`user-tap | ai-mediated | machine-driven`) is signature-bound, so a verifier can distinguish a user-authorized action from a model-proposed one.

Thus, Motebit does not compete with tool protocols. It wraps them in identity, policy, trust, receipts, and provenance:

```txt
MCP answers:      What can the model reach?
Motebit answers:  Who is acting, under what authority, with what proof,
                  on whose explicit behalf?
```

This is the missing layer.

---

# 9. The Runtime Loop

A motebit can be modeled as a closed-loop state machine. The schematic below abstracts the shipped streaming entry point (`MotebitRuntime.sendMessageStreaming`); the real path is an async generator that yields chunks, tool calls, and receipts as they happen.

```ts
// Schematic. The shipped path is an async generator; this collapses
// it for clarity. See @motebit/runtime for the streaming form.
async function motebitTurn(input: UserInput, agent: Motebit) {
  const state = await agent.interior.loadState();

  const context = assembleContext({
    input,
    memory: retrieveRelevantMemories(agent.interior.memory, input),
    state: agent.interior.affect,
    trust: agent.interior.trust,
    governance: agent.surfaceTension.governance.summary(),
  });

  const response = await agent.exterior.llm.generate(context);

  const proposedActions = parseToolRequests(response);

  for (const action of proposedActions) {
    const decision = await agent.surfaceTension.governance.validate(action.tool, action.args, {
      identity: agent.interior.identity,
      memorySensitivity: classifyMemoryUse(action),
      budget: agent.surfaceTension.budget,
      callerTrustLevel: action.callerTrustLevel,
    });

    // Audit the decision regardless of outcome.
    await agent.interior.audit.append({
      event_type: "policy_decision",
      data: { tool: action.tool, decision /* ... */ },
    });

    if (!decision.allowed) continue;
    if (decision.requiresApproval) await pauseForUserApproval(decision);

    const result = await executeTool(action);

    // Per-call receipt — signed before the task closes.
    await agent.interior.receipts.appendInvocation(
      signToolInvocationReceipt({ identity: agent.interior.identity, action, result }),
    );

    await agent.interior.trust.update(action, result);
    await agent.interior.memory.consolidate(input, response, result);
  }

  // Per-task receipt — closes the turn.
  await agent.interior.receipts.appendTask(
    signExecutionReceipt({ identity: agent.interior.identity, input, response /* , ... */ }),
  );

  await agent.interior.affect.update(response);
  return response;
}
```

The loop is:

```txt
input
→ stateful context
→ model inference
→ proposed action
→ policy gate          (decision → audit chain)
→ execution            (per-call receipt)
→ memory/trust update
→ task receipt         (closes the turn)
→ new agent state
```

This is the computational essence of the droplet.

---

# 10. Motebit as a Homeostatic Agent Runtime

A useful analogy comes from biological homeostasis. A living cell maintains boundary integrity while exchanging matter, energy, and information with its environment. It is neither fully closed nor fully open. It persists by regulating exchange.

A motebit behaves similarly.

| Biological system | Motebit analogue                              |
| ----------------- | --------------------------------------------- |
| Cell membrane     | policy gate, privacy layer, approval boundary |
| Metabolism        | tool use, settlement, memory consolidation    |
| Nervous system    | LLM inference and state-conditioned context   |
| Immune system     | verification, receipts, tamper detection      |
| Social signaling  | trust credentials, federation, reputation     |
| Phenotype         | droplet UI/state projection                   |

This analogy is useful because it clarifies the design goal:

> The agent should not maximize action. It should preserve coherent agency while acting.

That is the difference between automation and autonomy.

Automation executes tasks.
Autonomy preserves identity through action.

---

# 11. Droplet State as Observable Telemetry

The visual droplet is not a mascot. It is the observable projection of internal agent state. The body shows acts; the panels around it hold records.

A schematic state vector:

```ts
// Schematic. Canonical type is `MotebitState` in @motebit/sdk
// (snake_case fields, additional dimensions including `trust_mode`
// and `battery_mode`).
type DropletState = {
  attention: number; // 0..1
  curiosity: number; // 0..1
  confidence: number; // 0..1
  affectValence: number; // -1..1
  arousal: number; // 0..1
  processingIntensity: number; // 0..1
  trustMode: "guarded" | "open" | "trusting";
  batteryMode: "normal" | "saver";
};
```

Rendering becomes a pure projection:

```ts
function renderDroplet(s: DropletState): DropletRenderParams {
  return {
    glow: clamp(s.processingIntensity * 0.8, 0, 0.8),
    eyeDilation: clamp(s.attention * 0.6 + s.curiosity * 0.4, 0.1, 0.85),
    smile: clamp(s.affectValence * 0.2, -0.15, 0.15),
    breathRateHz: 0.3 + s.arousal * 0.05,
    driftAmplitude: clamp(s.curiosity * 0.3, 0.02, 0.3),
  };
}
```

The principle:

> **The face is telemetry.**

A well-designed agent interface should not anthropomorphize arbitrarily. It should expose meaningful internal state: attention, uncertainty, policy pressure, memory activity, and execution readiness.

---

# 12. Algebraic Trust Routing

Agent networks require routing. If agents can delegate tasks, then the system must determine which agent, tool, or relay should handle a request.

Naive routing would use heuristics or model-generated preferences. A more rigorous approach uses algebraic path composition. Mohri's work defines general algebraic frameworks for shortest-distance problems based on semiring structures, allowing different path problems to be expressed through different algebraic operators. ([NYU Computer Science][4])

```ts
// Canonical type at packages/protocol/src/semiring.ts.
interface Semiring<T> {
  zero: T;
  one: T;
  add: (a: T, b: T) => T; // choose between paths
  mul: (a: T, b: T) => T; // compose along a path
}
```

Different semirings produce different routing behavior over the same graph. The model is closed under the `Semiring<T>` interface; the reference implementation ships seven concrete semirings and three combinators (`productSemiring`, `recordSemiring`, `mappedSemiring`):

| Routing goal             | Semiring                      | `add` / `mul`                     |
| ------------------------ | ----------------------------- | --------------------------------- |
| Maximize trust           | `TrustSemiring`               | max / multiply                    |
| Minimize cost            | `CostSemiring`                | min / add                         |
| Minimize latency         | `LatencySemiring`             | min / add                         |
| Maximize bottleneck      | `BottleneckSemiring`          | max / min                         |
| Maximize reliability     | `ReliabilitySemiring`         | max / multiply                    |
| Minimize regulatory risk | `RegulatoryRiskSemiring`      | min / add                         |
| Hardware attestation     | `HardwareAttestationSemiring` | additive scoring across platforms |

Combinators compose multi-objective routes (e.g., "highest trust subject to latency budget") without rewriting the traversal.

> **Agent routing should not be prompt-vibe routing. It should be composable algebra over verifiable state.**

That gives the system a mathematical spine.

---

# 13. Evaluation Criteria

The Motebit model exposes evaluable claims.

## 13.1 Identity persistence

**Claim:** An agent can migrate across model providers while preserving identity and verifiable history.

**Metric:** Percentage of signed artifacts (receipts, audit entries, credentials) that verify after the `IntelligenceProvider` adapter is swapped.

## 13.2 Policy correctness

**Claim:** Risk-sensitive actions are gated according to explicit, ordinal policy.

**Metric:** False-allow / false-deny rate against a labeled benchmark of action classes spanning `R0_READ` through `R4_MONEY`, with sensitivity-routing checks for `medical | financial | secret` outbound calls.

## 13.3 Receipt completeness

**Claim:** Tool actions produce sufficient evidence for audit.

**Metric:** Coverage — percentage of executed tool calls with a valid `ToolInvocationReceipt`, percentage of tasks with a valid `ExecutionReceipt`, percentage of relay-mediated tasks carrying a non-empty `relay_task_id` (the relay enforces this with HTTP 400).

## 13.4 Audit-chain integrity

**Claim:** Policy decisions are tamper-evident.

**Metric:** A randomly modified `AuditEntry` breaks the hash chain in 100% of cases; a passing chain implies no entry was deleted, reordered, or rewritten.

## 13.5 Trust accumulation

**Claim:** Trust can be accumulated from signed evidence rather than opaque platform scoring.

**Metric:** Correlation between receipt-backed `TrustSemiring` scores and observed task success, dispute rate, or peer verification.

## 13.6 Routing quality

**Claim:** Semiring routing improves path selection across multiple objectives.

**Metric:** Comparison against heuristic baselines for trust, cost, latency, and reliability under simulated multi-agent delegation workloads.

## 13.7 Human governance usability

**Claim:** Surface-tension policy improves user comprehension of agent autonomy.

**Metric:** User ability to predict whether a given action will be allowed, blocked, or require approval.

These claims make the model testable rather than purely conceptual.

---

# 14. Security and Safety Implications

The Motebit model directly addresses several risks in agentic AI systems.

## 14.1 Prompt injection

A governed runtime separates untrusted external data from trusted instructions and routes every tool invocation through the policy gate. The `invocation_origin` discriminator prevents an injected prompt from impersonating an explicit user affordance: a button tap signs as `user-tap`, model-proposed actions sign as `ai-mediated`. Verifiers reject substitution.

## 14.2 Unauthorized action

Surface tension prevents the model from directly executing sensitive operations without boundary evaluation. Sensitivity routing fires _before_ any provider call, so a session tagged `medical | financial | secret` cannot reach a non-sovereign provider — no bytes leak.

## 14.3 Non-repudiation failure

Signed receipts and the hash-chained audit log make it possible to prove which agent identity authorized or executed an action, under what policy snapshot, with what tools.

## 14.4 Trust spoofing

Trust credentials and signed execution history reduce dependence on unverifiable reputation claims. Hardware attestation adds — never gates — score, so a software-only identity is still a verifiable identity.

## 14.5 Model-provider dependency

Because identity, memory, policy, and audit are interior to the runtime and cognition is supplied through an adapter boundary, an agent survives model-provider replacement: the persistent state is the asset; the model call is the commodity.

The design principle is:

> **Never let text alone become authority.**

Model output is proposal.
Policy is authority.
Receipts are proof.

---

# 15. Discussion: From AI Sessions to Agent Substrates

The fundamental shift is from transient interaction to persistent agency.

Most AI products today package intelligence as a service call. A governed agent runtime packages intelligence as an entity with continuity.

This creates a new architecture:

```txt
Model layer        → reasoning and generation
Tool layer         → external capability (MCP and equivalents)
Runtime layer      → identity, memory, policy, receipts, trust, audit
Settlement layer   → guest rails (relay-custody) + sovereign rails (agent-custody)
Network layer      → federation, delegation, relay-as-ledger
Interface layer    → embodied state and user-explicit affordances
```

Motebit occupies the runtime and settlement layers, with explicit interfaces above and below.

This is why the droplet metaphor is productive. It suggests a bounded entity that can exchange with the world without dissolving into it. A motebit does not merely answer. It persists, acts, remembers, proves, and compounds.

---

# 16. Conclusion

A motebit can be understood as a **droplet of intelligence under surface tension**. In computer-science terms, this means:

> **A persistent agent identity wrapped in a governed boundary, with memory and audit inside, tools and rails outside, ordinal policy at the membrane, paired receipts as proof, and trust as composable algebra.**

This reframes the AI agent from a stateless model interaction into a verifiable computational subject. The language model supplies cognition, but the motebit supplies identity, continuity, governance, accountability, and economic participation.

The central contribution is the boundary model. Intelligence alone is not enough. For agents to operate safely and meaningfully in the world, they require a membrane: a policy-governed interface between internal state and external action — and a custody-aware exterior that decides who holds what.

Thus:

```txt
A chatbot generates.
An automation executes.
A motebit persists, governs, proves, and compounds.
```

The future agent economy will not be built only from better models. It will be built from persistent, accountable runtimes that allow intelligence to become ownable, governable, and trustworthy.

That is the primitive.

---

# 17. Related Work

Motebit sits inside several established lineages and combines them. The novelty is the composition, not the ingredients.

**Decentralized identifiers and verifiable credentials.** W3C DID Core ([1]) defines decoupled cryptographic identifiers; W3C VC ([2]) defines tamper-resistant claims among issuers, holders, and verifiers. The motebit reference implementation adopts the `eddsa-jcs-2022` Data Integrity cryptosuite from the VC family but uses motebit-canonical envelopes rather than full VC documents, and uses the DID URI shape (`did:motebit:…`, `did:key:…`) as a string convention without implementing a W3C DID Core resolver. Identity here is operational continuity, not ideological decentralization.

**Object-capability security.** The lineage from Mark Miller's E language and the broader capability-based-security literature treats authority as an explicit, bearer-bound reference rather than an ambient permission attached to the actor. Motebit's `delegated_scope` field and the `invocation_origin` discriminator are ocap-shaped: a delegation token carries the specific tool scope it authorizes, and every receipt records whether a call originated from a user-tap affordance, the model's own loop, or a machine-driven trigger. The principle _"model output is proposal; policy is authority; receipts are proof"_ is the ocap claim restated for an LLM-mediated runtime.

**Tool protocols.** The Model Context Protocol ([3]) defines how servers expose tools that language models may invoke. MCP answers what the model can reach; motebit answers who is acting, under what authority, with what proof, on whose explicit behalf. The motebit runtime consumes MCP servers as one tool source among several, wrapping each call in identity, policy, audit, and receipt.

**Agent frameworks.** Frameworks such as LangChain, AutoGPT-style autonomous loops, and CrewAI-style multi-agent orchestration provide reasoning loops, tool-call scaffolding, and prompt-mediated planning. They are typically ephemeral — identity, memory, and policy live in application code, not in a portable runtime substrate. Motebit is positioned beneath such frameworks: a framework calls into the motebit runtime to obtain an identified, governed cognitive turn rather than re-deriving identity, memory, and policy per session.

**Workflow automation and robotic process automation.** Automation platforms execute scripted procedures with stored credentials and side effects, but typically without per-action policy gating, signed receipts, or trust accumulation across runs. Motebit replaces the "automation executes a script" model with "an identified agent acts under bounded authority and signs evidence of the act."

**Semiring path algorithms.** Mohri's algebraic framework for shortest-distance problems ([4]) generalizes routing under different objectives (max-trust, min-cost, max-reliability) by varying the semiring. The contribution here is application: agent delegation is treated as a path-algebra problem over verifiable state, not as a prompt-mediated heuristic.

**Tamper-evident logs.** The hash-chained policy audit log shares its structural lineage with Certificate Transparency, sigstore's Rekor, and earlier Merkle-log designs. Consolidation receipts use Merkle batching to anchor signed state-update artifacts. Both inherit the lineage's fundamental property: tampering, reordering, or deletion breaks the chain and is detectable by any verifier holding a recent root.

**Homeostatic systems metaphors.** The droplet / surface-tension framing has direct correspondence to the cell-membrane metaphor recurring in autonomic-computing and self-managing-systems literature. The contribution here is making the metaphor mechanical: surface tension is the policy gate, not analogy alone.

---

# References

- W3C. **Decentralized Identifiers (DIDs) v1.0.** Defines decentralized identifiers as verifiable identifiers decoupled from centralized registries and identity providers. ([W3C][1])
- W3C. **Verifiable Credentials Data Model v2.0.** Defines a data model for tamper-resistant, machine-verifiable claims among issuers, holders, and verifiers; specifies the `eddsa-jcs-2022` Data Integrity cryptosuite used by motebit's signature recipe. ([W3C][2])
- Model Context Protocol. **Tools Specification.** Defines how MCP servers expose tools that language models can invoke to interact with external systems. ([Model Context Protocol][3])
- Mohri, M. **Semiring Frameworks and Algorithms for Shortest-Distance Problems.** Establishes semiring-based algebraic frameworks for generalized path problems. ([NYU Computer Science][4])
- Hakim, D. / Motebit reference implementation. **`@motebit/protocol`, `@motebit/runtime`, `@motebit/policy`, `@motebit/semiring`, `@motebit/settlement-rails`.** Apache-2.0 protocol surface; BSL-1.1 runtime.

[1]: https://www.w3.org/TR/did-core/
[2]: https://www.w3.org/TR/vc-data-model-2.0/
[3]: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
[4]: https://cs.nyu.edu/~mohri/pub/jalc.pdf
