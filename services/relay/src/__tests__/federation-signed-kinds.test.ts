/**
 * Every signed federation message is recipient-bound — the static half
 * (relay-federation@1.5 §3.5). The behavioural halves are
 * `federation-route-registry.test.ts` (every registered `/federation` route is
 * declared, and every signed one refuses another relay's message and the v1
 * body with nothing written), `federation-recipient-binding.test.ts` (a
 * message signed for one relay, replayed to a third, is refused there) and the
 * crypto registry test (`packages/crypto/src/__tests__/federation-message.test.ts`,
 * every kind).
 *
 * `scanFederationRoutes` (federation-route-scan.ts) over every non-test relay
 * source and the CLI's federation subcommand: every literal-path
 * `/federation/v1/*` POST route's handler contains a call to the one verifier
 * naming exactly one §3.5 kind (or carries a stated exemption) — presence of
 * the call, not its order or reach (see the scan's aperture), every kind in the registry has a verifier site, every
 * verifier compares the recipient to this relay's own key, and every outbound
 * work request is signed through the one producer. Then each rule is tampered
 * in a fixture and must go red.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FEDERATION_MESSAGE_KINDS } from "@motebit/crypto";

import { FEDERATION_WORK_ROUTES } from "../federation.js";
import {
  scanFederationRoutes,
  UNENVELOPED_ROUTES,
  type ScanFile,
} from "./federation-route-scan.js";

const REPO = join(__dirname, "..", "..", "..", "..");
const RELAY_SRC = join(REPO, "services", "relay", "src");
const CLI_FEDERATION = join(REPO, "apps", "cli", "src", "subcommands", "federation.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...sources(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function load(p: string): ScanFile {
  return { file: relative(REPO, p).split("\\").join("/"), text: readFileSync(p, "utf8") };
}

const REGISTRY = {
  kinds: Object.keys(FEDERATION_MESSAGE_KINDS),
  workRoutes: FEDERATION_WORK_ROUTES as Readonly<Record<string, string>>,
};

const real = (): ScanFile[] => [...sources(RELAY_SRC).map(load), load(CLI_FEDERATION)];

const FED = "services/relay/src/federation.ts";
/** The real tree with `federation.ts` passed through `edit`. */
function tampered(edit: (text: string) => string): ScanFile[] {
  return real().map((f) => (f.file === FED ? { ...f, text: edit(f.text) } : f));
}
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from).length - 1, `tamper anchor present once: ${from.slice(0, 60)}`).toBe(1);
  return text.replace(from, to);
}

