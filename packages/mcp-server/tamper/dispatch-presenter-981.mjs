#!/usr/bin/env node
/**
 * Tamper checks for #981 (a task:dispatch token never authenticates the
 * transport; the relay authenticates as itself with a relay-signed mcp:call
 * token, fresh per request).
 *
 * Each entry is (file, text to revert, test expected red): the script removes
 * the fix — one or more exact edits — rebuilds any package whose `dist` the
 * test reads (the relay's tests import `@motebit/mcp-server` from dist), runs
 * the named test file, and requires it to FAIL; then restores every file and
 * rebuilds again. An edit whose text is not found exactly once is a failure
 * too ("could not apply" is never a silent pass). A rebuild that fails is a
 * failure (a stale dist would otherwise be a false result). Exit 1 if any
 * tamper stays green or cannot apply.
 *
 *   node packages/mcp-server/tamper/dispatch-presenter-981.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

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
      { file: SERVER, from: 'if (relay.kind === "refused") {', to: "if (false as boolean) {" },
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

function build(pkgs) {
  for (const p of pkgs ?? []) {
    execFileSync("pnpm", ["--filter", p, "build"], { cwd: ROOT, stdio: "ignore" });
  }
}

let bad = 0;
for (const t of TAMPERS) {
  const originals = new Map();
  let applied = true;
  for (const e of t.edits) {
    const path = resolve(ROOT, e.file);
    const current = readFileSync(path, "utf8");
    if (!originals.has(path)) originals.set(path, current);
    const count = current.split(e.from).length - 1;
    if (count !== 1) {
      console.log(`COULD NOT APPLY  ${t.name}  (${e.file}: text found ${count}×)`);
      applied = false;
      break;
    }
    writeFileSync(path, current.replace(e.from, e.to));
  }
  let red = false;
  let buildFailed = false;
  if (applied) {
    try {
      build(t.rebuild);
    } catch {
      buildFailed = true;
    }
    if (!buildFailed) {
      try {
        execFileSync("pnpm", ["--filter", t.pkg, "exec", "vitest", "run", t.test], {
          cwd: ROOT,
          stdio: "ignore",
        });
      } catch {
        red = true;
      }
    }
  }
  for (const [path, text] of originals) writeFileSync(path, text);
  build(t.rebuild); // restore the dist the next entry reads
  if (!applied) {
    bad++;
    continue;
  }
  if (buildFailed) {
    console.log(`BUILD FAILED     ${t.name}`);
    bad++;
    continue;
  }
  console.log(`${red ? "RED (ok)       " : "STAYED GREEN   "}  ${t.name}`);
  if (!red) bad++;
}
console.log(bad === 0 ? `all ${TAMPERS.length} tampers went red` : `${bad} tamper(s) failed`);
process.exit(bad === 0 ? 0 : 1);
