/**
 * #800 — the CLI's local identity evidence. `motebit.md` is read from the
 * working directory and every parent; a file there proves possession of
 * ITS key, never that it speaks for the identity. So a file contributes
 * records — and the CLI pins its guardian — only when it verifies, names
 * this motebit, and its current key IS the key the CLI holds (surface-kit's
 * `boundIdentityFile`). The #799 W1 probe, ported: a file planted in a
 * PARENT directory, signed by an unrelated key and naming a guardian that
 * signed a recovery onto the held key, never roots that key.
 *
 * The relay is a fake behind `fetch` serving the part-B routes (the
 * succession route and the roster): what is under test is which local
 * files the CLI's ports admit, not the relay.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveSovereignMotebitId,
  generateKeypair,
  hostEnrollmentId,
  hostRetirementId,
  signGuardianRecoverySuccession,
  signHostEnrollment,
  signKeySuccession,
  type KeyPair,
} from "@motebit/encryption";
import { generate, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { MachineRoster, buildRosterView, classifyHeldKey } from "@motebit/surface-kit";
import type { HostEnrollment, HostRetirement } from "@motebit/sdk";
import type { FullConfig } from "../config.js";
import { decryptPrivateKey, encryptPrivateKey } from "../identity.js";
import { cliRosterPorts, type CliRosterContext } from "../machine-roster.js";
import { rosterHookAfterRotate } from "../machine-roster-rotation.js";

const NOW = Date.now();
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "motebit-roster-800-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The part-B routes the CLI calls, behind `fetch`. */
class FakeRelay {
  enr = new Map<string, HostEnrollment>();
  ret = new Map<string, HostRetirement>();
  current: string | null = null;
  posts = 0;
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/succession")) {
      return Response.json({ chain: [], current_public_key: this.current });
    }
    if (url.endsWith("/roster") && (init?.method ?? "GET") === "GET") {
      return Response.json({
        enrollments: [...this.enr.values()],
        retirements: [...this.ret.values()],
        liveness: {
          observed_by: "relay",
          retention_days: 90,
          observing_since: NOW - 90 * 86_400_000,
          rows: [],
          live_unenrolled: [],
        },
      });
    }
    if (url.endsWith("/roster")) {
      this.posts++;
      const body = JSON.parse(init!.body as string) as {
        enrollments: HostEnrollment[];
        retirements: HostRetirement[];
      };
      for (const e of body.enrollments) this.enr.set(await hostEnrollmentId(e), e);
      for (const r of body.retirements) this.ret.set(await hostRetirementId(r), r);
      return Response.json({ accepted: [] });
    }
    return new Response("not found", { status: 404 });
  };
}

const enrol = (kp: KeyPair, deviceId: string, motebitId: string) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: hex(kp), enrolled_at: NOW },
    kp.privateKey,
  );

interface Scene {
  y: string;
  g: KeyPair;
  d: KeyPair;
  relay: FakeRelay;
  /** The working directory the CLI runs in: two levels under the planted file. */
  cwd: string;
}

/**
 * Sovereign Y (genesis g) with two hosts enrolled under g; the relay names g
 * current. This CLI holds D. A `motebit.md` naming Y and guardian G, carrying
 * the G-signed recovery g → D, sits in a PARENT of the working directory,
 * signed by `signer` (its current key).
 */
async function scene(signer: "foreign" | "held"): Promise<Scene> {
  const g = await generateKeypair();
  const d = await generateKeypair();
  const a = await generateKeypair(); // the planted file's author
  const gg = await generateKeypair(); // the guardian it names
  const y = await deriveSovereignMotebitId(hex(g));
  const recovery = await signGuardianRecoverySuccession(
    gg.privateKey,
    d.privateKey,
    g.publicKey,
    d.publicKey,
  );
  const base = await generate(
    {
      motebitId: y,
      ownerId: "o",
      publicKeyHex: hex(a),
      guardian: { public_key: hex(gg), established_at: "2026-01-01T00:00:00.000Z" },
    },
    a.privateKey,
  );
  const to = signer === "held" ? d : await generateKeypair();
  const planted = await rotateIdentityFile({
    existingContent: base,
    newPublicKey: to.publicKey,
    newPrivateKey: to.privateKey,
    successionRecord: recovery,
  });
  writeFileSync(join(dir, "motebit.md"), planted);
  const cwd = join(dir, "work", "deeper");
  mkdirSync(cwd, { recursive: true });
  const relay = new FakeRelay();
  relay.current = hex(g);
  relay.enr.set("1", await enrol(g, "host-1", y));
  relay.enr.set("2", await enrol(g, "host-2", y));
  return { y, g, d, relay, cwd };
}

