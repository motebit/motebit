/**
 * Static scan: every signed federation message is recipient-bound
 * (relay-federation@1.5 §3.5). Not a test file: the harness
 * (`federation-signed-kinds.test.ts`) runs it over every non-test source under
 * `services/relay/src` (and the CLI's federation subcommand) and over tamper
 * fixtures.
 *
 * The rules, each red on its own:
 *
 *   ROUTE   Every `.post("/federation/v1/…", handler)` call whose path is a
 *           string literal has, somewhere inside its handler's text, a call
 *           naming exactly ONE §3.5 kind — `verifyFederationRequest(…,
 *           "<kind>", …)` for a work kind, `verifyFederationMessage(…,
 *           { kind: "<kind>", … })` for a control kind — or is in
 *           `UNENVELOPED_ROUTES` with its reason. A verifying handler calls no
 *           raw signature primitive (`verify`, `verifyBySuite`,
 *           `verifyPeerSignature`): one verifier, no parallel path. A work
 *           kind is verified only at its own route (`FEDERATION_WORK_ROUTES`).
 *           An exemption that no route uses, or a route it names that now
 *           verifies a kind, is stale.
 *   CALL    Every `verifyFederationMessage` call names a literal kind and
 *           passes `selfPublicKeyHex` (the recipient-key compare). In the
 *           relay it is the relay's own key, `relayIdentity.publicKeyHex`.
 *           Every `verifyFederationRequest` call names a literal work kind.
 *   KIND    Every kind in `FEDERATION_MESSAGE_KINDS` has a verifier site.
 *   SEND    Every URL template naming a work route (an outbound request)
 *           sits in a function that signs through `signFederationRequest` or
 *           `signDiscoverBody` — the one producer.
 *
 * Aperture — what this scan examines, and what it does not: the TypeScript AST
 * of every scanned file; calls by callee identifier (or `a.b` member name);
 * string/template literals by text. ROUTE sees only `.post(...)` calls with a
 * literal `/federation/v1/` path, and proves only that a verifier CALL is
 * PRESENT in the handler — not that it runs (a call under
 * `if (body.message !== undefined)` passes), not that it runs before the
 * handler's side effects, and not that the handler is the only one at that
 * path. It does not see routes registered by another method (`.put`, `.all`,
 * `.on`), through a computed or prefixed path, or through a sub-router
 * mounted with `app.route("/federation/v1", sub)`. Those are proven by
 * execution in `federation-route-registry.test.ts`: every route the booted
 * relay registers under `/federation` is in its registry, and every signed
 * route refuses a message addressed to another relay's key and the v1 body
 * with no write and no outbound request. This scan keeps the call-site shape
 * (CALL, KIND, SEND) the registry test cannot see.
 */
import ts from "typescript";

/**
 * `/federation/v1/*` POST routes that carry no §3.5 envelope, each with why
 * that is not a recipient-binding gap — or, where it is one, the named
 * residual (relay-federation@1.5 §13).
 */
export const UNENVELOPED_ROUTES: Readonly<Record<string, string>> = {
  "/federation/v1/peer/propose":
    "handshake step 1 (§3.1): unsigned by design. It authorizes nothing and writes no record; the answer is a `peer-challenge` addressed to the key the propose named, and only a `peer-confirm` to THIS relay's key completes the handshake",
  "/federation/v1/horizon/witness":
    "a witness solicitation (§15): the issuer signs the cert BODY, and the same bytes are co-signed by every witness by design, so the signature is portable across witnesses on purpose. It writes nothing; it yields only this relay's own co-signature over a cert whose subject is the issuer",
  "/federation/v1/horizon/dispute":
    "a WitnessOmissionDispute (§15) is a self-verifying signed artifact (`verifyWitnessOmissionDispute`) about one of THIS relay's own certs, resolved by `cert_signature` in its local store — the cert, not an envelope, binds it to this relay",
  "/federation/v1/disputes/:disputeId/vote-request":
    "RESIDUAL (§16): one VoteRequest is fanned out to N peers as one signed artifact and names no recipient, so it is valid at every peer of the requester. It writes nothing and yields only this relay's own signed vote, which the requester could have asked for directly; moving it to a §3.5 kind is deferred",
};

export interface ScanFile {
  /** Repo-relative path. */
  file: string;
  text: string;
}

export interface RouteScan {
  path: string;
  file: string;
  kinds: string[];
  rawVerifiers: string[];
}

export interface ScanResult {
  routes: RouteScan[];
  /** Every kind with a verifier call site, in any scanned file. */
  verifiedKinds: Set<string>;
  violations: string[];
}

const RAW_VERIFIERS = new Set(["verify", "verifyBySuite", "verifyPeerSignature"]);
const SIGNERS = new Set(["signFederationRequest", "signDiscoverBody"]);

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/**
 * True inside the one work-request verifier, `verifyFederationRequest` in
 * `services/relay/src/federation.ts`, which passes its caller's (literal,
 * separately checked) kind through.
 */
function insideRequestVerifier(node: ts.Node, file: string): boolean {
  if (file !== "services/relay/src/federation.ts") return false;
  for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionDeclaration(p)) return p.name?.text === "verifyFederationRequest";
  }
  return false;
}

