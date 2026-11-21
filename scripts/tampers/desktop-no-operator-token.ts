/**
 * Tamper checks for "the desktop app holds no relay operator token" (design
 * 2026-11-20: the `sync_master_token` key-store slot is never read, and no
 * desktop request carries the token). Each entry re-opens one door and must
 * turn its test red.
 *
 * After the removal no test can hand a token in through a parameter or the
 * config (neither exists), so every per-site entry restores a READ of the
 * slot together with the SEND it fed. An entry that restored only a send line
 * would read nothing and prove nothing. In every test the slot holds a token
 * (apps/desktop/src/__tests__/operator-slot-guard.ts), so a restored read is
 * caught twice: by the stand-in (the slot was read) and on the wire (the
 * token was sent).
 *
 *   - each removed read or send site outside main.ts, restored, caught by a
 *     behavioural test: the config loader, the startup socket bearer (in the
 *     real-relay #962 matrix), the controller's socket bearer, its serving
 *     token (registration + task results), the `/sync` door at the controller
 *     and at the chat command, `relayBearer`, and the Sovereign panel's
 *     verified goals fetch;
 *   - one entry reading the slot by a key built AT RUN TIME at a serving site:
 *     the gate's stated blind spot, caught by the shared key-store stand-in;
 *   - each of main.ts's three sites (startup, the early registration,
 *     Connect), caught by the GATE, not by a test: main.ts cannot be imported
 *     by a test (vitest.config.ts excludes it), so these entries run the gate
 *     as a command;
 *   - the gate's rule, weakened twice (case-sensitive, Rust unscanned), caught
 *     by the gate's own test.
 *
 * Sites that only declared a type or an ignored parameter (the config field,
 * `registerWithRelay`'s ignored token, the interface in sync-startup.ts) have
 * no behaviour to catch and get no entry; they are held by typecheck and the
 * gate.
 *
 *   node_modules/.bin/tsx scripts/tampers/desktop-no-operator-token.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = "@motebit/desktop";

const CONFIG = "apps/desktop/src/ui/config.ts";
const STARTUP = "apps/desktop/src/sync-startup.ts";
const CONTROLLER = "apps/desktop/src/sync-controller.ts";
const INDEX = "apps/desktop/src/index.ts";
const CHAT = "apps/desktop/src/ui/chat.ts";
const BEARER = "apps/desktop/src/ui/relay-bearer.ts";
const SOVEREIGN = "apps/desktop/src/ui/sovereign.ts";
const MAIN = "apps/desktop/src/main.ts";
const GATE = "scripts/check-desktop-no-operator-token.ts";

const PANELS_TEST = "src/__tests__/operator-token-panels.test.ts";
const CONTROLLER_TEST = "src/__tests__/sync-controller.test.ts";
const MATRIX_TEST = "src/__tests__/every-configured-surface-pushes-962.test.ts";
const GATE_TEST = "scripts/__tests__/check-desktop-no-operator-token.test.ts";

const PANELS = "desktop panels — the operator token is never sent (design 2026-11-20)";
const SC = "SyncController — the operator token is never sent (design 2026-11-20)";
const RELAY_SWITCH = `${SC} start on relay A, stopSync, start on relay B: B receives no operator token`;
const MATRIX_CELL =
  "#962 — every configured desktop pushes (real DesktopApp, real relay) desktop | bootstrapped | down→up | token";
const GATE_NAME = "check-desktop-no-operator-token";

/** The read every per-site entry restores, spelled as main's tree spelled the slot. */
const READ = (invoke: string): string =>
  `await ${invoke}<string | null>("keyring_get", { key: "sync_master_token" })`;

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });

const desktop = (name: string, test: string, red: string, edits: TamperEdit[]): TamperEntry => ({
  name,
  edits,
  pkg: PKG,
  test,
  red,
});

/** A main.ts site: held by the gate alone, so the gate runs as the test. */
const byGate = (name: string, edits: TamperEdit[]): TamperEntry => ({
  name: `${name} (caught by the gate, not by a test: main.ts cannot be imported)`,
  edits,
  command: ["node_modules/.bin/tsx", GATE],
  redMarker: "the desktop app holds no relay operator token",
});

