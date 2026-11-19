/**
 * The operator (master) token, and the one place the CLI reads it.
 *
 * An operator token is one relay's master credential. The relay compares it
 * as an opaque string: it names no audience, no issuer and no expiry, so
 * nothing in the token says which relay it is for. The CLI used to read it
 * from `--sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN` and send it
 * to whatever relay URL the invocation resolved; with relay A's token
 * exported and the URL naming relay B, B received A's master token.
 *
 * Now the token is sent to a relay only when the owner has recorded, by a
 * deliberate act (`motebit relay bind-token --sync-url <url>`), that this
 * token belongs to that relay URL. The record is
 * `relay-operator-tokens.json` in the config directory: one SHA-256 hash per
 * relay URL (`relayPinKey`, the normalizer the relay key record uses), never
 * a token. In every other case the token is withheld and the caller behaves
 * as it does with no operator token set.
 *
 * This module is the ONLY code under `apps/cli/src` that reads the token
 * flag or the two variables (`check-cli-operator-token-reader`). No export
 * returns a token that is not bound to the URL it was asked about.
 *
 * Not claimed: that the recorded relay is honest, or that its URL still
 * reaches the same operator. The record ties a token to a URL the owner
 * named, nothing more.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { relayPinKey } from "@motebit/runtime";
import { sanitizeRelayText } from "@motebit/sync-engine";
import { dim, success } from "./colors.js";
import { CONFIG_DIR } from "./config.js";
import { isTrulyAbsent, mkdirOwnerOnly, withFileLock, writeFileAtomic } from "./durable-file.js";

// ── Sources ─────────────────────────────────────────────────────────────────

/**
 * One place an operator token can come from: `flag` is `--sync-token`, `api`
 * and `sync` are the two environment variables. A call site names the ones it
 * honours, in order; the names deliberately contain none of the strings the
 * reader gate matches.
 */
export type OperatorTokenSource = "flag" | "api" | "sync";

/** The sources a call site honours, in precedence order. */
export type OperatorTokenSources = readonly OperatorTokenSource[];

/** Flag, then `MOTEBIT_API_TOKEN`, then `MOTEBIT_SYNC_TOKEN`: the full set. */
export const ALL_OPERATOR_TOKEN_SOURCES: OperatorTokenSources = ["flag", "api", "sync"];

/** The part of the parsed CLI config this module reads: the token flag. */
export interface OperatorTokenConfig {
  syncToken: string | undefined;
}

/** For a call site that parses no flags (`motebit doctor`). */
export const NO_FLAG_CONFIG: OperatorTokenConfig = { syncToken: undefined };

const SOURCE_NAME: Record<OperatorTokenSource, string> = {
  flag: "--sync-token",
  api: "MOTEBIT_API_TOKEN",
  sync: "MOTEBIT_SYNC_TOKEN",
};

function sourceValue(source: OperatorTokenSource, config: OperatorTokenConfig): string | undefined {
  switch (source) {
    case "flag":
      return config.syncToken;
    case "api":
      return process.env["MOTEBIT_API_TOKEN"];
    case "sync":
      return process.env["MOTEBIT_SYNC_TOKEN"];
  }
}

/**
 * The first DEFINED source, as every reader did before this module: an empty
 * value counts as defined and hides the sources after it, and the caller then
 * treats the empty value as unset.
 */
function firstDefined(
  sources: OperatorTokenSources,
  config: OperatorTokenConfig,
): { source: OperatorTokenSource; value: string } | undefined {
  for (const source of sources) {
    const value = sourceValue(source, config);
    if (value != null) return { source, value };
  }
  return undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

// ── The record ──────────────────────────────────────────────────────────────

/** The record's path: `relay-operator-tokens.json` in the config directory. */
export function relayOperatorTokensPath(): string {
  return path.join(CONFIG_DIR, "relay-operator-tokens.json");
}

type RecordRead =
  { status: "ok"; tokens: Map<string, string> } | { status: "damaged"; cause: string };

/** Read the record. An absent file is an empty record. Never throws. */
function readRecord(file: string): RecordRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && isTrulyAbsent(file)) return { status: "ok", tokens: new Map() };
    return { status: "damaged", cause: `it cannot be read: ${code ?? "error"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "damaged", cause: "it is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "damaged", cause: "it is not a JSON object" };
  }
  const doc = parsed as Record<string, unknown>;
  if (!Object.hasOwn(doc, "version") || doc["version"] !== 1) {
    return { status: "damaged", cause: "its version is not one this motebit reads (1)" };
  }
  const tokens = Object.hasOwn(doc, "tokens") ? doc["tokens"] : undefined;
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
    return { status: "damaged", cause: "its `tokens` is not an object" };
  }
  // A Map, never a plain object: a `__proto__` key in the file is one more
  // key, reachable only by asking for exactly that key, which no relay URL
  // normalizes to.
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return { status: "damaged", cause: "an entry is not a string" };
    }
    out.set(key, value);
  }
  return { status: "ok", tokens: out };
}

const damagedSaid = new Set<string>();
const withheldSaid = new Set<string>();

/** Test-only: forget which lines this process has already printed. */
export function resetOperatorTokenMemoryForTests(): void {
  damagedSaid.clear();
  withheldSaid.clear();
}

/**
 * The record's entries for reading. A damaged record is NO entries, with one
 * line on stderr naming the file (once per process): the safe behaviour is to
 * withhold, never to exit.
 */
function entriesForRead(): Map<string, string> {
  const file = relayOperatorTokensPath();
  const read = readRecord(file);
  if (read.status === "ok") return read.tokens;
  if (!damagedSaid.has(file)) {
    damagedSaid.add(file);
    process.stderr.write(
      `Warning: the operator token record ${file} is unusable (${read.cause}); no operator token is sent to any relay. ` +
        `Move the file aside and run \`motebit relay bind-token --sync-url <url>\` again.\n`,
    );
  }
  return new Map();
}

