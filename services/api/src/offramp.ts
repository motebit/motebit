/**
 * Fiat off-ramp — crypto → fiat via Bridge.xyz Transfer API.
 *
 * Mirror of onramp.ts. The on-ramp uses Stripe (fiat→crypto); the
 * off-ramp uses Bridge (crypto→fiat). Both are pluggable adapters
 * with the relay as a session broker that never touches the funds.
 *
 * ## Flow
 *
 * 1. User clicks "Withdraw to Bank" in the wallet UX.
 * 2. Surface POSTs to relay `POST /api/v1/offramp/session` with the
 *    motebit's Solana address, amount, and destination bank details.
 * 3. Relay calls Bridge `POST /transfers` with:
 *      source: { payment_rail: "solana", currency: "usdc",
 *                from_address: motebit's Solana address }
 *      destination: { payment_rail: "ach_push", currency: "usd",
 *                     external_account_id: Bridge external account }
 * 4. Bridge returns transfer instructions including a `deposit_address`
 *    (Bridge's Solana address to send USDC to).
 * 5. Relay returns the deposit instructions to the surface.
 * 6. The motebit sends USDC from its wallet to Bridge's deposit address
 *    via wallet-solana (runtime.sendUsdc).
 * 7. Bridge detects the deposit, converts to fiat, ACH's to the user's
 *    bank account.
 * 8. Bridge webhook (already wired at POST /api/v1/bridge/webhook)
 *    confirms completion.
 *
 * ## KYC requirement
 *
 * Bridge requires KYC for fiat destinations. The user must have a
 * Bridge customer account with a linked external bank account. For
 * the MVP, the surface collects the Bridge `external_account_id` from
 * the user (or the user goes through Bridge's hosted KYC flow first).
 * A more polished flow would embed Bridge's KYC widget, but that's
 * a separate UX concern.
 *
 * ## Verified against Bridge API docs
 *
 * Endpoint: POST https://api.bridge.xyz/v0/transfers
 * Auth: Api-Key header + Idempotency-Key header
 * Source: { payment_rail: "solana", currency: "usdc", from_address }
 * Destination: { payment_rail: "ach_push", currency: "usd",
 *                external_account_id }
 * Response: { id, state, source_deposit_instructions: { to_address,
 *             amount, currency } }
 * States: awaiting_funds → funds_received → payment_submitted →
 *         payment_processed (terminal success)
 *
 * See: https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer
 * See: https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer-states
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

// ── Types ─────────────────────────────────────────────────────────────

export interface OfframpSessionRequest {
  /** The motebit this withdrawal is for. */
  motebitId: string;
  /** The motebit's Solana wallet address (source of USDC). */
  sourceAddress: string;
  /** Amount to withdraw in USD. */
  amountUsd: number;
  /**
   * Bridge customer ID. Required — identifies the KYC'd customer
   * whose bank account receives the fiat. In production, this is
   * obtained when the user completes Bridge's KYC flow.
   */
  bridgeCustomerId: string;
  /**
   * Bridge external account ID. Required — identifies the specific
   * bank account to send fiat to. Obtained via Bridge's external
   * accounts API after the customer links a bank account.
   */
  externalAccountId: string;
}

export interface OfframpSession {
  /** Bridge transfer ID. */
  transferId: string;
  /** Current transfer state (initially "awaiting_funds"). */
  state: string;
  /**
   * Bridge's deposit address — where the motebit should send USDC.
   * The surface uses runtime.sendUsdc(depositAddress, amount) to
   * execute this step.
   */
  depositAddress: string;
  /** Amount of USDC to deposit (may differ slightly from requested due to fees). */
  depositAmount: string;
  /** Currency to deposit. Should be "usdc". */
  depositCurrency: string;
  /** Provider identifier. */
  provider: string;
}

export interface OfframpAdapter {
  readonly provider: string;
  createSession(req: OfframpSessionRequest): Promise<OfframpSession>;
}

// ── Bridge off-ramp adapter ───────────────────────────────────────────

export interface BridgeOfframpConfig {
  /** Bridge API key. */
  apiKey: string;
  /** Bridge API base URL. Defaults to "https://api.bridge.xyz/v0". */
  apiBase?: string;
  /** Optional custom fetch for testing. */
  fetch?: typeof globalThis.fetch;
}

