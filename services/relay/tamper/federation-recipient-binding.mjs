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
 *     go red.
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
];

await runTampers(TAMPERS, { root: ROOT });
