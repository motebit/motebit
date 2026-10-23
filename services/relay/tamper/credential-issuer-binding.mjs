#!/usr/bin/env node
/**
 * Tamper checks for credential issuer binding: a credential is valid only when
 * the proof's signer IS its issuer (and a presentation's signer its holder).
 * Each entry is (file, text to revert, test expected red), run by the shared
 * runner (scripts/lib/tamper-runner.ts) in an isolated copy of the tree:
 *
 *   - `verifyVerifiableCredential`'s binding removed — the crypto tests go red;
 *   - `verify()`'s credential result ignoring the binding — crypto red;
 *   - `verifyVerifiablePresentation`'s holder binding removed — crypto red;
 *   - `verify()`'s presentation result ignoring the holder binding — crypto red;
 *   - the verifier's binding removed, crypto rebuilt — the relay's submit and
 *     verify routes go red (they inherit the binding; nothing else enforces it);
 *   - the relay's issuer normalization reverted to the string-only read — the
 *     object-issuer self-issuance case goes red;
 *   - the market aggregators' issuer normalization reverted — market red;
 *   - the credential store (credential-store.ts): a bound read made raw, a
 *     verified read's validity mode flipped, ambiguous JSON accepted — relay
 *     red; a raw read of the table outside the store, a bound read filtering
 *     after its LIMIT, the raw reader exported — the boundary test red;
 *   - the credential anchoring cut (relay rule 30): the batch INSERT and leaf
 *     assignments run outside one transaction, the assignment UPDATE loses
 *     `AND anchor_batch_id IS NULL`, the cut's short-count refusal removed —
 *     the cut-atomicity test red.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/credential-issuer-binding.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const CREDS = "packages/crypto/src/credentials.ts";
const INDEX = "packages/crypto/src/index.ts";
const RELAY = "services/relay/src/credentials.ts";
const MARKET = "packages/market/src/credential-weight.ts";

// Run as commands with a red marker, not as vitest entries: the repo's vitest
// config pins the JSON reporter's outputFile (see federation-recipient-binding.mjs).
const vitest = (pkg, file) => ({
  command: ["pnpm", "--filter", pkg, "exec", "vitest", "run", file],
  redMarker: "Test Files  1 failed",
});
const CRYPTO = vitest("@motebit/crypto", "src/__tests__/credential-issuer-binding.test.ts");
const RELAY_TEST = vitest("@motebit/relay", "src/__tests__/credential-issuer-binding.test.ts");
const MARKET_TEST = vitest("@motebit/market", "src/__tests__/credential-issuer-form.test.ts");

const VC_BINDING = {
  file: CREDS,
  from: "  if (!proofSignerIs(vc.proof, namedDidOf(vc.issuer))) return false;\n",
  to: "",
};
const VERIFY_BINDING = {
  file: INDEX,
  from: "    valid: proofValid && issuerBound && !expired && !notYetValid,",
  to: "    valid: proofValid && !expired && !notYetValid,",
};

const STORE = "services/relay/src/credential-store.ts";
const BOUNDARY_TEST = vitest("@motebit/relay", "src/__tests__/credential-store-boundary.test.ts");
const CUT_TEST = vitest("@motebit/relay", "src/__tests__/credential-anchor-cut-atomic.test.ts");
const ANCHORING = "services/relay/src/credential-anchoring.ts";
const RAW_READER = {
  file: STORE,
  from: "\nfunction readBoundCredentials<",
  to: "\nfunction readAllCredentials<T>(db: ReadDb, sql: string, ...params: unknown[]): T[] { return db.prepare(sql).all(...params) as T[]; }\nfunction readBoundCredentials<",
};
/**
 * One bound read in the store bypasses BOTH layers of the boundary: its call
 * becomes a raw read and its SQL loses the binding predicate. (Either layer
 * alone still filters, by design, so a tamper of one layer proves nothing.)
 */
const bypass = (name, edits) => ({
  name,
  edits: [RAW_READER, ...edits.map((e) => ({ file: STORE, ...e }))],
  ...RELAY_TEST,
});

