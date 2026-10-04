#!/usr/bin/env node
/**
 * Tamper checks for #957 (MCP caller-token audience, binding, replay, and
 * the replay store's resource bounds).
 *
 * Each entry is (file, text to revert, test expected red): removing the fix —
 * one or more exact edits — must turn the named test file RED. The shared
 * runner (scripts/lib/tamper-runner.ts) runs the entries in parallel, each in
 * an isolated copy of the tree; an edit whose text is not found exactly once
 * is a failure too ("could not apply" is never a silent pass). Exit 1 if any
 * tamper stays green or cannot apply.
 *
 *   node packages/mcp-server/tamper/caller-token-957.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");

const SERVER = "packages/mcp-server/src/index.ts";
const LAW = "packages/mcp-server/src/caller-token.ts";
const MATRIX = { pkg: "@motebit/mcp-server", test: "src/__tests__/caller-token-957.test.ts" };

const TAMPERS = [
  // --- (a) audience
  {
    name: "(a) audience check removed",
    ...MATRIX,
    edits: [
      { file: LAW, from: "if (claims.aud !== MCP_CALL_AUDIENCE) {", to: "if (false as boolean) {" },
    ],
  },
  // --- (b) binding
  {
    name: "(b) binding: a token for another server accepted",
    ...MATRIX,
    edits: [
      { file: LAW, from: "if (claims.sub !== serverMotebitId) {", to: "if (false as boolean) {" },
    ],
  },
  {
    name: "(b) binding: an unbound token accepted",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: 'if (typeof claims.sub !== "string" || claims.sub.length === 0) {',
        to: "if (false as boolean) {",
      },
    ],
  },
  {
    name: "(b) the verifier's payload is not re-checked",
    ...MATRIX,
    edits: [
      {
        file: SERVER,
        from: "const verdict = checkMcpCallerClaims(payload, this.deps.motebitId, Date.now());\n    if (!verdict.ok) return verdict;",
        to: "",
      },
    ],
  },
  // --- (c) replay
  {
    name: "(c) replay: the store verdict ignored",
    ...MATRIX,
    edits: [
      {
        file: SERVER,
        from: 'if (claimed !== "accepted") return refuse(replayRefusalReason(claimed));',
        to: "",
      },
    ],
  },
  {
    name: "(c) store never refuses a live key",
    ...MATRIX,
    edits: [{ file: LAW, from: 'if (this.live.has(entry.key)) return "replay";', to: "" }],
  },
  {
    name: "(c) ordering: the jti is claimed before key lookup and signature",
    ...MATRIX,
    edits: [
      {
        file: SERVER,
        from: "if (!early.ok) return early;",
        to: "if (!early.ok) return early;\n    const claimed = await this.callerReplay.claim(await callerReplayEntry(mid, String(claims.jti), Number(claims.exp)));",
      },
      {
        file: SERVER,
        from: "const claimed = await this.callerReplay.claim(\n      await callerReplayEntry(mid, payload.jti as string, payload.exp),\n    );",
        to: "",
      },
    ],
  },
  {
    name: "(c) jti length cap removed",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: "if (claims.jti.length > MCP_CALL_MAX_JTI_LENGTH) {",
        to: "if (false as boolean) {",
      },
    ],
  },
  {
    name: "(c) store keyed by the raw mid+jti (memory grows with jti length)",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: "key: await hex256(`${mid}\\u0000${jti}`),",
        to: "key: `${mid}\\u0000${jti}`,",
      },
    ],
  },
  {
    name: "(c) per-caller quota removed",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: 'if ((this.perCaller.get(entry.caller) ?? 0) >= this.quotaPerCaller) return "caller_quota";',
        to: "",
      },
    ],
  },
  {
    name: "(c) store full: evicts nothing but accepts past capacity",
    ...MATRIX,
    edits: [{ file: LAW, from: 'if (this.live.size >= this.capacity) return "full";', to: "" }],
  },
  {
    name: "(c) full-store reason collapsed into 'already used'",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: 'return "replay store at capacity — retry shortly";',
        to: 'return "token already used — mint a fresh token per request";',
      },
    ],
  },
  {
    name: "(c) lifetime bound back to 15 minutes",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: "MAX_MCP_CALLER_TOKEN_LIFETIME_MS = MCP_CALL_MAX_TOKEN_WINDOW_MS;",
        to: "MAX_MCP_CALLER_TOKEN_LIFETIME_MS = 15 * 60 * 1000;",
      },
    ],
  },
  {
    name: "(c) lifetime check removed",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: "if (claims.exp - nowMs > MAX_MCP_CALLER_TOKEN_LIFETIME_MS) {",
        to: "if (false as boolean) {",
      },
    ],
  },
  {
    name: "(c) iat skew allowance removed",
    ...MATRIX,
    edits: [
      {
        file: LAW,
        from: 'if (typeof claims.iat === "number" && claims.iat - nowMs > MCP_CALL_CLOCK_SKEW_MS) {',
        to: "if (false as boolean) {",
      },
    ],
  },
  {
    name: "(c) heap pop never sifts down (expired entries hide below a live root)",
    ...MATRIX,
    edits: [
      { file: LAW, from: "if (l < h.length && h[l]!.exp < h[m]!.exp) m = l;", to: "" },
      { file: LAW, from: "if (r < h.length && h[r]!.exp < h[m]!.exp) m = r;", to: "" },
    ],
  },
  // --- clients
  {
    name: "client: mcp-client mints unbound",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
    edits: [
      {
        file: "packages/mcp-client/src/index.ts",
        from: "          sub: targetMotebitId,\n",
        to: "",
      },
    ],
  },
  {
    name: "client: mcp-client mints the legacy audience",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
    edits: [
      {
        file: "packages/mcp-client/src/index.ts",
        from: "          aud: MCP_CALL_AUDIENCE,\n          sub: targetMotebitId,",
        to: '          aud: "task:submit",\n          sub: targetMotebitId,',
      },
    ],
  },
  {
    name: "client: mcp-client mints with the 5-minute default lifetime",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
    edits: [
      {
        file: "packages/mcp-client/src/index.ts",
        from: "          ttlMs: REFERENCE_MCP_CALL_TOKEN_TTL_MS,\n",
        to: "",
      },
    ],
  },
  {
    name: "client: mcp-client accepts a server that is not the bound target",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
    edits: [
      {
        file: "packages/mcp-client/src/index.ts",
        from: "if (this.boundTargetId != null && parsed.motebit_id !== this.boundTargetId) {",
        to: "if (false as boolean) {",
      },
    ],
  },
  {
    name: "client: planner mints unbound",
    pkg: "@motebit/planner",
    test: "src/__tests__/sovereign-delegation-adapter.test.ts",
    edits: [
      {
        file: "packages/planner/src/sovereign-delegation-adapter.ts",
        from: "            sub: workerMotebitId,\n",
        to: "",
      },
    ],
  },
  {
    name: "client: planner mints with the 5-minute default lifetime",
    pkg: "@motebit/planner",
    test: "src/__tests__/sovereign-delegation-adapter.test.ts",
    edits: [
      {
        file: "packages/planner/src/sovereign-delegation-adapter.ts",
        from: "            ttlMs: REFERENCE_MCP_CALL_TOKEN_TTL_MS,\n",
        to: "",
      },
    ],
  },
  {
    name: "client: web-search binds to /health, not the relay-admitted target",
    pkg: "@motebit/web-search",
    test: "src/__tests__/sub-delegate-binding.test.ts",
    edits: [
      {
        file: "services/web-search/src/sub-delegate.ts",
        from: "    ...(args.targetMotebitId != null ? { motebitId: args.targetMotebitId } : {}),\n",
        to: "",
      },
    ],
  },
];

await runTampers(TAMPERS, { root: ROOT });
