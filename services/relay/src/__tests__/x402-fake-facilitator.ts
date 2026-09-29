/**
 * An in-process x402 facilitator and EVM token chain for driving the REAL
 * `@x402/hono` 2.22 stack (`x402ResourceServer`, `x402HTTPResourceServer`,
 * `ExactEvmScheme` — eip3009, the "authorization" flow) over the relay's live
 * submit route (#907).
 *
 * Only the facilitator's network round-trip and the chain are replaced.
 * Install it with
 *
 *   vi.mock("../x402-facilitator.js", async () =>
 *     (await import("./x402-fake-facilitator.js")).fakeFacilitatorModule);
 *
 * and import `facilitator` for its state.
 *
 * The chain models USDC's EIP-3009: an authorization (from, nonce) is either
 * unused, USED by `transferWithAuthorization` (an `AuthorizationUsed` event
 * plus a `Transfer(from → to, value)` in the same transaction), or CANCELED by
 * `cancelAuthorization` (an `AuthorizationCanceled` event, no transfer). Both
 * set the same "state bit" (`authorizationStateBit`), exactly as FiatTokenV2
 * does — which is why reconciliation must never read it.
 *
 * `verify` accepts every payment (optionally waiting on `verifyBarrier`).
 * `settle` behaves per `settleMode`:
 *   - "ok": executes the authorization on the chain (honouring ITS value and
 *     recipient) and returns success — or, if the authorization is already
 *     used or canceled, refuses `invalid_exact_evm_nonce_already_used`, the
 *     real library's code for that state;
 *   - { refuse: reason, tx? }: returns `{ success: false, errorReason }`
 *     (with a transaction hash when `tx`);
 *   - "timeout-after-transfer": executes, then throws (the answer is lost);
 *   - "hang": never answers (a crash mid-settle);
 *   - { network }: executes and answers success on a DIFFERENT network;
 *   - { amount }: executes and answers success reporting that amount.
 * It is deliberately NON-conforming — it would settle one authorization twice
 * if its chain allowed — so the relay's own replay defence is what is tested.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_TOPIC,
  type AuthorizationEvent,
  type ReceiptLog,
  type X402ChainReader,
} from "../x402-settlements.js";

/** A Transfer log on the fake chain (block-scoped `logIndex`). */
export interface TokenTransfer {
  token: string;
  from: string;
  to: string;
  value: bigint;
  logIndex: number;
}

export interface FakeSettlement {
  payer: string;
  amount: string;
  payTo: string;
  network: string;
  tx: string;
  nonce: string;
}

type SettleMode =
  | "ok"
  | "timeout-after-transfer"
  | "hang"
  | { refuse: string; tx?: boolean }
  | { network: string }
  | { amount: string };

interface ChainEvent extends AuthorizationEvent {
  from: string;
  nonce: string;
  token: string;
}