/** The kind a verifier call names, or `undefined` when it is not a verifier call. */
function verifierKind(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  file: string,
  violations: string[],
): { kind: string | null } | undefined {
  const name = calleeName(call);
  const at = `${file}:${sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1}`;
  if (name === "verifyFederationRequest") {
    const kind = literalText(call.arguments[2]);
    if (kind === null)
      violations.push(`CALL ${at}: verifyFederationRequest without a literal kind`);
    return { kind };
  }
  if (name === "verifyFederationMessage") {
    const opts = call.arguments[1];
    if (opts === undefined || !ts.isObjectLiteralExpression(opts)) {
      violations.push(`CALL ${at}: verifyFederationMessage without an options literal`);
      return { kind: null };
    }
    let kind: string | null = null;
    let self: string | null = null;
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
      if (p.name.text === "kind") kind = literalText(p.initializer);
      if (p.name.text === "selfPublicKeyHex") self = p.initializer.getText(sf);
    }
    if (kind === null && !insideRequestVerifier(call, file))
      violations.push(`CALL ${at}: verifyFederationMessage without a literal kind`);
    if (self === null)
      violations.push(`CALL ${at}: verifyFederationMessage without selfPublicKeyHex`);
    else if (file.startsWith("services/relay/") && self !== "relayIdentity.publicKeyHex")
      violations.push(
        `CALL ${at}: verifyFederationMessage compares the recipient to \`${self}\`, not this relay's own key (relayIdentity.publicKeyHex)`,
      );
    return { kind };
  }
  return undefined;
}

export function scanFederationRoutes(
  files: readonly ScanFile[],
  registry: { kinds: readonly string[]; workRoutes: Readonly<Record<string, string>> },
  exempt: Readonly<Record<string, string>> = UNENVELOPED_ROUTES,
): ScanResult {
  const violations: string[] = [];
  const routes: RouteScan[] = [];
  const verifiedKinds = new Set<string>();
  const known = new Set(registry.kinds);
  const workPaths = new Set(Object.values(registry.workRoutes));

  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      const v = verifierKind(n, sf, file, violations);
      if (v?.kind != null) {
        if (!known.has(v.kind)) violations.push(`CALL ${file}: unknown kind "${v.kind}"`);
        verifiedKinds.add(v.kind);
      }
    });

    // ROUTE
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return;
      if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "post") return;
      const path = literalText(n.arguments[0]);
      if (path === null || !path.startsWith("/federation/v1/")) return;
      const handler = n.arguments[1];
      const kinds: string[] = [];
      const rawVerifiers: string[] = [];
      if (handler !== undefined) {
        walk(handler, (h) => {
          if (!ts.isCallExpression(h)) return;
          const v = verifierKind(h, sf, file, []);
          if (v?.kind != null) kinds.push(v.kind);
          const name = calleeName(h);
          if (name !== null && RAW_VERIFIERS.has(name)) rawVerifiers.push(name);
        });
      }
      routes.push({ path, file, kinds, rawVerifiers });
    });

    // SEND
    walk(sf, (n) => {
      if (!ts.isTemplateExpression(n)) return;
      const t = n.getText(sf);
      const hit = [...workPaths].find((p) => t.includes(`${p}\``) || t.includes(`${p}?`));
      if (hit === undefined) return;
      let fn: ts.Node | undefined = n.parent;
      while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
      let signs = false;
      if (fn !== undefined) {
        walk(fn, (c) => {
          if (ts.isCallExpression(c) && SIGNERS.has(calleeName(c) ?? "")) signs = true;
        });
      }
      if (!signs) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        violations.push(
          `SEND ${file}:${line}: a request to ${hit} is built in a function that does not sign it through signFederationRequest / signDiscoverBody`,
        );
      }
    });
  }

  const seenExempt = new Set<string>();
  for (const r of routes) {
    const where = `${r.file} ${r.path}`;
    if (Object.prototype.hasOwnProperty.call(exempt, r.path)) {
      seenExempt.add(r.path);
      if (r.kinds.length > 0)
        violations.push(
          `ROUTE ${where}: exempt as unenveloped but verifies ${r.kinds.join(", ")} — remove the stale exemption`,
        );
      continue;
    }
    const distinct = [...new Set(r.kinds)];
    if (distinct.length !== 1) {
      violations.push(
        distinct.length === 0
          ? `ROUTE ${where}: verifies no §3.5 kind — a signed federation request must go through verifyFederationRequest / verifyFederationMessage (or be listed in UNENVELOPED_ROUTES with its reason)`
          : `ROUTE ${where}: verifies several kinds (${distinct.join(", ")})`,
      );
    }
    for (const k of distinct) {
      const own = registry.workRoutes[k];
      if (own !== undefined && own !== r.path)
        violations.push(`ROUTE ${where}: verifies work kind "${k}", which belongs to ${own}`);
    }
    if (r.rawVerifiers.length > 0)
      violations.push(
        `ROUTE ${where}: calls a raw verifier (${[...new Set(r.rawVerifiers)].join(", ")}) beside the §3.5 one — one verifier, no parallel path`,
      );
  }
  for (const p of Object.keys(exempt)) {
    if (!seenExempt.has(p))
      violations.push(`ROUTE ${p}: stale UNENVELOPED_ROUTES entry (no such route)`);
  }
  for (const [k, p] of Object.entries(registry.workRoutes)) {
    if (!routes.some((r) => r.path === p && r.kinds.includes(k)))
      violations.push(`KIND ${k}: its route ${p} does not verify it`);
  }
  for (const k of registry.kinds) {
    if (!verifiedKinds.has(k))
      violations.push(`KIND ${k}: no verifier site in the scanned sources`);
  }
  return { routes, verifiedKinds, violations };
}
