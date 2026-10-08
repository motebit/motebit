/**
 * R4_MONEY handlers are UNREACHABLE without a runtime capability.
 *
 * The type-aware reference scan in `check-money-authority` (assertion 5) can
 * always be routed around by structural typing: a `Runner` interface in
 * another file with an `execute(name, args)` method, called with the
 * runtime's registry, ran `transfer_funds` with no grant while the gate stayed
 * green. Authority must be a RUNTIME capability, not a static property of the
 * call site: the runtime's registry refuses an R4_MONEY tool unless the call
 * carries a single-use capability that only a gate-decided runtime path mints
 * (bound to the tool name and the exact args). Every spelling below reaches
 * `SimpleToolRegistry.execute` without one, so the handler never runs.
 */
import { describe, it, expect, vi } from "vitest";
import { RiskLevel } from "@motebit/sdk";
import type { DelegationToken, StandingDelegation, ToolDefinition } from "@motebit/sdk";
import {
  generateKeypair,
  bytesToHex,
  signDelegation,
  signStandingDelegation,
} from "@motebit/crypto";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index.js";
import { SimpleToolRegistry } from "../simple-tool-registry.js";
import { ScopedToolRegistry } from "../scoped-tool-registry.js";
import { runIt } from "./fixtures/money-runner.js";

type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };
const HOUR = 3_600_000;
const ID = "worker-money-cap";

const TRANSFER: ToolDefinition = {
  name: "transfer_funds",
  mode: "api",
  description: "Transfer USDC to an address",
  inputSchema: { type: "object", properties: { to: { type: "string" } } },
  riskHint: { risk: RiskLevel.R4_MONEY },
};
const READ: ToolDefinition = {
  name: "read_note",
  mode: "api",
  description: "Read a note",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
};

async function setup() {
  const keys = await generateKeypair();
  const runtime = new MotebitRuntime(
    {
      motebitId: ID,
      tickRateHz: 0,
      signingKeys: keys,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R3_EXECUTE,
        denyAbove: RiskLevel.R4_MONEY,
      },
    },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  const moved = vi.fn(async () => ({ ok: true, data: "moved" }));
  const read = vi.fn(async () => ({ ok: true, data: "note" }));
  runtime.getToolRegistry().register(TRANSFER, moved as never);
  runtime.getToolRegistry().register(READ, read as never);
  return { runtime, keys, moved, read, registry: runtime.getToolRegistry() };
}

async function grant(
  delegator: Kp,
  delegatorId: string,
  delegate: Kp,
  delegateId: string,
  scope = "transfer_funds",
) {
  const now = Date.now();
  const g: StandingDelegation = await signStandingDelegation(
    {
      grant_id: `grant-cap-${crypto.randomUUID()}`,
      delegator_id: delegatorId,
      delegator_public_key: bytesToHex(delegator.publicKey),
      delegate_id: delegateId,
      delegate_public_key: bytesToHex(delegate.publicKey),
      scope,
      subject: "market:self-funded",
      cadence_ms: 24 * HOUR,
      issued_at: now,
      not_before: null,
      expires_at: now + 7 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 10_000_000 },
    },
    delegator.privateKey,
  );
  const token: DelegationToken = await signDelegation(
    {
      delegator_id: g.delegator_id,
      delegator_public_key: g.delegator_public_key,
      delegate_id: g.delegate_id,
      delegate_public_key: g.delegate_public_key,
      scope: g.scope,
      issued_at: now,
      expires_at: now + HOUR,
      grant_id: g.grant_id,
    },
    delegator.privateKey,
  );
  return { grant: g, token };
}

type Exec = (n: string, a: Record<string, unknown>) => Promise<{ ok: boolean }>;
// Meterable (the blast-radius meter prices `amount_micro` to `counterparty`),
// so a refusal below is the capability's, never the meter's.
const ARGS = { counterparty: "attacker", amount_micro: 1_000_000 };