// ── The bound token ─────────────────────────────────────────────────────────

declare const boundBrand: unique symbol;

/**
 * An operator token together with the relay URL it is bound to. Only this
 * module constructs one. A site that sends by header calls
 * `bearerHeaders(bound)` and requests `bound.relayUrl`; a site that hands a
 * string to a package passes `bound.token` together with `bound.relayUrl` in
 * the same call.
 */
export interface BoundOperatorToken {
  /** The relay URL the caller asked about, exactly as it gave it. */
  readonly relayUrl: string;
  readonly token: string;
  readonly [boundBrand]: true;
}

/** `Authorization` for a bound token. Send it to `bound.relayUrl` only. */
export function bearerHeaders(bound: BoundOperatorToken): Record<string, string> {
  return { Authorization: `Bearer ${bound.token}` };
}

/**
 * The operator token this call site may send to `relayUrl`, or undefined.
 *
 * It takes the first defined of `sources` (an empty value counts as defined
 * and then as unset), and returns it only when its SHA-256 equals the
 * record's entry for `relayPinKey(relayUrl)`. A URL `relayPinKey` refuses has
 * no entry and gets no token.
 *
 * When it withholds a non-empty token it says so on stderr, once per process
 * and relay URL: which source the token came from, the URL it was not sent
 * to, and the command that binds it. It never prints the token.
 *
 * `undefined` means "behave as with no operator token set".
 */
export function operatorTokenFor(
  relayUrl: string,
  sources: OperatorTokenSources,
  config: OperatorTokenConfig,
): BoundOperatorToken | undefined {
  const found = firstDefined(sources, config);
  if (found === undefined || found.value === "") return undefined;
  const pinKey = relayPinKey(relayUrl);
  if (pinKey !== null) {
    const entry = entriesForRead().get(pinKey);
    if (entry !== undefined && entry === hashToken(found.value)) {
      return { relayUrl, token: found.value } as BoundOperatorToken;
    }
  }
  sayWithheld(relayUrl, pinKey, found.source);
  return undefined;
}

/** What makes a relay URL one a token can be bound to (`relayPinKey` accepts it). */
const BINDABLE_URL_RULE =
  "it must be an http(s) address without `?`, `#`, `@`, a backslash or spaces";

function sayWithheld(relayUrl: string, pinKey: string | null, source: OperatorTokenSource): void {
  const memo = pinKey ?? relayUrl;
  if (withheldSaid.has(memo)) return;
  withheldSaid.add(memo);
  const shown = sanitizeRelayText(relayUrl);
  process.stderr.write(
    pinKey === null
      ? `Operator token (${SOURCE_NAME[source]}) was not sent to ${shown}: this relay URL cannot have a token bound to it ` +
          `(${BINDABLE_URL_RULE}). Name the relay by a plain address.\n`
      : `Operator token (${SOURCE_NAME[source]}) was not sent to ${shown}: it is not bound to that relay. ` +
          `This command continues as if no operator token were set. ` +
          `If the token is this relay's, bind it once: \`motebit relay bind-token --sync-url ${shown}\`.\n`,
  );
}

/**
 * Whether an operator token is SET for this process (bound or not).
 * `/connect` refuses on this: it never sends an operator token to a relay
 * named inside a session, whatever the record says.
 *
 * The answer carries a whole sentence naming the source, not the source's
 * name by itself: no export or returned value of this module is a bare flag
 * or variable name, or a short fragment around one. An importer that parses
 * a name out of a sentence at run time is not prevented; that is blind spot
 * (2) of `check-cli-operator-token-reader`.
 */
