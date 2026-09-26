/**
 * The machine roster, end to end: the CLI's ports and the kit's controller
 * against an in-process relay with part B applied, reached through its Hono
 * app (fetch-compatible), so nothing between the client and the routes is
 * stubbed (`docs/doctrine/composition-preserves-enforcement.md`). The
 * doors: mint-on-announce (C3), `motebit machines` (C4, C6), and the
 * rotation hook after a real `performRotation` (R21).
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generate } from "@motebit/identity-file";
import { deriveSovereignMotebitId, generateKeypair, bytesToHex } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { MachineRoster, buildRosterView } from "@motebit/surface-kit";

import type { FullConfig } from "../config.js";
import { encryptPrivateKey, decryptPrivateKey } from "../identity.js";
import {
  clearPendingRotation,
  setAsidePendingRotation,
  loadAnyPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
} from "../pending-rotation.js";
import { registerWithRelay } from "../relay-registration.js";
import { performRotation } from "../rotation.js";
import {
  cliRosterPorts,
  enrollOnAnnounce,
  rosterHookAfterRotate,
  type CliRosterContext,
} from "../machine-roster.js";
import { formatRosterView } from "../subcommands/machines.js";
import { loadReplica } from "../machine-roster-file.js";

const PASS = "correct horse";
const SYNC_URL = "http://relay.test";
const MASTER = "test-token";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay;
let dir: string;
let config: FullConfig;
/** Authorization headers every roster request carried. */
let rosterAuth: string[];