const TAMPERS: TamperEntry[] = [
  // ── per-site: a read of the slot restored together with its send ──
  desktop(
    "the config loader reads the slot into the config again",
    PANELS_TEST,
    `${PANELS} loadDesktopConfig never reads the operator slot and returns no token`,
    [
      edit(
        CONFIG,
        "    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;\n",
        `    const syncUrl = (parsed.sync_url as string | undefined) ?? undefined;\n    const operatorToken = ${READ("invoke")};\n`,
      ),
      edit(
        CONFIG,
        "      syncUrl,\n      governance,\n",
        "      syncUrl,\n      ...({ syncMasterToken: operatorToken ?? undefined } as object),\n      governance,\n",
      ),
    ],
  ),
  {
    ...desktop(
      "startup: a failed registration starts the socket with the slot's token",
      MATRIX_TEST,
      MATRIX_CELL,
      [
        edit(
          STARTUP,
          "    await app.startSync(invoke, syncUrl, token ?? undefined);\n",
          `    const operatorToken = (${READ("invoke")}) ?? undefined;\n    await app.startSync(invoke, syncUrl, token ?? operatorToken);\n`,
        ),
      ],
    ),
    only: true,
  },
  desktop(
    "the controller's socket bearer is the slot's token when none is passed",
    CONTROLLER_TEST,
    RELAY_SWITCH,
    [
      edit(
        CONTROLLER,
        "    let token = authToken;\n",
        `    let token = authToken ?? ((${READ("invoke")}) ?? undefined);\n`,
      ),
    ],
  ),
  desktop(
    "serving (registration + task results) sends the slot's token first",
    CONTROLLER_TEST,
    RELAY_SWITCH,
    [
      edit(
        CONTROLLER,
        "    this._servingToken = async (audience) => this.deps.createSyncToken(privKeyHex, audience);\n",
        `    const operatorToken = ${READ("invoke")};\n    this._servingToken = async (audience) =>\n      operatorToken ?? this.deps.createSyncToken(privKeyHex, audience);\n`,
      ),
    ],
  ),
  desktop(
    "the /sync door at the controller sends the slot's token",
    CONTROLLER_TEST,
    `${SC} /sync's door (syncConversations) mints its own sync token and never reads the slot`,
    [
      edit(
        CONTROLLER,
        "    const token = await this.deps.createSyncToken(keypair.privateKey);\n",
        `    const token =\n      (${READ("invoke")}) ?? (await this.deps.createSyncToken(keypair.privateKey));\n`,
      ),
    ],
  ),
  desktop(
    "the /sync command hands the slot's token to the app again",
    PANELS_TEST,
    `${PANELS} /sync passes no token: the app mints its own sync token`,
    [
      edit(
        CHAT,
        "          void ctx.app\n            .syncConversations(config.invoke, config.syncUrl)\n",
        '          void config\n            .invoke<string | null>("keyring_get", { key: "sync_master_token" })\n            .then((t) => ctx.app.syncConversations(config.invoke!, config.syncUrl!, t ?? undefined))\n',
      ),
      edit(
        INDEX,
        "  syncConversations(\n    invoke: InvokeFn,\n    syncUrl: string,\n  ): Promise<{",
        "  syncConversations(\n    invoke: InvokeFn,\n    syncUrl: string,\n    _operatorToken?: string,\n  ): Promise<{",
      ),
    ],
  ),
  desktop(
    "relayBearer returns the slot's token before minting",
    PANELS_TEST,
    `${PANELS} relayBearer mints for the route's audience and never returns the token`,
    [
      edit(
        BEARER,
        "  const config = ctx.getConfig();\n  if (audience == null",
        `  const config = ctx.getConfig();\n  const operatorToken = config?.invoke ? ${READ("config.invoke")} : null;\n  if (operatorToken) return operatorToken;\n  if (audience == null`,
      ),
    ],
  ),
  desktop(
    "the Sovereign panel's verified goals fetch sends the slot's token",
    PANELS_TEST,
    `${PANELS} the Sovereign panel's verified goals fetch carries no Authorization, and no panel request carries the token`,
    [
      edit(
        SOVEREIGN,
        "      const anchor = await bootstrapAnchor(syncUrl);\n",
        `      const operatorToken = config.invoke ? ${READ("config.invoke")} : null;\n      if (operatorToken) headers["Authorization"] = \`Bearer \${operatorToken}\`;\n      const anchor = await bootstrapAnchor(syncUrl);\n`,
      ),
    ],
  ),

  // ── the gate's stated blind spot: a key built at run time ──
  desktop(
    "serving reads the slot by a key built at run time (gate blind spot; caught by the key-store stand-in)",
    CONTROLLER_TEST,
    RELAY_SWITCH,
    [
      edit(
        CONTROLLER,
        "    this._servingToken = async (audience) => this.deps.createSyncToken(privKeyHex, audience);\n",
        '    const slot = ["sync", "mas" + "ter", "token"].join("_");\n    const held = await invoke<string | null>("keyring_get", { key: slot });\n    this._servingToken = async (audience) => held ?? this.deps.createSyncToken(privKeyHex, audience);\n',
      ),
    ],
  ),

  // ── main.ts: held by the gate ──
  byGate("main.ts startup sync is handed the slot's token", [
    edit(
      MAIN,
      "    void trySyncRegistration(config.invoke, config.syncUrl);\n",
      '    void trySyncRegistration(config.invoke, config.syncUrl);\n    const inv = config.invoke;\n    const url = config.syncUrl;\n    void inv<string | null>("keyring_get", { key: "sync_master_token" }).then((t) =>\n      app.startSync(inv, url, t ?? undefined),\n    );\n',
    ),
  ]),
  byGate("main.ts early registration with the slot's token comes back", [
    edit(
      MAIN,
      "    await tryBootstrapIdentity(invoke);\n",
      `    await tryBootstrapIdentity(invoke);\n    const operatorToken = ${READ("invoke")};\n    if (config.syncUrl && operatorToken) void app.startSync(invoke, config.syncUrl, operatorToken);\n`,
    ),
  ]),
  byGate("main.ts Connect sends the slot's token to the URL just typed", [
    edit(
      MAIN,
      "        await ctx.app.startSync(invokeFn, url);\n",
      `        const operatorToken = (${READ("invokeFn")}) ?? undefined;\n        await ctx.app.startSync(invokeFn, url, operatorToken);\n`,
    ),
  ]),

  // ── the gate's rule, weakened ──
  {
    name: "the gate matches the word case-sensitively",
    edits: [edit(GATE, "const WORD = /master/i;\n", "const WORD = /master/;\n")],
    test: GATE_TEST,
    red: `${GATE_NAME} the operator token named again the word in any case, in an identifier`,
  },
  {
    name: "the gate stops scanning Rust",
    edits: [
      edit(
        GATE,
        '      scanLines(file, stripRustComments(source), "outside a comment", violations);\n',
        "      void stripRustComments;\n",
      ),
    ],
    test: GATE_TEST,
    red: `${GATE_NAME} Rust a string naming the slot fails`,
  },
];

void runTampers(TAMPERS, { root: ROOT });
