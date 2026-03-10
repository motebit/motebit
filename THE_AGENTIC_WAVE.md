# The Agentic Wave: OpenClaw, Claude, Perplexity — and Where Motebit Sits

_February 27, 2026_

---

## The Three Products

### OpenClaw

**What it is.** A free, open-source, local-first autonomous AI agent created by Peter Steinberger. Runs on your machine, connects through messaging apps (WhatsApp, Telegram, Signal, Discord, iMessage). LLM-agnostic. Built entirely with Claude Code. Originally published November 2025 as Clawdbot, renamed after Anthropic's legal threat to Moltbot, then OpenClaw. Steinberger joined OpenAI on February 14, 2026. The project is being transferred to an open-source foundation.

**The numbers.** 226,887 GitHub stars. 1.27 million weekly npm downloads. 135,000+ instances detected on the public internet. Spawned Moltbook — a social network exclusively for AI bots (1.6 million registered agents, over a million human observers).

**Where it succeeded:**

- Proved massive demand for local-first, LLM-agnostic agents
- Messaging-native UX — no new app to learn
- Markdown-based skill system (3,286+ skills on ClawHub)
- Called "what Apple Intelligence should have been" (Jake Quist, 518 points on Hacker News)

**Where it failed:**

- 512 vulnerabilities in a January 2026 audit, 8 critical
- CVE-2026-25253 (CVSS 8.8): one-click RCE via cross-site WebSocket hijacking
- 93.4% of exposed instances had authentication bypass conditions
- 824+ malicious skills on ClawHub — AMOS stealer payloads, typosquatting, no code signing, no publisher identity verification
- Plaintext credential storage — API keys, memories, conversations stored as raw Markdown and JSON on disk
- No cryptographic identity, no signed tokens, no agent verification
- No policy gate — ambient authority, the agent inherits all OS-level permissions
- Gartner characterized it as "a dangerous preview of agentic AI" with "insecure by default risks"

**Sources:** Wikipedia (OpenClaw), CNBC, TechCrunch, Cisco AI Security Blog, Kaspersky, Infosecurity Magazine, Censys, CyberPress, Pragmatic Engineer, Trend Micro, Giskard.

---

### Claude Computer Use / Cowork

**What it is.** Anthropic's screenshot-action-screenshot loop. Claude sees your screen, controls mouse and keyboard, executes multi-step desktop tasks. Launched October 2024 in beta with Claude 3.5 Sonnet. Consumer version "Cowork" launched January 2026 on macOS, February 2026 on Windows. Anthropic acquired Vercept (desktop perception startup, $50M raised) on February 25, 2026 to accelerate the capability.

**Performance trajectory (OSWorld benchmark):**

| Date      | Score | Model                      |
| --------- | ----- | -------------------------- |
| Oct 2024  | 14.9% | Claude 3.5 Sonnet          |
| Feb 2025  | 28.0% | Claude 3.7 Sonnet          |
| Mid 2025  | 42.2% | Claude Sonnet 4.5          |
| Late 2025 | 61.4% | Claude Sonnet 4.5 improved |
| Current   | 72.5% | Latest Sonnet              |

**Where it succeeded:**

- First frontier model to offer general-purpose computer use
- Fastest improvement curve in the space — 5x in one year
- MCP as an open protocol for tool integration
- Enterprise adoption: Cognizant (350K associates), Accenture (30K), TELUS (57K)
- Claude Code revenue up 5.5x by July 2025

**Where it failed:**

- Cowork file exfiltration (PromptArmor, January 2026): indirect prompt injection made Claude `curl` user files to an attacker's account with no human approval required. Vulnerability reported via HackerOne in October 2025. Anthropic launched Cowork anyway.
- Claude Desktop Extensions: CVSS 10/10. Unsandboxed, full system privileges. A malicious calendar event combined with a benign prompt triggered arbitrary code execution.
- Claude Code CVEs: malicious hooks in project config auto-execute on open (CVE-2025-59536); config file redirects API URL to attacker server, leaking API keys (CVE-2026-21852)
- Screenshots sent to Anthropic servers. Not covered by Zero Data Retention. 30-day minimum retention.
- No sovereign identity — the agent is a session with an API key that Anthropic can revoke
- Memory is markdown files (CLAUDE.md). No structured graph, no decay, no sensitivity classification, no deletion certificates.

