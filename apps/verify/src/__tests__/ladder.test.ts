import { describe, it, expect } from "vitest";
import { proofLadder, type RelayContext, type Rung } from "../ladder.js";
import { PROXY_LABEL, type DisplayVerdict } from "../assess.js";

const OFFLINE: RelayContext = { kind: "offline", reason: "offline — sample" };
const RESOLVED: RelayContext = { kind: "resolved" };
const v = (over: Partial<DisplayVerdict>): DisplayVerdict => ({
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

  it("binding: pinned and anchored map to a passed level", () => {
    for (const level of ["pinned", "anchored"] as const) {
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
    expect(anchored.summary).toContain("independent RPC");
  });

  it("binding: a key commitment is never ✓ and says rotation and revocation are not established", () => {
    for (const ctx of [OFFLINE, RESOLVED]) {
      const r = rung(proofLadder(v({ binding: "key-commitment" }), ctx), "binding");
      expect(r.state).toBe("skipped");
      expect(r.level).toBeUndefined();
      expect(r.summary).toContain(
        "identity commitment matches the motebit's original key; rotation and revocation not established",
      );
      expect(r.summary).not.toMatch(/sovereign/i);
    }
    const ran = rung(
      proofLadder(v({ binding: "key-commitment", chainCheck: "not_active" }), RESOLVED),
      "binding",
    );
    expect(ran.state).toBe("skipped");
    expect(ran.summary).toContain("does not bind it at the time this receipt claims");
    expect(ran.summary).not.toMatch(/no succession check ran|hash of this key/);
  });

  it("binding: pinned states the chain root and never 'sovereign'", () => {
    const sov = rung(
      proofLadder(v({ binding: "pinned", chainRoot: "id-commitment" }), RESOLVED),
      "binding",
    );
    expect(sov.summary).toContain("roots at the key this motebit_id commits to");
    const leg = rung(
      proofLadder(v({ binding: "pinned", chainRoot: "relay-record" }), RESOLVED),
      "binding",
    );
    expect(leg.summary).toContain("the root is the relay's record");
    expect(`${sov.summary} ${leg.summary}`).not.toMatch(/sovereign/i);
  });

  it("binding: pinned with a proxy-read anchor carries the proxy label", () => {
    const r = rung(
      proofLadder(v({ binding: "pinned", anchorViaProxy: true }), RESOLVED),
      "binding",
    );
    expect(r.level).toBe("pinned");
    expect(r.summary).toContain(PROXY_LABEL);
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
    const fg = rung(proofLadder(v({ chainCheck: "recovery_unverifiable" }), RESOLVED), "binding");
    expect(fg.summary).toContain("guardian-recovery link");
    const nested = rung(proofLadder(v({}), { kind: "nested" }), "binding");
    expect(nested.summary).toContain("nested receipts");
  });

  it("binding: revoked → not established (—, never ✗); integrity failure → not checked", () => {
    const rev = rung(proofLadder(v({ binding: "revoked" }), RESOLVED), "binding");
    expect(rev.state).toBe("skipped");
    expect(rev.summary).toContain("not established");
    const r = rung(proofLadder(v({ integrity: false, binding: "unverified" }), OFFLINE), "binding");
    expect(r.state).toBe("skipped");
    expect(r.summary).toBe("not checked: integrity failed");
  });

  it("revocation: every display state maps strictly", () => {
    const rev = (over: Partial<DisplayVerdict>, ctx: RelayContext = RESOLVED) =>
      rung(proofLadder(v(over), ctx), "revocation");
    expect(rev({ revocation: "not_revoked" }).state).toBe("passed");
    const bad = rev({
      binding: "revoked",
      revocation: "revoked",
      revokedAt: 1500,
      chainSource: "independent",
    });
    expect(bad.state).toBe("failed");
    expect(bad.summary).toContain("1970-01-01T00:00:01.500Z");
    expect(bad.summary).toContain("REVOCATION REPORTED (unauthenticated)");
    expect(bad.summary).toContain("through an RPC the operator does not run");
    expect(bad.summary).not.toMatch(/revoked on-chain/);
    expect(bad.summary).not.toContain(PROXY_LABEL);
    const badProxy = rev({
      binding: "revoked",
      revocation: "revoked",
      revokedAt: 1500,
      chainSource: "operator-proxy",
    });
    expect(badProxy.state).toBe("failed");
    expect(badProxy.summary).toContain(PROXY_LABEL);
    const ne = rev({ revocation: "not_established", revocationNote: "rpc down" });
    expect(ne.state).toBe("skipped");
    expect(ne.summary).toBe("not established: rpc down");
    // Absent ⇒ not checked, never "passed".
    expect(rev({}, OFFLINE).state).toBe("skipped");
    expect(rev({}, OFFLINE).summary).toBe("not checked: offline — sample");
    expect(rev({}, { kind: "nested" }).summary).toContain("nested receipts");
    expect(rev({ integrity: false, binding: "unverified" }, OFFLINE).summary).toBe(
      "not checked: integrity failed",
    );
  });
});

describe("canonical form (round 4)", () => {
  it("the binding rung names each field not in canonical form", () => {
    const b = rung(proofLadder(v({ noncanonical: ["public_key", "suite"] }), RESOLVED), "binding");
    expect(b.state).toBe("skipped");
    expect(b.summary).toContain("signing key (public_key) is not in canonical form");
    expect(b.summary).toContain("suite not recognized");
  });

  it("the revocation ✓ states its scope: one address, the one the relay declares (N2)", () => {
    const r = rung(proofLadder(v({ revocation: "not_revoked" }), RESOLVED), "revocation");
    expect(r.state).toBe("passed");
    expect(r.summary).toContain("the anchor address the relay declares");
    expect(r.summary).toContain("memos anywhere else were not looked for");
  });

  it("a memo with no displayable date is still reported (N1)", () => {
    for (const at of [undefined, 1e17]) {
      const r = rung(
        proofLadder(
          v({
            binding: "revoked",
            revocation: "revoked",
            ...(at !== undefined ? { revokedAt: at } : {}),
          }),
          RESOLVED,
        ),
        "revocation",
      );
      expect(r.state).toBe("failed");
      expect(r.summary).toContain("with no date this page can show");
    }
  });
});