export const facilitator = {
  /** Every settlement the fake executed onchain, in order. */
  settled: [] as FakeSettlement[],
  /** Every verified payment: payer and the requirements it was verified against. */
  verified: [] as { payer: string; amount: string; payTo: string }[],
  /** Calls to `settle`. */
  settleCalls: 0,
  /** When set, `verify` waits on it (the facilitator await between quote and handler). */
  verifyBarrier: null as Promise<void> | null,
  /** When set, a successful settle lands onchain, then waits on it before answering. */
  settleAnswerBarrier: null as Promise<void> | null,
  /** Arrivals at `verify`. */
  verifyEntered: 0,
  settleMode: "ok" as SettleMode,
  // ── the chain ──
  /**
   * The chain's clock: block n has timestamp `genesis + 2n` (2 s blocks) —
   * one consistent timeline, so a block's time is fixed once it exists.
   * ~111 h of history before "now" at reset.
   */
  head: 200_000,
  genesis: Math.floor(Date.now() / 1000) - 400_000,
  events: [] as ChainEvent[],
  transfers: new Map<string, TokenTransfer[]>(),
  /** Override the confirmed head's timestamp (unix s); default: now. */
  /** The confirmed head's timestamp. Setting it advances (or rewinds, never below an event) the head. */
  get chainTime(): number {
    return this.genesis + 2 * this.head;
  },
  set chainTime(ts: number | null) {
    if (ts == null) return;
    const lastEvent = Math.max(0, ...this.events.map((e) => e.blockNumber));
    this.head = Math.max(lastEvent, Math.floor((ts - this.genesis) / 2));
  },
  reset(): void {
    this.settled = [];
    this.verified = [];
    this.settleCalls = 0;
    this.verifyBarrier = null;
    this.settleAnswerBarrier = null;
    this.verifyEntered = 0;
    this.settleMode = "ok";
    this.head = 200_000;
    this.genesis = Math.floor(Date.now() / 1000) - 400_000;
    this.events = [];
    this.transfers = new Map();
  },
  /** FiatTokenV2 `_authorizationStates[from][nonce]`: true once used OR canceled. */
  authorizationStateBit(from: string, nonce: string): boolean {
    return this.events.some(
      (e) => e.from === from.toLowerCase() && e.nonce === nonce.toLowerCase(),
    );
  },
  /** `transferWithAuthorization` on the chain: AuthorizationUsed at i, its Transfer at i + 1. */
  chainExecute(args: {
    token: string;
    from: string;
    nonce: string;
    to: string;
    value: bigint;
  }): string {
    return this.chainBatch(args.token, [{ kind: "execute", ...args }]);
  },
  /** `cancelAuthorization` on the chain: AuthorizationCanceled, no transfer. */
  chainCancel(from: string, nonce: string): void {
    this.chainBatch("0x0", [{ kind: "cancel", from, nonce }]);
  },
  /**
   * One transaction carrying several calls to the token, in order (a
   * Multicall3 / smart-wallet / 7702 batch). Each `execute` emits
   * AuthorizationUsed then ITS Transfer (FiatTokenV2's order); each `cancel`
   * emits AuthorizationCanceled; each `transfer` emits a plain Transfer.
   * Log indexes run consecutively through the transaction.
   */
  chainBatch(
    token: string,
    calls: (
      | { kind: "execute"; from: string; nonce: string; to: string; value: bigint }
      | { kind: "cancel"; from: string; nonce: string }
      | { kind: "transfer"; from: string; to: string; value: bigint }
    )[],
  ): string {
    const tx = fakeTx();
    this.head += 1;
    let logIndex = 7; // other transactions' logs precede it in the block
    const transfers: TokenTransfer[] = this.transfers.get(tx) ?? [];
    const t = (from: string, to: string, value: bigint): void => {
      transfers.push({
        token: token.toLowerCase(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        value,
        logIndex: logIndex++,
      });
    };
    for (const c of calls) {
      if (c.kind === "transfer") {
        t(c.from, c.to, c.value);
        continue;
      }
      this.events.push({
        kind: c.kind === "execute" ? "used" : "canceled",
        token: token.toLowerCase(),
        txHash: tx,
        blockNumber: this.head,
        logIndex: logIndex++,
        from: c.from.toLowerCase(),
        nonce: c.nonce.toLowerCase(),
      });
      if (c.kind === "execute") t(c.from, c.to, c.value);
    }
    this.transfers.set(tx, transfers);
    return tx;
  },
};

type Payload = {
  payload: {
    label?: string;
    authorization?: { from: string; to: string; value: string; nonce: string };
  };
};
type Requirements = { amount: string; payTo: string; network: string; asset: string };

function fakeTx(): string {
  return "0x" + randomBytes(32).toString("hex");
}
const labelOf = (p: Payload): string =>
  p.payload.label ?? p.payload.authorization?.from ?? "0xpayer";

const client = {
  getSupported: () =>
    Promise.resolve({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
      extensions: [],
      signers: {},
    }),
  verify: async (p: Payload, req: Requirements) => {
    facilitator.verifyEntered += 1;
    if (facilitator.verifyBarrier) await facilitator.verifyBarrier;
    const payer = labelOf(p);
    facilitator.verified.push({ payer, amount: req.amount, payTo: req.payTo });
    return { isValid: true, payer };
  },
  settle: async (p: Payload, req: Requirements) => {
    facilitator.settleCalls += 1;
    const payer = labelOf(p);
    const mode = facilitator.settleMode;
    if (mode === "hang") return new Promise<never>(() => {});
    if (typeof mode === "object" && "refuse" in mode) {
      return {
        success: false,
        errorReason: mode.refuse,
        transaction: mode.tx === true ? fakeTx() : "",
        network: req.network,
        payer,
      };
    }
    const auth = p.payload.authorization!;
    if (facilitator.authorizationStateBit(auth.from, auth.nonce)) {
      return {
        success: false,
        errorReason: "invalid_exact_evm_nonce_already_used",
        transaction: "",
        network: req.network,
        payer,
      };
    }
    const tx = facilitator.chainExecute({
      token: req.asset,
      from: auth.from,
      nonce: auth.nonce,
      to: auth.to,
      value: BigInt(auth.value),
    });
    facilitator.settled.push({
      payer,
      amount: auth.value,
      payTo: auth.to,
      network: req.network,
      tx,
      nonce: auth.nonce,
    });
    if (mode === "timeout-after-transfer") {
      throw new Error("Timed out while waiting for transaction receipt");
    }
    if (facilitator.settleAnswerBarrier != null) await facilitator.settleAnswerBarrier;
    if (typeof mode === "object" && "network" in mode) {
      return { success: true, transaction: tx, network: mode.network, payer };
    }
    if (typeof mode === "object" && "amount" in mode) {
      return { success: true, transaction: tx, network: req.network, payer, amount: mode.amount };
    }
    return { success: true, transaction: tx, network: req.network, payer };
  },
};

/** The `../x402-facilitator.js` module, with the facilitator replaced. */
export const fakeFacilitatorModule = {
  createX402FacilitatorClient: () => Promise.resolve(client),
};

/**
 * The fake chain behind the relay's `X402ChainReader` port. `lagging` misses
 * every event (a node behind the head); `failing` throws on every read;
 * `readsStateBit` is the WRONG reader — the `authorizationState` bit presented
 * as an execution — kept only so a test can show it credits a cancellation.
 */
export function fakeChainReader(
  opts: {
    lagging?: boolean;
    failing?: boolean;
    receiptQuirkOnce?: boolean;
    /** A node behind the chain: its confirmed head is this block, and it returns nothing past it (Geth clamps silently). */
    headAt?: number;
  } = {},
): X402ChainReader & { reads: number } {
  let quirked = false;
  const reader = {
    reads: 0,
    getConfirmedHead(): Promise<{ number: number; timestamp: number }> {
      reader.reads += 1;
      if (opts.failing) return Promise.reject(new Error("rpc down"));
      const number = opts.headAt ?? facilitator.head;
      return Promise.resolve({ number, timestamp: facilitator.genesis + 2 * number });
    },
    getBlockTimestamp(n: number): Promise<number> {
      if (opts.failing) return Promise.reject(new Error("rpc down"));
      // Two-second blocks ending at the head; block 0 is far in the past.
      return Promise.resolve(facilitator.genesis + 2 * n);
    },
    getAuthorizationEvents(args: {
      authorizer: string;
      nonce: string;
      fromBlock: number;
      toBlock: number;
    }): Promise<AuthorizationEvent[]> {
      reader.reads += 1;
      if (opts.failing) return Promise.reject(new Error("rpc down"));
      if (opts.lagging) return Promise.resolve([]);
      return Promise.resolve(
        facilitator.events
          .filter(
            (e) =>
              e.from === args.authorizer.toLowerCase() &&
              e.nonce === args.nonce.toLowerCase() &&
              e.blockNumber >= args.fromBlock &&
              e.blockNumber <= args.toBlock &&
              e.blockNumber <= (opts.headAt ?? Infinity),
          )
          .map(({ kind, txHash, blockNumber, logIndex }) => ({
            kind,
            txHash,
            blockNumber,
            logIndex,
          })),
      );
    },
    getReceiptLogs(txHash: string): Promise<ReceiptLog[]> {
      if (opts.failing) return Promise.reject(new Error("rpc down"));
      if (opts.receiptQuirkOnce && !quirked) {
        // A node quirk: the first receipt read drops the Transfer log.
        quirked = true;
        return Promise.resolve(receiptLogsOf(txHash).filter((l) => l.topics[0] !== TRANSFER_TOPIC));
      }
      return Promise.resolve(receiptLogsOf(txHash));
    },
  };
  return reader;
}

/** Decode a `PAYMENT-REQUIRED` header. */
export function decodeRequired(header: string): {
  resource: unknown;
  accepts: { amount: string; payTo: string; network: string; asset: string }[];
} {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    resource: unknown;
    accepts: { amount: string; payTo: string; network: string; asset: string }[];
  };
}

