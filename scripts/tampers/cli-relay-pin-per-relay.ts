/**
 * Tamper checks for "the CLI uses a relay key only for the relay URL that
 * key signs" (`packages/runtime/src/relay-key-pin.ts`: `relayPinKey`,
 * `verifyRelayMetadataForUrl`; `apps/cli/src/relay-pins.ts`: the per-relay
 * record, `bindRelayPin`, `resolveRelayKey`; the three money-path readers in
 * `index.ts`, `subcommands/delegate.ts`, `grant-preflight.ts`; `register.ts`).
 *
 * The CLI held one relay key for all relays, so a session on relay B could
 * use relay A's key on the paid peer-to-peer path: the client broadcast a
 * payment and B rejected the task. Each entry removes exactly one guard and
 * must turn the named test red. Numbers are the design's test plan.
 *
 *   establishing a key for a URL
 *   - the endpoint comparison dropped (3)
 *   - `relayPinKey` compares by origin (1, 3)
 *   - a raw `@` accepted (1)
 *   - the metadata signature skipped (2)
 *   - the 64-hex check skipped (2, by reason)
 *   - the declaration's key equality, and its `relay_id` equality, skipped (2)
 *   - redirects followed on the metadata fetch, and on the declaration fetch (2)
 *   - the declaration requested after a failed metadata step (2, 10a by count)
 *   the readers
 *   - `resolveRelayKey` returns the legacy key (5, 7, and `delegate --sovereign`)
 *   - `index.ts` passes the legacy key (8)
 *   - `resolveRelayKey` returns the recorded entry on `conflict` (6d)
 *   - `resolveRelayKey` re-reads the file on a second call (6d, 6e)
 *   - `preflightGrant` reads for itself instead of the session's result (8; 6d)
 *   - the pre-flight passes with no relay named (11a)
 *   binding and the store
 *   - `bindRelayPin` writes when the legacy key differs (5, 6a, 10a)
 *   - `bindRelayPin` writes when the legacy key is absent (6a, 10a)
 *   - lazy binding's "a legacy key exists" precondition removed (6)
 *   - `addRelayPin` overwrites a different entry (6b, 10)
 *   - `addRelayPin` reports an equal entry as a conflict (6b, 11)
 *   - `addRelayPin` throws instead of returning `unavailable` (6b, 6c)
 *   - `register` runs a second full check (10a, by the metadata requested twice)
 *   - `register` skips the damaged-record exit (12)
 *   - a damaged file treated as empty (12); shape damage mapped to "upgrade" (12)
 *   not changed
 *   - `verify-release` reads the per-relay record (14)
 *   no relay key ⇒ nothing signed or broadcast (runtime)
 *   - the selector's no-key guard removed (the AI-loop and deterministic doors)
 *   - the pinned-hire no-key guard removed
 *   - the granted-spend no-key guard removed
 *
 * There is no tamper for "`addRelayPin`'s read is inside the lock": the lock
 * is synchronous, so no in-process test can land between a read and the lock.
 *
 *   node_modules/.bin/tsx scripts/tampers/cli-relay-pin-per-relay.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const RUNTIME = "@motebit/runtime";
const CLI = "motebit";

const PIN_SRC = "packages/runtime/src/relay-key-pin.ts";
const DELEGATION_SRC = "packages/runtime/src/relay-delegation.ts";
const RUNTIME_SRC = "packages/runtime/src/motebit-runtime.ts";
const PINS_SRC = "apps/cli/src/relay-pins.ts";
const INDEX_SRC = "apps/cli/src/index.ts";
const PREFLIGHT_SRC = "apps/cli/src/grant-preflight.ts";
const REGISTER_SRC = "apps/cli/src/subcommands/register.ts";
const VERIFY_RELEASE_SRC = "apps/cli/src/subcommands/verify-release.ts";

const T_RUNTIME_PIN = "src/__tests__/relay-pin-per-relay.test.ts";
const T_NO_KEY = "src/__tests__/no-relay-key-no-broadcast.test.ts";
const T_GRANTED = "src/__tests__/execute-granted-delegation.test.ts";
const T_PINS = "src/__tests__/relay-pins.test.ts";
const T_REGISTER = "src/__tests__/register-relay-pins.test.ts";
const T_DELEGATE = "src/__tests__/delegate-sovereign-relay-pins.test.ts";
const T_WIRING = "src/__tests__/relay-pins-wiring.test.ts";
const T_PREFLIGHT = "src/__tests__/grant-preflight.test.ts";
const T_VERIFY_RELEASE = "src/__tests__/verify-release-legacy-pin.test.ts";

// ── exact test names (describe path + title) ────────────────────────────────

const R1 = "relayPinKey (design test 1)";
const R2 = "verifyRelayMetadataForUrl (design test 2, the metadata reasons)";
const R3 =
  "a server holding only copies of relay A's documents (design test 3) B, on A's host under another path, serving A's metadata: endpoint_mismatch naming the URL A signed";

const NO_KEY = "no relay key: a priced cross-agent task signs and broadcasts nothing";

const C2 = "test 2 — the full check: the declaration reasons";
const C5 = "test 5 — a legacy-only install on a relay that does not prove the legacy key";
const C6A = "test 6a — bindRelayPin writes only a key this install already held";
const C6B = "test 6b — addRelayPin, the store: the only writer, and it never overwrites";
const C6D =
  "test 6d — lazy binding finds a different key recorded meanwhile (conflict) no key is used; the line names the file and the entry; the answer is remembered; the pre-flight fails naming the conflict";
const C12 = "test 12 — a damaged record is 'pins unknown', never empty";
const DAMAGED_TAIL =
  ": no key, reason damaged, no request, the remedy, bytes unchanged; the pre-flight fails with it";

const G10A = "test 10a — the existing step returns without comparing";

const WIRING = "test 8 — index.ts: one resolveRelayKey result for the session";

/** The fixed-seed test relay key (`helpers/signed-relay-metadata`): its metadata verifies. */
const TEST_RELAY_KEY = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";

