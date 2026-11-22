/**
 * Tamper checks for "the runtime holds ONE delegation relay binding, read
 * once per call" (design runtime-relay-binding-design-2026-11-22 rev 6, part
 * 4a; gate check-runtime-single-relay-binding, invariant #183). Each entry
 * removes one piece of the fix and must turn a BEHAVIOUR test red — never
 * the gate's own test:
 *
 *   - each of the five holders restored to an enable-time capture (the tools'
 *     closures, the credential submitter, task-query retrieval, granted spend,
 *     the tap manager) plus the capabilities fetcher's relay;
 *   - a call's snapshot read moved per request (the delegation tool's and the
 *     tap's token source read live, so a call in flight across a rebind mints
 *     the new relay's token);
 *   - the generation kept on a relay change; the streaming check removed,
 *     moved before the resume's await, and the handler check removed (each
 *     caught by a different test: a non-delegation tool has only the
 *     streaming check, the direct handler test only the handler check);
 *   - `relay_url` not written; the `bound_elsewhere` check removed; the
 *     SQLite store dropping the column value;
 *   - the surfaces: web/desktop's session-number guard and Disconnect unbind,
 *     web's unbind at a Connect to another relay, mobile's bind-once and its
 *     unbind on attempt disposal.
 *
 *   node scripts/tampers/runtime-single-relay-binding.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const RT = "@motebit/runtime";
const RUNTIME = "packages/runtime/src/motebit-runtime.ts";
const ID = "packages/runtime/src/interactive-delegation.ts";
const IC = "packages/runtime/src/invoke-capability.ts";
const STREAMING = "packages/runtime/src/streaming.ts";
const BINDING = "packages/runtime/src/relay-binding.ts";
const LEDGER = "packages/runtime/src/paid-intent-ledger.ts";
const T_SINGLE = "src/__tests__/relay-single-binding.test.ts";
const T_APPROVAL = "src/__tests__/relay-binding-approval.test.ts";

const RED_T1 = "bind A then bind B every path sends every tokened request to B and nothing to A";
const RED_T2 =
  "bind A with a key, then bind B without granted spend returns sync_not_enabled and never uses A";
const RED_T4 =
  "a rebind while calls are in flight running calls finish on A with A's tokens; a later credential and call go to B";
const RED_T5F =
  "the capabilities fetch after a rebind it goes to the new relay; unbound, a receipt outside a call fetches nothing";
const RED_T6 =
  "a paid-result record names the relay it is owed from; retrieval elsewhere sends nothing";
const RED_T7 = "an in-flight paid hire across a rebind keeps polling A, and its record says A";
const RED_HELD_GRANTED =
  "a token mint held across a rebind granted spend: every request goes to A with a token A's source minted";
const RED_HELD_RETRIEVAL =
  "a token mint held across a rebind result retrieval: the read goes to A with A's token";
const RED_HELD_CREDENTIAL =
  "a token mint held across a rebind credential submission: the credential goes to A with A's token";
const RED_5A_DELEGATE =
  "approved delegate_to_agent across a rebind (a) rebind to B, then approve: relay_changed, nothing sent, handler not invoked";
const RED_5A_NOTE =
  "approved write_note across a rebind (a) rebind to B, then approve: relay_changed, nothing sent, handler not invoked";
const RED_5E_NOTE =
  "approved write_note across a rebind (e) approve, hold the yielded `calling` chunk, rebind to B, continue: relay_changed";
const RED_DIRECT =
  "each delegation handler checks the approved generation itself delegate_to_agent called with a stale approved generation: relay_changed, nothing sent";

function rt(name: string, edits: TamperEdit[], test: string, red: string): TamperEntry {
  return { name, edits, pkg: RT, test, red };
}

/** A runtime-file field a mutation adds, spelled through a cast so it compiles. */
const SLOT = (slot: string): string =>
  `(this as unknown as { ${slot}?: RelayBindingSnapshot | null }).${slot}`;

