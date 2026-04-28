/**
 * StripeCryptoOnrampAdapter — adapter-layer tests.
 *
 * These tests verify the adapter's translation responsibility: it takes
 * an `OnrampSessionRequest` (motebit vocabulary), calls the injected
 * `StripeCryptoClient` with motebit-shaped params, and returns a motebit
 * `OnrampSession` stamped with the provider identifier. The adapter
 * owns none of the Stripe HTTP surface — that is exercised separately
 * in `stripe-crypto-client.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { StripeCryptoOnrampAdapter } from "../onramp/stripe-crypto-adapter.js";
import type {
  StripeCryptoClient,
  StripeCryptoOnrampSession,
  StripeCryptoOnrampSessionParams,
} from "../onramp/stripe-crypto-client.js";

interface StubBuild {
  client: StripeCryptoClient;
  createSessionMock: ReturnType<typeof vi.fn>;
}

function makeStubClient(
  response: StripeCryptoOnrampSession = {
    sessionId: "cos_test",
    redirectUrl: "https://crypto.link.com/checkout/cos_test",
  },
): StubBuild {
  const createSessionMock = vi.fn(
    async (_params: StripeCryptoOnrampSessionParams): Promise<StripeCryptoOnrampSession> =>
      response,
  );
  const client: StripeCryptoClient = {
    createCryptoOnrampSession: createSessionMock,
  };
  return { client, createSessionMock };
}

describe("StripeCryptoOnrampAdapter", () => {
  it("identifies itself as stripe-crypto-onramp", () => {
    const { client } = makeStubClient();
    const adapter = new StripeCryptoOnrampAdapter({ client });
    expect(adapter.provider).toBe("stripe-crypto-onramp");
  });

  it("translates OnrampSessionRequest into motebit-shaped client params", async () => {
    const { client, createSessionMock } = makeStubClient();
    const adapter = new StripeCryptoOnrampAdapter({ client });

    await adapter.createSession({
      motebitId: "alice-mote",
      destinationAddress: "AliceSolanaAddress",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      amountUsd: 25,
    });

    expect(createSessionMock).toHaveBeenCalledOnce();
    const params = createSessionMock.mock.calls[0]![0] as StripeCryptoOnrampSessionParams;
    expect(params.walletAddress).toBe("AliceSolanaAddress");
    expect(params.destinationNetwork).toBe("solana");
    expect(params.destinationCurrency).toBe("usdc");
    expect(params.sourceAmountUsd).toBe(25);
    // Audit key is always attached.
    expect(params.metadata.motebit_id).toBe("alice-mote");
  });

  it("omits sourceAmountUsd when amountUsd is not provided", async () => {
    const { client, createSessionMock } = makeStubClient();
    const adapter = new StripeCryptoOnrampAdapter({ client });

    await adapter.createSession({
      motebitId: "m",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
    });

    const params = createSessionMock.mock.calls[0]![0] as StripeCryptoOnrampSessionParams;
    expect(params.sourceAmountUsd).toBeUndefined();
  });

  it("maps client response into motebit OnrampSession shape with provider id", async () => {
    const { client } = makeStubClient({
      sessionId: "cos_abc",
      redirectUrl: "https://crypto.link.com/checkout/cos_abc",
    });
    const adapter = new StripeCryptoOnrampAdapter({ client });

    const session = await adapter.createSession({
      motebitId: "m",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
    });

    expect(session).toEqual({
      sessionId: "cos_abc",
      redirectUrl: "https://crypto.link.com/checkout/cos_abc",
      provider: "stripe-crypto-onramp",
    });
  });

  it("forwards caller-supplied metadata and always stamps motebit_id", async () => {
    const { client, createSessionMock } = makeStubClient();
    const adapter = new StripeCryptoOnrampAdapter({ client });

    await adapter.createSession({
      motebitId: "alice",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { source: "web-ui", campaign: "launch" },
    });

    const params = createSessionMock.mock.calls[0]![0] as StripeCryptoOnrampSessionParams;
    expect(params.metadata).toEqual({
      source: "web-ui",
      campaign: "launch",
      motebit_id: "alice",
    });
  });

  it("prevents a caller from shadowing the motebit_id audit key via metadata", async () => {
    const { client, createSessionMock } = makeStubClient();
    const adapter = new StripeCryptoOnrampAdapter({ client });

    await adapter.createSession({
      motebitId: "real-id",
      destinationAddress: "addr",
      destinationNetwork: "solana",
      destinationCurrency: "usdc",
      metadata: { motebit_id: "spoofed-id" },
    });

    const params = createSessionMock.mock.calls[0]![0] as StripeCryptoOnrampSessionParams;
    expect(params.metadata.motebit_id).toBe("real-id");
  });

  it("propagates client errors to the caller unchanged", async () => {
    const client: StripeCryptoClient = {
      createCryptoOnrampSession: () => Promise.reject(new Error("stripe is down")),
    };
    const adapter = new StripeCryptoOnrampAdapter({ client });

    await expect(
      adapter.createSession({
        motebitId: "m",
        destinationAddress: "addr",
        destinationNetwork: "solana",
        destinationCurrency: "usdc",
      }),
    ).rejects.toThrow(/stripe is down/);
  });
});
