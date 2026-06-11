import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, type KeyPair } from "@motebit/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttachRefusedError, mintAttachToken } from "../client.js";
import { electRuntimeHost, type ElectRuntimeHostOptions } from "../election.js";
import { readLockfile, writeLockfile } from "../lockfile.js";
import { nodePlatform } from "../node-platform.js";

const platform = nodePlatform();

const MOTEBIT_ID = "36080ffe-test-8000-a000-000000000002";
const DEVICE_ID = "device-1";

let keys: KeyPair;
beforeAll(async () => {
  keys = await generateKeypair();
});

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-el-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function electionOptions(
  overrides: Partial<ElectRuntimeHostOptions> = {},
): ElectRuntimeHostOptions {
  return {
    platform,
    socketPath: join(dir, "runtime.sock"),
    lockfilePath: join(dir, "runtime.lock"),
    motebitId: MOTEBIT_ID,
    resolveDevicePublicKey: (deviceId) => (deviceId === DEVICE_ID ? keys.publicKey : null),
    // eslint-disable-next-line @typescript-eslint/require-await
    onInvoke: async function* () {
      yield "ok";
    },
    mintToken: () =>
      mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, keys.privateKey),
    retryDelayMs: 20,
    ...overrides,
  };
}

describe("electRuntimeHost", () => {
  it("makes the first process coordinator and writes the lockfile", async () => {
    const outcome = await electRuntimeHost(electionOptions({ pid: 7001 }));
    expect(outcome.role).toBe("coordinator");
    if (outcome.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => outcome.server.close());
    expect((await readLockfile(platform, electionOptions().lockfilePath))?.pid).toBe(7001);
  });

  it("attaches the second process as a frontend to the first", async () => {
    const first = await electRuntimeHost(electionOptions({ pid: 7001 }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());

    const second = await electRuntimeHost(electionOptions({ pid: 7002 }));
    expect(second.role).toBe("frontend");
    if (second.role !== "frontend") throw new Error("unreachable");
    expect(second.client.coordinatorPid).toBe(7001);
    second.client.close();
  });

  it("takes over a crashed coordinator: stale socket file + dead-pid lock", async () => {
    const opts = electionOptions({ pid: 7003 });
    // Simulate the crash artifacts: a socket path nothing listens on
    // and a lockfile naming a dead PID.
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(opts.socketPath, () => resolve()));
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    if (!existsSync(opts.socketPath)) writeFileSync(opts.socketPath, "");
    await writeLockfile(platform, opts.lockfilePath, {
      pid: 99_999_999,
      bound_at: 0,
      protocol_version: 1,
    });

    const outcome = await electRuntimeHost({
      ...opts,
      probePid: () => false,
    });
    expect(outcome.role).toBe("coordinator");
    if (outcome.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => outcome.server.close());
    expect((await readLockfile(platform, opts.lockfilePath))?.pid).toBe(7003);
  });

  it("gives a live-pid lock a grace period, then binds anyway (the bind is the truth)", async () => {
    const opts = electionOptions({ pid: 7004, maxAttempts: 3 });
    await writeLockfile(platform, opts.lockfilePath, {
      pid: process.pid,
      bound_at: 0,
      protocol_version: 1,
    });
    let probes = 0;
    const outcome = await electRuntimeHost({
      ...opts,
      probePid: () => {
        probes += 1;
        return true;
      },
    });
    expect(outcome.role).toBe("coordinator");
    if (outcome.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => outcome.server.close());
    expect(probes).toBeGreaterThanOrEqual(2);
  });

  it("rethrows a coordinator's refusal instead of binding over it", async () => {
    const first = await electRuntimeHost(electionOptions({ pid: 7005 }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    cleanups.push(() => first.server.close());

    const stranger = await generateKeypair();
    await expect(
      electRuntimeHost(
        electionOptions({
          mintToken: () =>
            mintAttachToken({ motebitId: MOTEBIT_ID, deviceId: DEVICE_ID }, stranger.privateKey),
        }),
      ),
    ).rejects.toThrow(AttachRefusedError);
    // The refused process must NOT have displaced the coordinator.
    expect((await readLockfile(platform, electionOptions().lockfilePath))?.pid).toBe(7005);
  });

  it("resolves a simultaneous start to exactly one coordinator", async () => {
    // Both electors run with synthetic pids; the probe must report them
    // alive (as the real pids of two live processes would be) or the
    // second racer would treat the takeover-mutex holder as crashed.
    const probePid = (pid: number): boolean => pid === 7006 || pid === 7007;
    const [a, b] = await Promise.all([
      electRuntimeHost(electionOptions({ pid: 7006, probePid })),
      electRuntimeHost(electionOptions({ pid: 7007, probePid })),
    ]);
    const roles = [a.role, b.role].sort();
    expect(roles).toEqual(["coordinator", "frontend"]);
    for (const outcome of [a, b]) {
      if (outcome.role === "coordinator") cleanups.push(() => outcome.server.close());
      else outcome.client.close();
    }
  });

  it("frontends observe coordinator exit and a re-election succeeds", async () => {
    const first = await electRuntimeHost(electionOptions({ pid: 7008 }));
    if (first.role !== "coordinator") throw new Error("first should coordinate");
    const second = await electRuntimeHost(electionOptions({ pid: 7009 }));
    if (second.role !== "frontend") throw new Error("second should attach");

    const closedSignal = new Promise<void>((resolve) => second.client.onClose(() => resolve()));
    await first.server.close();
    await closedSignal;

    const reelected = await electRuntimeHost(electionOptions({ pid: 7009 }));
    expect(reelected.role).toBe("coordinator");
    if (reelected.role !== "coordinator") throw new Error("unreachable");
    cleanups.push(() => reelected.server.close());
    expect((await readLockfile(platform, electionOptions().lockfilePath))?.pid).toBe(7009);
  });
});