const WEB = "apps/web/src/web-app.ts";
const T_WEB = "src/__tests__/relay-binding-switch.test.ts";
const WEB_RED_DISCONNECT =
  "web relay switch (Connect A, Disconnect, Connect B) after Disconnect nothing new reaches A; after Connect B chat delegation and taps reach B only";
const WEB_RED_HELD_DISCONNECT =
  "web relay switch (Connect A, Disconnect, Connect B) Disconnect while Connect A is still fetching A's key: nothing binds to A";
const WEB_RED_HELD_CONNECT =
  "web relay switch (Connect A, Disconnect, Connect B) Connect B while Connect A is still fetching A's key: everything stays on B";
const WEB_RED_PAIRING =
  "web relay switch (Connect A, Disconnect, Connect B) Connect B without Disconnect (pairing) that fails before binding: nothing stays bound to A";

const DESKTOP = "apps/desktop/src/sync-controller.ts";
const T_DESKTOP = "src/__tests__/relay-binding-switch.test.ts";
const DESK_RED_DISCONNECT =
  "desktop relay switch through SyncController after Disconnect nothing new reaches A; after Connect B chat delegation reaches B only";
const DESK_RED_HELD =
  "desktop relay switch through SyncController Disconnect while Connect A is still fetching A's key: nothing binds to A";

const MOBILE = "apps/mobile/src/sync-controller.ts";
const T_MOBILE = "src/__tests__/relay-binding-attempt.test.ts";
const MOB_RED_PIN =
  "mobile: one delegation relay binding per attempt the second cycle's pin resolves to a key the first did not: still runs, generation unchanged";
const MOB_RED_DISPOSE =
  "mobile: one delegation relay binding per attempt attempt A disposed with a paid hire in flight: the record names A; on attempt B retrieval is bound_elsewhere";