**Sources:** Anthropic blog, Claude API docs, WorkOS, Prompt Security, PromptArmor, The Register, Check Point Research, SecurityWeek, LayerX Security, Bank Info Security, VentureBeat.

---

### Perplexity Computer

**What it is.** Multi-model agentic orchestration. 19 models (Claude Opus 4.6, GPT-5.2, Gemini, Grok, Veo 3.1, Nano Banana, 13 unnamed). Accepts a high-level objective, decomposes into subtasks, assigns best model per subtask, runs them in parallel in cloud sandboxes. Launched February 25, 2026. Built in approximately 2 months. $200/month (Max tier).

Also includes the Comet browser (Chromium-based AI browser, launched July 2025, now free) and an announced Comet hardware device ($699 desktop with "Comet OS").

**Where it succeeded:**

- Launch day was Perplexity's highest-ever revenue day
- Multi-model orchestration eliminates switching between tools
- Long-running tasks (hours/days)
- 400+ app integrations
- Parallel research across 7 search types simultaneously
- ~33 million monthly active users, ~780 million queries/month (platform-wide)

**Where it failed:**

- CometJacking (Brave, July 2025): indirect prompt injection in the Comet browser. Researchers extracted email and OTP from a user's Gmail inbox, posted both to Reddit. Traditional browser protections (same-origin policy, CORS) "effectively useless."
- Canceled a live demo of Computer because flaws were found hours before the event
- Comet agent described as "wildly inconsistent" — stuck in loops, hallucinated bookings, slower than manual
- Cloud-only. All data processes on Perplexity's servers. No local execution option.
- No sovereign identity. No cryptographic anchoring. No export mechanism for agent state or memory.
- CEO Aravind Srinivas stated they want browser data "to better understand you" for profiling and potentially advertising
- The only non-Chinese AI platform seeing stagnant growth at the start of 2026

**Sources:** VentureBeat, Semafor, TechCrunch, Brave security blog, TIME, Perplexity blog, Tuta, Help Net Security, PYMNTS, SitePoint.

---

## The Common Gap

Strip away the branding and the numbers. All three share the same structural absence:

| Dimension                                  | OpenClaw                      | Claude Computer Use                 | Perplexity Computer               |
| ------------------------------------------ | ----------------------------- | ----------------------------------- | --------------------------------- |
| **Who owns the identity?**                 | Nobody (no identity system)   | Anthropic (API key)                 | Perplexity (account)              |
| **Cryptographic anchoring**                | None                          | None                                | None                              |
| **Persistent memory**                      | Plaintext files, unstructured | Markdown files, unstructured        | Cloud-stored, platform-controlled |
| **Memory governance**                      | None                          | None                                | None                              |
| **Trust accumulation**                     | None                          | None                                | None                              |
| **Policy gate**                            | None (ambient authority)      | Anthropic's classifier (not user's) | None documented                   |
| **Audit trail**                            | None                          | None                                | None                              |
| **Deletion certificates**                  | None                          | None                                | None                              |
| **Sensitivity classification**             | None                          | None                                | None                              |
| **Agent proves identity to third parties** | No                            | No                                  | No                                |
| **User can leave with their agent**        | Files on disk (no integrity)  | Nothing portable                    | Nothing portable                  |
| **Intelligence is pluggable**              | Yes                           | No (Claude only)                    | Partially (Perplexity selects)    |

Intelligence is abundant. Identity is absent. Every product in this wave provides a more capable agent. None of them provide a more sovereign one.

---

## Cross-Reference Against Motebit

### 1. Cryptographic Identity — Built

| Gap in the wave             | Motebit                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No agent identity           | Ed25519 keypair generated on first launch, private key in OS keyring (desktop) or encrypted with PBKDF2 (CLI) |
| No device registration      | Multi-device registration with Ed25519 signed tokens (5-min expiry)                                           |
| Agent can't prove who it is | `motebit.md` — cryptographically signed identity file, verifiable by anyone via `@motebit/verify`             |
| No public standard          | `npm create motebit` generates signed identity. `identity-v1.md` spec published.                              |
| Identity tied to provider   | Identity is provider-independent. Intelligence is pluggable (CloudProvider, OllamaProvider, HybridProvider).  |

OpenClaw has 226K stars and no identity system. The agentic surface just shipped (signed execution receipts, verifiable by any third party without trusting the relay) is the protocol answer for when agents need to prove what they did.

### 2. Trust Accumulation — Built

