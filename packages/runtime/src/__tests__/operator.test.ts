import { describe, it, expect, vi } from "vitest";
import { setOperatorMode, setupOperatorPin, resetOperatorPin } from "../operator.js";

// === Mock Dependencies ===

class MockKeyring {
  private store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

class MockPolicyGate {
  operatorMode = false;
  setOperatorMode(enabled: boolean) {
    this.operatorMode = enabled;
  }
}

function makeDeps(keyring: MockKeyring | null = new MockKeyring()) {
  const policy = new MockPolicyGate();
  const onPolicyChanged = vi.fn();
  return {
    deps: { keyring, policy: policy as any, onPolicyChanged },
    policy,
    keyring,
    onPolicyChanged,
  };
}

// === Tests ===

describe("setOperatorMode", () => {
  it("disabling always succeeds without PIN", async () => {
    const { deps, policy, onPolicyChanged } = makeDeps();
    const result = await setOperatorMode(deps, false);
    expect(result).toEqual({ success: true });
    expect(policy.operatorMode).toBe(false);
    expect(onPolicyChanged).toHaveBeenCalledOnce();
  });

  it("enabling without keyring succeeds (dev mode fallback)", async () => {
    const { deps, policy, onPolicyChanged } = makeDeps(null);
    const result = await setOperatorMode(deps, true);
    expect(result).toEqual({ success: true });
    expect(policy.operatorMode).toBe(true);
    expect(onPolicyChanged).toHaveBeenCalledOnce();
  });

  it("enabling when no PIN is set up returns needsSetup", async () => {
    const { deps } = makeDeps();
    const result = await setOperatorMode(deps, true, "1234");
    expect(result).toEqual({ success: false, needsSetup: true });
  });

  it("enabling with wrong PIN returns error", async () => {
    const { deps, keyring } = makeDeps();
    await setupOperatorPin(keyring, "1234");
    const result = await setOperatorMode(deps, true, "9999");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Incorrect PIN");
  });

  it("enabling with correct PIN returns success", async () => {
    const { deps, keyring, policy, onPolicyChanged } = makeDeps();
    await setupOperatorPin(keyring, "1234");
    const result = await setOperatorMode(deps, true, "1234");
    expect(result).toEqual({ success: true });
    expect(policy.operatorMode).toBe(true);
    expect(onPolicyChanged).toHaveBeenCalled();
  });

  it("enabling without providing a PIN returns error", async () => {
    const { deps, keyring } = makeDeps();
    await setupOperatorPin(keyring, "1234");
    const result = await setOperatorMode(deps, true);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PIN required");
  });

  it("locks out after 5 failed attempts with lockedUntil timestamp", async () => {
    const { deps, keyring } = makeDeps();
    await setupOperatorPin(keyring, "1234");

    // Fail 5 times
    for (let i = 0; i < 5; i++) {
      const r = await setOperatorMode(deps, true, "0000");
      expect(r.success).toBe(false);
      expect(r.error).toBe("Incorrect PIN");
    }

    // 6th attempt should be locked out
    const locked = await setOperatorMode(deps, true, "0000");
    expect(locked.success).toBe(false);
    expect(locked.error).toBe("Too many failed attempts");
    expect(locked.lockedUntil).toBeTypeOf("number");
    expect(locked.lockedUntil!).toBeGreaterThan(Date.now());
  });

  it("lockout durations are exponential: 30s, 5m, 30m", async () => {
    const { deps, keyring } = makeDeps();
    await setupOperatorPin(keyring, "5678");

    // Helper: fail N times, then check the lockedUntil relative to now
    // We mock Date.now to control time for predictable lockout windows.
    const realNow = Date.now;
    let fakeTime = realNow.call(Date);
    vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

    try {
      // Accumulate 5 failures (no lockout yet on these)
      for (let i = 0; i < 5; i++) {
        await setOperatorMode(deps, true, "0000");
      }
      // 6th attempt triggers first lockout window (30s)
      const r1 = await setOperatorMode(deps, true, "0000");
      expect(r1.lockedUntil).toBeDefined();
      expect(r1.lockedUntil! - fakeTime).toBeLessThanOrEqual(30_000);

      // Advance past the 30s lockout
      fakeTime += 31_000;

      // Fail again (attempt count now 6), triggers 5m lockout window
      await setOperatorMode(deps, true, "0000");
      const r2 = await setOperatorMode(deps, true, "0000");
      expect(r2.lockedUntil).toBeDefined();
      expect(r2.lockedUntil! - fakeTime).toBeLessThanOrEqual(5 * 60_000);
      expect(r2.lockedUntil! - fakeTime).toBeGreaterThan(30_000);

      // Advance past 5m lockout
      fakeTime += 5 * 60_000 + 1_000;

      // Fail again, triggers 30m lockout window
      await setOperatorMode(deps, true, "0000");
      const r3 = await setOperatorMode(deps, true, "0000");
      expect(r3.lockedUntil).toBeDefined();
      expect(r3.lockedUntil! - fakeTime).toBeLessThanOrEqual(30 * 60_000);
      expect(r3.lockedUntil! - fakeTime).toBeGreaterThan(5 * 60_000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("successful auth clears the attempt counter", async () => {
    const { deps, keyring } = makeDeps();
    await setupOperatorPin(keyring, "1234");

    // Fail 4 times (one short of lockout)
    for (let i = 0; i < 4; i++) {
      await setOperatorMode(deps, true, "0000");
    }

    // Succeed — should clear counter
    const ok = await setOperatorMode(deps, true, "1234");
    expect(ok.success).toBe(true);

    // Disable, then fail 4 more times — should NOT lock out
    // (counter was cleared by the success above)
    await setOperatorMode(deps, false);
    for (let i = 0; i < 4; i++) {
      const r = await setOperatorMode(deps, true, "0000");
      expect(r.error).toBe("Incorrect PIN");
    }

    // 5th failure after reset — still not locked yet
    const r5 = await setOperatorMode(deps, true, "0000");
    expect(r5.error).toBe("Incorrect PIN");
    expect(r5.lockedUntil).toBeUndefined();
  });
});

describe("setupOperatorPin", () => {
  it("throws without keyring", async () => {
    await expect(setupOperatorPin(null, "1234")).rejects.toThrow("Keyring not available");
  });

  it("rejects non-digit PINs", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "abc")).rejects.toThrow("PIN must be 4-6 digits");
    await expect(setupOperatorPin(keyring, "ab12")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("rejects PINs shorter than 4 digits", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "123")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("rejects PINs longer than 6 digits", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "1234567")).rejects.toThrow("PIN must be 4-6 digits");
  });

  it("accepts valid 4-digit PIN", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "1234")).resolves.toBeUndefined();
    const stored = await keyring.get("operator_pin_hash");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("accepts valid 5-digit PIN", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "12345")).resolves.toBeUndefined();
  });

  it("accepts valid 6-digit PIN", async () => {
    const keyring = new MockKeyring();
    await expect(setupOperatorPin(keyring, "123456")).resolves.toBeUndefined();
  });
});