const viaRelay: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/roster")) {
    const h = new Headers(init?.headers);
    rosterAuth.push(h.get("authorization") ?? "");
  }
  return relay.app.request(url, init);
};

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  dir = mkdtempSync(join(tmpdir(), "motebit-roster-activation-"));
  rosterAuth = [];
  // The operator's master token is in the environment: the roster doors
  // must not pick it up (it would be refused 403 — and it is not this
  // motebit's credential).
  process.env["MOTEBIT_API_TOKEN"] = MASTER;
});
afterEach(async () => {
  delete process.env["MOTEBIT_API_TOKEN"];
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  mid: string;
  deviceId: string;
  a: KeyPair;
  identityPath: string;
  key: Uint8Array;
}

async function registeredHost(): Promise<Fixture> {
  const a = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(a));
  const identityPath = join(dir, "motebit.md");
  writeFileSync(
    identityPath,
    await generate({ motebitId: mid, ownerId: "owner", publicKeyHex: hex(a) }, a.privateKey),
  );
  const deviceId = `${mid}-vps`;
  config = {
    motebit_id: mid,
    device_id: deviceId,
    device_public_key: hex(a),
    cli_encrypted_key: (await encryptPrivateKey(bytesToHex(a.privateKey), PASS))!,
  } as FullConfig;
  const handle = await registerWithRelay({
    syncUrl: SYNC_URL,
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(a), privateKey: a.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "roster activation",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: viaRelay,
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return { mid, deviceId, a, identityPath, key: a.privateKey };
}

function ctx(f: Fixture, key: () => Uint8Array | null = () => f.key): CliRosterContext {
  return {
    motebitId: f.mid,
    deviceId: f.deviceId,
    syncUrl: SYNC_URL,
    privateKey: key,
    identityPaths: [f.identityPath],
    dir,
    fetchImpl: viaRelay,
    loadConfig: () => ({ ...config }),
    cwd: dir,
  };
}

const relayEntries = (mid: string, kind: "enrollment" | "retirement"): number =>
  (
    relay.moteDb.db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = ?",
      )
      .get(mid, kind) as { n: number }
  ).n;

describe("mint-on-announce against a real relay", () => {
  it("the first start enrols; the next re-presents and mints nothing; `machines` counts one", async () => {
    const f = await registeredHost();
    const lines: string[] = [];
    const first = await enrollOnAnnounce(ctx(f), (l) => lines.push(l));
    expect(first?.kind).toBe("minted");
    expect(lines).toEqual([expect.stringMatching(/^Machine roster: enrolled this machine/)]);
    expect(relayEntries(f.mid, "enrollment")).toBe(1);

    const quiet: string[] = [];
    const second = await enrollOnAnnounce(ctx(f), (l) => quiet.push(l));
    expect(second?.kind).toBe("active");
    expect(quiet).toEqual([]); // calm: nothing to say
    expect(relayEntries(f.mid, "enrollment")).toBe(1);

    const view = buildRosterView(
      await new MachineRoster(cliRosterPorts(ctx(f))).acquire(),
      Date.now(),
    );
    const text = formatRosterView(view, f.mid).join("\n");
    expect(text).toMatch(/1 machine on the current key/);
    expect(text).toMatch(/\(this device\) — active/);

    // Every roster request carried a device token, never the master token.
    expect(rosterAuth.length).toBeGreaterThan(0);
    for (const a of rosterAuth) {
      expect(a).toMatch(/^Bearer /);
      expect(a).not.toBe(`Bearer ${MASTER}`);
    }
  });

  it("a retired machine that restarts never re-enrols on its own; `machines enroll` rejoins it", async () => {
    const f = await registeredHost();
    await enrollOnAnnounce(ctx(f), () => {});
    const roster = new MachineRoster(cliRosterPorts(ctx(f)));
    expect((await roster.retire(f.deviceId)).kind).toBe("retired");
    expect(relayEntries(f.mid, "retirement")).toBe(1);

    const lines: string[] = [];
    const out = await enrollOnAnnounce(ctx(f), (l) => lines.push(l));
    expect(out?.kind).toBe("retired");
    expect(lines[0]).toMatch(/retired from the roster but running/);
    expect(relayEntries(f.mid, "enrollment")).toBe(1);

    expect((await roster.enroll(f.deviceId)).kind).toBe("enrolled");
    expect(relayEntries(f.mid, "enrollment")).toBe(2);
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("active");
  });

  it("no key → nothing read, nothing sent, nothing said", async () => {
    const f = await registeredHost();
    const lines: string[] = [];
    expect(
      await enrollOnAnnounce(
        ctx(f, () => null),
        (l) => lines.push(l),
      ),
    ).toEqual({
      kind: "no-key",
    });
    expect(lines).toEqual([]);
    expect(rosterAuth).toEqual([]);
  });

  it("an unreachable relay never blocks the start: one line, nothing minted", async () => {
    const f = await registeredHost();
    const lines: string[] = [];
    const down: typeof fetch = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const out = await enrollOnAnnounce({ ...ctx(f), fetchImpl: down }, (l) => lines.push(l));
    expect(out).toMatchObject({ kind: "unknown", why: "fetch-failed" });
    expect(lines).toEqual([expect.stringMatching(/not updated this start/)]);
    expect(loadReplica(f.mid, dir).kind).toBe("value");
  });
});

describe("the rotation hook after a real rotation (R21, option b)", () => {
  it("an active host rotates: enrolled under the new key; the old line is history; `machines` still counts one", async () => {
    const f = await registeredHost();
    await enrollOnAnnounce(ctx(f), () => {});
    const o = await performRotation({
      identityPath: f.identityPath,
      loadConfig: () => ({ ...config }),
      saveConfig: (c) => {
        config = c;
      },
      pending: {
        load: (mid, key) => loadPendingRotation(mid, key, dir),
        loadAny: () => loadAnyPendingRotation(dir),
        save: (p) => savePendingRotation(p, dir),
        clear: () => clearPendingRotation(dir),
        setAside: () => setAsidePendingRotation(dir),
        path: pendingRotationPath(dir),
      },
      passphrase: PASS,
      syncUrl: SYNC_URL,
      fetchImpl: viaRelay,
    });
    expect(o.kind).toBe("rotated");
    if (o.kind !== "rotated") return;

    // The old key is locked out of the roster routes now (device rows moved).
    const stale = await enrollOnAnnounce(ctx(f), () => {});
    expect(stale).toMatchObject({
      kind: "refused",
      reason: "held_key_superseded",
      remedy: "restart",
    });

    const line = await rosterHookAfterRotate({
      identityPath: f.identityPath,
      passphrase: PASS,
      syncUrl: SYNC_URL,
      newPublicKeyHex: o.newPublicKeyHex,
      decryptPrivateKey,
      loadConfig: () => ({ ...config }),
      dir,
      fetchImpl: viaRelay,
    });
    expect(line).toMatch(/enrolled under the new key/);
    expect(relayEntries(f.mid, "enrollment")).toBe(2);

    const newKey = Uint8Array.from(
      Buffer.from(await decryptPrivateKey(config.cli_encrypted_key!, PASS), "hex"),
    );
    const view = buildRosterView(
      await new MachineRoster(cliRosterPorts(ctx(f, () => newKey))).acquire(),
      Date.now(),
    );
    expect(view.kind).toBe("roster");
    if (view.kind !== "roster") return;
    expect(view.claim?.text).toMatch(/^1 machine on the current key/);
    expect(view.head.public_key).toBe(o.newPublicKeyHex);
    // The hook is idempotent on the resume paths: nothing new minted.
    expect(
      await rosterHookAfterRotate({
        identityPath: f.identityPath,
        passphrase: PASS,
        syncUrl: SYNC_URL,
        newPublicKeyHex: o.newPublicKeyHex,
        decryptPrivateKey,
        loadConfig: () => ({ ...config }),
        dir,
        fetchImpl: viaRelay,
      }),
    ).toBeNull();
    expect(relayEntries(f.mid, "enrollment")).toBe(2);
    // The replica keeps the link (R26): readable, and on disk owner-only.
    const stored = JSON.parse(readFileSync(join(dir, "machine-roster.json"), "utf-8")) as {
      replicas: Record<string, { succession: unknown[] }>;
    };
    expect(stored.replicas[f.mid]!.succession.length).toBe(1);
  });
});
