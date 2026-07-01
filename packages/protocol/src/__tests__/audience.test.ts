/**
 * TokenAudience registry tests. Locks the closed vocabulary of `aud`
 * claim values so a new audience can only land via intentional update
 * of both the `TokenAudience` union and the `ALL_TOKEN_AUDIENCES`
 * array, and exercises the `isTokenAudience` guard that verifiers
 * call before dispatch.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_TOKEN_AUDIENCES,
  isTokenAudience,
  SYNC_AUDIENCE,
  DEVICE_AUTH_AUDIENCE,
  PAIR_AUDIENCE,
  ROTATE_KEY_AUDIENCE,
  PUSH_REGISTER_AUDIENCE,
  TASK_SUBMIT_AUDIENCE,
  TASK_QUERY_AUDIENCE,
  TASK_RESULT_AUDIENCE,
  ADMIN_QUERY_AUDIENCE,
  PROPOSAL_AUDIENCE,
  RECEIPTS_READ_AUDIENCE,
  MARKET_LISTING_AUDIENCE,
  CREDENTIALS_AUDIENCE,
  CREDENTIALS_PRESENT_AUDIENCE,
  ACCOUNT_BALANCE_AUDIENCE,
  ACCOUNT_DEPOSIT_AUDIENCE,
  ACCOUNT_WITHDRAW_AUDIENCE,
  ACCOUNT_WITHDRAWALS_AUDIENCE,
  ACCOUNT_CHECKOUT_AUDIENCE,
  BROWSER_SANDBOX_GRANT_AUDIENCE,
  BROWSER_SANDBOX_AUDIENCE,
  RUNTIME_ATTACH_AUDIENCE,
  type TokenAudience,
} from "../audience.js";

describe("ALL_TOKEN_AUDIENCES", () => {
  it("has exactly the twenty-two registered entries", () => {
    expect(ALL_TOKEN_AUDIENCES.length).toBe(22);
  });

  it("enumerates every named constant exactly once", () => {
    const named: TokenAudience[] = [
      SYNC_AUDIENCE,
      DEVICE_AUTH_AUDIENCE,
      PAIR_AUDIENCE,
      ROTATE_KEY_AUDIENCE,
      PUSH_REGISTER_AUDIENCE,
      TASK_SUBMIT_AUDIENCE,
      TASK_QUERY_AUDIENCE,
      TASK_RESULT_AUDIENCE,
      ADMIN_QUERY_AUDIENCE,
      PROPOSAL_AUDIENCE,
      RECEIPTS_READ_AUDIENCE,
      MARKET_LISTING_AUDIENCE,
      CREDENTIALS_AUDIENCE,
      CREDENTIALS_PRESENT_AUDIENCE,
      ACCOUNT_BALANCE_AUDIENCE,
      ACCOUNT_DEPOSIT_AUDIENCE,
      ACCOUNT_WITHDRAW_AUDIENCE,
      ACCOUNT_WITHDRAWALS_AUDIENCE,
      ACCOUNT_CHECKOUT_AUDIENCE,
      BROWSER_SANDBOX_GRANT_AUDIENCE,
      BROWSER_SANDBOX_AUDIENCE,
      RUNTIME_ATTACH_AUDIENCE,
    ];
    expect([...named].sort()).toEqual([...ALL_TOKEN_AUDIENCES].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_TOKEN_AUDIENCES)).toBe(true);
  });
});

describe("isTokenAudience", () => {
  it("narrows every registered audience", () => {
    for (const aud of ALL_TOKEN_AUDIENCES) {
      const value: unknown = aud;
      if (isTokenAudience(value)) {
        const narrowed: TokenAudience = value;
        expect(narrowed).toBe(aud);
      } else {
        throw new Error(`isTokenAudience should have narrowed ${aud}`);
      }
    }
  });

  it("rejects unknown strings", () => {
    expect(isTokenAudience("task:sumbit")).toBe(false); // typo
    expect(isTokenAudience("admin")).toBe(false);
    expect(isTokenAudience("")).toBe(false);
    expect(isTokenAudience("BROWSER_SANDBOX")).toBe(false); // wrong case
  });

  it("rejects non-strings", () => {
    expect(isTokenAudience(0)).toBe(false);
    expect(isTokenAudience(null)).toBe(false);
    expect(isTokenAudience(undefined)).toBe(false);
    expect(isTokenAudience({ aud: "sync" })).toBe(false);
    expect(isTokenAudience(["sync"])).toBe(false);
  });
});