export function operatorTokenIsSet(
  sources: OperatorTokenSources,
  config: OperatorTokenConfig,
): { sentence: string } | undefined {
  const found = firstDefined(sources, config);
  if (found === undefined || found.value === "") return undefined;
  return {
    sentence: `An operator token is set for this session (${SOURCE_NAME[found.source]}).`,
  };
}

// ── Binding ─────────────────────────────────────────────────────────────────

/** What `bindOperatorToken` did. It never carries the token. */
export type BindResult =
  | {
      ok: true;
      /** The record's key for the relay: the URL as normalized. */
      relay: string;
      file: string;
      /** The whole line saying where the token came from and six characters of its hash. */
      tokenLine: string;
      /** The first 6 characters of the token's SHA-256. */
      hashPrefix: string;
      /** True when an entry for this relay existed and was replaced. */
      replaced: boolean;
      /** Whole sentences to print as warnings; empty when there are none. */
      warnings: string[];
    }
  | {
      ok: false;
      reason: "unbindable_url" | "no_token" | "empty_token" | "record_unusable";
      /** A whole sentence saying what was refused and why. Nothing was written. */
      message: string;
    };

/**
 * Record that the operator token of this process belongs to `relayUrl`.
 * The token is read (flag, then `MOTEBIT_API_TOKEN`, then
 * `MOTEBIT_SYNC_TOKEN`), hashed and written HERE; the caller never holds it.
 *
 * It replaces an existing entry for the relay (a relay's token can be
 * rotated). It makes no network request and does not prove the relay accepts
 * the token. It refuses, writing nothing, for a URL `relayPinKey` refuses, no
 * token, an empty token, or a record it cannot read (it does not overwrite a
 * damaged record). Never throws.
 */
export function bindOperatorToken(relayUrl: string, config: OperatorTokenConfig): BindResult {
  const shown = sanitizeRelayText(relayUrl);
  const pinKey = relayPinKey(relayUrl);
  if (pinKey === null) {
    return {
      ok: false,
      reason: "unbindable_url",
      message:
        `Cannot bind an operator token to ${shown}: the relay URL must be an http(s) address ` +
        "without `?`, `#`, `@`, a backslash or spaces. Nothing was written.",
    };
  }
  const found = firstDefined(ALL_OPERATOR_TOKEN_SOURCES, config);
  if (found === undefined) {
    return {
      ok: false,
      reason: "no_token",
      message:
        "No operator token to bind: pass --sync-token <token>, or set MOTEBIT_API_TOKEN or MOTEBIT_SYNC_TOKEN. Nothing was written.",
    };
  }
  if (found.value === "") {
    return {
      ok: false,
      reason: "empty_token",
      message: `The operator token from ${SOURCE_NAME[found.source]} is empty. Nothing was written.`,
    };
  }
  const hash = hashToken(found.value);
  const file = relayOperatorTokensPath();
  const unusable = (cause: string): BindResult => ({
    ok: false,
    reason: "record_unusable",
    message:
      `The operator token record ${file} cannot be used (${sanitizeRelayText(cause)}). Nothing was written, and the file was not overwritten. ` +
      "Fix or move the file aside, then run the command again.",
  });
  try {
    mkdirOwnerOnly(path.dirname(file));
    return withFileLock(
      file,
      (): BindResult => {
        const read = readRecord(file);
        if (read.status === "damaged") return unusable(read.cause);
        const previous = read.tokens.get(pinKey);
        const sharedWith = [...read.tokens.entries()]
          .filter(([key, value]) => key !== pinKey && value === hash)
          .map(([key]) => key);
        read.tokens.set(pinKey, hash);
        // A null-prototype object, so no key of the record is special.
        const tokens = Object.assign(
          Object.create(null) as Record<string, string>,
          Object.fromEntries(read.tokens),
        );
        writeFileAtomic(file, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, 0o600);
        const warnings: string[] = [];
        if (sharedWith.length > 0) {
          warnings.push(
            `The same token is already bound to ${sharedWith.map((u) => sanitizeRelayText(u)).join(", ")}. ` +
              "Relays may share a token (staging), but if this is another relay's token left in your environment, " +
              "this relay now receives it: check before running an operator command.",
          );
        }
        const api = process.env["MOTEBIT_API_TOKEN"];
        const sync = process.env["MOTEBIT_SYNC_TOKEN"];
        if (api != null && api !== "" && sync != null && sync !== "" && api !== sync) {
          warnings.push(
            `MOTEBIT_API_TOKEN and MOTEBIT_SYNC_TOKEN are both set and differ; the one bound is ${SOURCE_NAME[found.source]}. ` +
              "`motebit run` reads only MOTEBIT_SYNC_TOKEN and `motebit serve` reads only MOTEBIT_API_TOKEN " +
              "(each after --sync-token), so a command that reads the other variable still has its token withheld.",
          );
        }
        return {
          ok: true,
          relay: pinKey,
          file,
          tokenLine: `token   from ${SOURCE_NAME[found.source]} (sha256 ${hash.slice(0, 6)}…; the token is not stored)`,
          hashPrefix: hash.slice(0, 6),
          replaced: previous !== undefined,
          warnings,
        };
      },
      { timeoutMs: 5_000 },
    );
  } catch (err) {
    return unusable(err instanceof Error ? err.message : String(err));
  }
}

