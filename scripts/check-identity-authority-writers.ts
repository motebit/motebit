#!/usr/bin/env tsx
/**
 * `check-identity-authority-writers` — every door that writes identity
 * authority must name the principal that authorizes it.
 *
 * Why this exists. Three weaknesses closed in one week had a single shape:
 * **authority asserted over a target the request never proves a relationship
 * to.**
 *
 *   - #701 — a key succession could be recorded under another identity: the
 *     route never compared the caller to the identity in the path.
 *   - #713 — a federation peer could re-key or de-list any identity: the
 *     handler verified the sender's signature and read that as entitlement to
 *     speak about whatever `motebit_id` the event named.
 *   - #719 — any agent could revoke any credential: the route compared the
 *     caller to a path segment the caller chooses, never to the credential.
 *
 * None was a logic error inside a function. Each was a door added beside the
 * doors that already had the rule, without the rule. `services/relay/CLAUDE.md`
 * rule 21 already asks every writer of `agent_registry.public_key` to answer to
 * the shared rule or say what roots its authority instead — and prose cannot
 * notice a tenth writer appearing.
 *
 * What this gate asserts. The set of write sites into the tables that carry
 * identity authority is CLOSED, and each entry names its authorizing
 * principal. A new writer is a compile-time-visible decision: register it with
 * the principal it answers to, or it fails here. That is deliberately not a
 * proof that the site is correct — a gate cannot read an authorization. It
 * forces the question to be answered in writing at the moment the door is cut,
 * which is the step all three defects skipped.
 *
 * Scope, stated because a green gate's claim is only as wide as what it
 * scanned (`docs/doctrine/gate-repair-instructions.md`): it reads
 * `services/relay/src` and `packages/persistence/src`, skipping `__tests__`
 * and `dist`, for INSERT/UPDATE against four tables. An `UPDATE agent_registry`
 * counts only when its SET clause touches an authority column — a heartbeat
 * refresh is not an authority write. It cannot see a write built by string
 * concatenation at runtime, or one issued from another package.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["services/relay/src", "packages/persistence/src"];

/** Tables whose rows decide who an identity is, or whether it may act. */
const TABLES = [
  "agent_registry",
  "devices",
  "relay_key_successions",
  "relay_revoked_credentials",
] as const;

/** Columns that carry authority. An UPDATE touching none of these is routine. */
const AUTHORITY_COLUMNS = ["public_key", "revoked", "guardian_public_key"];

interface Writer {
  /** Repo-relative file. */
  file: string;
  verb: "INSERT" | "UPDATE";
  table: (typeof TABLES)[number];
  /** How many such writes this file is expected to contain. */
  count: number;
  /**
   * WHO may cause this write, and what in the request proves they are that.
   * Not decoration — this sentence is the artifact the gate exists to force.
   */
  principal: string;
}

/**
 * The closed set. Keyed by file rather than line so ordinary edits do not
 * churn it, and counted so a SECOND door cut in a file that already has one
 * still fails — which is exactly how #713 and #719 were added.
 */
const WRITERS: readonly Writer[] = [
  {
    file: "services/relay/src/agents.ts",
    verb: "INSERT",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — registration is behind refusePublicDeviceRegistration, so an existing identity must present a key it already holds (#693)",
  },
  {
    file: "services/relay/src/agents.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the operator — de-listing writes a signed, append-only relay_agent_revocations record, so the moderation history is public and verifiable (CLAUDE.md rule 6)",
  },
  {
    file: "services/relay/src/credentials.ts",
    verb: "INSERT",
    table: "relay_revoked_credentials",
    count: 1,
    principal:
      "the credential's subject or its issuer, resolved from the credential row itself, or the operator; never the identity named in the path (#719)",
  },
  {
    file: "services/relay/src/key-rotation.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — /revoke marks its own row revoked under its own token (or the operator's)",
  },
  {
    file: "services/relay/src/succession-apply.ts",
    verb: "INSERT",
    table: "relay_key_successions",
    count: 1,
    principal:
      "the identity itself, or its designated guardian for a recovery — the ONE writer both doors (/rotate-key, the succession path of /agents/register) call after verifying the record's signatures and that it departs from a key this relay holds (#701, #702 relay half); a recovery is the deliberate exception to current-key possession, since it exists because that key is gone",
  },
  {
    file: "services/relay/src/succession-apply.ts",
    verb: "UPDATE",
    table: "devices",
    count: 1,
    principal:
      "the identity itself — the same verified succession that records the link moves every device row holding the key it retires (and only those), in the same transaction; a device row is what a bearer is verified against FIRST, so leaving it on the retired key would let that key keep authenticating (#702 relay half)",
  },
  {
    file: "services/relay/src/succession-apply.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself (or its guardian for a recovery) — the registry key moves only FROM the key the verified link retires, or into an empty master-token slot, so a stray re-presentation can never drag it back from a later key",
  },
  {
    file: "services/relay/src/migration.ts",
    verb: "INSERT",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — accept-migration verifies a migration token and a credential bundle against the presented key before the row lands",
  },
  {
    file: "services/relay/src/migration.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — departure is initiated by the identity's own migration token; the row is marked revoked because the identity now lives elsewhere",
  },
  {
    file: "services/relay/src/tasks.ts",
    verb: "UPDATE",
    table: "agent_registry",
    count: 1,
    principal:
      "the identity itself — a receipt may reconcile the registry key ONLY to a key already registered as one of that identity's devices; an arbitrary embedded key is refused",
  },
  {
    file: "packages/persistence/src/index.ts",
    verb: "INSERT",
    table: "devices",
    count: 1,
    principal:
      "the identity itself — the relay's public doors gate this behind refusePublicDeviceRegistration; the authenticated pairing flow is what adds a device under a new key",
  },
];

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "dist" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, acc);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

