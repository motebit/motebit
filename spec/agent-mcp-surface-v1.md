# motebit/agent-mcp-surface@1.0

**Status:** Draft
**Version:** 1.0
**Date:** 2026-04-24

---

## 1. Overview

Every motebit running an MCP server exposes a small set of canonical tool names that constitute the **agent-MCP surface** — the face one motebit shows to another over MCP. Without a pinned vocabulary, two implementations cannot agree on what tools each exposes by name: a sibling motebit that exposes `submit_task` instead of `motebit_task`, or `who_are_you` instead of `motebit_identity`, fractures federation at the call boundary.

This specification pins the **tool names and input schemas** of the agent-MCP surface so any conforming motebit (the reference TypeScript implementation, a future Rust port, a federation peer running a different stack) speaks the same vocabulary. The output payloads of these tools point into existing specs — `ExecutionReceipt` (`execution-ledger-v1.md` §11), `VerifiablePresentation` (`credential-v1.md` §2.2), `AgentServiceListing` (`delegation-v1.md` §7.1) — so this spec only adds what is currently un-pinned: the tool names themselves, their argument shapes, and the conformance profile that says when each MUST be exposed.

**Design principles:**

- **Names are the surface.** Field shapes inside arguments are pinned for portability, but the load-bearing promise is the tool name. Renaming a tool here is a wire break and requires a new spec version.
- **Profile-based conformance.** Not every motebit exposes every tool. The `motebitType: "personal" | "service" | "collaborative"` field on `McpServerConfig` (`@motebit/mcp-server`) selects which tools are required. See §4.
- **Output shapes point into existing specs.** `motebit_task` returns an `ExecutionReceipt` from execution-ledger-v1; `motebit_credentials` returns a `VerifiablePresentation` from credential-v1. This spec pins entry points; artifact wire formats live where they already live.
- **Optional tools are still pinned by name.** If a motebit exposes A2A chat at all, it MUST be at `motebit_query` — not `chat`, not `ask`. The spec pins the canonical name; the implementation chooses whether to register it.

---

## 2. Scope and Non-Scope

**In scope:**

- The foundation law every agent-MCP-surface implementation must satisfy (§3).
- The conformance profile mapping `motebitType` to required/optional tools (§4).
- The canonical tool name vocabulary (§5).
- Tool input schemas (§5).
- Sensitivity boundary on `motebit_remember` (§6).

**Out of scope:**

- Output payload shapes — those live in their owning specs (`execution-ledger-v1.md`, `credential-v1.md`, `delegation-v1.md` §7.1, `identity-v1.md`).
- Transport — MCP stdio vs. Streamable HTTP. The reference implementation supports both; the surface is identical.
- Authentication — bearer tokens, motebit signed tokens. Specified by `auth-token-v1.md`.
- Builtin tool surfaces (`web_search`, `read_url`, `read_file`, `shell_exec`, etc.). Those are local tools registered into the runtime; only the canonical delegated capabilities cross delegation boundaries (`delegation-v1.md`).
- Resources and prompts (`motebit://identity`, `motebit://state`, `motebit://memories`, MCP `prompt` registrations). v1 covers tools only; resources/prompts are a v1.1 extension.

---

## 3. Foundation Law

### §3.1 Name-stability invariant

The eight tool names listed in §5 are binding vocabulary. A conforming motebit MUST register exposed tools under exactly these names. Renaming is a wire break and requires a new spec version.

### §3.2 Universal-required invariant

Every motebit MCP server, regardless of `motebitType`, MUST register `motebit_identity` and `motebit_tools`. A motebit that responds to MCP `tools/list` without these two names is non-conformant.

### §3.3 Profile-required invariant

A motebit configured as `motebitType: "service"` MUST register `motebit_task`, `motebit_service_listing`, and `motebit_credentials`. The first is the delegation entry point; the second is discovery; the third proves reputation. Service motebits without all three break the routing surface.

### §3.4 Optional-tool name pin

`motebit_query`, `motebit_remember`, and `motebit_recall` are optional in any profile. If exposed at all, they MUST be exposed under these names. A motebit that exposes A2A chat as `chat` instead of `motebit_query` is non-conformant even though chat exposure itself is optional.

### §3.5 Sensitivity floor on `motebit_remember`

External callers MUST NOT be permitted to store memories at sensitivity levels `personal`, `medical`, `financial`, or `secret`. The handler MUST reject such writes with a clear error. This is the same floor enforced on memory ingress everywhere else in the protocol.

---

## 4. Conformance Profiles

The `motebitType` field on `McpServerConfig` (`@motebit/mcp-server`) takes one of three values: `"personal"`, `"service"`, `"collaborative"`. Each value induces a required-tool set:

| Tool                      | personal | service      | collaborative |
| ------------------------- | -------- | ------------ | ------------- |
| `motebit_identity`        | required | required     | required      |
| `motebit_tools`           | required | required     | required      |
| `motebit_task`            | optional | **required** | optional      |
| `motebit_service_listing` | optional | **required** | optional      |
| `motebit_credentials`     | optional | **required** | optional      |
| `motebit_query`           | optional | optional     | optional      |
| `motebit_remember`        | optional | optional     | optional      |
| `motebit_recall`          | optional | optional     | optional      |

