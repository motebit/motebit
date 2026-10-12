#!/usr/bin/env node
/**
 * Tamper checks for Inc 6 (relay-federation@1.5 §3.5): every signed federation
 * message names the relay it is for, and a relay acts only on messages
 * addressed to its own key.
 *
 * Each entry is (file, text to revert, test expected red), run by the shared
 * runner (scripts/lib/tamper-runner.ts) in an isolated copy of the tree:
 *
 *   - for EACH work kind, the recipient compare removed for that kind alone
 *     (the route-side check before lookup AND the verifier's own-key/own-id
 *     arguments) — the three-relay replay harness must go red;
 *   - a new signed route that skips the one verifier — the static scan must
 *     go red;
 *   - the runtime route registry (`federation-route-registry.test.ts`) must go
 *     red for: a new `app.put` route that writes and verifies nothing; a side
 *     effect moved before the verifier; the verifier run only when `message`
 *     is present (the downgrade); a sub-router mounted at `/federation/v1`.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/federation-recipient-binding.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const FED = "services/relay/src/federation.ts";
// Run as commands with a red marker, not as vitest entries: the repo's vitest
// config pins the JSON reporter's outputFile (vitest.shared.ts
// TEST_RESULTS_FILE, #1062), so the runner's own --outputFile.json is never
// written and every vitest entry reads "BASELINE NOT GREEN". vitest prints
// "Test Files  1 failed" only when the file fails.
const vitest = (test) => ({
  command: ["pnpm", "--filter", "@motebit/relay", "exec", "vitest", "run", test],
  redMarker: "Test Files  1 failed",
});
const REPLAY = vitest("src/__tests__/federation-recipient-binding.test.ts");
const SCAN = vitest("src/__tests__/federation-signed-kinds.test.ts");
const REGISTRY = vitest("src/__tests__/federation-route-registry.test.ts");
const BEFORE_FORWARD =
  '  /** @spec motebit/relay-federation@1.5 */\n  app.post("/federation/v1/task/forward"';

/** `kind`'s recipient compare removed: no check before lookup, and the verifier told "self" is whoever the message names. */
const dropRecipientCompare = (kind) => [
  {
    file: FED,
    from: "  refuseBeforeLookup(parsed.envelope, kind, relayIdentity, label);\n  const sender = parsed.envelope.sender;",
    to: `  if (kind !== "${kind}") refuseBeforeLookup(parsed.envelope, kind, relayIdentity, label);\n  const sender = parsed.envelope.sender;`,
  },
  {
    file: FED,
    from: "    kind,\n    self: relayIdentity.relayMotebitId,\n    selfPublicKeyHex: relayIdentity.publicKeyHex,\n    expectedSender: sender,",
    to:
      `    kind,\n    self: kind === "${kind}" ? parsed.envelope.recipient : relayIdentity.relayMotebitId,\n` +
      `    selfPublicKeyHex:\n      kind === "${kind}" ? parsed.envelope.recipient_public_key : relayIdentity.publicKeyHex,\n` +
      "    expectedSender: sender,",
  },
];

const TAMPERS = [
  ...["discover", "task-forward", "task-result", "settlement-forward"].map((kind) => ({
    name: `${kind}: the recipient compare removed for this kind alone`,
    edits: dropRecipientCompare(kind),
    ...REPLAY,
  })),
  {
    name: "scan: a new signed federation route that skips the one verifier",
    edits: [
      {
        file: FED,
        from: '  app.post("/federation/v1/task/result", async (c) => {',
        to:
          '  app.post("/federation/v1/task/cancel", async (c) => {\n' +
          "    const body = await c.req.json<{ origin_relay: string; signature: string }>();\n" +
          "    const { signature, ...payload } = body;\n" +
          "    const ok = await verify(\n" +
          "      hexToBytes(signature),\n" +
          "      new TextEncoder().encode(canonicalJson(payload)),\n" +
          "      hexToBytes(relayIdentity.publicKeyHex),\n" +
          "    );\n" +
          "    return c.json({ ok });\n" +
          "  });\n\n" +
          '  app.post("/federation/v1/task/result", async (c) => {',
      },
    ],
    ...SCAN,
  },
  {
    name: "registry: a new app.put route that writes a row and verifies nothing",
    edits: [
      {
        file: FED,
        from: BEFORE_FORWARD,
        to:
          '  app.put("/federation/v1/peer/note", async (c) => {\n' +
          '    db.prepare("INSERT INTO relay_federation_nonces (sender, nonce, ts) VALUES (?, ?, ?)").run("x", "n", Date.now());\n' +
          "    return c.json({ ok: true });\n" +
          "  });\n\n" +
          BEFORE_FORWARD,
      },
    ],
    ...REGISTRY,
  },
  {
    name: "registry: task-forward's side effect moved before the verifier",
    edits: [
      {
        file: FED,
        from: '    const { sender } = await verifyFederationRequest(db, relayIdentity, "task-forward", body, [',
        to:
          "    await deps.onTaskForwarded({\n" +
          "      taskId: body.task_id,\n" +
          "      originRelay: body.origin_relay,\n" +
          "      targetAgent: body.target_agent,\n" +
          "      payload: body.task_payload,\n" +
          "    });\n" +
          '    const { sender } = await verifyFederationRequest(db, relayIdentity, "task-forward", body, [',
      },
    ],
    ...REGISTRY,
  },
  {
    name: "registry: settlement-forward verified only when `message` is present (downgrade)",
    edits: [
      {
        file: FED,
        from:
          "    const { sender } = await verifyFederationRequest(\n      db,\n      relayIdentity,\n" +
          '      "settlement-forward",\n      body,\n      ["active", "suspended"],\n    );',
        to:
          "    const { sender } =\n      body.message !== undefined\n" +
          '        ? await verifyFederationRequest(db, relayIdentity, "settlement-forward", body, [\n' +
          '            "active",\n            "suspended",\n          ])\n' +
          "        : { sender: body.origin_relay };",
      },
    ],
    ...REGISTRY,
  },
  {
    name: "registry: a sub-router mounted at /federation/v1",
    edits: [
      {
        file: FED,
        from: BEFORE_FORWARD,
        to:
          "  {\n    const sub = new (app.constructor as new () => Hono)();\n" +
          '    sub.post("/peer/note", (c) => c.json({ ok: true }));\n' +
          '    app.route("/federation/v1", sub);\n  }\n\n' +
          BEFORE_FORWARD,
      },
    ],
    ...REGISTRY,
  },
];

await runTampers(TAMPERS, { root: ROOT });