function ctx(s: Scene): CliRosterContext {
  return {
    motebitId: s.y,
    deviceId: "cli-host",
    syncUrl: "https://relay.test",
    privateKey: () => s.d.privateKey,
    identityPaths: [],
    dir: join(dir, "state"),
    fetchImpl: s.relay.fetch as typeof fetch,
    loadConfig: () => ({ motebit_id: s.y, device_id: "cli-host" }) as FullConfig,
    cwd: s.cwd,
  };
}

describe("#800 — a motebit.md in a parent directory is evidence only when the held key signed it", () => {
  it("#799 W1 probe: a planted file signed by an unrelated key never roots the held key — no guardian, no records, no count, nothing signed", async () => {
    const s = await scene("foreign");
    mkdirSync(join(dir, "state"), { recursive: true });
    const ports = cliRosterPorts(ctx(s));
    expect(await ports.pinnedGuardian()).toBeNull();
    expect(await ports.localSuccession()).toEqual([]);

    const roster = new MachineRoster(ports);
    const acq = await roster.acquire();
    expect(classifyHeldKey(acq).kind).not.toBe("identity");
    if (acq.kind === "acquired") {
      expect(acq.chain.chain).not.toContain(hex(s.g));
      expect(acq.chain.ancestry.kind).not.toBe("rooted");
    }
    const view = buildRosterView(acq, NOW);
    expect(view.kind === "roster" ? view.claim : null).toBeNull();

    await roster.retire("host-1");
    expect(s.relay.ret.size).toBe(0);
    expect([...s.relay.enr.values()].some((e) => e.public_key === hex(s.d))).toBe(false);
  });

  it("a file signed by the held key is this key's own declaration: its records count and its guardian is pinned", async () => {
    const s = await scene("held");
    mkdirSync(join(dir, "state"), { recursive: true });
    const ports = cliRosterPorts(ctx(s));
    const records = await ports.localSuccession();
    expect(records).toHaveLength(1);
    expect(await ports.pinnedGuardian()).toMatch(/^[0-9a-f]{64}$/);

    const acq = await new MachineRoster(ports).acquire();
    expect(acq.kind).toBe("acquired");
    if (acq.kind !== "acquired") return;
    expect(acq.chain.chain).toEqual([hex(s.g), hex(s.d)]);
    expect(acq.chain.ancestry.kind).toBe("rooted");
  });

  it("the evidence follows the key in hand: the same file under a different held key contributes nothing", async () => {
    const s = await scene("held");
    const other = await generateKeypair();
    const ports = cliRosterPorts({ ...ctx(s), privateKey: () => other.privateKey });
    expect(await ports.localSuccession()).toEqual([]);
    expect(await ports.pinnedGuardian()).toBeNull();
    const none = cliRosterPorts({ ...ctx(s), privateKey: () => null });
    expect(await none.localSuccession()).toEqual([]);
    expect(await none.pinnedGuardian()).toBeNull();
  });
});

describe("#800 sibling — the rotation hook reads its link only from a file bound to the new key", () => {
  it("a file at the identity path carrying the link but signed by another key ⇒ the hook does nothing", async () => {
    const oldKey = await generateKeypair();
    const newKey = await generateKeypair();
    const x = await generateKeypair();
    const mid = await deriveSovereignMotebitId(hex(oldKey));
    const link = await signKeySuccession(
      oldKey.privateKey,
      newKey.privateKey,
      newKey.publicKey,
      oldKey.publicKey,
    );
    const base = await generate(
      { motebitId: mid, ownerId: "o", publicKeyHex: hex(x) },
      x.privateKey,
    );
    const signedBy = (kp: KeyPair) =>
      rotateIdentityFile({
        existingContent: base,
        newPublicKey: kp.publicKey,
        newPrivateKey: kp.privateKey,
        successionRecord: link,
      });
    const config = {
      motebit_id: mid,
      device_id: "cli-host",
      cli_encrypted_key: (await encryptPrivateKey(bytesToHex(newKey.privateKey), "pw"))!,
    } as FullConfig;
    mkdirSync(join(dir, "state"), { recursive: true });
    const run = async (file: string): Promise<number> => {
      const identityPath = join(dir, "motebit.md");
      writeFileSync(identityPath, file);
      let calls = 0;
      await rosterHookAfterRotate({
        identityPath,
        passphrase: "pw",
        syncUrl: "https://relay.test",
        newPublicKeyHex: hex(newKey),
        decryptPrivateKey,
        loadConfig: () => config,
        dir: join(dir, "state"),
        fetchImpl: (async () => {
          calls++;
          return new Response("{}", { status: 503 });
        }) as typeof fetch,
      });
      return calls;
    };
    // Signed by an unrelated key: the link is not read, nothing is fetched.
    expect(await run(await signedBy(await generateKeypair()))).toBe(0);
    // Control — signed by the committed key: the hook runs.
    expect(await run(await signedBy(newKey))).toBeGreaterThan(0);
  });
});
