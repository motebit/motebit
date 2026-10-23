/**
 * One module owns the credential table (GHSA-7pgw-2976-r236).
 *
 * The table is evidence, not a trust source: rows stored before the issuer
 * binding, and kept because they are anchored, can name an issuer that never
 * signed them. So every SQL statement against it lives in
 * `credential-store.ts`, as a named function that is either EVIDENCE (raw
 * rows, conferring nothing) or BOUND / VERIFIED (what a trust-bearing
 * consumer reads). A caller cannot write the wrong read, because it cannot
 * write a read at all.
 *
 * The rule: outside `src/credential-store.ts` and the schema migrations
 * (`src/migrations.ts`), no non-test relay source mentions the table's name,
 * in any spelling (`from`, `"..."`, `main.`, a subquery, a comment).
 *
 * Aperture: every file under services/relay ending .ts/.tsx/.js/.mjs/.cjs/.sql,
 * except `.test.` files and the node_modules, dist, coverage, __tests__ and
 * tamper directories; the identifier is matched case-insensitively, comments
 * included (a regex comment-stripper can swallow real code). Out of scope: a
 * table name assembled at runtime (`"relay_" + "credentials"`) and every
 * other package. This test guards against drift; deliberate evasion is a
 * review matter.
 *
 * Inside the store, every bound or verified read applies `BOUND_ISSUER_SQL`
 * in its WHERE clause, so a LIMIT counts bound rows only; every Bound/Verified
 * export reads only through the private bound/verified readers (the owner's
 * status list marks every row instead); the number of statements is pinned
 * (`STORE_MENTIONS`), so a new one is reviewed rather than added silently; and
 * every exported function's name says which kind it is.
 *
 * Who may use the store is a closed set too (`REFERENCES`): every name it
 * exports, and every file outside it that names one, counted, imports
 * included. Counting names, not call shapes, catches a call, a reference
 * passed into a deps object, an aliased import and a new wrapper export alike;
 * `import * as` and `export *` of the store are refused. The behaviour of each
 * bound reader is proven in `credential-issuer-binding.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "tamper"]);
const CODE = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const MENTION = /relay_credentials(?![a-z0-9_])/gi;
const MENTIONS_TABLE = /relay_credentials(?![a-z0-9_])/i;
const STORE = "src/credential-store.ts";
/** The only files allowed to name the table, and why. */
const OWNERS: Record<string, string> = {
  [STORE]: "the credential store: every statement against the table",
  "src/migrations.ts":
    "the schema migrations: create, indexes, column add, v59 triggers and cleanup",
};
const BOUND_CALL =
  /read(?:Bound|Verified)Credentials(?:<[^>]*>)?\(\s*(?:"(?:current|history)"\s*,\s*)?db\s*,\s*(["'`])([\s\S]*?)\1/g;
/**
 * Every name the store exports, and every file outside it that names it, with
 * the count of mentions (imports included). A closed set: a new export, a new
 * file, or one more mention of an export (a second call, the function passed
 * by reference into a deps object, an aliased import) fails until it is
 * registered here with its reason. A WRITER's callers are new doors onto a
 * stored row (check-identity-authority-writers registers the SQL itself); a
 * Bound/Verified reader's callers are trust consumers; an Evidence reader
 * handed to a trust consumer is the mistake this table makes visible in review.
 * Counting names rather than call shapes is what makes the set closed.
 */
const REFERENCES: Record<string, Record<string, number>> = {
  // The binding rule, re-exported by the shim for credential-issuer-binding.test.ts.
  BOUND_ISSUER_SQL: { "src/credential-reads.ts": 1 },
  isBoundRow: { "src/credential-reads.ts": 1 },
  boundCredentialRows: { "src/credential-reads.ts": 1 },
  // The transparency declaration names the table it retains.
  CREDENTIAL_STORE_TABLE: { "src/transparency.ts": 2 },
  // Trust consumers (bound / verified reads).
  readBoundReputationCredentialsForRouting: { "src/task-routing.ts": 2 },
  readBoundTrustCredentialsForRouting: { "src/task-routing.ts": 2 },
  readBoundTrustCredentialsForSubjects: { "src/agents.ts": 2 }, // discovery's hardware badge
  countBoundCredentialsForSubject: { "src/migration.ts": 2 }, // departure attestation
  readVerifiedCredentialsForPresentation: { "src/credentials.ts": 2 },
  readVerifiedCredentialsForExport: { "src/migration.ts": 2 },
  listOwnerCredentialsWithBoundStatus: { "src/credentials.ts": 2 }, // every row, marked
  // Writers: each caller is a door.
  insertSubmittedCredential: { "src/credentials.ts": 4 }, // credentials/submit (BoundIdentity owner, #850); re-exported
  insertRelayIssuedCredentialEvidence: { "src/tasks.ts": 2, "src/federation-callbacks.ts": 2 }, // the relay's own reputation credential
  assignCredentialEvidenceToBatch: { "src/credential-anchoring.ts": 2 },
  addCredentialEvidenceAnchorColumn: { "src/credential-anchoring.ts": 2 },
  // Evidence reads (confer nothing).
  getCredentialEvidenceHolding: {},
  getCredentialEvidenceParties: { "src/credentials.ts": 2 }, // revoke authority: who issued / holds it
  countCredentialEvidenceForSubject: { "src/migration.ts": 2 }, // the export's stored-row accounting
  listUnanchoredCredentialEvidence: { "src/credential-anchoring.ts": 2 },
  countUnanchoredCredentialEvidence: { "src/credential-anchoring.ts": 3 },
  oldestUnanchoredCredentialEvidenceIssuedAt: { "src/credential-anchoring.ts": 2 },
  getCredentialEvidenceWithBatch: { "src/credential-anchoring.ts": 2 },
  listCredentialEvidenceInBatch: { "src/credential-anchoring.ts": 2 },
  getCredentialEvidenceBatchId: { "src/credential-anchoring.ts": 2 },
  CredentialEvidenceRow: {},
  CredentialEvidenceLeaf: {},
};
/**
 * Mentions of the table inside the store. Pinned, so a statement added to
 * the store fails until it is counted here: a bound read that skips the
 * binding is caught by review of exactly that change, never added silently.
 */
const STORE_MENTIONS = 24;
/** Exported store functions whose names need not say their kind, and why. */
const NAME_EXEMPT: Record<string, string> = {
  insertSubmittedCredential:
    "the #850 bound writer; its name is registered in check-identity-authority-writers and relay rule 26",
};
const REPAIR =
  "Move the statement into src/credential-store.ts as a named function (an `...Evidence...` " +
  "function when it confers nothing; a `...Bound...`/`...Verified...` function when a consumer " +
  "presents, counts or weighs a credential as issued by its issuer) and call it. A comment that " +
  "names the table should say `the credential store` instead.";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(path);
    return CODE.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const scanned = sources(ROOT);
const mentions = new Map<string, number>();
for (const path of scanned) {
  const count = readFileSync(path, "utf8").match(MENTION)?.length ?? 0;
  if (count > 0) mentions.set(relative(ROOT, path), count);
}
const store = readFileSync(join(ROOT, STORE), "utf8");

describe("one module owns the credential table", () => {
  it("scans the relay's sources (aperture)", () => {
    // Guards the aperture itself: a scan that found nothing proves nothing.
    expect(scanned.length).toBeGreaterThan(100);
    expect(mentions.has(STORE)).toBe(true);
  });

  it("no source outside the store and the migrations mentions the table", () => {
    const strays = [...mentions.keys()]
      .filter((file) => !(file in OWNERS))
      .map((file) => `${file} (${mentions.get(file)} mention(s)) — ${REPAIR}`);
    expect(strays).toEqual([]);
  });

  it("every bound or verified read in the store filters in SQL, before any LIMIT", () => {
    const bound = [...store.matchAll(BOUND_CALL)]
      .map((m) => m[2]!)
      .filter((sql) => MENTIONS_TABLE.test(sql));
    expect(bound.length).toBeGreaterThan(0);
    const unfiltered = bound.filter((sql) => !sql.includes("${BOUND_ISSUER_SQL}"));
    expect(
      unfiltered,
      "add `AND ${BOUND_ISSUER_SQL}` to the WHERE clause, before ORDER BY / LIMIT",
    ).toEqual([]);
  });

  it("the raw bound/verified readers stay private to the store", () => {
    // Exported, they would take SQL from a caller again.
    expect(store).not.toMatch(/export\s+(async\s+)?function\s+read(Bound|Verified)Credentials\b/);
  });

  it("every exported function names its kind", () => {
    const exported = [...store.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
      (m) => m[1]!,
    );
    // Evidence confers nothing; Bound/Verified confer attribution; the binding
    // rule itself (isBoundRow, boundCredentialRows) is a predicate.
    const unnamed = exported.filter(
      (name) => !/evidence|bound|verified/i.test(name) && !(name in NAME_EXEMPT),
    );
    expect(
      unnamed,
      "name an exported store function `...Evidence...` (raw rows) or `...Bound...`/`...Verified...`",
    ).toEqual([]);
  });

  it("every store export is registered, and named only from its registered files", () => {
    const exported = [
      ...store.matchAll(
        /export\s+(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s+(\w+)/g,
      ),
    ]
      .map((m) => m[1]!)
      .sort();
    expect(exported, "register each store export in REFERENCES with its files").toEqual(
      Object.keys(REFERENCES).sort(),
    );
    const found: Record<string, Record<string, number>> = {};
    for (const name of exported) {
      found[name] = {};
      const mention = new RegExp(`\\b${name}\\b`, "g");
      for (const path of scanned) {
        const file = relative(ROOT, path);
        if (file === STORE) continue;
        const n = readFileSync(path, "utf8").match(mention)?.length ?? 0;
        if (n > 0) found[name][file] = n;
      }
    }
    expect(
      found,
      "a new file or mention of a store export is a new door or consumer: register it in REFERENCES with its reason",
    ).toEqual(REFERENCES);
  });

  it("nothing imports the store wholesale or re-exports it in bulk", () => {
    // `import * as store` / `export * from` would let a name travel unseen.
    const bulk = scanned
      .filter((path) => relative(ROOT, path) !== STORE)
      .filter((path) =>
        /(import\s*\*\s*as\s+\w+|export\s*\*(\s*as\s+\w+)?)\s*from\s*["'][^"']*credential-store/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(ROOT, path));
    expect(bulk).toEqual([]);
  });

  it("the store's statements are counted, and every bound or verified export reads through the binding", () => {
    expect(
      store.match(MENTION)?.length,
      "a statement was added to or removed from the store: review it, then update STORE_MENTIONS",
    ).toBe(STORE_MENTIONS);
    const bodies = [
      ...store.matchAll(
        /export\s+(?:async\s+)?function\s+(\w+)([\s\S]*?)(?=\n\/\*\*|\nexport\s|$)/g,
      ),
    ].filter(
      (m) => /Bound|Verified/.test(m[1]!) && !/^(isBoundRow|boundCredentialRows)$/.test(m[1]!),
    );
    expect(bodies.length).toBeGreaterThan(0);
    // The owner's own list shows every row with its status instead of hiding
    // unbound ones (#1131 review 5): it reads raw and must mark each row.
    const STATUS_READERS = new Set(["listOwnerCredentialsWithBoundStatus"]);
    const bad = bodies
      .filter((m) =>
        STATUS_READERS.has(m[1]!)
          ? !/\bisBoundRow\(/.test(m[2]!)
          : /\.prepare\s*\(/.test(m[2]!) ||
            !/\bread(?:Bound|Verified)Credentials\s*(?:<[^>]*>)?\(/.test(m[2]!),
      )
      .map((m) => m[1]!);
    expect(
      bad,
      "a Bound/Verified export must read only through readBoundCredentials / readVerifiedCredentials, never db.prepare",
    ).toEqual([]);
  });
});
