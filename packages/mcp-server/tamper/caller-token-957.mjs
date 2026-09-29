#!/usr/bin/env node
/**
 * Tamper checks for #957 (MCP caller-token audience, binding, replay).
 *
 * Each entry is a (file, text to revert, test expected red) triple: the
 * script removes the fix, runs the named test file, and requires it to FAIL;
 * then restores the file. A tamper whose text is not found exactly once is a
 * failure too ("could not apply" is never a silent pass). Exit 1 if any
 * tamper stays green or cannot apply.
 *
 *   node packages/mcp-server/tamper/caller-token-957.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");

const TAMPERS = [
  {
    name: "(a) audience check removed",
    file: "packages/mcp-server/src/caller-token.ts",
    from: "if (claims.aud !== MCP_CALL_AUDIENCE) {",
    to: "if (false as boolean) {",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(b) binding: a token for another server accepted",
    file: "packages/mcp-server/src/caller-token.ts",
    from: "if (claims.sub !== serverMotebitId) {",
    to: "if (false as boolean) {",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(b) binding: an unbound token accepted",
    file: "packages/mcp-server/src/caller-token.ts",
    from: 'if (typeof claims.sub !== "string" || claims.sub.length === 0) {',
    to: "if (false as boolean) {",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(c) replay: the jti claim result ignored",
    file: "packages/mcp-server/src/index.ts",
    from: 'if (!fresh) return refuse("token already used',
    to: 'if (false as boolean) return refuse("token already used',
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(c) replay store never refuses a live key",
    file: "packages/mcp-server/src/caller-token.ts",
    from: "if (prior > now) return false;",
    to: "if (prior > now) return true;",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(c) lifetime bound removed (replay memory unbounded)",
    file: "packages/mcp-server/src/caller-token.ts",
    from: "if (claims.exp - nowMs > MAX_MCP_CALLER_TOKEN_LIFETIME_MS) {",
    to: "if (false as boolean) {",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "(c) replay store evicts a live key when full",
    file: "packages/mcp-server/src/caller-token.ts",
    from: "if (this.seen.size >= this.capacity) return false;",
    to: "if (this.seen.size >= this.capacity) this.seen.clear();",
    pkg: "@motebit/mcp-server",
    test: "src/__tests__/caller-token-957.test.ts",
  },
  {
    name: "client: mcp-client mints unbound",
    file: "packages/mcp-client/src/index.ts",
    from: "          sub: targetMotebitId,\n",
    to: "",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
  },
  {
    name: "client: mcp-client mints the legacy audience",
    file: "packages/mcp-client/src/index.ts",
    from: "          aud: MCP_CALL_AUDIENCE,\n          sub: targetMotebitId,",
    to: '          aud: "task:submit",\n          sub: targetMotebitId,',
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
  },
  {
    name: "client: mcp-client accepts a server that is not the bound target",
    file: "packages/mcp-client/src/index.ts",
    from: "if (this.boundTargetId != null && parsed.motebit_id !== this.boundTargetId) {",
    to: "if (false as boolean) {",
    pkg: "@motebit/mcp-client",
    test: "src/__tests__/index.test.ts",
  },
  {
    name: "client: planner mints unbound",
    file: "packages/planner/src/sovereign-delegation-adapter.ts",
    from: "aud: MCP_CALL_AUDIENCE, sub: workerMotebitId }",
    to: "aud: MCP_CALL_AUDIENCE }",
    pkg: "@motebit/planner",
    test: "src/__tests__/sovereign-delegation-adapter.test.ts",
  },
];

let bad = 0;
for (const t of TAMPERS) {
  const path = resolve(ROOT, t.file);
  const original = readFileSync(path, "utf8");
  const count = original.split(t.from).length - 1;
  if (count !== 1) {
    console.log(`COULD NOT APPLY  ${t.name}  (${t.file}: text found ${count}×)`);
    bad++;
    continue;
  }
  writeFileSync(path, original.replace(t.from, t.to));
  let red = false;
  try {
    execFileSync("pnpm", ["--filter", t.pkg, "exec", "vitest", "run", t.test], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    red = true;
  } finally {
    writeFileSync(path, original);
  }
  console.log(`${red ? "RED (ok)       " : "STAYED GREEN   "}  ${t.name}`);
  if (!red) bad++;
}
console.log(bad === 0 ? `all ${TAMPERS.length} tampers went red` : `${bad} tamper(s) failed`);
process.exit(bad === 0 ? 0 : 1);
