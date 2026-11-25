/**
 * Tamper checks for "recovered approvals carry their relay" (design
 * runtime-relay-binding 4b rev 10.1, PR 1: §2 "Recovered approvals carry
 * their relay", "The runtime refuses, not only the gate", "invokeLocalTool
 * takes approvedUnderRelay"; §3 change 1). Each entry removes one piece of
 * the fix and must turn a BEHAVIOUR test red:
 *
 *   - ai-core: either `approval_request` emit site loses its stamp;
 *   - runtime: the loop deps lose the identity or the relay-bound flag; an
 *     unpinnable URL compared by raw string; `invokeLocalTool`'s carried-
 *     approval check removed, a missing relay accepted, the key or the pin
 *     key ignored, the generation not passed to the handler; the delegation
 *     tool registered without the flag; `replace` dropping the flag;
 *   - persistence: the relay columns not written / mis-read;
 *   - CLI: either writer reading the binding instead of the chunk; the
 *     drain check removed, an unregistered relay-bound tool or an old row
 *     not refused, `approvedUnderRelay` not passed, and the check run before
 *     the goal tools are registered.
 *
 *   node scripts/tampers/runtime-relay-drain.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOOP = "packages/ai-core/src/loop.ts";
const RUNTIME = "packages/runtime/src/motebit-runtime.ts";
const BINDING = "packages/runtime/src/relay-binding.ts";
const REGISTRY = "packages/runtime/src/simple-tool-registry.ts";
const ID = "packages/runtime/src/interactive-delegation.ts";
const STORE = "packages/persistence/src/index.ts";
const SCHED = "apps/cli/src/scheduler.ts";

const T_STAMP = "src/__tests__/loop-approval-relay-stamp.test.ts";
const T_CARRIED = "src/__tests__/relay-binding-carried-approval.test.ts";
const T_COLUMNS = "src/__tests__/approval-relay-columns.test.ts";
const T_DRAIN = "src/__tests__/scheduler-drain-relay.test.ts";

const STAMP = "approval_request relay stamp";
const STAMP_RED = "stamps the relay identity read at the pause and the registry's relay-bound flag";
const CARRIED = "invokeLocalTool with a carried approval for a relay-bound tool";
const STAMP_RT = "the relay stamp on approval_request";
const ROWS = "approval rows are stamped from the chunk";
const DRAIN = "the drain runs a relay-bound approval only under its relay";

const TAMPERS: TamperEntry[] = [
  // ── ai-core: the stamp at both emit sites ──
  {
    name: "the policy-gate pause emits no relay stamp",
    edits: [
      {
        file: LOOP,
        from: "            turn_id: turnCtx.turnId,\n            ...approvalRelayStamp(deps, toolCall.name),\n",
        to: "            turn_id: turnCtx.turnId,\n",
      },
    ],
    pkg: "@motebit/ai-core",
    test: T_STAMP,
    red: `${STAMP} (policy-gate pause) ${STAMP_RED}`,
  },
  {
    name: "the legacy requiresApproval pause emits no relay stamp",
    edits: [
      {
        file: LOOP,
        from: "          args: toolCall.args,\n          ...approvalRelayStamp(deps, toolCall.name),\n",
        to: "          args: toolCall.args,\n",
      },
    ],
    pkg: "@motebit/ai-core",
    test: T_STAMP,
    red: `${STAMP} (legacy requiresApproval pause) ${STAMP_RED}`,
  },
  {
    name: "a deps object without the callback stamps no relay (not null)",
    edits: [
      {
        file: LOOP,
        from: "  const relay = deps.relayIdentity?.() ?? null;\n  return {\n    relay: relay == null ? null : { pinKey: relay.pinKey, publicKey: relay.publicKey },\n",
        to: "  const relay = deps.relayIdentity?.() ?? null;\n  return {\n    relay: (relay == null ? undefined : { pinKey: relay.pinKey, publicKey: relay.publicKey }) as ApprovalRelayIdentity | null,\n",
      },
    ],
    pkg: "@motebit/ai-core",
    test: T_STAMP,
    red: `${STAMP} (policy-gate pause) stamps relay null and no relay_bound when the deps carry no callbacks`,
  },

  // ── runtime: the loop deps the stamp reads ──
  {
    name: "the runtime's loop deps carry no relay identity",
    edits: [
      { file: RUNTIME, from: "        relayIdentity: () => this.getRelayIdentity(),\n", to: "" },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${STAMP_RT} a turn's delegate_to_agent pause names the bound relay and is relay-bound`,
  },
  {
    name: "the runtime's loop deps carry no relay-bound flag",
    edits: [
      {
        file: RUNTIME,
        from: "        isRelayBoundTool: (name) => this.toolRegistry.isRelayBound(name),\n",
        to: "",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${STAMP_RT} a local tool's pause names the relay and is not relay-bound`,
  },
  {
    name: "an unpinnable relay is identified by its raw URL",
    edits: [
      {
        file: BINDING,
        from: "  if (pinKey == null) return null;\n  return { pinKey, publicKey: binding.relayPublicKey ?? null };\n",
        to: "  return { pinKey: pinKey ?? binding.syncUrl, publicKey: binding.relayPublicKey ?? null };\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} an unpinnable binding never matches: refused`,
  },

  // ── runtime: invokeLocalTool refuses a carried approval elsewhere ──
  {
    name: "invokeLocalTool runs a carried approval for a relay-bound tool unchecked",
    edits: [
      {
        file: RUNTIME,
        from: "    if (options.humanApproved === true && this.toolRegistry.isRelayBound(name)) {\n",
        to: "    if (options.humanApproved === true && name === ('' as string)) {\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} humanApproved with no approvedUnderRelay: refused relay_changed, handler not invoked`,
  },
  {
    name: "invokeLocalTool accepts a carried approval that names no relay",
    edits: [
      {
        file: RUNTIME,
        from: "      if (!sameRelayIdentity(options.approvedUnderRelay, relayIdentityOf(this._relayBinding))) {\n",
        to: "      if (\n        options.approvedUnderRelay != null &&\n        !sameRelayIdentity(options.approvedUnderRelay, relayIdentityOf(this._relayBinding))\n      ) {\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} humanApproved with no approvedUnderRelay: refused relay_changed, handler not invoked`,
  },
  {
    name: "relay identity ignores the pinned key",
    edits: [
      {
        file: BINDING,
        from: "  return a.pinKey === b.pinKey && (a.publicKey ?? null) === (b.publicKey ?? null);\n",
        to: "  return a.pinKey === b.pinKey;\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} approvedUnderRelay naming the bound relay with another key: refused`,
  },
  {
    name: "relay identity ignores the pin key",
    edits: [
      {
        file: BINDING,
        from: "  return a.pinKey === b.pinKey && (a.publicKey ?? null) === (b.publicKey ?? null);\n",
        to: "  return (a.publicKey ?? null) === (b.publicKey ?? null);\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} approvedUnderRelay naming another relay: refused before execute, handler not invoked`,
  },
  {
    name: "invokeLocalTool does not hand the handler the approved generation",
    edits: [
      {
        file: RUNTIME,
        from: "      result = await this.toolRegistry.execute(name, args, approvedCall ?? OWNER_CALL);\n",
        to: "      result = await this.toolRegistry.execute(name, args, OWNER_CALL);\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} a rebind after the comparison is refused by the handler: nothing reaches B`,
  },
  {
    name: "delegate_to_agent is registered without the relay-bound flag",
    edits: [
      {
        file: ID,
        from: "    this.deps.toolRegistry.registerRelayBound(\n      {\n        name: TOOL_NAME,\n",
        to: "    this.deps.toolRegistry.register(\n      {\n        name: TOOL_NAME,\n",
      },
    ],
    pkg: "@motebit/runtime",
    test: T_CARRIED,
    red: `${CARRIED} humanApproved with no approvedUnderRelay: refused relay_changed, handler not invoked`,
  },
  {
    name: "replace drops the relay-bound flag",
    edits: [
      {
        file: REGISTRY,
        from: "    const relayBound = this.#tools.get(tool.name)?.relayBound;\n",
        to: "    const relayBound = undefined as true | undefined;\n",
      },
    ],
    pkg: "motebit",
    rebuild: ["@motebit/runtime"],
    test: T_DRAIN,
    red: `${DRAIN} a row mislabelled not relay-bound for a relay-bound tool: the runtime refuses it`,
  },

  // ── persistence: the columns ──
  {
    name: "the SQLite approval store drops relay_pin_key",
    edits: [{ file: STORE, from: "      item.relay_pin_key,\n", to: "      null,\n" }],
    pkg: "@motebit/persistence",
    test: T_COLUMNS,
    red: "approval_queue relay columns (migration #54) records and reads the relay and the relay-bound flag",
  },
  {
    name: "the SQLite approval store reads relay_bound false as true",
    edits: [
      {
        file: STORE,
        from: "    relay_bound: row.relay_bound == null ? null : row.relay_bound !== 0,\n",
        to: "    relay_bound: row.relay_bound == null ? null : true,\n",
      },
    ],
    pkg: "@motebit/persistence",
    test: T_COLUMNS,
    red: "approval_queue relay columns (migration #54) records and reads the relay and the relay-bound flag",
  },

  // ── CLI: the writers copy from the chunk ──
  {
    name: "the turn writer reads the binding instead of the chunk",
    edits: [
      {
        file: SCHED,
        from: "            ...relayColumnsOf(chunk),\n",
        to: "            ...relayColumnsOf({ ...chunk, relay: this.runtime.getRelayIdentity() }),\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${ROWS} turn writer: a rebind between the pause and the write leaves the row naming A`,
  },
  {
    name: "the plan-step writer reads the binding instead of the chunk",
    edits: [
      {
        file: SCHED,
        from: "            ...relayColumnsOf(innerChunk),\n",
        to: "            ...relayColumnsOf({ ...innerChunk, relay: this.runtime.getRelayIdentity() }),\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${ROWS} plan-step writer: a rebind between the pause and the write leaves the row naming A`,
  },

  // ── CLI: the drain ──
  {
    name: "the drain's relay check is removed",
    edits: [
      {
        file: SCHED,
        from: "        if (this.recoveredRelayRefused(item, approvedUnder)) {\n",
        to: "        if (item.tool_name === ('' as string)) {\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${DRAIN} recorded under A, restarted bound to B: denied relay_changed, handler not invoked`,
  },
  {
    name: "the drain runs a relay-bound row whose tool is unregistered",
    edits: [
      {
        file: SCHED,
        from: '    if (item.relay_bound === true) {\n      if (status === "unregistered") return true;\n',
        to: "    if (item.relay_bound === true) {\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${DRAIN} a relay-bound row whose tool is unregistered: the drain's own relay_changed verdict`,
  },
  {
    name: "the drain runs an old row whose tool is unregistered",
    edits: [
      {
        file: SCHED,
        from: '    if (item.relay_bound == null) {\n      if (status === "unregistered") return true;\n',
        to: "    if (item.relay_bound == null) {\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${DRAIN} an old row (relay_bound unknown) whose tool is unregistered: denied relay_changed`,
  },
  {
    name: "the drain runs an old row whose tool is relay-bound now",
    edits: [
      {
        file: SCHED,
        from: '      if (status === "relay_bound") {\n        return !sameRelayIdentity(approvedUnder, this.runtime.getRelayIdentity());\n      }\n',
        to: "",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${DRAIN} an old row (relay_bound unknown) for a tool relay-bound now: denied`,
  },
  {
    name: "the drain does not pass approvedUnderRelay",
    edits: [
      {
        file: SCHED,
        from: "            ...(approvedUnder != null ? { approvedUnderRelay: approvedUnder } : {}),\n",
        to: "",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: `${DRAIN} recorded under A, restarted bound to A: runs`,
  },
  {
    name: "the drain's relay check runs before the goal tools are registered",
    edits: [
      {
        file: SCHED,
        from: "      this.registerGoalTools();\n      let result: { ok: boolean; data?: unknown; error?: string };\n      let relayRefused = false;\n",
        to: "      const refusedEarly = this.recoveredRelayRefused(item, recoveredApprovalRelay(item));\n      this.registerGoalTools();\n      let result: { ok: boolean; data?: unknown; error?: string };\n      let relayRefused = false;\n",
      },
      {
        file: SCHED,
        from: "        if (this.recoveredRelayRefused(item, approvedUnder)) {\n",
        to: "        if (refusedEarly) {\n",
      },
    ],
    pkg: "motebit",
    test: T_DRAIN,
    red: "recovered goal-tool approvals run as on main (Cautious preset) create_sub_goal from before the relay columns: runs",
  },
];

void runTampers(TAMPERS, { root: ROOT });