const TAMPERS: TamperEntry[] = [
  // ── the five holders, and the fetcher, restored to an enable-time capture ──
  rt(
    "holder 1: the relay tools read the binding captured when they were registered",
    [
      {
        file: ID,
        from: "    const bumpTrust = (receipt: ExecutionReceipt, relayUrl: string) =>\n",
        to:
          "    const registeredBinding = this.deps.getBinding();\n" +
          "    const bumpTrust = (receipt: ExecutionReceipt, relayUrl: string) =>\n",
      },
      {
        file: ID,
        from:
          "      const binding = this.deps.getBinding();\n" +
          "      if (approvalOutlivedBinding(call?.approvedRelayGeneration, binding)) {\n",
        to:
          "      const binding = registeredBinding;\n" +
          "      if (approvalOutlivedBinding(call?.approvedRelayGeneration, binding)) {\n",
      },
    ],
    T_SINGLE,
    RED_T1,
  ),
  rt(
    "holder 2: the credential submitter keeps the binding of its first credential",
    [
      {
        file: ID,
        from:
          "    this.deps.setCredentialSubmitter(async (vc, targetMotebitId) => {\n" +
          "      const binding = this.deps.getBinding();\n",
        to:
          "    let firstBinding: RelayBindingSnapshot | null = null;\n" +
          "    this.deps.setCredentialSubmitter(async (vc, targetMotebitId) => {\n" +
          "      const binding = (firstBinding ??= this.deps.getBinding());\n",
      },
    ],
    T_SINGLE,
    RED_T5F,
  ),
  rt(
    "holder 3: task-query retrieval keeps the first binding it read",
    [
      {
        file: RUNTIME,
        from:
          "    // The retrieval's ONE snapshot of the binding.\n" +
          "    const binding = this._relayBinding;\n",
        to:
          "    // The retrieval's ONE snapshot of the binding.\n" +
          `    const binding = (${SLOT("__taskQuery")} ??= this._relayBinding);\n`,
      },
    ],
    T_SINGLE,
    RED_T6,
  ),
  rt(
    "holder 4: granted spend keeps the last binding that had a key (main's _grantedSpendCoords)",
    [
      {
        file: RUNTIME,
        from: "    if (startsNewGeneration(this._relayBinding, binding)) this._relayGeneration++;\n",
        to:
          "    if (startsNewGeneration(this._relayBinding, binding)) this._relayGeneration++;\n" +
          `    if (binding.relayPublicKey != null) ${SLOT("__granted")} = { ...binding, generation: this._relayGeneration };\n`,
      },
      {
        file: RUNTIME,
        from:
          "    // no binding) fails closed, and never falls back to an earlier relay's.\n" +
          "    const binding = this._relayBinding;\n",
        to:
          "    // no binding) fails closed, and never falls back to an earlier relay's.\n" +
          `    const binding = ${SLOT("__granted")} ?? null;\n`,
      },
    ],
    T_SINGLE,
    RED_T2,
  ),
  rt(
    "holder 5: the tap manager keeps the first binding that bound taps",
    [
      {
        file: RUNTIME,
        from: "    this._relayBinding = Object.freeze({ ...binding, generation: this._relayGeneration });\n",
        to:
          "    this._relayBinding = Object.freeze({ ...binding, generation: this._relayGeneration });\n" +
          `    if (binding.invokeCapability) ${SLOT("__tap")} ??= this._relayBinding;\n`,
      },
      {
        file: RUNTIME,
        from: "      () => this._relayBinding,\n    );\n",
        to: `      () => ${SLOT("__tap")} ?? null,\n    );\n`,
      },
    ],
    T_SINGLE,
    RED_T1,
  ),
  rt(
    "holder 6: the capabilities fetch keeps the relay it first fetched from (a cached bootstrap URL)",
    [
      {
        file: RUNTIME,
        from: "    return _bumpTrustFromReceipt(\n      this.trustDepsOn(relayUrl),\n",
        to:
          "    return _bumpTrustFromReceipt(\n" +
          "      this.trustDepsOn(\n" +
          "        ((this as unknown as { __capUrl?: string }).__capUrl ??= relayUrl),\n" +
          "      ),\n",
      },
    ],
    T_SINGLE,
    RED_T5F,
  ),

  // ── a call's snapshot read per request ──
  rt(
    "snapshot: delegate_to_agent mints each request's token from the LIVE binding",
    [
      {
        file: ID,
        from:
          "          syncUrl: binding.syncUrl,\n" +
          "          authToken: binding.authToken,\n" +
          "          prompt,\n",
        to:
          "          syncUrl: binding.syncUrl,\n" +
          "          authToken: (aud) => (this.deps.getBinding() ?? binding).authToken(aud),\n" +
          "          prompt,\n",
      },
    ],
    T_SINGLE,
    RED_T4,
  ),
  rt(
    "snapshot: a tap mints each request's token from the LIVE binding",
    [
      {
        file: IC,
        from: "    const result = await resolveDelegation(this.deps, binding, {\n",
        to:
          '    const live = (aud?: import("@motebit/protocol").TokenAudience) =>\n' +
          "      (this.getBinding() ?? binding).authToken(aud);\n" +
          "    const result = await resolveDelegation(this.deps, { ...binding, authToken: live }, {\n",
      },
    ],
    T_SINGLE,
    RED_T4,
  ),

  // ── a mint held across a rebind (granted spend, retrieval, credentials) ──
  // Granted spend mints several tokens in one call: a token read per request
  // mints the later ones from the new binding. Retrieval and credential
  // submission mint ONE token, first thing, so reading that token per request
  // is the same as reading it from the snapshot (an equivalent mutant); what
  // can move is the request TARGET, read after the mint's await.
  rt(
    "snapshot: granted spend mints each request's token from the LIVE binding",
    [
      {
        file: RUNTIME,
        from:
          "      authToken: binding.authToken,\n" +
          "      relayPublicKeyHex: binding.relayPublicKey,\n",
        to:
          '      authToken: (aud?: import("@motebit/protocol").TokenAudience) =>\n' +
          "        (this._relayBinding ?? binding).authToken(aud),\n" +
          "      relayPublicKeyHex: binding.relayPublicKey,\n",
      },
    ],
    T_SINGLE,
    RED_HELD_GRANTED,
  ),
  rt(
    "snapshot: result retrieval reads its relay URL at request time, after the mint",
    [
      {
        file: RUNTIME,
        from:
          "    const result = await retrieveDelegationResult({\n" +
          "      motebitId: this.motebitId,\n" +
          "      syncUrl: binding.syncUrl,\n",
        to:
          "    const live = (): RelayBindingSnapshot => this._relayBinding ?? binding;\n" +
          "    const result = await retrieveDelegationResult({\n" +
          "      motebitId: this.motebitId,\n" +
          "      get syncUrl(): string {\n" +
          "        return live().syncUrl;\n" +
          "      },\n",
      },
    ],
    T_SINGLE,
    RED_HELD_RETRIEVAL,
  ),
  rt(
    "snapshot: credential submission reads its relay URL at request time, after the mint",
    [
      {
        file: ID,
        from: "          `${binding.syncUrl}/api/v1/agents/${encodeURIComponent(targetMotebitId)}/credentials/submit`,\n",
        to: "          `${(this.deps.getBinding() ?? binding).syncUrl}/api/v1/agents/${encodeURIComponent(targetMotebitId)}/credentials/submit`,\n",
      },
    ],
    T_SINGLE,
    RED_HELD_CREDENTIAL,
  ),

  // ── the generation and the two approval checks ──
  rt(
    "generation kept on a relay change",
    [{ file: BINDING, from: "    !sameRelay(prev.syncUrl, next.syncUrl) ||\n", to: "" }],
    T_APPROVAL,
    RED_5A_DELEGATE,
  ),
  rt(
    "the streaming-step check removed (a non-delegation tool has no other)",
    [
      {
        file: STREAMING,
        from: "            relayGeneration !== this.deps.getRelayGeneration()\n",
        to: "            (relayGeneration as number) !== (relayGeneration as number)\n",
      },
    ],
    T_APPROVAL,
    RED_5A_NOTE,
  ),
  rt(
    "the streaming-step check reads the generation BEFORE the resume's await and yield",
    [
      {
        file: STREAMING,
        from: "      await this.signAndEmitApprovalDecision(pending, approved);\n",
        to:
          "      const generationAtResume = this.deps.getRelayGeneration?.();\n" +
          "      await this.signAndEmitApprovalDecision(pending, approved);\n",
      },
      {
        file: STREAMING,
        from: "            relayGeneration !== this.deps.getRelayGeneration()\n",
        to: "            relayGeneration !== generationAtResume\n",
      },
    ],
    T_APPROVAL,
    RED_5E_NOTE,
  ),
  rt(
    "the delegation handlers' own generation check removed",
    [
      {
        file: ID,
        from: "      if (approvalOutlivedBinding(call?.approvedRelayGeneration, binding)) {\n",
        to: "      if (approvalOutlivedBinding(undefined, binding)) {\n",
      },
    ],
    T_APPROVAL,
    RED_DIRECT,
  ),

  // ── paid-result records name their relay ──
  rt(
    "relay_url not written by the ledger",
    [{ file: LEDGER, from: "      relay_url: relayUrl,\n", to: "" }],
    T_SINGLE,
    RED_T7,
  ),
  rt(
    "the bound_elsewhere check removed (a record owed by another relay is read from the bound one)",
    [
      {
        file: RUNTIME,
        from: "    if (owedBy != null && !sameRelay(owedBy, binding.syncUrl)) {\n",
        to: "    if (owedBy != null && (false as boolean)) {\n",
      },
    ],
    T_SINGLE,
    RED_T6,
  ),
  {
    name: "the SQLite paid-intent store drops relay_url",
    edits: [
      {
        file: "packages/persistence/src/index.ts",
        from: "      entry.relay_url ?? null,\n",
        to: "      null,\n",
      },
    ],
    pkg: "@motebit/persistence",
    test: "src/__tests__/paid-intent-store.test.ts",
    red: "paid_intent_ledger.relay_url (migration #53) records and reads the relay a paid result is owed from",
  },

  // ── surfaces ──
  {
    name: "web: Disconnect no longer unbinds",
    edits: [
      {
        file: WEB,
        from: "    this.runtime?.unbindRelay();\n    this._taskClaims.dispose();\n",
        to: "    this._taskClaims.dispose();\n",
      },
    ],
    pkg: "@motebit/web",
    test: T_WEB,
    red: WEB_RED_DISCONNECT,
  },
  {
    name: "web: the session-number guard removed (a Disconnect during the key fetch)",
    edits: [
      {
        file: WEB,
        from: "    if (session === this._syncSession) {\n      this.runtime.bindRelay({\n",
        to: "    if ((true as boolean) || session === this._syncSession) {\n      this.runtime.bindRelay({\n",
      },
    ],
    pkg: "@motebit/web",
    test: T_WEB,
    red: WEB_RED_HELD_DISCONNECT,
  },
  {
    name: "web: the session-number guard removed (another Connect during the key fetch)",
    edits: [
      {
        file: WEB,
        from: "    if (session === this._syncSession) {\n      this.runtime.bindRelay({\n",
        to: "    if ((true as boolean) || session === this._syncSession) {\n      this.runtime.bindRelay({\n",
      },
    ],
    pkg: "@motebit/web",
    test: T_WEB,
    red: WEB_RED_HELD_CONNECT,
  },
  {
    name: "web: a Connect to another relay no longer unbinds at entry (pairing without Disconnect)",
    edits: [
      {
        file: WEB,
        from: "    if (bound != null && !sameRelay(bound.url, relayUrl)) this.runtime.unbindRelay();\n",
        to: "",
      },
    ],
    pkg: "@motebit/web",
    test: T_WEB,
    red: WEB_RED_PAIRING,
  },
  {
    name: "desktop: Disconnect no longer unbinds",
    edits: [
      {
        file: DESKTOP,
        from: "    this.deps.getRuntime()?.unbindRelay();\n",
        to: "",
      },
    ],
    pkg: "@motebit/desktop",
    test: T_DESKTOP,
    red: DESK_RED_DISCONNECT,
  },
  {
    name: "desktop: the session-number guard removed (a Disconnect during the key fetch)",
    edits: [
      {
        file: DESKTOP,
        from: "    if (session === this._syncSession) {\n",
        to: "    if ((true as boolean) || session === this._syncSession) {\n",
      },
    ],
    pkg: "@motebit/desktop",
    test: T_DESKTOP,
    red: DESK_RED_HELD,
  },
  {
    name: "mobile: every sync cycle rebinds (a pin that resolves mid-attempt churns the generation)",
    edits: [
      {
        file: MOBILE,
        from: "        if (!attempt.delegationBound) {\n",
        to: "        if ((true as boolean) || !attempt.delegationBound) {\n",
      },
    ],
    pkg: "@motebit/mobile",
    test: T_MOBILE,
    red: MOB_RED_PIN,
  },
  {
    name: "mobile: a disposed attempt no longer unbinds",
    edits: [
      {
        file: MOBILE,
        from: "    runtime?.unbindRelay();\n    runtime?.setDelegationAdapter(undefined);\n",
        to: "    runtime?.setDelegationAdapter(undefined);\n",
      },
    ],
    pkg: "@motebit/mobile",
    test: T_MOBILE,
    red: MOB_RED_DISPOSE,
  },
];

void runTampers(TAMPERS, { root: ROOT });