function entry(
  name: string,
  pkg: string,
  test: string,
  red: string,
  ...edits: TamperEdit[]
): TamperEntry {
  return { name, edits, pkg, test, red };
}

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });

// ── the edits ────────────────────────────────────────────────────────────────

const DROP_ENDPOINT_COMPARISON = edit(
  PIN_SRC,
  '  if (signedPinKey !== pinKey) return { ok: false, reason: "endpoint_mismatch", signedPinKey };\n',
  "",
);
const COMPARE_BY_ORIGIN = edit(
  PIN_SRC,
  '  return parsed.href.replace(/\\/+$/, "");\n',
  "  return parsed.origin;\n",
);
const ACCEPT_AT = edit(
  PIN_SRC,
  "  if (/[\\\\?#@\\s\\u0000-\\u001f\\u007f]/.test(url)) return null;\n",
  "  if (/[\\\\?#\\s\\u0000-\\u001f\\u007f]/.test(url)) return null;\n",
);
const SKIP_METADATA_SIGNATURE = edit(
  PIN_SRC,
  '  if (!verified) return { ok: false, reason: "bad_signature" };\n',
  "",
);
const SKIP_HEX_CHECK = edit(
  PIN_SRC,
  '  if (!/^[0-9a-fA-F]{64}$/.test(doc.public_key)) return { ok: false, reason: "malformed_key" };\n',
  "",
);
const FOLLOW_METADATA_REDIRECT = edit(
  PIN_SRC,
  '        redirect: "manual",\n',
  '        redirect: "follow",\n',
);
const FOLLOW_DECLARATION_REDIRECT = edit(
  PINS_SRC,
  '        redirect: "manual",\n',
  '        redirect: "follow",\n',
);
const SKIP_DECLARATION_KEY = edit(
  PINS_SRC,
  "  if (declaration.relay_public_key.toLowerCase() !== metadata.publicKey) {\n",
  "  if (false as boolean) {\n",
);
const SKIP_DECLARATION_RELAY_ID = edit(
  PINS_SRC,
  "  if (declaration.relay_id !== metadata.relayId) {\n",
  "  if (false as boolean) {\n",
);
const DECLARATION_AFTER_FAILED_METADATA = edit(
  PINS_SRC,
  "  if (!metadata.ok) {\n",
  "  if (!metadata.ok) {\n" +
    "    await fetchImpl(`${relayPinKey(url) ?? url}${TRANSPARENCY_PATH}`).catch(() => undefined);\n",
);
const RETURN_LEGACY_KEY = edit(
  PINS_SRC,
  '    return { status: "no_key", relayUrl, reason: "legacy_mismatch" };\n',
  '    return { status: "key", relayUrl, key: readLegacyRelayKey() ?? "", origin: "recorded" };\n',
);
const INDEX_PASSES_LEGACY_KEY = edit(
  INDEX_SRC,
  '    relayPublicKey: sessionRelayKey.status === "key" ? sessionRelayKey.key : undefined,\n',
  "    relayPublicKey: fullConfig.relay_public_key,\n",
);
const RETURN_RECORDED_ON_CONFLICT = edit(
  PINS_SRC,
  '    return { status: "no_key", relayUrl, reason: "conflict", file, pinKey: bound.pinKey };\n',
  "    const recordedNow = readRelayPins(file);\n" +
    '    const recordedEntry = recordedNow.status === "ok" ? recordedNow.pins[bound.pinKey] : undefined;\n' +
    "    if (recordedEntry != null) {\n" +
    '      return { status: "key", relayUrl, key: recordedEntry.public_key, origin: "recorded" };\n' +
    "    }\n" +
    '    return { status: "no_key", relayUrl, reason: "conflict", file, pinKey: bound.pinKey };\n',
);
const REREAD_ON_SECOND_CALL = edit(PINS_SRC, "  if (remembered != null) return remembered;\n", "");
const INDEX_PREFLIGHT_OWN_RESOLVE = edit(
  INDEX_SRC,
  "        relayKey: sessionRelayKey,\n",
  '        relayKey: syncUrl != null ? await resolveRelayKey(syncUrl) : { status: "no_relay" },\n',
);
const PREFLIGHT_OWN_FILE_READ: TamperEdit[] = [
  edit(
    PREFLIGHT_SRC,
    'import { relayKeyRemedy, type SessionRelayKey } from "./relay-pins.js";\n',
    'import { readRelayPins, relayKeyRemedy, type SessionRelayKey } from "./relay-pins.js";\n',
  ),
  edit(
    PREFLIGHT_SRC,
    "  const relayKey = deps.relayKey;\n",
    "  const given = deps.relayKey;\n" +
      "  const onDisk = readRelayPins();\n" +
      "  const diskEntry =\n" +
      '    given.status === "no_key" && onDisk.status === "ok" ? Object.values(onDisk.pins)[0] : undefined;\n' +
      "  const relayKey: SessionRelayKey =\n" +
      '    given.status === "no_key" && diskEntry != null\n' +
      '      ? { status: "key", relayUrl: given.relayUrl, key: diskEntry.public_key, origin: "recorded" }\n' +
      "      : given;\n",
  ),
];
const PREFLIGHT_PASSES_NO_RELAY = edit(
  PREFLIGHT_SRC,
  '  } else if (relayKey.status === "no_relay") {\n    checks.push({\n      name: "relay-pin",\n      ok: false,\n',
  '  } else if (relayKey.status === "no_relay") {\n    checks.push({\n      name: "relay-pin",\n      ok: true,\n',
);
const BIND_WHEN_LEGACY_DIFFERS = edit(
  PINS_SRC,
  '  if (legacy == null || legacy !== check.publicKey) return { result: "legacy_mismatch" };\n',
  '  if (legacy == null) return { result: "legacy_mismatch" };\n',
);
const BIND_WHEN_LEGACY_ABSENT = edit(
  PINS_SRC,
  '  if (legacy == null || legacy !== check.publicKey) return { result: "legacy_mismatch" };\n',
  '  if (legacy != null && legacy !== check.publicKey) return { result: "legacy_mismatch" };\n',
);
const NO_LEGACY_PRECONDITION = edit(
  PINS_SRC,
  '  if (readLegacyRelayKey() == null) return { status: "no_key", relayUrl, reason: "not_pinned" };\n',
  "",
);
const STORE_OVERWRITES = edit(
  PINS_SRC,
  '        if (existing != null) return { result: "conflict" };\n',
  "",
);
const STORE_EQUAL_IS_CONFLICT = edit(
  PINS_SRC,
  "        if (existing != null && existing.public_key === entry.public_key) {\n" +
    '          return { result: "already_present" };\n' +
    "        }\n",
  "",
);
const STORE_THROWS = edit(
  PINS_SRC,
  '    return { result: "unavailable", cause: err instanceof Error ? err.message : String(err) };\n',
  "    throw err;\n",
);
const REGISTER_SECOND_FULL_CHECK = edit(
  REGISTER_SRC,
  "  const bound = await bindRelayPin(syncUrl, deps.relayKey);\n",
  "  await bindRelayPin(syncUrl, deps.relayKey);\n" +
    "  const bound = await bindRelayPin(syncUrl, deps.relayKey);\n",
);
const REGISTER_SKIPS_DAMAGED_EXIT = edit(
  REGISTER_SRC,
  '  if (pins.status === "damaged") {\n',
  '  if ((false as boolean) && pins.status === "damaged") {\n',
);
const DAMAGED_AS_EMPTY = edit(
  PINS_SRC,
  '    return damaged("it is not valid JSON");\n',
  '    return { status: "ok", pins: {} };\n',
);
const SHAPE_DAMAGE_AS_UPGRADE = edit(
  PINS_SRC,
  '    return damaged("its `pins` is not an object");\n',
  '    return { status: "damaged", damage: "newer_version", cause: "its `pins` is not an object" };\n',
);
const VERIFY_RELEASE_READS_PINS = edit(
  VERIFY_RELEASE_SRC,
  "  const pinned = fullConfig.relay_public_key;\n",
  '  const pinsRead = (await import("../relay-pins.js")).readRelayPins();\n' +
    "  const pinned =\n" +
    '    (pinsRead.status === "ok" ? Object.values(pinsRead.pins)[0]?.public_key : undefined) ??\n' +
    "    fullConfig.relay_public_key;\n",
);

