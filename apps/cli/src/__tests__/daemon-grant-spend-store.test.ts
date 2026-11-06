/**
 * `motebit run` and `motebit serve` build their runtime through
 * `daemonRuntimeConfig` (daemon.ts), and both set `identityPublicKeyHex`, so
 * a standing grant this identity signed authorizes R4 spending in the
 * unattended process. Before the fix neither passed `grantSpendStore`; the
 * runtime fell back to `InMemoryGrantSpendStore`, and the money meter's
 * window and LIFETIME ceilings re-armed on every daemon restart (#436
 * finding 6).
 *
 * `handleRun` / `handleServe` cannot be driven in a unit test (passphrase
 * prompt, runtime-host socket, relay registration), so this drives the one
 * config builder both daemons call, against a real on-disk MoteDb, through a
 * real `MotebitRuntime`'s own meter: spend under a grant, close the database,
 * reopen it, construct the runtime again, and the lifetime ceiling still
 * holds. Ephemeral keys and a temp directory only; nothing reads ~/.motebit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, generateKeypair } from "@motebit/encryption";
import { openMotebitDatabase } from "@motebit/persistence";
import { MotebitRuntime, NullRenderer, verifyGrantForTurn } from "@motebit/runtime";
import type { MoneyMeter } from "@motebit/runtime";
import { daemonRuntimeConfig } from "../daemon.js";
import { buildStorageAdapters } from "../runtime-factory.js";
import { mintGrantWithSchedule } from "../subcommands/grant.js";

const M = 1_000_000;
const DAY = 24 * 3_600_000;

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The runtime's own meter: the object an R4 call is metered by. */
function meterOf(runtime: MotebitRuntime): MoneyMeter {
  return (runtime as unknown as { moneyMeter: MoneyMeter }).moneyMeter;
}

describe("daemon runtime: the grant spend store is persistent", () => {
  it("a daemon restart does not re-arm the grant's lifetime ceiling", async () => {
    dir = mkdtempSync(join(tmpdir(), "motebit-daemon-spend-"));
    const dbPath = join(dir, "motebit.db");
    const kp = await generateKeypair();
    const publicKeyHex = bytesToHex(kp.publicKey);
    const motebitId = "did:motebit:daemon-spend";
    const now = Date.now();
    const minted = await mintGrantWithSchedule({
      motebitId,
      publicKeyHex,
      privateKey: kp.privateKey,
      scope: "pay_invoice",
      subject: "billing:vendor=acme",
      ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 2 * M },
      cadenceMs: DAY,
      days: 2,
      now,
    });
    const verified = await verifyGrantForTurn(minted.ticks[0]!, minted.grant, [], {
      presenter: { motebitId, publicKeyHex },
      delegator: { motebitId, publicKeyHex },
      now: now + 1,
    });
    // The next day's tick: a fresh nonce, so only the ceiling can refuse it.
    const nextTick = await verifyGrantForTurn(minted.ticks[1]!, minted.grant, [], {
      presenter: { motebitId, publicKeyHex },
      delegator: { motebitId, publicKeyHex },
      now: now + DAY + 1,
    });
    expect(verified).not.toBeNull();
    expect(nextTick).not.toBeNull();

    // One daemon process: construct exactly as `run` / `serve` do.
    const boot = async () => {
      const moteDb = await openMotebitDatabase(dbPath);
      const runtime = new MotebitRuntime(
        daemonRuntimeConfig(
          { motebitId, identityPublicKeyHex: publicKeyHex },
          { syncUrl: undefined },
          moteDb.grantSpendStore,
        ),
        { storage: buildStorageAdapters(moteDb), renderer: new NullRenderer() },
      );
      return { moteDb, runtime };
    };

    const first = await boot();
    const spent = await meterOf(first.runtime)(verified!, "pay_invoice", {
      amount_micro: 2 * M,
      counterparty: "vendor-acme",
    });
    expect(spent.allowed).toBe(true);
    first.moteDb.close();

    // The daemon restarts against the same database.
    const second = await boot();
    const meter = meterOf(second.runtime);
    const fresh = await meter(nextTick!, "pay_invoice", {
      amount_micro: 1 * M,
      counterparty: "vendor-acme",
    });
    // The spent tick's nonce is remembered across the restart too.
    const replayed = await meter(verified!, "pay_invoice", {
      amount_micro: 1 * M,
      counterparty: "vendor-acme",
    });
    second.moteDb.close();
    expect(fresh.allowed).toBe(false);
    expect(fresh.denial).toBe("lifetime_exceeded");
    expect(replayed.allowed).toBe(false);
    expect(replayed.denial).toBe("replay");
  });
});
