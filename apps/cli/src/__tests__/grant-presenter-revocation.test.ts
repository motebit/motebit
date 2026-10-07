/**
 * Finding 2 — a revocation written AFTER a `--grant` session starts bites on
 * the very next presentation.
 *
 * `createGrantPresenter` read the stored grant's revocation (and the relay's
 * revocation cache) once, at startup, and closed over that set: `motebit
 * grant revoke <id>` while `serve --direct --grant <id>` (or an interactive
 * `motebit --grant <id>` session) was running changed nothing until restart.
 * Each presentation now re-reads the stored grant and its revocation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, bytesToHex, signDelegationRevocation } from "@motebit/encryption";
import { verifyGrantForTurn } from "@motebit/runtime";

const DAY = 24 * 3_600_000;
const M = 1_000_000;
const ID = "founder-revoke";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "motebit-grant-revoke-"));
  vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
  vi.stubEnv("MOTEBIT_SYNC_URL", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("finding 2: grant revoked after the session started", () => {
  it("the next presentation carries the revocation and the grant no longer verifies", async () => {
    vi.resetModules();
    const grantMod = await import("../subcommands/grant.js");
    const kp = await generateKeypair();
    const pub = bytesToHex(kp.publicKey);
    const minted = await grantMod.mintGrantWithSchedule({
      motebitId: ID,
      publicKeyHex: pub,
      privateKey: kp.privateKey,
      scope: "transfer_funds",
      subject: "billing:vendor=acme",
      ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5 * M },
      cadenceMs: DAY,
      days: 3,
      now: Date.now() - 1000,
    });
    const grantsDir = join(dir, grantMod.GRANTS_DIR_NAME);
    mkdirSync(grantsDir, { recursive: true });
    const file = join(grantsDir, `${minted.grant.grant_id}.json`);
    writeFileSync(file, JSON.stringify({ grant: minted.grant, ticks: minted.ticks }));

    const presenter = await grantMod.createGrantPresenter(minted.grant.grant_id);
    expect(presenter).not.toBeNull();
    const presenterId = { motebitId: ID, publicKeyHex: pub };

    const first = await presenter!.delegationForTurn();
    expect(first).not.toBeNull();
    const before = await verifyGrantForTurn(
      first!.delegation.token,
      first!.delegation.grant,
      first!.delegation.revocations,
      { presenter: presenterId } as never,
    );
    expect(before).not.toBeNull();

    // `motebit grant revoke` from another shell, while the session runs.
    const revocation = await signDelegationRevocation(
      {
        grant_id: minted.grant.grant_id,
        delegator_id: minted.grant.delegator_id,
        delegator_public_key: minted.grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      kp.privateKey,
    );
    writeFileSync(file, JSON.stringify({ grant: minted.grant, ticks: minted.ticks, revocation }));

    const second = await presenter!.delegationForTurn();
    const after =
      second == null
        ? null
        : await verifyGrantForTurn(
            second.delegation.token,
            second.delegation.grant,
            second.delegation.revocations,
            { presenter: presenterId } as never,
          );
    expect(after).toBeNull();
  });
});