// No relay key ⇒ nothing signed or broadcast. Removing a no-key guard needs a
// key to type-check; the fixed-seed test relay's key is the one whose signed
// metadata the tests' relay serves, so the path then really builds a payment.
const SELECTOR_NO_KEY_GUARD: TamperEdit[] = [
  edit(
    DELEGATION_SRC,
    "  if (params.buildP2pPayment != null && params.relayPublicKey != null && capability != null) {\n",
    "  if (params.buildP2pPayment != null && capability != null) {\n",
  ),
  edit(
    DELEGATION_SRC,
    "      relayPublicKeyHex: params.relayPublicKey,\n",
    `      relayPublicKeyHex: params.relayPublicKey ?? "${TEST_RELAY_KEY}",\n`,
  ),
];
const PINNED_HIRE_NO_KEY_GUARD = edit(
  DELEGATION_SRC,
  "    if (params.buildP2pPayment == null || params.relayPublicKey == null) {\n",
  "    if (params.buildP2pPayment == null) {\n",
);
const GRANTED_NO_KEY_GUARD: TamperEdit[] = [
  edit(RUNTIME_SRC, "    if (config.relayPublicKey != null) {\n", "    if (true as boolean) {\n"),
  edit(
    RUNTIME_SRC,
    "        relayPublicKeyHex: config.relayPublicKey,\n",
    `        relayPublicKeyHex: config.relayPublicKey ?? "${TEST_RELAY_KEY}",\n`,
  ),
];

