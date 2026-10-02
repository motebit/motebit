import { describe, it, expect } from "vitest";
import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { proofLadder, type RelayContext, type Rung } from "../ladder.js";

const OFFLINE: RelayContext = { kind: "offline", reason: "offline — sample" };
const RESOLVED: RelayContext = { kind: "resolved" };
const v = (over: Partial<ReceiptDocumentVerification>): ReceiptDocumentVerification => ({
  integrity: true,
  binding: "integrity-only",
  ...over,
});
const rung = (rs: Rung[], key: Rung["key"]): Rung => rs.find((r) => r.key === key)!;

describe("proofLadder", () => {
  it("always returns the three rungs, in order", () => {
    expect(proofLadder(v({}), OFFLINE).map((r) => r.key)).toEqual([
      "integrity",
      "binding",
      "revocation",
    ]);
  });

  it("integrity: passed / failed (with the verifier's detail)", () => {
    expect(rung(proofLadder(v({}), OFFLINE), "integrity").state).toBe("passed");
    const failed = rung(
      proofLadder(v({ integrity: false, binding: "unverified", detail: "bad sig" }), OFFLINE),
      "integrity",
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("bad sig");
  });

  it("binding: each passed level maps from the verifier's binding", () => {
    for (const level of ["pinned", "anchored", "sovereign"] as const) {
      const r = rung(proofLadder(v({ binding: level }), RESOLVED), "binding");
      expect(r.state).toBe("passed");
      expect(r.level).toBe(level);
      expect(r.summary.startsWith(level)).toBe(true);
    }
    const anchored = rung(
      proofLadder(v({ binding: "anchored", anchorTxHash: "TX" }), RESOLVED),
      "binding",
    );
    expect(anchored.summary).toContain("TX");
  });

  it("sovereign is stated as a math binding, not trust", () => {
    const r = rung(proofLadder(v({ binding: "sovereign" }), OFFLINE), "binding");
    expect(r.summary).toContain("not a statement of trust");
  });

  it("binding: integrity-only is never failed and always says why (per context)", () => {
    const off = rung(proofLadder(v({}), OFFLINE), "binding");
    expect(off.state).toBe("skipped");
    expect(off.level).toBeUndefined();
    expect(off.summary).toContain("offline — sample");
    const un = rung(proofLadder(v({}), { kind: "unavailable", reason: "relay down" }), "binding");
    expect(un.summary).toContain("relay down");
    const res = rung(proofLadder(v({}), RESOLVED), "binding");
    expect(res.summary).toContain("does not bind this key");
    const nested = rung(proofLadder(v({}), { kind: "nested" }), "binding");
    expect(nested.summary).toContain("nested receipts");
  });

  it("binding: revoked → failed; integrity failure → not checked", () => {
    expect(rung(proofLadder(v({ binding: "revoked" }), RESOLVED), "binding").state).toBe("failed");
    const r = rung(proofLadder(v({ integrity: false, binding: "unverified" }), OFFLINE), "binding");
    expect(r.state).toBe("skipped");
    expect(r.summary).toBe("not checked: integrity failed");
  });

  it("revocation: every state maps strictly from the verifier", () => {
    const rev = (over: Partial<ReceiptDocumentVerification>, ctx: RelayContext = RESOLVED) =>
      rung(proofLadder(v(over), ctx), "revocation");
    expect(rev({ revocation: "not_revoked" }).state).toBe("passed");
    const later = rev({ revocation: "revoked_after_signing", revokedAt: 3000 });
    expect(later.state).toBe("passed");
    expect(later.summary).toContain("revoked later");
    const bad = rev({ binding: "revoked", revocation: "revoked", revokedAt: 1500 });
    expect(bad.state).toBe("failed");
    expect(bad.summary).toContain("1970-01-01T00:00:01.500Z");
    const unk = rev({ revocation: "unknown", revocationDetail: "rpc down" });
    expect(unk.state).toBe("skipped");
    expect(unk.summary).toContain("rpc down");
    // Absent ⇒ not checked, never "passed".
    expect(rev({}, OFFLINE).state).toBe("skipped");
    expect(rev({}, OFFLINE).summary).toBe("not checked: offline — sample");
    expect(rev({}, { kind: "nested" }).summary).toContain("nested receipts");
    expect(rev({ integrity: false, binding: "unverified" }, OFFLINE).summary).toBe(
      "not checked: integrity failed",
    );
  });
});