describe("every signed federation kind is recipient-bound (static)", () => {
  it("the real tree: no violation, and the aperture it read", () => {
    const files = real();
    const r = scanFederationRoutes(files, REGISTRY);
    expect(r.violations).toEqual([]);
    // Aperture: what was examined, so a green is only as wide as it says.
    const fedRoutes = r.routes.map((x) => x.path).sort();
    expect(fedRoutes).toEqual(
      [
        "/federation/v1/discover",
        "/federation/v1/disputes/:disputeId/vote-request",
        "/federation/v1/horizon/dispute",
        "/federation/v1/horizon/witness",
        "/federation/v1/peer/confirm",
        "/federation/v1/peer/heartbeat",
        "/federation/v1/peer/propose",
        "/federation/v1/peer/remove",
        "/federation/v1/settlement/forward",
        "/federation/v1/task/forward",
        "/federation/v1/task/result",
      ].sort(),
    );
    expect([...r.verifiedKinds].sort()).toEqual([...REGISTRY.kinds].sort());
    expect(files.length).toBeGreaterThan(50);
    console.info(
      `[federation-signed-kinds] scanned ${files.length} files; ${r.routes.length} literal-path /federation/v1 POST routes scanned for a verifier call (${Object.keys(UNENVELOPED_ROUTES).length} stated exemptions); ${r.verifiedKinds.size}/${REGISTRY.kinds.length} kinds with a verifier site`,
    );
  });

  it("each work kind is verified at its own route", () => {
    const r = scanFederationRoutes(real(), REGISTRY);
    for (const [kind, path] of Object.entries(FEDERATION_WORK_ROUTES)) {
      expect(r.routes.find((x) => x.path === path)?.kinds, path).toEqual([kind]);
    }
  });

  describe("tampers — each is red", () => {
    const red = (files: ScanFile[], match: RegExp) => {
      const v = scanFederationRoutes(files, REGISTRY).violations;
      expect(
        v.some((x) => match.test(x)),
        v.join("\n"),
      ).toBe(true);
    };

    it("a new signed route that skips the helper (raw verify over a body naming no recipient)", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            '  app.post("/federation/v1/task/result", async (c) => {',
            `  app.post("/federation/v1/task/cancel", async (c) => {
    const body = await c.req.json<{ origin_relay: string; signature: string }>();
    const { signature, ...payload } = body;
    await verify(hexToBytes(signature), new TextEncoder().encode(canonicalJson(payload)), hexToBytes("00"));
    return c.json({ ok: true });
  });

  app.post("/federation/v1/task/result", async (c) => {`,
          ),
        ),
        /ROUTE .*\/federation\/v1\/task\/cancel: verifies no §3\.5 kind/,
      );
    });

    it("a work route whose handler drops the helper", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            `    const { sender } = await verifyFederationRequest(
      db,
      relayIdentity,
      "settlement-forward",
      body,
      ["active", "suspended"],
    );`,
            `    const sender = body.origin_relay;`,
          ),
        ),
        /settlement\/forward: verifies no §3\.5 kind|KIND settlement-forward/,
      );
    });

    it("a raw verifier beside the helper in a work route", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            "    checkFederationEnabled();\n\n    // Federation owns: the v2 `task-forward` message",
            "    checkFederationEnabled();\n    await verify(new Uint8Array(), new Uint8Array(), new Uint8Array());\n\n    // Federation owns: the v2 `task-forward` message",
          ),
        ),
        /task\/forward: calls a raw verifier/,
      );
    });

    it("a work kind verified at another kind's route", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            'await verifyFederationRequest(db, relayIdentity, "task-result", body, [',
            'await verifyFederationRequest(db, relayIdentity, "task-forward", body, [',
          ),
        ),
        /verifies work kind "task-forward", which belongs to \/federation\/v1\/task\/forward/,
      );
    });

    it("a control verifier comparing the recipient to a key other than this relay's own", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            `      kind: "peer-remove",
      self: relayIdentity.relayMotebitId,
      selfPublicKeyHex: relayIdentity.publicKeyHex,`,
            `      kind: "peer-remove",
      self: relayIdentity.relayMotebitId,
      selfPublicKeyHex: parseFederationMessage(body.message)!.envelope.recipient_public_key,`,
          ),
        ),
        /compares the recipient to .*not this relay's own key/,
      );
    });

    it("an outbound work request not signed by the one producer", () => {
      red(
        tampered((t) =>
          replaceOnce(
            t,
            `    const signed = await signFederationRequest(
      db,
      relayIdentity,
      "task-result",
      row.peer_relay_id,
      {`,
            `    const signed = await Promise.resolve(
      {`,
          ),
        ),
        /SEND .*\/federation\/v1\/task\/result/,
      );
    });

    it("a registry kind with no verifier site", () => {
      const v = scanFederationRoutes(real(), {
        ...REGISTRY,
        kinds: [...REGISTRY.kinds, "task-cancel"],
      }).violations;
      expect(v).toContain("KIND task-cancel: no verifier site in the scanned sources");
    });

    it("a stale exemption", () => {
      const v = scanFederationRoutes(real(), REGISTRY, {
        ...UNENVELOPED_ROUTES,
        "/federation/v1/peer/heartbeat": "stale",
        "/federation/v1/nowhere": "stale",
      }).violations;
      expect(v.some((x) => /peer\/heartbeat: exempt as unenveloped but verifies/.test(x))).toBe(
        true,
      );
      expect(v).toContain(
        "ROUTE /federation/v1/nowhere: stale UNENVELOPED_ROUTES entry (no such route)",
      );
    });
  });
});
