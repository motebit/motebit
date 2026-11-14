/**
 * Tamper checks for the relay's signed revocation evidence
 * (standing-delegation@1.3 §5.2–§5.3; money-authority increment 2). Each fix,
 * removed alone, must turn its named test red
 * (`delegation-revocation-set-attestation.test.ts`).
 *
 *   node --import tsx scripts/tampers/relay-revocation-evidence.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "services/relay/src/delegation-revocations.ts";
const MIDDLEWARE = "services/relay/src/middleware.ts";
const PKG = "@motebit/relay";
const TEST = "src/__tests__/delegation-revocation-set-attestation.test.ts";

const ROUTE = "revocation set attestation route";
const POST = "inclusion receipt on POST";
const ATOMIC = "relay atomicity (spec §5.2/§8.1): high-water never covers an invisible record";

function entry(
  name: string,
  from: string,
  to: string,
  red: string,
  file: string = SRC,
): TamperEntry {
  return { name, edits: [{ file, from, to }], pkg: PKG, test: TEST, red, only: true };
}

const TAMPERS: TamperEntry[] = [
  // ── Atomicity: entries and high-water in ONE snapshot ──
  {
    name: "set snapshot: transaction wrap removed (entries and high-water read separately)",
    edits: [
      {
        file: SRC,
        from: "  return db.transaction(() => {\n    const rows = db",
        to: "  return ((() => {\n    const rows = db",
      },
      {
        file: SRC,
        from: "      })),\n    };\n  });\n}",
        to: "      })),\n    };\n  }))();\n}",
      },
    ],
    pkg: PKG,
    test: TEST,
    red: `${ATOMIC} a record committed between the snapshot's reads has seq > high-water, and appears once committed-before`,
    only: true,
  },
  entry(
    "set snapshot: high-water is not the relay-wide MAX(seq)",
    '"SELECT COALESCE(MAX(id), 0) AS hw FROM relay_delegation_revocations"',
    '"SELECT 0 AS hw"',
    `${ROUTE} a delegator with no revocations gets a valid empty attestation at the current relay-wide high-water`,
  ),
  entry(
    "set snapshot: not scoped to the delegator",
    "         WHERE delegator_id = ?\n         ORDER BY id ASC`,\n      )\n      .all(delegatorId)",
    "         ORDER BY id ASC`,\n      )\n      .all()",
    `${ROUTE} entries are strictly ascending, scoped to the delegator, and carry no other delegator's records`,
  ),
  entry(
    "set snapshot: entries not ascending by seq",
    "         WHERE delegator_id = ?\n         ORDER BY id ASC`",
    "         WHERE delegator_id = ?\n         ORDER BY id DESC`",
    `${ROUTE} entries are strictly ascending, scoped to the delegator, and carry no other delegator's records`,
  ),

  // ── Inclusion receipt on POST ──
  entry(
    "POST: inclusion receipt dropped from the response",
    "      inclusion_receipt: inclusionReceipt,\n",
    "",
    `${POST} recorded and already_recorded each carry a receipt that verifies, with the same seq on repeat`,
  ),
  entry(
    "POST: already_recorded receipt reads the last-inserted row, not the stored one (seq drifts)",
    "         WHERE signature = ?`,\n      )\n      .get(revocation.signature)",
    "         WHERE id = (SELECT MAX(id) FROM relay_delegation_revocations)`,\n      )\n      .get()",
    `${POST} recorded and already_recorded each carry a receipt that verifies, with the same seq on repeat`,
  ),
  entry(
    "POST: already_recorded receipt stamps the request clock, not the stored received_at",
    "        received_at: row.received_at,\n",
    "        received_at: receivedAt,\n",
    `${POST} recorded and already_recorded each carry a receipt that verifies, with the same seq on repeat`,
  ),

  // ── Route validation ──
  entry(
    "route: challenge length bounds removed",
    "      challenge.length < REVOCATION_SET_ATTESTATION_CHALLENGE_MIN_LENGTH ||\n      challenge.length > REVOCATION_SET_ATTESTATION_CHALLENGE_MAX_LENGTH\n",
    "      (false as boolean)\n",
    `${ROUTE} refuses a missing, short or overlong challenge (400)`,
  ),
  entry(
    "route: a missing challenge is defaulted instead of refused",
    '    const challenge = c.req.query("challenge");\n',
    '    const challenge = c.req.query("challenge") ?? "0".repeat(64);\n',
    `${ROUTE} refuses a missing, short or overlong challenge (400)`,
  ),
  entry(
    "route: delegator id bounds/charset not enforced",
    "    if (idRefusal !== null) {",
    "    if ((false as boolean) && idRefusal !== null) {",
    `${ROUTE} refuses a missing or invalid delegator id (400)`,
  ),

  // ── Auth posture and rate tier ──
  entry(
    "middleware: head route not carved out of the master-token catch-all",
    '  { method: "GET", path: "/api/v1/delegations/revocations/head", auth: PUBLIC_ARTIFACT },\n',
    "",
    `${ROUTE} is public and on the read tier, separate from the write tier the cache path uses`,
    MIDDLEWARE,
  ),
  entry(
    "middleware: head route rate binding removed",
    '  app.use("/api/v1/delegations/revocations/head", rl(readLimiter));\n',
    "",
    `${ROUTE} is public and on the read tier, separate from the write tier the cache path uses`,
    MIDDLEWARE,
  ),
];

void runTampers(TAMPERS, { root: ROOT });