describe("R4_MONEY handler unreachable without the runtime capability", () => {
  const forms: Record<string, (r: SimpleToolRegistry) => Promise<unknown>> = {
    "reviewer's cross-file Runner interface": (r) => runIt(r, "transfer_funds"),
    direct: (r) => r.execute("transfer_funds", ARGS),
    alias: (r) => {
      const e = r.execute.bind(r);
      return e("transfer_funds", ARGS);
    },
    bind: (r) => r.execute.bind(r)("transfer_funds", ARGS),
    call: (r) => r.execute.call(r, "transfer_funds", ARGS),
    apply: (r) => r.execute.apply(r, ["transfer_funds", ARGS]),
    callback: (r) => {
      const run = (f: Exec) => f("transfer_funds", ARGS);
      return run((n, a) => r.execute(n, a));
    },
    destructure: (r) => {
      const { execute } = r;
      return execute.call(r, "transfer_funds", ARGS);
    },
    "prototype method": (r) => SimpleToolRegistry.prototype.execute.call(r, "transfer_funds", ARGS),
    "merge into another registry": (r) => {
      const other = new SimpleToolRegistry();
      other.merge(r);
      return other.execute("transfer_funds", ARGS);
    },
    "scoped wrapper": (r) =>
      new ScopedToolRegistry(r, { allows: () => true }).execute("transfer_funds", ARGS),
    "forged capability on the call": (r) =>
      r.execute("transfer_funds", ARGS, {
        moneyCapability: Object.freeze({}),
      } as never),
    "private handler map": async (r) => {
      const map = (r as unknown as Record<string, unknown>)["tools"] as
        Map<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }> | undefined;
      return map?.get("transfer_funds")?.handler(ARGS) ?? { ok: false };
    },
  };

  for (const [form, run] of Object.entries(forms)) {
    it(`refuses at runtime: ${form}`, async () => {
      const { registry, moved } = await setup();
      const result = (await run(registry)) as { ok?: boolean } | undefined;
      expect(result?.ok).not.toBe(true);
      expect(moved).not.toHaveBeenCalled();
    });
  }

  it("a non-money tool still executes raw (MCP executeTool / services unaffected)", async () => {
    const { registry, read } = await setup();
    const result = await registry.execute("read_note", {});
    expect(result.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("the gated owner path with the owner's own grant still moves money, exactly once", async () => {
    const { runtime, keys, moved } = await setup();
    const g = await grant(keys, ID, keys, ID);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(true);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("the gated path without a grant refuses (no capability is minted for a refused call)", async () => {
    const { runtime, moved } = await setup();
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
    });
    expect(result.ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });
});

describe("a grant's delegator must be this runtime's own identity", () => {
  it("a stranger's SELF-ISSUED grant (delegator = delegate = stranger) authorizes nothing", async () => {
    const { runtime, moved } = await setup();
    const stranger = await generateKeypair();
    const g = await grant(stranger, "stranger", stranger, "stranger");
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: {
        principal: "foreign",
        identity: { motebitId: "stranger", publicKeyHex: bytesToHex(stranger.publicKey) },
      },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });

  it("a stranger-issued grant naming THIS motebit as delegate authorizes nothing on the owner path", async () => {
    const { runtime, keys, moved } = await setup();
    const stranger = await generateKeypair();
    const g = await grant(stranger, "stranger", keys, ID);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });

  it("an impostor reusing this motebit's id as delegator with another key authorizes nothing", async () => {
    const { runtime, moved } = await setup();
    const stranger = await generateKeypair();
    const g = await grant(stranger, ID, stranger, "stranger");
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: {
        principal: "foreign",
        identity: { motebitId: "stranger", publicKeyHex: bytesToHex(stranger.publicKey) },
      },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });

  it("the owner's grant to a true delegate still runs for that delegate", async () => {
    const { runtime, keys, moved } = await setup();
    const delegate = await generateKeypair();
    const g = await grant(keys, ID, delegate, "delegate-d");
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: {
        principal: "foreign",
        identity: { motebitId: "delegate-d", publicKeyHex: bytesToHex(delegate.publicKey) },
      },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(true);
    expect(moved).toHaveBeenCalledTimes(1);
  });
});

describe("a runtime that holds only its identity PUBLIC key (the CLI's shape)", () => {
  function keyless(pubHex: string | undefined) {
    const runtime = new MotebitRuntime(
      {
        motebitId: ID,
        tickRateHz: 0,
        ...(pubHex != null ? { identityPublicKeyHex: pubHex } : {}),
        policy: {
          operatorMode: true,
          maxRiskLevel: RiskLevel.R4_MONEY,
          requireApprovalAbove: RiskLevel.R3_EXECUTE,
          denyAbove: RiskLevel.R4_MONEY,
        },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    const moved = vi.fn(async () => ({ ok: true, data: "moved" }));
    runtime.getToolRegistry().register(TRANSFER, moved as never);
    return { runtime, moved };
  }

  it("its own self-grant verifies via identityPublicKeyHex", async () => {
    const keys = await generateKeypair();
    const { runtime, moved } = keyless(bytesToHex(keys.publicKey).toUpperCase());
    const g = await grant(keys, ID, keys, ID);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(true);
    expect(moved).toHaveBeenCalledTimes(1);
  });

  it("knowing no identity key, no grant confers authority (fail closed)", async () => {
    const keys = await generateKeypair();
    const { runtime, moved } = keyless(undefined);
    const g = await grant(keys, ID, keys, ID);
    const result = await runtime.executeToolGated("transfer_funds", ARGS, {
      caller: { principal: "owner" },
      delegation: { token: g.token, grant: g.grant, revocations: [] },
    });
    expect(result.ok).toBe(false);
    expect(moved).not.toHaveBeenCalled();
  });

  it("a declared key that contradicts signingKeys is refused at construction", async () => {
    const keys = await generateKeypair();
    const other = await generateKeypair();
    expect(
      () =>
        new MotebitRuntime(
          {
            motebitId: ID,
            tickRateHz: 0,
            signingKeys: keys,
            identityPublicKeyHex: bytesToHex(other.publicKey),
          },
          { storage: createInMemoryStorage(), renderer: new NullRenderer() },
        ),
    ).toThrow(/identityPublicKeyHex/);
  });
});
