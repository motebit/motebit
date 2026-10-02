#!/usr/bin/env node
/**
 * Tamper checks for #981 (a task:dispatch token never authenticates the
 * transport; the relay authenticates as itself with a relay-signed mcp:call
 * token, fresh per request).
 *
 * Each entry is (file, text to revert, test expected red): removing the fix —
 * one or more exact edits — and rebuilding any package whose `dist` the test
 * reads (the relay's tests import `@motebit/mcp-server` from dist) must turn
 * the named test file RED. The shared runner (scripts/lib/tamper-runner.ts)
 * runs the entries in parallel, each in an isolated copy of the tree; an edit
 * whose text is not found exactly once, or a rebuild that fails, is a failure
 * too. Exit 1 if any tamper stays green or cannot apply.
 *
 *   node packages/mcp-server/tamper/dispatch-presenter-981.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");

const SERVER = "packages/mcp-server/src/index.ts";
const ROUTING = "services/relay/src/task-routing.ts";
const TASKS = "services/relay/src/tasks.ts";
const UNIT = { pkg: "@motebit/mcp-server", test: "src/__tests__/relay-bearer.test.ts" };
const R2 = { pkg: "@motebit/mcp-server", test: "src/__tests__/relay-bearer-981-r2.test.ts" };
const HARNESS = {
  pkg: "@motebit/relay",
  test: "src/__tests__/dispatch-presenter-981.test.ts",
  rebuild: ["@motebit/mcp-server"],
};
const FORWARD = { pkg: "@motebit/relay", test: "src/__tests__/task-dispatch-token.test.ts" };

// The worker's pre-#981 behaviour: a relay-signed task:dispatch token bound to
// this worker is served as the relay.
const ACCEPT_DISPATCH_AS_RELAY = {
  file: SERVER,
  from: "    if (payload.aud === TASK_DISPATCH_AUDIENCE) {\n      return refuse(",
  to:
    "    if (payload.aud === TASK_DISPATCH_AUDIENCE && payload.mid === this.deps.motebitId) {\n" +
    '      return {\n        kind: "relay",\n' +
    "        caller: { motebitId: `relay:${payload.did}`, trustLevel: AgentTrustLevel.Verified },\n" +
    "      };\n    }\n" +
    "    if (payload.aud === TASK_DISPATCH_AUDIENCE) {\n      return refuse(",
};

const TAMPERS = [
  // --- worker: the transport door
  {
    name: "worker: a task:dispatch bearer is served as the relay (unit)",
    ...UNIT,
    edits: [ACCEPT_DISPATCH_AS_RELAY],
  },
  {
    name: "worker: a task:dispatch bearer is served as the relay (end-to-end matrix)",
    ...HARNESS,
    edits: [ACCEPT_DISPATCH_AS_RELAY],
  },
  {
    name: "worker: the relay bearer's claims (binding, window) are not checked",
    ...UNIT,
    edits: [
      {
        file: SERVER,
        from: "    if (!verdict.ok) return refuse(`relay bearer: ${verdict.reason}`);\n",
        to: "",
      },
    ],
  },
  {
    name: "worker: the relay bearer is not single-use",
    ...UNIT,
    edits: [
      {
        file: SERVER,
        from: '    if (claimed !== "accepted") return refuse(`relay bearer: ${replayRefusalReason(claimed)}`);\n',
        to: "",
      },
    ],
  },
  {
    name: "worker: a relay-signed refusal falls through to the caller path (no reason)",
    ...UNIT,
    edits: [
      // `&& false`, not `false`: relay stays narrowed inside, so the edit type-checks.
      {
        file: SERVER,
        from: 'if (relay.kind === "refused") {',
        to: 'if (relay.kind === "refused" && (false as boolean)) {',
      },
    ],
  },
  // --- relay: the forward
  {
    name: "relay: the forward presents the dispatch token as its bearer",
    ...HARNESS,
    edits: [
      {
        file: TASKS,
        from: "        () => mintRelayMcpBearer(relayIdentity, workerId),\n",
        to: "        async () => token,\n",
      },
    ],
  },
  {
    name: "relay: the forward mints one bearer and reuses it for every request",
    ...FORWARD,
    edits: [
      {
        file: ROUTING,
        from: "  const authed = async (): Promise<Record<string, string>> => ({",
        to: "  const once = await mintBearer();\n  const authed = async (): Promise<Record<string, string>> => ({",
      },
      {
        file: ROUTING,
        from: "    Authorization: `Bearer motebit:${await mintBearer()}`,",
        to: "    Authorization: `Bearer motebit:${once}`,",
      },
    ],
  },
  {
    name: "relay: a forward without a bearer minter is not refused",
    ...FORWARD,
    edits: [
      { file: ROUTING, from: "  if (mintBearer == null) {", to: "  if (false as boolean) {" },
      // …and the bearer is minted only when a minter exists (else the edit
      // does not type-check: TS2722, mintBearer possibly undefined).
      { file: ROUTING, from: "${await mintBearer()}", to: "${await mintBearer?.()}" },
    ],
  },
  // --- round 2 (cold review of the first round)
  {
    name: "r2 F1: relay bearers are claimed in the CALLER replay store",
    ...R2,
    edits: [
      {
        file: SERVER,
        from: "    const claimed = await this.relayReplay.claim(",
        to: "    const claimed = await this.callerReplay.claim(",
      },
    ],
  },
  {
    name: "r2 F1: the relay store carries the caller per-caller quota",
    ...R2,
    edits: [
      {
        file: SERVER,
        from: "      new MemoryCallerTokenReplayStore(\n        DEFAULT_RELAY_REPLAY_CAPACITY,\n        DEFAULT_RELAY_REPLAY_CAPACITY,\n      );",
        to: "      new MemoryCallerTokenReplayStore(DEFAULT_RELAY_REPLAY_CAPACITY);",
      },
    ],
  },
  {
    name: "r2 F2: a relay-claimed token that fails verification falls through to the caller path",
    ...R2,
    edits: [
      {
        file: SERVER,
        from: '      if (!claimsRelay) return { kind: "not_relay" };',
        to: '      return { kind: "not_relay" };',
      },
    ],
  },
  {
    name: "r2 F2: relay claim read from nothing (only a verifying token counts as relay-claimed)",
    ...R2,
    edits: [
      {
        file: SERVER,
        from: "    const claimsRelay = claims != null && claims.did === publicKeyToDidKey(key);",
        to: "    const claimsRelay = claims != null && claims.did === publicKeyToDidKey(key) && false;",
      },
    ],
  },
];

await runTampers(TAMPERS, { root: ROOT });