const TAMPERS = [
  {
    name: "verifyVerifiableCredential: issuer/signer binding removed",
    edits: [VC_BINDING],
    ...CRYPTO,
  },
  {
    name: "verify(): credential validity ignores the issuer binding",
    edits: [VERIFY_BINDING],
    ...CRYPTO,
  },
  {
    name: "verifyVerifiablePresentation: holder/signer binding removed",
    edits: [
      {
        file: CREDS,
        from:
          "  if (!proofSignerIs(vp.proof, namedDidOf(vp.holder))) {\n" +
          '    errors.push("Presentation holder is not the presentation signer");\n' +
          "  }\n",
        to: "",
      },
    ],
    ...CRYPTO,
  },
  {
    name: "verify(): presentation validity ignores the holder binding",
    edits: [
      {
        file: INDEX,
        from: "  const allValid = envelopeValid && holderBound && credentialResults.every((c) => c.valid);",
        to: "  const allValid = envelopeValid && credentialResults.every((c) => c.valid);",
      },
    ],
    ...CRYPTO,
  },
  {
    name: "relay routes: the verifier's binding removed (crypto rebuilt)",
    edits: [VC_BINDING],
    rebuild: ["@motebit/crypto"],
    ...RELAY_TEST,
  },
  {
    name: "relay submit: issuer read as a string only",
    edits: [
      {
        file: RELAY,
        from:
          "      const issuerDid =\n" +
          '        typeof rawIssuer === "string"\n' +
          "          ? rawIssuer\n" +
          "          : rawIssuer !== null &&\n" +
          '              typeof rawIssuer === "object" &&\n' +
          '              typeof (rawIssuer as { id?: unknown }).id === "string"\n' +
          "            ? (rawIssuer as { id: string }).id\n" +
          '            : "";',
        to: '      const issuerDid = typeof rawIssuer === "string" ? rawIssuer : "";',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "market aggregators: issuer passed through unnormalized",
    edits: [
      {
        file: MARKET,
        from: '  if (typeof issuer === "string") return issuer.length > 0 ? issuer : undefined;\n',
        to: '  if (typeof issuer !== "symbol") return issuer as string;\n',
      },
    ],
    ...MARKET_TEST,
  },
  {
    name: "market: a stored credential counts without its signer being its issuer",
    edits: [
      {
        file: MARKET,
        from: "  return signerDid === issuerDid ? issuerDid : undefined;",
        to: "  return issuerDid;",
      },
    ],
    ...vitest("@motebit/market", "src/__tests__/credential-stored-binding.test.ts"),
  },
  {
    name: "migration v59: stored forgeries are kept",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "          del.run(row.credential_id);",
        to: "          void del;",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the insert trigger accepts a forgery",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "        BEFORE INSERT ON relay_credentials\n        WHEN json_valid(NEW.credential_json) = 0 OR NOT COALESCE(${bound}, 0)",
        to: "        BEFORE INSERT ON relay_credentials\n        WHEN 0",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the update trigger accepts a rewrite into a forgery",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "        BEFORE UPDATE OF credential_json, issuer_did ON relay_credentials\n        WHEN json_valid(NEW.credential_json) = 0 OR NOT COALESCE(${bound}, 0)",
        to: "        BEFORE UPDATE OF credential_json, issuer_did ON relay_credentials\n        WHEN 0",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: anchored forgeries deleted too (breaks honest anchor proofs)",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: '"SELECT credential_id, credential_json FROM relay_credentials WHERE anchor_batch_id IS NULL"',
        to: '"SELECT credential_id, credential_json FROM relay_credentials"',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "migration v59: the trigger ignores the issuer_did column",
    edits: [
      {
        file: "services/relay/src/migrations.ts",
        from: "      ) AND NEW.issuer_did = (",
        to: "      ) AND 1 = 1 AND NULL IS (",
      },
    ],
    ...RELAY_TEST,
  },
  bypass("relay discovery: the hardware-attestation badge reads raw rows", [
    {
      from: '  const placeholders = subjectMotebitIds.map(() => "?").join(",");\n  return readBoundCredentials<{',
      to: '  const placeholders = subjectMotebitIds.map(() => "?").join(",");\n  return readAllCredentials<{',
    },
    {
      from: "         AND subject_motebit_id IN (${placeholders})\n         AND ${BOUND_ISSUER_SQL}\n",
      to: "         AND subject_motebit_id IN (${placeholders})\n",
    },
  ]),
  bypass("relay: the departure attestation counts raw rows", [
    {
      from: "export function countBoundCredentialsForSubject(db: ReadDb, subjectMotebitId: string): number {\n  return readBoundCredentials<",
      to: "export function countBoundCredentialsForSubject(db: ReadDb, subjectMotebitId: string): number {\n  return readAllCredentials<",
    },
    {
      from: "relay_credentials WHERE subject_motebit_id = ? AND ${BOUND_ISSUER_SQL}`,\n    subjectMotebitId,\n  ).length;",
      to: "relay_credentials WHERE subject_motebit_id = ?`,\n    subjectMotebitId,\n  ).length;",
    },
  ]),
  {
    name: "registry: an unregistered read spelled lowercase and quoted",
    edits: [
      {
        file: "services/relay/src/agents.ts",
        from: "  if (boundRows.length === 0) return agents;",
        to: "  if (boundRows.length === 0) return agents;\n  void db.prepare('select 1 from \"relay_credentials\"');",
      },
    ],
    ...BOUNDARY_TEST,
  },
  {
    name: "boundary: a raw read of the table in task-routing.ts",
    edits: [
      {
        file: "services/relay/src/task-routing.ts",
        from: "        const credRows = readBoundReputationCredentialsForRouting(db, mid);",
        to: '        const credRows = readBoundReputationCredentialsForRouting(db, mid);\n        void db.prepare("SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ?").all(mid);',
      },
    ],
    ...BOUNDARY_TEST,
  },
  {
    name: "boundary: a new door calls a store writer",
    edits: [
      {
        file: "services/relay/src/agents.ts",
        from: 'import { readBoundTrustCredentialsForSubjects } from "./credential-store.js";',
        to: 'import {\n  insertRelayIssuedCredentialEvidence,\n  readBoundTrustCredentialsForSubjects,\n} from "./credential-store.js";',
      },
      {
        file: "services/relay/src/agents.ts",
        from: "  if (boundRows.length === 0) return agents;",
        to: "  if (boundRows.length === 0) return agents;\n  if (agents.length < 0) insertRelayIssuedCredentialEvidence(db, null as never);",
      },
    ],
    ...BOUNDARY_TEST,
  },
  {
    name: "boundary: the store exports its raw bound reader",
    edits: [
      {
        file: STORE,
        from: "\nfunction readBoundCredentials<",
        to: "\nexport function readBoundCredentials<",
      },
    ],
    ...BOUNDARY_TEST,
  },
  {
    name: "relay: the owner's list reports every credential as bound",
    edits: [
      {
        file: STORE,
        from: "  return rows.map((r) => ({ ...r, issuer_bound: isBoundRow(r) }));",
        to: "  return rows.map((r) => ({ ...r, issuer_bound: true }));",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the presentation ignores the validity window (an expired credential is presented)",
    edits: [
      {
        file: STORE,
        from: '  }\n  return readVerifiedCredentials<{ credential_json: string }>(\n    "current",',
        to: '  }\n  return readVerifiedCredentials<{ credential_json: string }>(\n    "history",',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the export withholds expired honest credentials (spec/migration-v1.md §6.2)",
    edits: [
      {
        file: STORE,
        from: '  return readVerifiedCredentials<{ credential_id: string; credential_json: string }>(\n    "history",',
        to: '  return readVerifiedCredentials<{ credential_id: string; credential_json: string }>(\n    "current",',
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "relay: the export silently drops what it excluded",
    edits: [
      {
        file: "services/relay/src/migration.ts",
        from: "      excluded_credentials: storedCount - credentials.length,",
        to: "      excluded_credentials: 0,",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "registry: a routing read filters only after its LIMIT",
    edits: [
      {
        file: STORE,
        from: "WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'\n             AND ${BOUND_ISSUER_SQL}",
        to: "WHERE subject_motebit_id = ? AND credential_type = 'AgentReputationCredential'",
      },
    ],
    ...BOUNDARY_TEST,
  },
  {
    name: "boundary: ambiguous (non-canonical, duplicate-key) JSON accepted",
    edits: [
      {
        file: STORE,
        from: "  if (JSON.stringify(parsed) !== text) return null;",
        to: "",
      },
    ],
    ...RELAY_TEST,
  },
  {
    name: "anchoring cut: batch row and leaf assignments outside one transaction",
    edits: [
      {
        file: ANCHORING,
        from: "  db.transaction(() => {\n    db.prepare(\n      `INSERT INTO relay_credential_anchor_batches",
        to: "  ((fn: () => void) => fn())(() => {\n    db.prepare(\n      `INSERT INTO relay_credential_anchor_batches",
      },
    ],
    ...CUT_TEST,
  },
  {
    name: "anchoring cut: an anchored credential re-assigned (IS NULL guard dropped)",
    edits: [
      {
        file: STORE,
        from: "SET anchor_batch_id = ? WHERE credential_id = ? AND anchor_batch_id IS NULL",
        to: "SET anchor_batch_id = ? WHERE credential_id = ?",
      },
    ],
    ...CUT_TEST,
  },
  {
    name: "anchoring cut: a short assignment count committed",
    edits: [
      {
        file: ANCHORING,
        from: "    if (assigned !== rows.length) {",
        to: "    if (assigned > rows.length) {",
      },
    ],
    ...CUT_TEST,
  },
];

await runTampers(TAMPERS, { root: ROOT });
