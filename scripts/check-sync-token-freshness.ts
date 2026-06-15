/**
 * Sync-token freshness check (web surface).
 *
 * The web surface authenticates to the relay with a ROTATING short-lived JWT
 * (`createSyncToken()` mints `exp = now + 5min`; @motebit/panels rule 3 —
 * "web uses a rotating createSyncToken()"). A long-lived sync engine that polls
 * the relay for minutes therefore MUST resolve a FRESH token per request, via
 * the adapter's `credentialSource` provider — never a static `authToken` string
 * captured once at bootstrap. Hand a polling adapter a single 5-minute JWT and
 * every request after minute 5 ships an expired signature; the relay reads an
 * expired `aud:sync` token as "device not authorized" and returns 403, silently
 * wedging cross-device sync for the rest of the session.
 *
 * The motivating incident (2026-06-15): `HttpConversationSyncAdapter` and
 * `HttpPlanSyncAdapter` were each constructed with `authToken: token` (the
 * static 5-min JWT) while their siblings — the event-store HTTP + WS adapters —
 * had already been switched to a per-request `credentialSource`. After 5 minutes
 * the conversation poll 403'd on `/sync/:id/conversations`. A textbook
 * sibling-boundary miss: the staleness fix landed on two of four sync adapters.
 *
 * This is WEB-ONLY by construction. Desktop/CLI authenticate with a static
 * `syncMasterToken` (panels rule 3) that is long-lived by design; mobile uses
 * none. So the rotating-token-must-stay-fresh invariant binds the web surface
 * alone — scanning other surfaces would false-positive on their legitimate
 * static-token strategy.
 *
 * Invariant: in `apps/web/src/**`, every construction of a long-lived HTTP sync
 * adapter (`HttpEventStoreAdapter`, `HttpPlanSyncAdapter`,
 * `HttpConversationSyncAdapter`) MUST pass `credentialSource` in its config
 * object. Exit 1 on any that does not.
 *
 * See `docs/drift-defenses.md` invariant #128 and the per-construction comments
 * at `apps/web/src/web-app.ts`. The `web-app.ts:3474` comment documents the
 * fresh-token pattern this gate locks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Web only — the rotating-token surface. Other surfaces use a static master
// token by design (panels rule 3) and are out of scope by construction.
const SCAN_ROOT = resolve(ROOT, "apps/web/src");

// The long-lived, relay-polling HTTP sync adapters. Each holds its config for
// the session and re-requests on a timer, so each must resolve a token freshly.
// (WebSocketEventStoreAdapter is deliberately excluded: it carries a distinct
// valid pattern — a 4.5-min refresh timer that reconstructs the adapter with a
// freshly minted token — not a static capture.)
const POLLING_ADAPTERS = [
  "HttpEventStoreAdapter",
  "HttpPlanSyncAdapter",
  "HttpConversationSyncAdapter",
] as const;

interface Violation {
  file: string;
  line: number;
  adapter: string;
  reason: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * From the index of `new Adapter(`, extract the first balanced `{ … }` object
 * literal that follows (the constructor config). Returns null if no `{` opens
 * before the call's closing `)` — i.e. the adapter was passed a variable, not
 * an inline object, which this textual gate cannot inspect and treats as a
 * violation (a polling adapter built from an opaque config defeats the check).
 */
function extractConfigObject(src: string, fromIndex: number): string | null {
  const open = src.indexOf("{", fromIndex);
  const paren = src.indexOf(")", fromIndex);
  if (open === -1 || (paren !== -1 && paren < open)) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

const violations: Violation[] = [];

for (const file of walk(SCAN_ROOT)) {
  const src = readFileSync(file, "utf-8");
  for (const adapter of POLLING_ADAPTERS) {
    const needle = `new ${adapter}(`;
    let from = 0;
    for (;;) {
      const at = src.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      const config = extractConfigObject(src, at + needle.length - 1);
      const rel = relative(ROOT, file);
      const line = lineOf(src, at);
      if (config === null) {
        violations.push({
          file: rel,
          line,
          adapter,
          reason: "config is not an inline object literal — cannot prove a fresh-token source",
        });
      } else if (!/\bcredentialSource\b/.test(config)) {
        const hasStatic = /\bauthToken\b/.test(config);
        violations.push({
          file: rel,
          line,
          adapter,
          reason: hasStatic
            ? "passes a static `authToken` with no `credentialSource` — a 5-min JWT goes stale and the relay 403s every poll past minute 5"
            : "missing `credentialSource` — a polling sync adapter must resolve a fresh token per request",
        });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "\n✗ check-sync-token-freshness: web sync adapter(s) without a fresh-token source.\n\n",
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  new ${v.adapter}(…) — ${v.reason}\n`);
  }
  process.stderr.write(
    "\n  The web surface mints rotating 5-minute JWTs (createSyncToken). A long-lived\n" +
      "  polling adapter must take `credentialSource: syncCredentialSource` (re-mints per\n" +
      "  request), never a captured `authToken` string. See apps/web/src/web-app.ts:3474\n" +
      "  and docs/drift-defenses.md invariant #128.\n\n",
  );
  process.exit(1);
}

process.stdout.write(
  "✓ check-sync-token-freshness: every web HTTP sync adapter resolves a fresh token per request.\n",
);