| Gap in the wave               | Motebit                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Memory is flat files          | Semantic memory graph with cosine similarity retrieval, half-life decay (7d default), graph edges linking related memories |
| No sensitivity classification | 5 levels (none / personal / medical / financial / secret) with retention rules per level                                   |
| No deletion certificates      | SHA-256 hashed deletion certificates with audit trail                                                                      |
| No event sourcing             | Immutable append-only log with version clocks, conflict detection, compaction after snapshot                               |
| No audit trail                | Full audit log — every tool call, every policy decision (allowed / denied / requires_approval)                             |
| Trust doesn't compound        | Trust mode in state vector, behavioral history, accumulated memory that makes the agent more capable over time             |

### 3. Governance at the Boundary — Built

| Gap in the wave                                         | Motebit                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Ambient authority (OpenClaw)                            | PolicyGate with tool approval, budgets, risk thresholds                          |
| No user-controlled governance (Claude)                  | MemoryGovernor with sensitivity-aware filtering                                  |
| No policy gate (Perplexity)                             | Operator mode (PIN-protected), governance thresholds from `motebit.md`           |
| No injection defense                                    | Injection defense in policy layer, external data boundary marking in MCP client  |
| Skills marketplace poisoning (OpenClaw, 824+ malicious) | MCP manifest pinning — SHA-256 hash of tool manifest, trust revoked on mismatch  |
| No code signing for extensions                          | `motebit.md` identity files are cryptographically signed and publicly verifiable |

### 4. The Agentic Surface — Just Shipped

The agent protocol committed February 26, 2026 (`1b9c1f1`) addresses the question none of the three products answer: how do agents call each other with verifiable proof?

- **Signed execution receipts** (Ed25519) — the caller verifies the result with the motebit's public key. No trust in the relay required.
- **Canonical JSON serialization** — deterministic signing, tamper-evident
- **Task mailbox pattern** — the relay stores tasks and pushes via WebSocket, the motebit decides whether to execute. Sovereignty preserved.
- **Wall-clock timeout** — bounded execution via AbortController, no runaway tasks
- **Isolated context** — agent tasks run in fresh conversation context, user context restored after

None of the three products have a protocol where the agent produces cryptographic proof of what it did and any third party can verify it without trusting the intermediary.

---

## What Motebit Doesn't Have

| Dimension                      | Status                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Distribution**               | Zero public users. OpenClaw has 226K GitHub stars. This is the existential gap.                                                                            |
| **Computer use**               | Not built. Claude is at 72.5% on OSWorld. Intentionally outside scope — metabolic principle says absorb capabilities through adapters, don't rebuild them. |
| **Multi-model orchestration**  | Single provider at a time (Cloud / Ollama / Hybrid fallback). Perplexity routes to 19 models per task.                                                     |
| **Browser automation**         | Not built. Comet and Operator do this natively.                                                                                                            |
| **Managed app integrations**   | MCP-based, not a marketplace. Perplexity has 400+ integrations.                                                                                            |
| **Long-running orchestration** | Goal scheduler exists (60s tick), but not hours/days-scale cloud orchestration.                                                                            |

---

## Synthesis

The three products validate motebit's thesis by negative example:

**OpenClaw** proves the demand is real. 226K stars in weeks for a local-first, LLM-agnostic agent. But it's a security catastrophe — no identity, no governance, no trust layer. 93.4% authentication bypass. 824 malicious skills. Plaintext everything. The body has no surface tension.

**Claude Computer Use** proves the intelligence is improving fast. 14.9% to 72.5% in one year. But the intelligence is rented, the identity resets every session, and the governance is Anthropic's, not the user's. They shipped Cowork with a known file exfiltration vulnerability because the business priority outweighed the security concern.

**Perplexity Computer** proves multi-model orchestration works. 19 models, parallel subtasks, cloud sandboxes. But everything lives on Perplexity's servers, the CEO wants your browsing data for profiling, and there's no export mechanism for your agent's accumulated state. The agent is a subscription, not a sovereign entity.

**What none of them have built:**

1. A cryptographic entity the user owns independently of any provider
2. A memory system where trust compounds instead of resetting
3. A governance layer the user controls at the boundary
4. A protocol where agents produce verifiable proof of execution

**What motebit has built:** exactly those four things.

**The open question:** whether the security disasters create the demand before the window closes. The infrastructure is complete. The distribution is zero. The market is learning — through breaches, through stolen credentials, through malicious skills, through file exfiltration — that intelligence without identity is dangerous. The question is timing.