/** A deterministic EVM address for a payer label. */
export function addressOf(label: string): string {
  return "0x" + createHash("sha256").update(label).digest("hex").slice(0, 40);
}

/**
 * The client's signing step: an EIP-3009 authorization for the first accepted
 * requirement, from `payer`'s address, with a fresh nonce. `value` overrides
 * the authorized value (a client that signs for a different amount).
 */
export function signPayment(
  requiredHeader: string,
  payer: string,
  opts: {
    nonce?: string;
    validAfter?: number;
    validBefore?: number;
    value?: string;
    to?: string;
  } = {},
): string {
  const required = decodeRequired(requiredHeader);
  const accepted = required.accepts[0]!;
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: {
        label: payer,
        signature: "0x" + "11".repeat(65),
        authorization: {
          from: addressOf(payer),
          to: opts.to ?? accepted.payTo,
          value: opts.value ?? accepted.amount,
          validAfter: String(opts.validAfter ?? now - 600),
          validBefore: String(opts.validBefore ?? now + 300),
          nonce: opts.nonce ?? "0x" + randomBytes(32).toString("hex"),
        },
      },
    }),
  ).toString("base64");
}

/** The authorization inside a signed payment header. */
export function authorizationOf(payment: string): {
  from: string;
  nonce: string;
  to: string;
  value: string;
} {
  const p = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as {
    payload: { authorization: { from: string; nonce: string; to: string; value: string } };
  };
  return p.payload.authorization;
}