export class BridgeOfframpAdapter implements OfframpAdapter {
  readonly provider = "bridge";

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly apiBase: string;

  constructor(config: BridgeOfframpConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? globalThis.fetch;
    this.apiBase = config.apiBase ?? "https://api.bridge.xyz/v0";
  }

  async createSession(req: OfframpSessionRequest): Promise<OfframpSession> {
    // Verified against:
    // https://apidocs.bridge.xyz/platform/orchestration/transfers/transfer
    const body = {
      amount: req.amountUsd.toFixed(2),
      on_behalf_of: req.bridgeCustomerId,
      source: {
        payment_rail: "solana",
        currency: "usdc",
        from_address: req.sourceAddress,
      },
      destination: {
        payment_rail: "ach_push",
        currency: "usd",
        external_account_id: req.externalAccountId,
      },
    };

    const response = await this.fetchFn(`${this.apiBase}/transfers`, {
      method: "POST",
      headers: {
        "Api-Key": this.apiKey,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Bridge API error: HTTP ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      id?: string;
      state?: string;
      source_deposit_instructions?: {
        to_address?: string;
        amount?: string;
        currency?: string;
      };
    };

    if (!data.id) {
      throw new Error("Bridge returned no transfer ID");
    }

    const instructions = data.source_deposit_instructions;
    if (!instructions?.to_address) {
      throw new Error("Bridge returned no deposit address in source_deposit_instructions");
    }

    return {
      transferId: data.id,
      state: data.state ?? "awaiting_funds",
      depositAddress: instructions.to_address,
      depositAmount: instructions.amount ?? req.amountUsd.toFixed(2),
      depositCurrency: instructions.currency ?? "usdc",
      provider: this.provider,
    };
  }
}

// ── Mock adapter ──────────────────────────────────────────────────────

export class MockOfframpAdapter implements OfframpAdapter {
  readonly provider = "mock";

  createSession(req: OfframpSessionRequest): Promise<OfframpSession> {
    return Promise.resolve({
      transferId: `mock_${req.motebitId}_${Date.now()}`,
      state: "awaiting_funds",
      depositAddress: "BridgeMockDepositAddress1111111111111111111111",
      depositAmount: req.amountUsd.toFixed(2),
      depositCurrency: "usdc",
      provider: this.provider,
    });
  }
}

// ── HTTP route registration ──────────────────────────────────────────

export function registerOfframpRoutes(app: Hono, adapter: OfframpAdapter | null): void {
  /** @internal */
  app.post("/api/v1/offramp/session", async (c) => {
    if (!adapter) {
      throw new HTTPException(503, {
        message: "Off-ramp is not configured on this relay",
      });
    }

    let body: {
      motebit_id?: string;
      source_address?: string;
      amount_usd?: number;
      bridge_customer_id?: string;
      external_account_id?: string;
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    if (typeof body.motebit_id !== "string" || body.motebit_id === "") {
      throw new HTTPException(400, { message: "motebit_id is required" });
    }
    if (typeof body.source_address !== "string" || body.source_address === "") {
      throw new HTTPException(400, { message: "source_address is required" });
    }
    if (typeof body.amount_usd !== "number" || body.amount_usd <= 0) {
      throw new HTTPException(400, {
        message: "amount_usd must be a positive number",
      });
    }
    if (typeof body.bridge_customer_id !== "string" || body.bridge_customer_id === "") {
      throw new HTTPException(400, {
        message: "bridge_customer_id is required",
      });
    }
    if (typeof body.external_account_id !== "string" || body.external_account_id === "") {
      throw new HTTPException(400, {
        message: "external_account_id is required",
      });
    }

    try {
      const session = await adapter.createSession({
        motebitId: body.motebit_id,
        sourceAddress: body.source_address,
        amountUsd: body.amount_usd,
        bridgeCustomerId: body.bridge_customer_id,
        externalAccountId: body.external_account_id,
      });

      return c.json({
        transfer_id: session.transferId,
        state: session.state,
        deposit_address: session.depositAddress,
        deposit_amount: session.depositAmount,
        deposit_currency: session.depositCurrency,
        provider: session.provider,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(502, {
        message: `Offramp provider error: ${message}`,
      });
    }
  });
}