Conformance is verified by a tools/list query against the running server: every "required" entry for the declared profile MUST appear by name, with the input schema in §5.

---

## 5. Tool Vocabulary

#### Tools (foundation law)

The eight tool names every conforming motebit MCP server uses for the named role. Renaming any of these is a wire break.

- `motebit_identity` — return this motebit's identity (motebit_id, public key, did, optional motebit_type). Output shape: implementation MAY return either the raw identity file content or a structured `{ motebit_id, public_key, did, motebit_type? }` object.
- `motebit_tools` — list available tools with risk levels. Output shape: array of `{ name, description, risk }`.
- `motebit_task` — submit an autonomous task; returns a signed `ExecutionReceipt` (`execution-ledger-v1.md` §11). Input schema: §5.1.
- `motebit_service_listing` — return this motebit's `AgentServiceListing` (`delegation-v1.md` §7.1).
- `motebit_credentials` — return a signed `VerifiablePresentation` (`credential-v1.md` §2.2) carrying gradient/reputation credentials.
- `motebit_query` — A2A free-form chat. Input: `{ message: string }`. Output: `{ response: string, memories_formed: number }`.
- `motebit_remember` — A2A memory write at a permitted sensitivity. Input: §5.2. Output: `{ node_id: string }`.
- `motebit_recall` — A2A semantic memory search. Input: `{ query: string, limit?: number }`. Output: array of memory hits with `{ content, confidence, similarity, half_life_days?, memory_type?, created_at? }`.

### 5.1 — `motebit_task` input

#### Wire format (foundation law)

```
MotebitTaskInput {
  prompt:                 string      // Required, non-empty
  delegation_token:       string      // Optional: signed delegation token (JSON) authorizing the task within a scope
  required_capabilities:  string[]    // Optional: capability names required for the task
  relay_task_id:          string      // Optional: relay-assigned task ID for economic binding
}
```

When `delegation_token` is present:

- The token MUST verify (`@motebit/encryption.verifyDelegation`).
- `required_capabilities` MUST be a subset of the token's parsed scope (`@motebit/encryption.parseScopeSet`); a wildcard `*` scope passes any capability set.
- The token's `scope` is forwarded to the agent loop as `delegatedScope` and included in the signed receipt.

Receipts MUST include `task_id`, `motebit_id`, `signature`, and `status`. A response without these is malformed and MUST be rejected by the caller.

### 5.2 — `motebit_remember` input

#### Wire format (foundation law)

```
MotebitRememberInput {
  content:      string      // Required: the content to remember
  sensitivity:  string      // Optional: sensitivity level
}
```

`sensitivity` is one of `none | personal | medical | financial | secret`. Per §3.5, external callers attempting to write `personal | medical | financial | secret` MUST be rejected.

---

## 6. Sensitivity

The agent-MCP surface enforces the same emitter/forwarder/storage sensitivity model as the rest of the protocol. The only surface-specific rule is §3.5: external write rejection at sensitivity ≥ `personal`. Reads (`motebit_recall`) follow the runtime's policy gate, which by default returns memories at `none` and `personal` and excludes `medical | financial | secret`.

---

## 7. Storage (reference convention — non-binding)

The reference implementation registers tools through `McpServerAdapter.registerSyntheticToolsOn` (`@motebit/mcp-server/src/index.ts`). Each tool is conditionally registered based on the presence of a backing dependency (`MotebitServerDeps.{sendMessage, storeMemory, queryMemories, handleAgentTask, getCredentials, getServiceListing}`). Universal-required tools (`motebit_identity`, `motebit_tools`) are registered unconditionally.

Alternative implementations MAY use a different registration mechanism. The conformance check in §4 is on the running tools/list response, not on the source code that produced it.

---

## 8. Conformance

A motebit is conformant with `motebit/agent-mcp-surface@1.0` if all of:

1. The server's MCP `tools/list` response includes every required-for-profile name (§4).
2. Each registered tool's input schema is structurally identical to the binding shape in §5 (extra fields on optional tools are tolerated; missing required fields are not).
3. `motebit_remember`, when registered, rejects writes at sensitivity ≥ `personal` from external callers (§3.5).
4. `motebit_task`, when registered, returns an `ExecutionReceipt` carrying `task_id`, `motebit_id`, `signature`, `status` and verifying under `execution-ledger-v1.md` §11.4.

---

## 9. Relationship to Other Specs

| Spec                  | Relationship                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------ |
| identity-v1.0         | `motebit_identity` exposes the identity surface defined here.                              |
| execution-ledger-v1.0 | `motebit_task` returns the `ExecutionReceipt` shape pinned in §11.                         |
| delegation-v1.0       | `motebit_service_listing` returns the `AgentServiceListing` pinned in §7.1.                |
| credential-v1.0       | `motebit_credentials` returns the `VerifiablePresentation` pinned in §2.2.                 |
| memory-delta-v1.0     | `motebit_remember` writes produce `memory_formed` events at the sensitivity floor in §3.5. |
| auth-token-v1.0       | All tools are reachable behind motebit signed tokens or operator-configured bearer tokens. |

---

## Change Log

- **1.0 (2026-04-24)** — Initial draft. Pins the eight canonical agent-MCP surface tool names and their input schemas. Introduces profile-based conformance via `motebitType`.