const TAMPERS: TamperEntry[] = [
  // ── establishing a key for a URL (runtime) ──
  entry(
    "the endpoint comparison is dropped (3)",
    RUNTIME,
    T_RUNTIME_PIN,
    R3,
    DROP_ENDPOINT_COMPARISON,
  ),
  entry(
    "relayPinKey compares by origin (1: different paths)",
    RUNTIME,
    T_RUNTIME_PIN,
    `${R1} different paths on one host get different keys`,
    COMPARE_BY_ORIGIN,
  ),
  entry(
    "relayPinKey compares by origin (3: B under another path)",
    RUNTIME,
    T_RUNTIME_PIN,
    R3,
    COMPARE_BY_ORIGIN,
  ),
  entry(
    "a raw `@` is accepted (1)",
    RUNTIME,
    T_RUNTIME_PIN,
    `${R1} null for \`@\` anywhere: userinfo, empty userinfo, and in the path`,
    ACCEPT_AT,
  ),
  entry(
    "the metadata signature is skipped (2)",
    RUNTIME,
    T_RUNTIME_PIN,
    `${R2} bad_signature: the document does not verify under the key it names`,
    SKIP_METADATA_SIGNATURE,
  ),
  entry(
    "the 64-hex check is skipped (2, by reason)",
    RUNTIME,
    T_RUNTIME_PIN,
    `${R2} malformed_key: \`public_key\` is not 64 hex characters`,
    SKIP_HEX_CHECK,
  ),
  entry(
    "redirects are followed on the metadata fetch (2)",
    RUNTIME,
    T_RUNTIME_PIN,
    `${R2} redirect_refused: a redirect is not followed, even to a document that would pass`,
    FOLLOW_METADATA_REDIRECT,
  ),
  // ── the full check (CLI) ──
  entry(
    "the declaration's key equality is skipped (2)",
    CLI,
    T_PINS,
    `${C2} declaration_key_mismatch: a valid declaration that names a different key`,
    SKIP_DECLARATION_KEY,
  ),
  entry(
    "the declaration's relay_id equality is skipped (2)",
    CLI,
    T_PINS,
    `${C2} declaration_relay_id_mismatch: a valid declaration that names a different relay_id`,
    SKIP_DECLARATION_RELAY_ID,
  ),
  entry(
    "redirects are followed on the declaration fetch (2)",
    CLI,
    T_PINS,
    `${C2} redirect_refused: the declaration redirects, even to a declaration that would pass`,
    FOLLOW_DECLARATION_REDIRECT,
  ),
  entry(
    "the declaration is requested after a failed metadata step (2, by count)",
    CLI,
    T_PINS,
    `${C2} a failed metadata step does not request the declaration`,
    DECLARATION_AFTER_FAILED_METADATA,
  ),
  entry(
    "the declaration is requested after a failed metadata step (10a, by count)",
    CLI,
    T_REGISTER,
    `${G10A} an existing entry and no key established (endpoint_empty): the entry is untouched; the declaration is requested once`,
    DECLARATION_AFTER_FAILED_METADATA,
  ),
  // ── the readers ──
  entry(
    "resolveRelayKey returns the legacy key (5)",
    CLI,
    T_PINS,
    `${C5} a relay with a different key: no entry, no key passed, the reason's line`,
    RETURN_LEGACY_KEY,
  ),
  entry(
    "resolveRelayKey returns the legacy key (7)",
    CLI,
    T_REGISTER,
    "test 7 — register on A, then sessions naming B no key is passed for B named by --sync-url, by MOTEBIT_SYNC_URL, or by the saved sync_url",
    RETURN_LEGACY_KEY,
  ),
  entry(
    "resolveRelayKey returns the legacy key (delegate --sovereign, the defect)",
    CLI,
    T_DELEGATE,
    "delegate --sovereign and the per-relay key the defect: the install holds ANOTHER relay's key: exits 1, that key is never used here, nothing is broadcast",
    RETURN_LEGACY_KEY,
  ),
  entry(
    "index.ts passes the legacy key to the relay wiring (8)",
    CLI,
    T_WIRING,
    `${WIRING} hands that one result to the relay wiring`,
    INDEX_PASSES_LEGACY_KEY,
  ),
  entry(
    "resolveRelayKey returns the recorded entry on conflict (6d)",
    CLI,
    T_PINS,
    C6D,
    RETURN_RECORDED_ON_CONFLICT,
  ),
  entry(
    "resolveRelayKey re-reads the file on a second call (6d)",
    CLI,
    T_PINS,
    C6D,
    REREAD_ON_SECOND_CALL,
  ),
  entry(
    "resolveRelayKey re-reads the file on a second call (6e)",
    CLI,
    T_PINS,
    "test 6e — one answer per process after no_key, an entry added by another process is not picked up in this process; the pre-flight fails",
    REREAD_ON_SECOND_CALL,
  ),
  entry(
    "index.ts gives preflightGrant its own resolution instead of the session's result (8)",
    CLI,
    T_WIRING,
    `${WIRING} hands that same result to preflightGrant`,
    INDEX_PREFLIGHT_OWN_RESOLVE,
  ),
  entry(
    "preflightGrant reads the record itself instead of the session's result (6d)",
    CLI,
    T_PINS,
    C6D,
    ...PREFLIGHT_OWN_FILE_READ,
  ),
  entry(
    "the pre-flight passes with no relay named (11a)",
    CLI,
    T_PREFLIGHT,
    "preflightGrant — the relay-pin check is the session's one answer test 11a: with no relay named, the check fails and says relay sync is off",
    PREFLIGHT_PASSES_NO_RELAY,
  ),
  // ── binding and the store ──
  entry(
    "bindRelayPin writes when the legacy key differs (5)",
    CLI,
    T_PINS,
    `${C5} a relay with a different key: no entry, no key passed, the reason's line`,
    BIND_WHEN_LEGACY_DIFFERS,
  ),
  entry(
    "bindRelayPin writes when the legacy key differs (6a: an equal entry on disk)",
    CLI,
    T_PINS,
    `${C6A} an entry on disk equal to the proved key, and a differing legacy key: legacy_mismatch, file byte-identical`,
    BIND_WHEN_LEGACY_DIFFERS,
  ),
  entry(
    "bindRelayPin writes when the legacy key differs (10a)",
    CLI,
    T_REGISTER,
    `${G10A} a differing legacy key, the full check then succeeds: no entry, the legacy_mismatch warning, exit code as today`,
    BIND_WHEN_LEGACY_DIFFERS,
  ),
  entry(
    "bindRelayPin writes when the legacy key is absent (6a)",
    CLI,
    T_PINS,
    `${C6A} no legacy key: legacy_mismatch, no file written`,
    BIND_WHEN_LEGACY_ABSENT,
  ),
  entry(
    "bindRelayPin writes when the legacy key is absent (6a: removed mid-check)",
    CLI,
    T_PINS,
    `${C6A} the legacy key is removed from config.json while the full check is in flight: legacy_mismatch, no file written`,
    BIND_WHEN_LEGACY_ABSENT,
  ),
  entry(
    "bindRelayPin writes when the legacy key is absent (10a)",
    CLI,
    T_REGISTER,
    `${G10A} no legacy key, the full check then succeeds: no entry, the legacy_mismatch warning, exit code as today`,
    BIND_WHEN_LEGACY_ABSENT,
  ),
  entry(
    "lazy binding's 'a legacy key exists' precondition is removed (6, by the relay receiving a request)",
    CLI,
    T_PINS,
    "test 6 — no legacy key and no record the relay receives no request, no key is passed, no file is created, and the REPL prints no line",
    NO_LEGACY_PRECONDITION,
  ),
  entry(
    "addRelayPin overwrites a different entry (6b)",
    CLI,
    T_PINS,
    `${C6B} an entry for the same pin key under a DIFFERENT key: conflict, file byte-identical`,
    STORE_OVERWRITES,
  ),
  entry(
    "addRelayPin overwrites a different entry (10)",
    CLI,
    T_REGISTER,
    "test 10 — register and a key that disagrees the legacy key equals the relay's key but this relay's entry holds a different key: exit 1, per-relay PIN MISMATCH naming the file and the entry; file byte-identical",
    STORE_OVERWRITES,
  ),
  entry(
    "addRelayPin reports an equal entry as a conflict (6b)",
    CLI,
    T_PINS,
    `${C6B} an entry for the same pin key under the SAME key: already_present, file byte-identical`,
    STORE_EQUAL_IS_CONFLICT,
  ),
  entry(
    "addRelayPin reports an equal entry as a conflict (11)",
    CLI,
    T_PINS,
    "test 11 — two bindings of the same key for one relay, interleaved both succeed and the file holds the one entry",
    STORE_EQUAL_IS_CONFLICT,
  ),
  entry(
    "addRelayPin throws instead of returning unavailable (6b)",
    CLI,
    T_PINS,
    `${C6B} the lock is held by another live process: unavailable, does not throw, writes nothing`,
    STORE_THROWS,
  ),
  entry(
    "addRelayPin throws instead of returning unavailable (6c, register)",
    CLI,
    T_REGISTER,
    "test 6c — register while another live process holds the record's lock the warning names the file and the cause; exit code as today; nothing written",
    STORE_THROWS,
  ),
  entry(
    "register runs a second full check (10a, by the metadata being requested twice)",
    CLI,
    T_REGISTER,
    `${G10A} request counts on the ordinary path: the metadata exactly once, the declaration twice`,
    REGISTER_SECOND_FULL_CHECK,
  ),
  entry(
    "register skips the damaged-record exit (12)",
    CLI,
    T_REGISTER,
    "test 12 — register with a damaged record exits 1 naming the file, before the passphrase prompt and any request; bytes unchanged",
    REGISTER_SKIPS_DAMAGED_EXIT,
  ),
  entry(
    "a damaged file is treated as empty (12)",
    CLI,
    T_PINS,
    `${C12} invalid JSON${DAMAGED_TAIL}`,
    DAMAGED_AS_EMPTY,
  ),
  entry(
    "shape damage is mapped to 'upgrade' (12)",
    CLI,
    T_PINS,
    `${C12} wrong shape (pins is not an object)${DAMAGED_TAIL}`,
    SHAPE_DAMAGE_AS_UPGRADE,
  ),
  // ── not changed ──
  entry(
    "verify-release reads the per-relay record (14)",
    CLI,
    T_VERIFY_RELEASE,
    "test 14 — verify-release compares against the legacy key, as before …and still fails when the per-relay record's entry for that relay is the witness's own key",
    VERIFY_RELEASE_READS_PINS,
  ),
  // ── no relay key ⇒ nothing signed or broadcast (runtime) ──
  entry(
    "the selector's no-key guard is removed (delegate_to_agent)",
    RUNTIME,
    T_NO_KEY,
    `${NO_KEY} delegate_to_agent (the AI-loop door): relay-mode, zero wallet calls, no P2P read, no payment proof`,
    ...SELECTOR_NO_KEY_GUARD,
  ),
  entry(
    "the selector's no-key guard is removed (invokeCapability)",
    RUNTIME,
    T_NO_KEY,
    `${NO_KEY} invokeCapability (the deterministic door): relay-mode, zero wallet calls, no payment proof`,
    ...SELECTOR_NO_KEY_GUARD,
  ),
  entry(
    "the pinned-hire no-key guard is removed",
    RUNTIME,
    T_NO_KEY,
    `${NO_KEY} a pinned hire (a named worker) with no relay key fails closed: nothing submitted, nothing built`,
    PINNED_HIRE_NO_KEY_GUARD,
  ),
  entry(
    "the granted-spend no-key guard is removed",
    RUNTIME,
    T_GRANTED,
    "executeGrantedDelegation — deterministic granted spend, fail-closed relay wired WITHOUT a relay key (wallet present, valid grant) ⇒ sync_not_enabled: nothing built, live or dry",
    ...GRANTED_NO_KEY_GUARD,
  ),
];

void runTampers(TAMPERS, { root: ROOT });
