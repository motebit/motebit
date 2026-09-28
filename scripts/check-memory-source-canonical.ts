#!/usr/bin/env tsx
/**
 * `check-memory-source-canonical` — registry-coverage gate for the
 * `MemorySource` closed registry, plus the two load-bearing
 * provenance-authorship scans.
 *
 * Closed-registry / structural-lock pattern — same shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85),
 * `check-sensitivity-canonical` (#97),
 * `check-event-type-canonical` (#99),
 * `check-settlement-mode-canonical` (#100).
 *
 *   1. `MemorySource` (the union in
 *      `packages/protocol/src/memory-source.ts`) is the closed
 *      vocabulary of memory provenance — who contributed a remembered
 *      fact. Every `MemoryFormedPayload` MAY carry `source`; render
 *      surfaces show `[from:X]`; policy weighs it. Cross-implementation
 *      drift silently demotes (or worse, promotes) the epistemic
 *      standing of synced memories.
 *
 *   2. Three-way lock: union × `ALL_MEMORY_SOURCES` × this gate's
 *      `MEMORY_SOURCES_REFERENCE` must agree exactly.
 *
 *   3. Wire-format compliance: lowercase snake_case identifiers
 *      (`^[a-z][a-z0-9_]*$`), same convention as `EventType`.
 *
 *   4. **Authorship scan (the load-bearing assertion)**: `source` is
 *      assigned by the FORMING CODE PATH — never authored by the model,
 *      never accepted from a peer.
 *        (a) No file in `packages/ai-core/src` may parse or instruct a
 *            `source` attribute on `<memory>` tags — the model cannot
 *            self-classify provenance (self-escalation channel).
 *        (b) The MCP server's memory write path may only ever pass the
 *            literal `"peer_agent"` source — a remote caller cannot
 *            self-declare a trusted provenance tier.
 *
 * Doctrine: `docs/doctrine/memory-provenance.md` (tenth registered
 * registry, `docs/doctrine/registry-pattern-canonical.md`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * The canonical set, mirrored from
 * `packages/protocol/src/memory-source.ts:ALL_MEMORY_SOURCES`.
 */
const MEMORY_SOURCES_REFERENCE = [
  "user_stated",
  "agent_inferred",
  "tool_derived",
  "peer_agent",
  "consolidation_derived",
] as const;

const SNAKE_CASE_IDENT_PATTERN = /^[a-z][a-z0-9_]*$/;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolve(ROOT, dir));
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = join(dir, entry);
    const full = resolve(ROOT, rel);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(rel));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function readUnionValues(source: string): string[] {
  const unionMatch = source.match(/export type MemorySource\s*=([^;]+);/);
  if (unionMatch === null) return [];
  const body = unionMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function readArrayValues(source: string): string[] {
  const arrayMatch = source.match(/ALL_MEMORY_SOURCES[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/);
  if (arrayMatch === null) return [];
  const body = arrayMatch[1] ?? "";
  const values: string[] = [];
  const valuePattern = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = valuePattern.exec(body)) !== null) {
    values.push(m[1] as string);
  }
  return values;
}

