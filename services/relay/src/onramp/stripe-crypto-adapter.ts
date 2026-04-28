/**
 * StripeCryptoOnrampAdapter — OnrampAdapter backed by
 * Stripe's Crypto Onramp API.
 *
 * ## Why this adapter lives here
 *
 * Per `services/relay/CLAUDE.md` rule 1 the relay must never inline
 * protocol plumbing; rule 13 extends that to medium plumbing. The
 * `OnrampAdapter` interface itself stays in `../onramp.ts` because it
 * is the shared vocabulary the route handler speaks. The Stripe-backed
 * implementation moves here so route handling, adapter composition,
 * and Stripe HTTP plumbing each live in their own file.
 *
 * The adapter never touches `fetch` itself — it depends on a
 * `StripeCryptoClient` injected via config. Tests substitute a fake
 * client, not a fake `fetch`. The concrete `HttpStripeCryptoClient`
 * ships next to this module in `./stripe-crypto-client.ts`.
 */

import type { OnrampAdapter, OnrampSession, OnrampSessionRequest } from "../onramp.js";
import type { StripeCryptoClient } from "./stripe-crypto-client.js";

export interface StripeCryptoOnrampAdapterConfig {
  /**
   * The Stripe Crypto Onramp client. In production this is an
   * `HttpStripeCryptoClient` constructed from the relay's Stripe
   * secret key. In tests it is a stub that returns canned responses.
   */
  client: StripeCryptoClient;
}

/**
 * Concrete `OnrampAdapter` backed by Stripe's Crypto Onramp API.
 *
 * The adapter's only job is translation: `OnrampSessionRequest` →
 * `StripeCryptoOnrampSessionParams` on the way in,
 * `StripeCryptoOnrampSession` → `OnrampSession` on the way out. It
 * never sees Stripe's wire format directly; that lives in the client.
 */
export class StripeCryptoOnrampAdapter implements OnrampAdapter {
  readonly provider = "stripe-crypto-onramp";

  private readonly client: StripeCryptoClient;

  constructor(config: StripeCryptoOnrampAdapterConfig) {
    this.client = config.client;
  }

  async createSession(req: OnrampSessionRequest): Promise<OnrampSession> {
    // Stripe's session metadata is a flat string map. We always
    // attach `motebit_id` for audit; any caller-supplied metadata
    // is merged on top but cannot shadow the motebit_id field —
    // declaring it second would let a caller overwrite the audit
    // key, so we set it last.
    const metadata: Record<string, string> = { ...(req.metadata ?? {}) };
    metadata.motebit_id = req.motebitId;

    const session = await this.client.createCryptoOnrampSession({
      walletAddress: req.destinationAddress,
      destinationNetwork: req.destinationNetwork,
      destinationCurrency: req.destinationCurrency,
      sourceAmountUsd: req.amountUsd,
      metadata,
    });

    return {
      sessionId: session.sessionId,
      redirectUrl: session.redirectUrl,
      provider: this.provider,
    };
  }
}
