import { describe, it, expect } from "vitest";
import { inferX402FacilitatorMode, X402ConfigError } from "../x402-facilitator.js";

describe("inferX402FacilitatorMode", () => {
  describe("default (testnet) mode", () => {
    it("returns the configured facilitator URL when no CDP creds present", () => {
      const mode = inferX402FacilitatorMode(
        {
          testnet: true,
          facilitatorUrl: "https://x402.org/facilitator",
          network: "eip155:84532",
        },
        {} as NodeJS.ProcessEnv,
      );
      expect(mode).toEqual({
        type: "default",
        url: "https://x402.org/facilitator",
      });
    });

    it("falls back to the public testnet facilitator when no URL configured", () => {
      const mode = inferX402FacilitatorMode(
        { testnet: true, network: "eip155:84532" },
        {} as NodeJS.ProcessEnv,
      );
      expect(mode).toEqual({
        type: "default",
        url: "https://x402.org/facilitator",
      });
    });
  });

  describe("CDP mode (production)", () => {
    it("uses CDP when both API key id and secret are set", () => {
      const mode = inferX402FacilitatorMode({ testnet: false, network: "eip155:8453" }, {
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "key-secret",
      } as NodeJS.ProcessEnv);
      expect(mode).toEqual({
        type: "cdp",
        url: "https://api.cdp.coinbase.com/platform/v2/x402",
      });
    });

    it("uses CDP even on testnet when CDP creds are present (developer with creds in shell)", () => {
      const mode = inferX402FacilitatorMode({ testnet: true, network: "eip155:84532" }, {
        CDP_API_KEY_ID: "key-id",
        CDP_API_KEY_SECRET: "key-secret",
      } as NodeJS.ProcessEnv);
      // CDP supports testnets too (Base Sepolia, Solana Devnet, etc.) — when
      // the operator has CDP creds exported, hit the production facilitator
      // regardless. The CDP facilitator handles testnet networks correctly.
      expect(mode.type).toBe("cdp");
    });
  });

  describe("fail-fast on mainnet misconfiguration", () => {
    it("throws X402ConfigError on testnet=false without any CDP creds", () => {
      expect(() =>
        inferX402FacilitatorMode(
          { testnet: false, network: "eip155:8453" },
          {} as NodeJS.ProcessEnv,
        ),
      ).toThrow(X402ConfigError);
    });

    it("throws X402ConfigError when only the API key id is set (half-credentials)", () => {
      expect(() =>
        inferX402FacilitatorMode({ testnet: false, network: "eip155:8453" }, {
          CDP_API_KEY_ID: "key-id",
        } as NodeJS.ProcessEnv),
      ).toThrow(X402ConfigError);
    });

    it("throws X402ConfigError when only the secret is set (half-credentials)", () => {
      expect(() =>
        inferX402FacilitatorMode({ testnet: false, network: "eip155:8453" }, {
          CDP_API_KEY_SECRET: "key-secret",
        } as NodeJS.ProcessEnv),
      ).toThrow(X402ConfigError);
    });

    it("error message names the network and points operator at portal.cdp.coinbase.com", () => {
      let caught: unknown;
      try {
        inferX402FacilitatorMode(
          { testnet: false, network: "eip155:8453" },
          {} as NodeJS.ProcessEnv,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(X402ConfigError);
      expect((caught as Error).message).toContain("eip155:8453");
      expect((caught as Error).message).toContain("CDP_API_KEY_ID");
      expect((caught as Error).message).toContain("CDP_API_KEY_SECRET");
      expect((caught as Error).message).toContain("portal.cdp.coinbase.com");
      expect((caught as Error).message).toContain("X402_TESTNET=true");
    });
  });

  describe("X402ConfigError type", () => {
    it("has a distinguishable name property for instanceof checks", () => {
      const err = new X402ConfigError("test");
      expect(err.name).toBe("X402ConfigError");
      expect(err instanceof Error).toBe(true);
      expect(err instanceof X402ConfigError).toBe(true);
    });
  });
});
