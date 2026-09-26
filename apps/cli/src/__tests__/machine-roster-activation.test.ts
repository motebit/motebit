/**
 * The machine roster, end to end: the CLI's ports and the kit's controller
 * against an in-process relay with part B applied, reached through its Hono
 * app (fetch-compatible), so nothing between the client and the routes is
 * stubbed (`docs/doctrine/composition-preserves-enforcement.md`). The
 * doors: mint-on-announce (C3), `motebit machines` (C4, C6), and the
 * rotation hook after a real `performRotation` (R21).
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generate } from "@motebit/identity-file";
import {
  deriveSovereignMotebitId,
  generateKeypair,
  bytesToHex,
  hexToBytes,
  mintAudienceToken,
  signHostEnrollment,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { MachineRoster, buildRosterView, captureFor } from "@motebit/surface-kit";

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
import { cliRosterPorts, enrollOnAnnounce, type CliRosterContext } from "../machine-roster.js";
import { formatRosterView } from "../subcommands/machines.js";
import { rosterCaptureBeforeRotate, rosterHookAfterRotate } from "../machine-roster-rotation.js";
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
    expect(lines[0]).toMatch(/this machine is retired — `motebit machines enroll/);
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

  it("W2 — `run` and `serve` starting together on one machine mint one enrolment (the mint lock)", async () => {
    const f = await registeredHost();
    const outs = await Promise.all([
      enrollOnAnnounce(ctx(f), () => {}),
      enrollOnAnnounce(ctx(f), () => {}),
    ]);
    expect(outs.map((o) => o?.kind).sort()).toEqual(["active", "minted"]);
    expect(relayEntries(f.mid, "enrollment")).toBe(1);
    const read = loadReplica(f.mid, dir);
    expect(read.kind === "value" && read.replica.enrollments).toHaveLength(1);
  });

  it("W1 — a machine with an empty replica that cannot read the roster never says no machine has enrolled", async () => {
    const f = await registeredHost();
    await enrollOnAnnounce(ctx(f), () => {});
    // A second machine of this motebit whose device was never registered: 403.
    const other = { ...ctx(f), deviceId: `${f.mid}-laptop`, dir: `${dir}/other` };
    const view = buildRosterView(
      await new MachineRoster(cliRosterPorts(other)).acquire(),
      Date.now(),
    );
    const text = formatRosterView(view, f.mid).join("\n");
    expect(text).toMatch(/No count: /);
    expect(text).not.toMatch(/no machine has enrolled/);
    expect(text).toMatch(/this device holds no roster entries/);
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
    // R21 (a): the capture under A, before the rotation is sent.
    expect(
      await rosterCaptureBeforeRotate({
        passphrase: PASS,
        syncUrl: SYNC_URL,
        identityPath: f.identityPath,
        decryptPrivateKey,
        loadConfig: () => ({ ...config }),
        dir,
        fetchImpl: viaRelay,
      }),
    ).toBe("captured");
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

describe("F1 (#783 decisive round): a retired host that loses its replica never re-enrols itself", () => {
  it.each([409, 429])(
    "retire → rotate → replica deleted → identity file unfindable → /succession %i once → the start mints nothing",
    async (status) => {
      const f = await registeredHost();
      expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
      // `motebit machines retire <own>` under A.
      expect((await new MachineRoster(cliRosterPorts(ctx(f))).retire(f.deviceId)).kind).toBe(
        "retired",
      );
      // Rotate A → B for real; the hook freezes not-active and mints nothing.
      // R21 (a): the capture under A, before the rotation is sent.
      expect(
        await rosterCaptureBeforeRotate({
          passphrase: PASS,
          syncUrl: SYNC_URL,
          identityPath: f.identityPath,
          decryptPrivateKey,
          loadConfig: () => ({ ...config }),
          dir,
          fetchImpl: viaRelay,
        }),
      ).toBe("captured");
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
      const enrolledBefore = relayEntries(f.mid, "enrollment");

      // The replica is lost, and the rotated motebit.md is not findable.
      rmSync(join(dir, "machine-roster.json"), { force: true });
      const hidden = join(dir, "elsewhere");
      mkdirSync(hidden);
      renameSync(f.identityPath, join(hidden, "motebit.md"));
      // /succession answers `status` once.
      let failed = false;
      const flaky: typeof fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!failed && url.endsWith("/succession")) {
          failed = true;
          return new Response("{}", { status });
        }
        return viaRelay(input, init);
      };
      const newKey = hexToBytes(await decryptPrivateKey(config.cli_encrypted_key!, PASS));
      const lines: string[] = [];
      const out = await enrollOnAnnounce(
        {
          ...ctx(f, () => newKey),
          identityPaths: [],
          cwd: join(dir, "nowhere"),
          fetchImpl: flaky,
        },
        (l) => lines.push(l),
      );
      expect(failed).toBe(true);
      expect(out?.kind).not.toBe("minted");
      expect(relayEntries(f.mid, "enrollment")).toBe(enrolledBefore);
      // The truth, under the full chain: the machine is not active.
      const view = buildRosterView(
        await new MachineRoster(
          cliRosterPorts({ ...ctx(f, () => newKey), identityPaths: [join(hidden, "motebit.md")] }),
        ).acquire(),
        Date.now(),
      );
      expect(view.kind).toBe("roster");
      if (view.kind !== "roster") return;
      expect(view.lines.some((l) => l.kind === "active" && l.device_id === f.deviceId)).toBe(false);
    },
  );
});

describe("P2 (#785): a 200 from /succession that is not a key chain is a failed read", () => {
  it.each(["null", "[]", "not json", "{}", '{"chain":"x"}'])(
    "body %s → nothing minted",
    async (body) => {
      const f = await registeredHost();
      const garbage: typeof fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/succession")) return new Response(body, { status: 200 });
        return viaRelay(input, init);
      };
      const out = await enrollOnAnnounce({ ...ctx(f), fetchImpl: garbage }, () => {});
      expect(out).toMatchObject({ kind: "unknown", why: "succession-unread" });
      expect(relayEntries(f.mid, "enrollment")).toBe(0);
    },
  );
});

describe("#785 decisive round: an old-key line presented between the link and a resumed hook never re-activates a retired machine", () => {
  it("retired D; linked device K; rotate → held (lost response); the old-key holder presents a fresh A-enrolment via K; rotate resumes ⇒ D stays retired", async () => {
    const f = await registeredHost();
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
    expect((await new MachineRoster(cliRosterPorts(ctx(f))).retire(f.deviceId)).kind).toBe(
      "retired",
    );
    // A device linked without the identity key: its own key K, its own row.
    const k = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("linked-k", f.mid, "tok-linked-k", hex(k), Date.now());

    const deps = (fetchImpl: typeof fetch) => ({
      identityPath: f.identityPath,
      loadConfig: () => ({ ...config }),
      saveConfig: (c: FullConfig) => {
        config = c;
      },
      pending: {
        load: (mid: string, key: string) => loadPendingRotation(mid, key, dir),
        loadAny: () => loadAnyPendingRotation(dir),
        save: (p: Parameters<typeof savePendingRotation>[0]) => savePendingRotation(p, dir),
        clear: () => clearPendingRotation(dir),
        setAside: () => setAsidePendingRotation(dir),
        path: pendingRotationPath(dir),
      },
      passphrase: PASS,
      syncUrl: SYNC_URL,
      fetchImpl,
    });
    const capture = () =>
      rosterCaptureBeforeRotate({
        passphrase: PASS,
        syncUrl: SYNC_URL,
        identityPath: f.identityPath,
        decryptPrivateKey,
        loadConfig: () => ({ ...config }),
        dir,
        fetchImpl: viaRelay,
      });

    // Attempt 1: captured under A (not active — D is retired); the relay
    // RECORDS A → B, and the response is lost.
    expect(await capture()).toBe("captured");
    const lost: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const resp = await viaRelay(input, init);
      if (url.endsWith("/rotate-key") && (init?.method ?? "GET").toUpperCase() === "POST") {
        throw new Error("socket hang up");
      }
      return resp;
    };
    const held = await performRotation(deps(lost));
    expect(held.kind).toBe("held");

    // The holder of A re-lights D with a fresh A-enrolment, presented under K's device token.
    const fresh = await signHostEnrollment(
      {
        motebit_id: f.mid,
        device_id: f.deviceId,
        public_key: hex(f.a),
        enrolled_at: Date.now() + 1,
      },
      f.a.privateKey,
    );
    const { token } = await mintAudienceToken(
      { mid: f.mid, did: "linked-k", aud: "device:auth" },
      k.privateKey,
    );
    const posted = await viaRelay(`${SYNC_URL}/api/v1/agents/${f.mid}/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enrollments: [fresh] }),
    });
    expect(posted.status).toBe(200);

    // Attempt 2 resumes: no fresh capture (a rotation is in flight), the
    // relay already holds B, the commit finishes, the hook runs.
    expect(await capture()).toBe("kept");
    const o = await performRotation(deps(viaRelay));
    expect(o.kind).toBe("rotated");
    if (o.kind !== "rotated") return;
    expect(o.relay).toBe("already-held");
    await rosterHookAfterRotate({
      identityPath: f.identityPath,
      passphrase: PASS,
      syncUrl: SYNC_URL,
      newPublicKeyHex: o.newPublicKeyHex,
      decryptPrivateKey,
      loadConfig: () => ({ ...config }),
      dir,
      fetchImpl: viaRelay,
    });

    // Nothing was minted under B, and D is not active.
    const underB = (
      relay.moteDb.db
        .prepare(
          "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'enrollment' AND signer_key = ?",
        )
        .get(f.mid, o.newPublicKeyHex) as { n: number }
    ).n;
    expect(underB).toBe(0);
    const newKey = hexToBytes(await decryptPrivateKey(config.cli_encrypted_key!, PASS));
    const acq = await new MachineRoster(cliRosterPorts(ctx(f, () => newKey))).acquire();
    expect(acq.kind).toBe("acquired");
    if (acq.kind !== "acquired") return;
    expect(acq.verdict.active.map((m) => m.device_id)).not.toContain(f.deviceId);
  });
});

describe("#786 round 1", () => {
  const rotationDeps = (f: Fixture, fetchImpl: typeof fetch) => ({
    identityPath: f.identityPath,
    loadConfig: () => ({ ...config }),
    saveConfig: (c: FullConfig) => {
      config = c;
    },
    pending: {
      load: (mid: string, key: string) => loadPendingRotation(mid, key, dir),
      loadAny: () => loadAnyPendingRotation(dir),
      save: (p: Parameters<typeof savePendingRotation>[0]) => savePendingRotation(p, dir),
      clear: () => clearPendingRotation(dir),
      setAside: () => setAsidePendingRotation(dir),
      path: pendingRotationPath(dir),
    },
    passphrase: PASS,
    syncUrl: SYNC_URL,
    fetchImpl,
  });
  const captureNow = (f: Fixture) =>
    rosterCaptureBeforeRotate({
      passphrase: PASS,
      syncUrl: SYNC_URL,
      identityPath: f.identityPath,
      decryptPrivateKey,
      loadConfig: () => ({ ...config }),
      dir,
      fetchImpl: viaRelay,
    });
  const hookNow = (newPublicKeyHex: string, fetchImpl: typeof fetch = viaRelay) =>
    rosterHookAfterRotate({
      identityPath: join(dir, "motebit.md"),
      passphrase: PASS,
      syncUrl: SYNC_URL,
      newPublicKeyHex,
      decryptPrivateKey,
      loadConfig: () => ({ ...config }),
      dir,
      fetchImpl,
    });
  const lostResponse: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const resp = await viaRelay(input, init);
    if (url.endsWith("/rotate-key") && (init?.method ?? "GET").toUpperCase() === "POST") {
      throw new Error("socket hang up");
    }
    return resp;
  };
  const underKey = (mid: string, key: string): number =>
    (
      relay.moteDb.db
        .prepare(
          "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'enrollment' AND signer_key = ?",
        )
        .get(mid, key) as { n: number }
    ).n;

  it("W1: retire D under A; the A-holder POSTs a fresh A-enrolment for D; D rotates ⇒ capture not-active, nothing minted under B", async () => {
    const f = await registeredHost();
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
    expect((await new MachineRoster(cliRosterPorts(ctx(f))).retire(f.deviceId)).kind).toBe(
      "retired",
    );
    const k = await generateKeypair();
    relay.moteDb.db
      .prepare(
        "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("linked-k", f.mid, "tok-linked-k-786", hex(k), Date.now());
    const fresh = await signHostEnrollment(
      {
        motebit_id: f.mid,
        device_id: f.deviceId,
        public_key: hex(f.a),
        enrolled_at: Date.now() + 1,
      },
      f.a.privateKey,
    );
    const { token } = await mintAudienceToken(
      { mid: f.mid, did: "linked-k", aud: "device:auth" },
      k.privateKey,
    );
    const posted = await viaRelay(`${SYNC_URL}/api/v1/agents/${f.mid}/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ enrollments: [fresh] }),
    });
    expect(posted.status).toBe(200);

    expect(await captureNow(f)).toBe("captured");
    const read = loadReplica(f.mid, dir);
    const cap = read.kind === "value" ? captureFor(read.replica, f.deviceId, hex(f.a)) : null;
    expect(cap).toMatchObject({ status: "not-active", entries: [] });
    const o = await performRotation(rotationDeps(f, viaRelay));
    expect(o.kind).toBe("rotated");
    if (o.kind !== "rotated") return;
    await hookNow(o.newPublicKeyHex);
    expect(underKey(f.mid, o.newPublicKeyHex)).toBe(0);
  });

  it("P2: an active host's rotation is held, then resumed ⇒ the ORIGINAL capture re-enrols it (a re-capture after the link would read absent)", async () => {
    const f = await registeredHost();
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
    expect(await captureNow(f)).toBe("captured");
    expect((await performRotation(rotationDeps(f, lostResponse))).kind).toBe("held");
    expect(await captureNow(f)).toBe("kept");
    const o = await performRotation(rotationDeps(f, viaRelay));
    expect(o.kind === "rotated" && o.relay).toBe("already-held");
    if (o.kind !== "rotated") return;
    const line = await hookNow(o.newPublicKeyHex);
    expect(line).toMatch(/enrolled under the new key/);
    expect(underKey(f.mid, o.newPublicKeyHex)).toBe(1);
  });

  it("a STALE write-ahead (another identity) does not block a fresh capture", async () => {
    const f = await registeredHost();
    await enrollOnAnnounce(ctx(f), () => {});
    savePendingRotation(
      {
        motebit_id: "someone-else",
        old_public_key: "1".repeat(64),
        new_public_key: "2".repeat(64),
        record: {} as never,
        encrypted_new_key: config.cli_encrypted_key!,
        written_at: 1,
      },
      dir,
    );
    expect(await captureNow(f)).toBe("captured");
  });

  it("P6: the hook says when the relay did not take the new enrolment", async () => {
    const f = await registeredHost();
    await enrollOnAnnounce(ctx(f), () => {});
    expect(await captureNow(f)).toBe("captured");
    const o = await performRotation(rotationDeps(f, viaRelay));
    if (o.kind !== "rotated") throw new Error("expected rotated");
    const refusePost: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/roster") && (init?.method ?? "GET").toUpperCase() === "POST") {
        return new Response("{}", { status: 500 });
      }
      return viaRelay(input, init);
    };
    const line = await hookNow(o.newPublicKeyHex, refusePost);
    expect(line).toMatch(/enrolled under the new key/);
    expect(line).toMatch(/Not yet taken by the relay; kept on this device, presented again/);
  });
});

describe("BUILD 5 (c) — the hook says when an active capture was not carried", () => {
  it("active before the rotation; the read after it fails ⇒ a line naming it, and the enroll remedy", async () => {
    const f = await registeredHost();
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
    expect(
      await rosterCaptureBeforeRotate({
        passphrase: PASS,
        syncUrl: SYNC_URL,
        identityPath: f.identityPath,
        decryptPrivateKey,
        loadConfig: () => ({ ...config }),
        dir,
        fetchImpl: viaRelay,
      }),
    ).toBe("captured");
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
    if (o.kind !== "rotated") throw new Error("expected rotated");
    const noChain: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/succession")) return new Response("{}", { status: 503 });
      return viaRelay(input, init);
    };
    const line = await rosterHookAfterRotate({
      identityPath: f.identityPath,
      passphrase: PASS,
      syncUrl: SYNC_URL,
      newPublicKeyHex: o.newPublicKeyHex,
      decryptPrivateKey,
      loadConfig: () => ({ ...config }),
      dir,
      fetchImpl: noChain,
    });
    expect(line).toBe(
      `  Machine roster: active before the rotation; not enrolled under the new key (the read after the rotation was incomplete) — \`motebit machines enroll ${f.deviceId}\``,
    );
  });
});

describe("W3 (#792) — the start line qualifies a status the relay did not confirm", () => {
  it("enrolled; retired elsewhere; roster 503 at the next start ⇒ not an unqualified 'active'", async () => {
    const f = await registeredHost();
    expect((await enrollOnAnnounce(ctx(f), () => {}))?.kind).toBe("minted");
    // Retired ELSEWHERE: another surface (its own replica) retires this machine.
    const phone = { ...ctx(f), dir: join(dir, "elsewhere") };
    expect((await new MachineRoster(cliRosterPorts(phone)).retire(f.deviceId)).kind).toBe(
      "retired",
    );
    const down: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/roster") && (init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response("{}", { status: 503 });
      }
      return viaRelay(input, init);
    };
    const lines: string[] = [];
    const out = await enrollOnAnnounce({ ...ctx(f), fetchImpl: down }, (l) => lines.push(l));
    // This machine's copy still shows it active; the line must not say so as fact.
    expect(out).toMatchObject({ kind: "active", confirmed: false });
    expect(lines).toEqual([
      "Machine roster: not updated this start — the relay could not be read; this device's copy shows this machine active",
    ]);
  });
});