// ── Sentences ───────────────────────────────────────────────────────────────
//
// Text that names the token flag or variables, for files that must not name
// them themselves. Every one is a FUNCTION returning complete user-facing
// lines: no export is a bare flag or variable name, or a short fragment
// around one. That is all that is enforced (by this module's tests). An
// importer that parses a name out of a returned sentence at run time is the
// gate's stated blind spot (2).

/**
 * `motebit smoke reconciliation` refusing for want of an operator token.
 * With NO token set this is the text the command has always printed. With a
 * token set but not bound to `relayUrl` it says that instead, with the bind
 * command.
 */
export function smokeTokenRequiredMessage(
  relayUrl: string,
  sources: OperatorTokenSources,
  config: OperatorTokenConfig,
): string {
  if (operatorTokenIsSet(sources, config) !== undefined) {
    const probes =
      "  This subcommand probes the relay's\n" +
      "  master-token-gated /api/v1/admin/treasury-reconciliation surface\n" +
      "  and exits non-zero on failure (suitable for CI / cron).";
    // No bind command for a URL `bind-token` would refuse.
    if (relayPinKey(relayUrl) === null) {
      return (
        "Error: motebit smoke reconciliation requires a master token, and the one set cannot be bound to this relay URL.\n" +
        `  A token is bound to a relay by its URL, and ${BINDABLE_URL_RULE}. Name the relay by a plain address.\n` +
        probes
      );
    }
    return (
      "Error: motebit smoke reconciliation requires a master token, and the one set is not bound to this relay.\n" +
      `  Bind it once: \`motebit relay bind-token --sync-url ${sanitizeRelayText(relayUrl)}\`.\n` +
      probes
    );
  }
  return (
    "Error: motebit smoke reconciliation requires a master token.\n" +
    "  Set MOTEBIT_API_TOKEN (or MOTEBIT_SYNC_TOKEN, or pass --sync-token <token>)\n" +
    "  with the relay's admin token. This subcommand probes the relay's\n" +
    "  master-token-gated /api/v1/admin/treasury-reconciliation surface\n" +
    "  and exits non-zero on failure (suitable for CI / cron)."
  );
}

/**
 * `motebit doctor`'s detail when the treasury probe was refused: no operator
 * token was sent, either because none is set or because the one set is not
 * bound to this relay.
 */
export function treasuryProbeSkippedDetail(
  relayUrl: string,
  sources: OperatorTokenSources,
  config: OperatorTokenConfig,
  bound: BoundOperatorToken | undefined,
): string {
  if (bound === undefined && operatorTokenIsSet(sources, config) !== undefined) {
    // No bind command for a URL `bind-token` would refuse.
    if (relayPinKey(relayUrl) === null) {
      return `skipped — operator-only check (an operator token is set, but this relay URL cannot have a token bound to it: ${BINDABLE_URL_RULE})`;
    }
    return `skipped — operator-only check (an operator token is set but not bound to this relay; run \`motebit relay bind-token --sync-url ${sanitizeRelayText(relayUrl)}\`)`;
  }
  return "skipped — operator-only check (set MOTEBIT_API_TOKEN to enable)";
}

/** `motebit relay up`: the token file beside the database is empty. */
export function relayTokenFileEmptyMessage(file: string): string {
  return `The relay's token file ${file} is empty. Delete it to generate a new token, or set MOTEBIT_API_TOKEN.`;
}

/** `motebit relay up`: the banner's auth line when the environment supplied the master token. */
export function relayUpAuthLineFromEnv(): string {
  return `  ${dim("—")} auth     ${success("master token")} ${dim("from MOTEBIT_API_TOKEN")}`;
}

/**
 * `motebit relay up`: the banner's auth line when the token is kept in
 * `tokenFile`, with how an operator uses it with this CLI for a relay
 * listening on `port`.
 */
export function relayUpAuthLineFromFile(tokenFile: string, port: number): string {
  const url = `http://localhost:${String(port)}`;
  const hint =
    `in ${tokenFile} (for operator commands: export MOTEBIT_API_TOKEN=$(cat <that file>), ` +
    `then bind it once with \`motebit relay bind-token --sync-url ${url}\` — spell the URL as you will name ` +
    "the relay later: `localhost` and `127.0.0.1` are different entries)";
  return `  ${dim("—")} auth     ${success("master token")} ${dim(hint)}`;
}