describe("resetOperatorPin", () => {
  it("throws without keyring", async () => {
    const policy = new MockPolicyGate();
    const onPolicyChanged = vi.fn();
    await expect(
      resetOperatorPin({ keyring: null, policy: policy as any, onPolicyChanged }),
    ).rejects.toThrow("Keyring not available");
  });

  it("clears PIN hash, clears attempts, and disables operator mode", async () => {
    const { deps, keyring, policy, onPolicyChanged } = makeDeps();

    // Set up PIN and enable operator mode
    await setupOperatorPin(keyring, "1234");
    await setOperatorMode(deps, true, "1234");
    expect(policy.operatorMode).toBe(true);

    // Fail a few times to accumulate attempts
    await setOperatorMode(deps, false);
    await setOperatorMode(deps, true, "0000");
    await setOperatorMode(deps, true, "0000");

    // Reset
    await resetOperatorPin(deps);

    expect(policy.operatorMode).toBe(false);
    expect(onPolicyChanged).toHaveBeenCalled();

    // PIN hash should be gone
    const hash = await keyring!.get("operator_pin_hash");
    expect(hash).toBeNull();

    // Attempts should be gone
    const attempts = await keyring!.get("operator_pin_attempts");
    expect(attempts).toBeNull();

    // Enabling should now require setup again
    const result = await setOperatorMode(deps, true, "1234");
    expect(result).toEqual({ success: false, needsSetup: true });
  });
});