function main(): void {
  // === Sibling-alignment: three-way lock =========================
  const source = readFile("packages/protocol/src/memory-source.ts");
  if (source === null) {
    console.error(
      "check-memory-source-canonical: could not read packages/protocol/src/memory-source.ts.",
    );
    console.error("The MemorySource registry surface is missing; this gate cannot validate.");
    process.exit(1);
  }

  const unionValues = readUnionValues(source);
  const arrayValues = readArrayValues(source);
  const gateValues = [...MEMORY_SOURCES_REFERENCE];

  if (unionValues.length === 0) {
    console.error("check-memory-source-canonical: could not parse MemorySource union values.");
    process.exit(1);
  }
  if (arrayValues.length === 0) {
    console.error(
      "check-memory-source-canonical: could not parse ALL_MEMORY_SOURCES array values.",
    );
    process.exit(1);
  }

  const unionSet = new Set(unionValues);
  const arraySet = new Set(arrayValues);
  const gateSet = new Set(gateValues);

  const unionOnly = [...unionSet].filter((v) => !arraySet.has(v) || !gateSet.has(v));
  const arrayOnly = [...arraySet].filter((v) => !unionSet.has(v) || !gateSet.has(v));
  const gateOnly = [...gateSet].filter((v) => !unionSet.has(v) || !arraySet.has(v));

  if (unionOnly.length > 0 || arrayOnly.length > 0 || gateOnly.length > 0) {
    console.error(
      "check-memory-source-canonical: sibling-alignment failure across MemorySource × ALL_MEMORY_SOURCES × gate reference.",
    );
    if (unionOnly.length > 0) {
      console.error(`  In union but not all three: ${unionOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    if (arrayOnly.length > 0) {
      console.error(
        `  In ALL_MEMORY_SOURCES but not all three: ${arrayOnly.map((v) => `"${v}"`).join(", ")}`,
      );
    }
    if (gateOnly.length > 0) {
      console.error(`  In gate but not all three: ${gateOnly.map((v) => `"${v}"`).join(", ")}`);
    }
    console.error("");
    console.error(
      "The three-way lock requires `MemorySource` (union) × `ALL_MEMORY_SOURCES` (array) × `MEMORY_SOURCES_REFERENCE` (gate) to agree exactly.",
    );
    console.error(
      "Adding a memory source is intentional protocol-level work — update all three (plus MEMORY_SOURCE_MARKERS, compile-locked) in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md.");
    process.exit(1);
  }

  // === Wire-format compliance ====================================
  const malformed = MEMORY_SOURCES_REFERENCE.filter((v) => !SNAKE_CASE_IDENT_PATTERN.test(v));
  if (malformed.length > 0) {
    console.error(
      `check-memory-source-canonical: ${malformed.length} value(s) violate wire-format convention:`,
    );
    for (const v of malformed) {
      console.error(`  - "${v}" — expected lowercase snake_case ([a-z][a-z0-9_]*)`);
    }
    process.exit(1);
  }

  // === Authorship scan (a): the model cannot author source =======
  //
  // No file in packages/ai-core/src may (i) include a `source` attribute
  // group in a `<memory` tag pattern (parsing) or (ii) instruct the model
  // to emit one (prompting). A line that mentions `<memory` and `source=`
  // together is the drift signature for both.
  const aiCoreViolations: string[] = [];
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    // Test files are excluded: the negative fixture proving a
    // model-authored source attribute is NOT honored necessarily
    // contains the forbidden pattern.
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.includes("<memory") && /source\s*=/.test(line)) {
        aiCoreViolations.push(`${rel}:${i + 1}`);
      }
    }
  }
  if (aiCoreViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: model-authored provenance detected — a `<memory>` tag pattern in ai-core carries a `source` attribute:",
    );
    for (const v of aiCoreViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "`source` is assigned by the forming code path, never parsed from model output. The model self-classifying provenance is the self-escalation channel this registry exists to close.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (b): peers cannot self-declare source =====
  //
  // The MCP server's memory write path may pass ONLY the literal
  // "peer_agent". Any other registry value as a `source:` property in
  // mcp-server source is a peer-trust escalation. (Absence is fine —
  // pre-threading code passes no source at all.)
  const mcpViolations: string[] = [];
  const forbiddenInMcp = MEMORY_SOURCES_REFERENCE.filter((v) => v !== "peer_agent");
  for (const rel of walkTsFiles("packages/mcp-server/src")) {
    if (rel.includes("__tests__")) continue;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      for (const v of forbiddenInMcp) {
        if (new RegExp(`source\\s*:\\s*["']${v}["']`).test(line)) {
          mcpViolations.push(`${rel}:${i + 1} (source: "${v}")`);
        }
      }
      // A source derived from caller input is the same escalation.
      if (/source\s*:\s*(args|params|input|request)\b/.test(line)) {
        mcpViolations.push(`${rel}:${i + 1} (caller-derived source)`);
      }
    }
  }
  if (mcpViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: peer-declared provenance detected in mcp-server — remote writes must be `peer_agent` only:",
    );
    for (const v of mcpViolations) console.error(`  - ${v}`);
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (c): a foreign turn cannot form owner provenance
  //
  // #893: a customer's `motebit_task` (or a caller's `motebit_query`) runs
  // ANOTHER principal's words through the owner's loop. Every memory such a
  // turn forms must be `peer_agent`; stamped `user_stated` it would surface
  // in the owner's recall as `[from:user]`.
  //
  // The structure this locks, link by link:
  //   (i)   the turn-provenance resolver `turnMemorySource` in
  //         `packages/ai-core/src/memory-provenance.ts` returns
  //         `"peer_agent"` for a foreign turn as its FIRST return, so no
  //         later branch can promote one;
  //   (ii)  no other non-test ai-core file names an owner tier
  //         (`"user_stated"` / `"tool_derived"`) — a second formation
  //         path cannot mint owner provenance beside the resolver;
  //   (iii) the loop feeds the resolver the TURN's foreign fact
  //         (`foreignPrincipal: deps.foreignPrincipal`), not a global read;
  //   (iv)  the runtime sets that fact per turn through ONE mechanism
  //         (#880's per-turn mark): `loopDepsForTurn` stamps
  //         `foreignPrincipal: this.isForeignPrincipalTurn()` on every
  //         deps object it returns; both `sendMessage` entry points and the
  //         approval resume (after restoring the paused turn's mark) build
  //         their deps through it; and `handleAgentTask` starts every task
  //         turn with `foreignPrincipal: true`.
  // What this cannot express textually — that each foreign DOOR outside
  // the runtime (e.g. serve's `motebit_query` in apps/cli) passes the
  // option — is behavior, locked by the runtime and ai-core tests
  // (`foreign-turn-memory-provenance.test.ts`,
  // `foreign-turn-memory-deps.test.ts`, `foreign-turn-provenance.test.ts`).
  const foreignViolations: string[] = [];
  const RESOLVER = "packages/ai-core/src/memory-provenance.ts";
  const resolverSrc = readFile(RESOLVER);
  if (resolverSrc === null) {
    foreignViolations.push(`${RESOLVER}: missing — the one turn-provenance resolver is gone`);
  } else {
    const fnStart = resolverSrc.indexOf("export function turnMemorySource(");
    const firstReturn =
      fnStart === -1
        ? null
        : (resolverSrc
            .slice(fnStart)
            .split("\n")
            .find((l) => /\breturn\b/.test(l)) ?? null);
    if (firstReturn === null) {
      foreignViolations.push(`${RESOLVER}: \`export function turnMemorySource(\` not found`);
    } else if (!/foreignPrincipal\s*===\s*true\)\s*return\s+"peer_agent"/.test(firstReturn)) {
      foreignViolations.push(
        `${RESOLVER}: turnMemorySource's first return must be \`if (facts.foreignPrincipal === true) return "peer_agent";\` — found: ${firstReturn.trim()}`,
      );
    }
  }
  let aiCoreFilesScanned = 0;
  for (const rel of walkTsFiles("packages/ai-core/src")) {
    if (rel.includes("__tests__") || rel === RESOLVER) continue;
    aiCoreFilesScanned++;
    const content = readFile(rel);
    if (content === null) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      // Prose may NAME the tiers (doc comments, in backticks); code
      // minting one is a quoted string literal.
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (/["'](user_stated|tool_derived)["']/.test(line)) {
        foreignViolations.push(
          `${rel}:${i + 1}: owner-tier provenance literal outside ${RESOLVER} — route through turnMemorySource`,
        );
      }
    }
  }
  const loopSrc = readFile("packages/ai-core/src/loop.ts") ?? "";
  if (!/turnMemorySource\(\{\s*foreignPrincipal:\s*deps\.foreignPrincipal\b/.test(loopSrc)) {
    foreignViolations.push(
      "packages/ai-core/src/loop.ts: formation must call `turnMemorySource({ foreignPrincipal: deps.foreignPrincipal, ... })` — the turn's own deps carry whose words it runs",
    );
  }
  const runtimeSrc = readFile("packages/runtime/src/motebit-runtime.ts") ?? "";
  // (iv-a) ONE loopDepsForTurn stamps the per-turn mark on the deps.
  const ldftStart = runtimeSrc.indexOf("private loopDepsForTurn<");
  const ldftEnd = ldftStart === -1 ? -1 : runtimeSrc.indexOf("\n  }\n", ldftStart);
  const ldftBody = ldftStart === -1 || ldftEnd === -1 ? "" : runtimeSrc.slice(ldftStart, ldftEnd);
  const ldftReturns = ldftBody.split("\n").filter((l) => /\breturn\b/.test(l));
  if (
    !/const foreignPrincipal = this\.isForeignPrincipalTurn\(\);/.test(ldftBody) ||
    ldftReturns.length === 0 ||
    ldftReturns.some((l) => !/\{\s*\.\.\.deps,\s*foreignPrincipal\b/.test(l))
  ) {
    foreignViolations.push(
      "packages/runtime/src/motebit-runtime.ts: `loopDepsForTurn` must set `foreignPrincipal` from `this.isForeignPrincipalTurn()` on EVERY deps object it returns (`{ ...deps, foreignPrincipal, ... }`) — the turn's deps are where formation reads whose words it runs",
    );
  }
  // (iv-b) both turn entries build their deps through it.
  const perTurnDeps = (runtimeSrc.match(/this\.loopDepsForTurn\(\s*clearedLoopDeps\s*\)/g) ?? [])
    .length;
  if (perTurnDeps < 2) {
    foreignViolations.push(
      `packages/runtime/src/motebit-runtime.ts: sendMessage AND sendMessageStreaming must build their loop deps via \`this.loopDepsForTurn(clearedLoopDeps)\` — found ${perTurnDeps} of 2`,
    );
  }
  // (iv-c) the approval resume builds its continuation's deps through it too,
  // with the paused turn's mark restored (enterForeignPrincipalTurn) first.
  if (!/loopDepsForTurn: \(deps\) => this\.loopDepsForTurn\(deps\)/.test(runtimeSrc)) {
    foreignViolations.push(
      "packages/runtime/src/motebit-runtime.ts: StreamingManager must be wired with `loopDepsForTurn: (deps) => this.loopDepsForTurn(deps)`",
    );
  }
  const streamingSrc = readFile("packages/runtime/src/streaming.ts") ?? "";
  if (
    !/pending\.foreignPrincipal === true \? this\.deps\.enterForeignPrincipalTurn\?\.\(\)/.test(
      streamingSrc,
    ) ||
    !/runTurnStreaming\(\s*this\.deps\.loopDepsForTurn\?\.\(loopDeps\)/.test(streamingSrc)
  ) {
    foreignViolations.push(
      "packages/runtime/src/streaming.ts: the approval resume must restore the paused turn's foreign mark (`enterForeignPrincipalTurn`) and run its continuation with `this.deps.loopDepsForTurn?.(loopDeps)`",
    );
  }
  const taskHandlerSrc = readFile("packages/runtime/src/agent-task-handler.ts") ?? "";
  if (!/sendMessageStreaming\(task\.prompt,[^)]*foreignPrincipal:\s*true/s.test(taskHandlerSrc)) {
    foreignViolations.push(
      "packages/runtime/src/agent-task-handler.ts: a task's turn must be started with `foreignPrincipal: true` — the prompt is another principal's",
    );
  }
  if (foreignViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: a foreign principal's turn could form owner provenance (#893):",
    );
    for (const v of foreignViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: every memory a foreign turn forms is `peer_agent`. Keep the one resolver (`turnMemorySource`, foreign branch first), feed it `deps.foreignPrincipal`, and set that per turn in the runtime (`loopDepsForTurn` from `isForeignPrincipalTurn()`, the resume's restored mark, `handleAgentTask`).",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  // === Authorship scan (d): a foreign turn never writes the owner's history
  //
  // #904: a foreign turn's exchange pushed into the owner's conversation
  // reached the NEXT owner turn as `role:"user"`, so a memory that turn
  // formed from it was `user_stated` — scan (c)'s laundering, one hop
  // later — and the store row synced to the owner's other devices as the
  // owner's own conversation. The floor is the state holder's, read from
  // the per-turn mark, so no door can forget it:
  //   (i)   no non-test runtime file outside `conversation.ts` writes a
  //         conversation store (`.appendMessage(` / `.createConversation(`)
  //         — every writer of the owner's conversation goes through
  //         `ConversationManager`;
  //   (ii)  in `conversation.ts`, every method that appends to the store,
  //         plus `injectIntermediateMessages`, opens with
  //         `if (this.isForeignTurn()) return;`, and `isForeignTurn` reads
  //         `this.deps.isForeignPrincipalTurn?.() === true`;
  //   (iii) the runtime wires that dep from the one per-turn predicate
  //         (`isForeignPrincipalTurn: () => this.isForeignPrincipalTurn()`);
  //   (iv)  the approval TIMEOUT (which fires outside any turn, mark down)
  //         skips a foreign expiry, and the resume continues a foreign turn
  //         over a private copy (`pending.foreignPrincipal === true` branch).
  //   (v)   READ side (#904 round 2 — the owner's interior is never served
  //         to another principal, #880's law): `trimmed()`, `liveHistory`,
  //         `getSessionInfo()` and `clearSessionInfo()` each open with the
  //         same `if (this.isForeignTurn()) return …` floor, so a foreign
  //         turn's context carries no owner history, summary or session
  //         facts, and cannot consume the owner's session marker;
  //   (vi)  CONSENT: a foreign turn is not the human — every non-test
  //         runtime line that releases the denial brake
  //         (`.beginExchange()`), records user activity
  //         (`_lastUserMessageAt =`) or sets aside a pending approval
  //         (`.voidPendingApproval()`) is guarded by `_foreignTurn` on the
  //         same line.
  // Behavior: `foreign-turn-history.test.ts` (both doors, the store, a real
  // sync push, the task, the resume, the timeout, the read side, the brake,
  // the pending approval).
  const historyViolations: string[] = [];
  const CONV = "packages/runtime/src/conversation.ts";
  let runtimeFilesScanned = 0;
  let consentSites = 0;
  for (const rel of walkTsFiles("packages/runtime/src")) {
    if (rel.includes("__tests__") || rel === CONV) continue;
    runtimeFilesScanned++;
    const content = readFile(rel) ?? "";
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      if (/\.(appendMessage|createConversation)\(/.test(line)) {
        historyViolations.push(
          `${rel}:${i + 1}: writes a conversation store outside ${CONV} — route the write through ConversationManager, whose floor refuses a foreign turn`,
        );
      }
      if (
        /\.beginExchange\(\)|\b_lastUserMessageAt\s*=[^=]|\.voidPendingApproval\(\)/.test(line) &&
        !/^\s*(?:private |public )?_lastUserMessageAt\b/.test(line)
      ) {
        consentSites++;
        if (!/_foreignTurn/.test(line)) {
          historyViolations.push(
            `${rel}:${i + 1}: releases the owner's denial brake, records user activity, or voids the owner's pending approval without a \`_foreignTurn\` guard on the same line — a foreign turn is not the human: ${line.trim()}`,
          );
        }
      }
    }
  }
  const convSrc = readFile(CONV) ?? "";
  const convLines = convSrc.split("\n");
  // Method starts at class-member indentation (two spaces), e.g. `  pushExchange(`.
  const methodStarts: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < convLines.length; i++) {
    const m = /^ {2}(?:private |async |public |get )*([A-Za-z_]\w*)\s*\([^)]*\).*\{\s*$/.exec(
      convLines[i] as string,
    );
    if (m) methodStarts.push({ name: m[1] as string, line: i });
  }
  let guardedMethods = 0;
  for (let k = 0; k < methodStarts.length; k++) {
    const { name, line } = methodStarts[k] as { name: string; line: number };
    const end =
      k + 1 < methodStarts.length
        ? (methodStarts[k + 1] as { line: number }).line
        : convLines.length;
    const body = convLines.slice(line + 1, end);
    const writesStore = body.some((l) => /\.(appendMessage|createConversation)\(/.test(l));
    if (!writesStore && name !== "injectIntermediateMessages") continue;
    const firstStatement = body.find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
    if (
      firstStatement === undefined ||
      !/^\s*if \(this\.isForeignTurn\(\)\) return;/.test(firstStatement)
    ) {
      historyViolations.push(
        `${CONV}: \`${name}\` writes the owner's conversation but does not open with \`if (this.isForeignTurn()) return;\` — found: ${(firstStatement ?? "(empty)").trim()}`,
      );
    } else {
      guardedMethods++;
    }
  }
  const READERS = ["trimmed", "liveHistory", "getSessionInfo", "clearSessionInfo"];
  let guardedReaders = 0;
  for (const reader of READERS) {
    const k = methodStarts.findIndex((m) => m.name === reader);
    if (k === -1) {
      historyViolations.push(
        `${CONV}: \`${reader}\` not found — the read-side floor has nowhere to live`,
      );
      continue;
    }
    const { line } = methodStarts[k] as { line: number };
    const end =
      k + 1 < methodStarts.length
        ? (methodStarts[k + 1] as { line: number }).line
        : convLines.length;
    const firstStatement = convLines
      .slice(line + 1, end)
      .find((l) => l.trim() !== "" && !/^\s*(\*|\/\/|\/\*)/.test(l));
    if (
      firstStatement === undefined ||
      !/^\s*if \(this\.isForeignTurn\(\)\) return\b/.test(firstStatement)
    ) {
      historyViolations.push(
        `${CONV}: \`${reader}\` serves the owner's conversation to the turn's context but does not open with \`if (this.isForeignTurn()) return …\` — found: ${(firstStatement ?? "(empty)").trim()}`,
      );
    } else {
      guardedReaders++;
    }
  }
  if (consentSites < 3) {
    historyViolations.push(
      `packages/runtime/src: expected the three consent sites (beginExchange, _lastUserMessageAt, voidPendingApproval) — found ${consentSites}; if one moved, keep its \`_foreignTurn\` guard on the same line`,
    );
  }
  if (guardedMethods < 3) {
    historyViolations.push(
      `${CONV}: expected the floor on pushExchange, pushActivation and injectIntermediateMessages — found ${guardedMethods} guarded writer(s)`,
    );
  }
  if (
    !/private isForeignTurn\(\): boolean \{\s*return this\.deps\.isForeignPrincipalTurn\?\.\(\) === true;/.test(
      convSrc,
    )
  ) {
    historyViolations.push(
      `${CONV}: \`isForeignTurn()\` must return \`this.deps.isForeignPrincipalTurn?.() === true\``,
    );
  }
  const bcdStart = runtimeSrc.indexOf("private buildConversationDeps(");
  const bcdEnd = bcdStart === -1 ? -1 : runtimeSrc.indexOf("\n  }\n", bcdStart);
  const bcdBody = bcdStart === -1 || bcdEnd === -1 ? "" : runtimeSrc.slice(bcdStart, bcdEnd);
  if (!/isForeignPrincipalTurn: \(\) => this\.isForeignPrincipalTurn\(\)/.test(bcdBody)) {
    historyViolations.push(
      "packages/runtime/src/motebit-runtime.ts: `buildConversationDeps` must wire `isForeignPrincipalTurn: () => this.isForeignPrincipalTurn()` — the conversation floor reads the per-turn mark",
    );
  }
  if (
    !/if \(expired\.foreignPrincipal !== true\) \{\s*this\.deps\.injectIntermediateMessages\(/.test(
      streamingSrc,
    )
  ) {
    historyViolations.push(
      "packages/runtime/src/streaming.ts: the approval timeout fires outside any turn — it must skip a foreign expiry (`if (expired.foreignPrincipal !== true) { this.deps.injectIntermediateMessages(… }`)",
    );
  }
  if (
    !/if \(pending\.foreignPrincipal === true\) \{\s*continuationHistory = \[\.\.\.this\.deps\.getLiveHistory\(\), \.\.\.continuationPair\];/.test(
      streamingSrc,
    )
  ) {
    historyViolations.push(
      "packages/runtime/src/streaming.ts: a foreign resume must continue over a private copy (`continuationHistory = [...this.deps.getLiveHistory(), ...continuationPair]`), never inject into the owner's history",
    );
  }
  if (historyViolations.length > 0) {
    console.error(
      "check-memory-source-canonical: a foreign principal's turn could write, read, or act as the owner's conversation (#904):",
    );
    for (const v of historyViolations) console.error(`  - ${v}`);
    console.error("");
    console.error(
      "Repair: a foreign turn's words never enter the owner's history as `user`. Every conversation write goes through ConversationManager, whose writers open with `if (this.isForeignTurn()) return;`, wired in the runtime from `isForeignPrincipalTurn()`; the approval timeout skips a foreign expiry and a foreign resume continues over a private copy. Read side: `trimmed`, `liveHistory`, `getSessionInfo`, `clearSessionInfo` open with the same floor. Consent: `beginExchange`, `_lastUserMessageAt =` and `voidPendingApproval` stay behind `!this._foreignTurn`.",
    );
    console.error("Doctrine: docs/doctrine/memory-provenance.md § authorship.");
    process.exit(1);
  }

  console.log(
    `✓ check-memory-source-canonical: ${MEMORY_SOURCES_REFERENCE.length} memory source(s) locked across union + ALL_MEMORY_SOURCES + gate reference; wire-format-compliant; model/peer authorship scans clean; foreign-turn provenance locked (resolver + ${aiCoreFilesScanned} other ai-core file(s) scanned, 7 wiring links checked); foreign-turn history floor locked (${runtimeFilesScanned} other runtime file(s) scanned for conversation-store writes, ${guardedMethods} ConversationManager writer(s) + ${guardedReaders} reader(s) guarded, ${consentSites} consent site(s) guarded, 4 wiring links checked).`,
  );
}

main();