interface Found {
  file: string;
  line: number;
  verb: "INSERT" | "UPDATE";
  table: string;
}

function scan(): { found: Found[]; filesScanned: number } {
  const pattern = new RegExp(
    `(INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE)\\s+(${TABLES.join("|")})([\\s\\S]{0,200})`,
    "gi",
  );
  const found: Found[] = [];
  let filesScanned = 0;
  for (const root of SCAN_ROOTS) {
    for (const abs of tsFiles(resolve(ROOT, root))) {
      filesScanned++;
      const src = readFileSync(abs, "utf-8");
      for (const m of src.matchAll(pattern)) {
        const verb = m[1]!.toUpperCase().startsWith("INSERT") ? "INSERT" : "UPDATE";
        const table = m[2]!;
        if (verb === "UPDATE" && table === "agent_registry") {
          const setClause = m[3]!.split(/WHERE/i)[0]!;
          if (!AUTHORITY_COLUMNS.some((c) => setClause.includes(c))) continue;
        }
        found.push({
          file: relative(ROOT, abs),
          line: src.slice(0, m.index).split("\n").length,
          verb,
          table,
        });
      }
    }
  }
  return { found, filesScanned };
}

const { found, filesScanned } = scan();
const key = (f: { file: string; verb: string; table: string }): string =>
  `${f.file}|${f.verb}|${f.table}`;

const actual = new Map<string, Found[]>();
for (const f of found) {
  const list = actual.get(key(f)) ?? [];
  list.push(f);
  actual.set(key(f), list);
}

const violations: string[] = [];

for (const [k, sites] of actual) {
  const registered = WRITERS.find((w) => key(w) === k);
  if (registered === undefined) {
    const [file, verb, table] = k.split("|");
    violations.push(
      `UNREGISTERED: ${verb} ${table} in ${file} (line${sites.length > 1 ? "s" : ""} ${sites.map((s) => s.line).join(", ")}) — this door writes identity authority and names no principal`,
    );
    continue;
  }
  if (sites.length !== registered.count) {
    violations.push(
      `COUNT CHANGED: ${registered.verb} ${registered.table} in ${registered.file} — registered ${registered.count}, found ${sites.length} (lines ${sites.map((s) => s.line).join(", ")}). A new write here is a new door; it needs its own answer.`,
    );
  }
}

for (const w of WRITERS) {
  if (!actual.has(key(w))) {
    violations.push(
      `STALE ENTRY: ${w.verb} ${w.table} in ${w.file} is registered but no longer present — remove it so the registry keeps describing the code`,
    );
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant: "a door that writes identity authority must name the principal that authorizes it",
    canonical: "scripts/check-identity-authority-writers.ts (the WRITERS registry)",
    sites: violations,
    fix: "Answer one question in writing, then add the entry to WRITERS: WHO may cause this write, and what IN THE REQUEST proves they are that? A signature proves authorship, not authority (#713). A path segment is chosen by the caller (#719). An identifier in a body is not a relationship to the object it names (#701). If the honest answer is 'nothing in the request proves it', the door is the defect and the registry entry is not the fix.",
    doctrine:
      "services/relay/CLAUDE.md rule 21 and docs/doctrine/memory-never-confers-authority.md — only a named principal, proven by the request, may move identity authority.",
  });
}

process.stdout.write(
  `✓ check-identity-authority-writers: ${found.length} identity-authority write site(s) across ` +
    `${WRITERS.length} registered door(s), each naming its principal.\n` +
    `  Aperture: ${filesScanned} .ts file(s) scanned under ${SCAN_ROOTS.join(", ")} ` +
    `(excluding __tests__/dist) for INSERT/UPDATE against ${TABLES.length} table(s) ` +
    `(${TABLES.join(", ")}); an UPDATE of agent_registry counts only when its SET clause ` +
    `touches ${AUTHORITY_COLUMNS.join("/")}. Blind to a statement assembled at runtime, ` +
    `and to writes issued from any other package.\n`,
);