/** The token (USDC) contract the relay's route prices in, from a signed payment. */
export function tokenOf(payment: string): string {
  const p = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as {
    accepted: { asset: string };
  };
  return p.accepted.asset;
}

const pad32 = (a: string): string => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

/** A fake transaction's receipt logs, in log order (as a node's receipt lists them). */
export function receiptLogsOf(txHash: string): ReceiptLog[] {
  const logs: { logIndex: number; log: ReceiptLog }[] = [];
  for (const e of facilitator.events) {
    if (e.txHash !== txHash) continue;
    logs.push({
      logIndex: e.logIndex,
      log: {
        address: e.token,
        topics: [
          e.kind === "used" ? AUTHORIZATION_USED_TOPIC : AUTHORIZATION_CANCELED_TOPIC,
          pad32(e.from),
          e.nonce,
        ],
        data: "0x",
      },
    });
  }
  for (const t of facilitator.transfers.get(txHash) ?? []) {
    logs.push({
      logIndex: t.logIndex,
      log: {
        address: t.token,
        topics: [TRANSFER_TOPIC, pad32(t.from), pad32(t.to)],
        data: "0x" + t.value.toString(16).padStart(64, "0"),
      },
    });
  }
  return logs.sort((a, b) => a.logIndex - b.logIndex).map((x) => x.log);
}
