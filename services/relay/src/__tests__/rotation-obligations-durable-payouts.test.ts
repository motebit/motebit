/**
 * #1049 × #996: every non-terminal Path 0 payout state to the retiring key's
 * derived address is an open obligation a rotation reports.
 *
 * #996 makes a Path 0 payout a durable-nonce transaction decided only by
 * finalized chain facts. It adds tables (the chain claim, the recorded
 * attempts, the nonce-lane queue) but no withdrawal status: a payout queued
 * behind a busy lane stays `pending`, and one that is broadcast and
 * undecided — including after its kill is broadcast but not yet finalized —
 * stays `processing`. `openObligationsToKey` reads `relay_withdrawals` by
 * status and destination, so each of those states must be in its answer.
 * The states here are produced by the real `/withdraw` route and the real
 * resolution tick over the durable-payout fake, never inserted by hand.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { creditAccount } from "../accounts.js";
import { openObligationsToKey } from "../rotation-obligations.js";
import { PAYOUT_KILL_AFTER_MS } from "../budget.js";
import { createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";
import { freshChain, makeDurableOperator } from "./durable-payout-fake.js";

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await relay?.close();
  relay = undefined;
});

describe("rotation obligations cover every #996 payout state", () => {
  it("an undecided payout, a queued payout and a kill awaiting finality to the old address are all reported", async () => {
    const chain = freshChain({ sendOutcome: "unknown", killLands: false });
    const { operator, adapter } = makeDurableOperator(chain);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const db = relay.moteDb.db;

    const kp = await generateKeypair();
    const keyHex = bytesToHex(kp.publicKey);
    const oldAddress = deriveSolanaAddress(kp.publicKey);
    const mid = "rot-996-holder";
    creditAccount(db, mid, 10_000_000, "deposit", "rot-996-dep", "self-deposit");

    const withdraw = async (amount: number): Promise<string> => {
      const res = await relay!.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount, destination: oldAddress }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { withdrawal: { withdrawal_id: string } }).withdrawal
        .withdrawal_id;
    };

    // 1. Broadcast, recorded, not finalized: `processing`, undecided.
    const undecided = await withdraw(1);
    expect(adapter.sendUsdcDurable).toHaveBeenCalledTimes(1);
    // 2. The lane's nonce is carried by (1): this one waits in the lane queue.
    const queued = await withdraw(2);
    expect(adapter.sendUsdcDurable).toHaveBeenCalledTimes(1);

    const status = (id: string) =>
      (
        db.prepare("SELECT status FROM relay_withdrawals WHERE withdrawal_id = ?").get(id) as {
          status: string;
        }
      ).status;
    expect(status(undecided)).toBe("processing");
    expect(status(queued)).toBe("pending");
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM relay_withdrawal_payout_queue WHERE withdrawal_id = ?")
        .get(queued),
    ).toEqual({ n: 1 });

    // 3. Past the kill horizon the tick broadcasts the kill, which does not
    //    finalize: (1) is still undecided, (2) still queued.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + PAYOUT_KILL_AFTER_MS + 60_000);
    await relay.withdrawalPayouts.resolveOnce();
    expect(adapter.broadcastNonceKill).toHaveBeenCalledTimes(1);
    expect(status(undecided)).toBe("processing");
    expect(status(queued)).toBe("pending");

    const open = openObligationsToKey(db, mid, keyHex);
    expect(open?.address).toBe(oldAddress);
    expect(
      open?.obligations
        .filter((o) => o.kind === "withdrawal")
        .map((o) => (o.kind === "withdrawal" ? [o.withdrawal_id, o.status] : null))
        .sort(),
    ).toEqual(
      [
        [undecided, "processing"],
        [queued, "pending"],
      ].sort(),
    );
  });
});
