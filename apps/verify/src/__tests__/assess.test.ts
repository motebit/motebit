import { describe, it, expect } from "vitest";
import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import {
  assessVerdict,
  classifyRpc,
  observeSignatureScans,
  scansComplete,
  PROXY_LABEL,
  NO_BINDING_EVIDENCE,
  sourceLabel,
  type BindingEvidence,
  type ChainEvidence,
} from "../assess.js";

const v = (over: Partial<ReceiptDocumentVerification> = {}): ReceiptDocumentVerification => ({
  integrity: true,
  binding: "integrity-only",
  ...over,
});
const INDEPENDENT_COMPLETE: ChainEvidence = {
  source: "independent",
  revocationScanComplete: true,
  memoScan: { status: "none" },
};
const INDEPENDENT_TRUNCATED: ChainEvidence = {
  source: "independent",
  revocationScanComplete: false,
};
const PROXY_COMPLETE: ChainEvidence = { source: "operator-proxy", revocationScanComplete: true };
const NONE = NO_BINDING_EVIDENCE;
const COMMITS: BindingEvidence = { keyCommitsToId: true };
const BOUND_ID: BindingEvidence = {
  keyCommitsToId: false,
  servedChain: { kind: "bound", root: "id-commitment" },
};
const BOUND_RELAY: BindingEvidence = {
  keyCommitsToId: false,
  servedChain: { kind: "bound", root: "relay-record" },
};

describe("classifyRpc", () => {
  it("operator hosts and garbage are the proxy; anything else is independent", () => {
    expect(classifyRpc("https://api.motebit.com/v1/solana-rpc")).toBe("operator-proxy");
    expect(classifyRpc("https://motebit.com/x")).toBe("operator-proxy");
    expect(classifyRpc("https://rpc.receipt.computer/")).toBe("operator-proxy");
    expect(classifyRpc("not a url")).toBe("operator-proxy");
    expect(classifyRpc("https://notmotebit.com/")).toBe("independent");
    expect(classifyRpc("http://localhost:8899")).toBe("independent");
  });
});

describe("assessVerdict", () => {
  it("never SOVEREIGN: the verifier's sovereign is pinned when the page's chain check binds, else a key commitment only when the id commits to the key", () => {
    for (const ev of [undefined, INDEPENDENT_COMPLETE, PROXY_COMPLETE]) {
      const sov = v({ binding: "sovereign" });
      expect(assessVerdict(sov, ev, BOUND_ID).binding).toBe("pinned");
      expect(assessVerdict(sov, ev, BOUND_ID).chainRoot).toBe("id-commitment");
      expect(assessVerdict(sov, ev, COMMITS).binding).toBe("key-commitment");
      // The identity-path sovereign for a key the id does not commit to, with no
      // binding from the page's own check (e.g. a file-named guardian link).
      expect(assessVerdict(sov, ev, NONE).binding).toBe("integrity-only");
      const notBound: BindingEvidence = {
        keyCommitsToId: false,
        servedChain: { kind: "recovery_unverifiable" },
      };
      const r = assessVerdict(sov, ev, notBound);
      expect(r.binding).toBe("integrity-only");
      expect(r.chainCheck).toBe("recovery_unverifiable");
    }
  });

  it("the verifier's pinned stands only when the page's chain check binds too", () => {
    expect(assessVerdict(v({ binding: "pinned" }), undefined, BOUND_RELAY).binding).toBe("pinned");
    for (const kind of ["recovery_unverifiable", "root_mismatch", "not_active"] as const) {
      const r = assessVerdict(v({ binding: "pinned" }), undefined, {
        keyCommitsToId: false,
        servedChain: { kind },
      });
      expect(r.binding).toBe("integrity-only");
      expect(r.chainCheck).toBe(kind);
    }
    // A page check that binds never lifts a verifier verdict below the bound rungs.
    expect(assessVerdict(v({}), undefined, BOUND_ID).binding).toBe("integrity-only");
  });

  it("a key commitment with a served chain that does not bind carries the reason", () => {
    const r = assessVerdict(v({ binding: "sovereign" }), PROXY_COMPLETE, {
      keyCommitsToId: true,
      servedChain: { kind: "not_active" },
    });
    expect(r.binding).toBe("key-commitment");
    expect(r.chainCheck).toBe("not_active");
  });

  it("nested receipts get no binding evidence", () => {
    const d = assessVerdict(v({ delegations: [v({ binding: "sovereign" })] }), undefined, COMMITS);
    expect(d.delegations?.[0]?.binding).toBe("integrity-only");
  });

  it("anchored stands only on independent evidence; otherwise pinned + proxy flag", () => {
    const a = assessVerdict(
      v({ binding: "anchored", anchorTxHash: "TX" }),
      INDEPENDENT_COMPLETE,
      BOUND_RELAY,
    );
    expect(a.binding).toBe("anchored");
    expect(a.anchorTxHash).toBe("TX");
    for (const ev of [undefined, PROXY_COMPLETE]) {
      const p = assessVerdict(v({ binding: "anchored", anchorTxHash: "TX" }), ev, BOUND_RELAY);
      expect(p.binding).toBe("pinned");
      expect(p.anchorViaProxy).toBe(true);
      expect(p.anchorTxHash).toBeUndefined();
    }
    expect(
      assessVerdict(v({ binding: "anchored" }), INDEPENDENT_COMPLETE, {
        keyCommitsToId: false,
        servedChain: { kind: "recovery_unverifiable" },
      }).binding,
    ).toBe("integrity-only");
  });

  it("revocation ✓ only on a complete independent scan", () => {
    for (const r of ["not_revoked"] as const) {
      expect(assessVerdict(v({ revocation: r }), INDEPENDENT_COMPLETE, NONE).revocation).toBe(r);
      const trunc = assessVerdict(v({ revocation: r }), INDEPENDENT_TRUNCATED, NONE);
      expect(trunc.revocation).toBe("not_established");
      expect(trunc.revocationNote).toContain("200-signature page limit");
      const proxy = assessVerdict(v({ revocation: r }), PROXY_COMPLETE, NONE);
      expect(proxy.revocation).toBe("not_established");
      expect(proxy.revocationNote).toContain(PROXY_LABEL);
      expect(assessVerdict(v({ revocation: r }), undefined, NONE).revocation).toBe(
        "not_established",
      );
    }
    const failed = assessVerdict(
      v({ revocation: "unknown", revocationDetail: "HTTP 503" }),
      INDEPENDENT_COMPLETE,
      NONE,
    );
    expect(failed.revocation).toBe("not_established");
    expect(failed.revocationNote).toContain("HTTP 503");
  });

  it("revocation ✓ also needs the page's own decoded-key scan to have run and found nothing (round 4)", () => {
    const ran = (memoScan?: ChainEvidence["memoScan"]): ChainEvidence => ({
      source: "independent",
      revocationScanComplete: true,
      ...(memoScan ? { memoScan } : {}),
    });
    const notRun = assessVerdict(v({ revocation: "not_revoked" }), ran(), NONE);
    expect(notRun.revocation).toBe("not_established");
    expect(notRun.revocationNote).toContain("own scan");
    const failed = assessVerdict(
      v({ revocation: "not_revoked" }),
      ran({ status: "unknown", detail: "HTTP 429" }),
      NONE,
    );
    expect(failed.revocation).toBe("not_established");
    expect(failed.revocationNote).toContain("HTTP 429");
    // The page's scan finds a memo the verifier's text-keyed lookup missed.
    const found = assessVerdict(
      v({ binding: "sovereign", revocation: "not_revoked" }),
      ran({ status: "found", revokedAt: 7 }),
      COMMITS,
    );
    expect(found.binding).toBe("revoked");
    expect(found.revocation).toBe("revoked");
    expect(found.revokedAt).toBe(7);
    const undated = assessVerdict(v({ revocation: "not_revoked" }), ran({ status: "found" }), NONE);
    expect(undated.binding).toBe("revoked");
    expect(undated.revokedAt).toBeUndefined();
  });

  it("a field not in canonical form binds nothing and earns no revocation verdict (round 4)", () => {
    for (const f of ["motebit_id", "public_key", "signature", "suite"] as const) {
      const r = assessVerdict(
        v({ binding: "sovereign", revocation: "not_revoked" }),
        INDEPENDENT_COMPLETE,
        { ...BOUND_ID, keyCommitsToId: true, noncanonical: [f] },
      );
      expect(r.binding, f).toBe("integrity-only");
      expect(r.revocation, f).toBe("not_established");
      expect(r.noncanonical, f).toEqual([f]);
    }
    // A memo for the decoded key is still reported.
    const memo = assessVerdict(
      v({ revocation: "not_revoked" }),
      { ...INDEPENDENT_COMPLETE, memoScan: { status: "found" } },
      { keyCommitsToId: false, noncanonical: ["public_key"] },
    );
    expect(memo.binding).toBe("revoked");
  });

  it("a found revocation stays revoked (reported) from any source, labelled by source", () => {
    const r = assessVerdict(
      v({ binding: "revoked", revocation: "revoked", revokedAt: 5 }),
      PROXY_COMPLETE,
      BOUND_ID,
    );
    expect(r.binding).toBe("revoked");
    expect(r.revocation).toBe("revoked");
    expect(r.chainSource).toBe("operator-proxy");
    expect(sourceLabel(r.chainSource)).toBe(PROXY_LABEL);
    expect(sourceLabel("independent")).toBe("through an RPC the operator does not run");
    expect(sourceLabel(undefined)).toBe("from an unrecorded source");
  });

  it("a memo dated AFTER the claimed completed_at is reported exactly like one before it (F1)", () => {
    // completed_at is the signer's claim: the verifier's "revoked_after_signing"
    // clears nothing, whatever the source and however complete the scan.
    for (const ev of [INDEPENDENT_COMPLETE, INDEPENDENT_TRUNCATED, PROXY_COMPLETE, undefined]) {
      for (const keyEv of [BOUND_ID, BOUND_RELAY, NONE]) {
        const r = assessVerdict(
          v({ binding: "pinned", revocation: "revoked_after_signing", revokedAt: 9 }),
          ev,
          keyEv,
        );
        expect(r.binding).toBe("revoked");
        expect(r.revocation).toBe("revoked");
        expect(r.revokedAt).toBe(9);
      }
    }
  });

  it("offline views pass through without chain fields", () => {
    const o = assessVerdict(
      v({ motebitId: "m", taskId: "t", signerDid: "did:key:z" }),
      undefined,
      NONE,
    );
    expect(o).toEqual({
      integrity: true,
      binding: "integrity-only",
      motebitId: "m",
      taskId: "t",
      signerDid: "did:key:z",
    });
  });
});

describe("observeSignatureScans / scansComplete", () => {
  const rpcBody = (limit: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: ["addr", { limit }],
    });
  const respond =
    (n: number, status = 200): typeof fetch =>
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: new Array(n).fill({}) }), {
        status,
      });

  it("a scan that returns fewer than the limit is complete", async () => {
    const o = observeSignatureScans(respond(3));
    const res = await o.fetch("https://rpc", { method: "POST", body: rpcBody(200) });
    expect(((await res.json()) as { result: unknown[] }).result).toHaveLength(3);
    expect(o.scans).toEqual([{ ok: true, limit: 200, returned: 3 }]);
    expect(scansComplete(o.scans)).toBe(true);
  });

  it("a scan that hits the limit, fails, or throws is not complete; no scan is not complete", async () => {
    const full = observeSignatureScans(respond(200));
    await full.fetch("https://rpc", { method: "POST", body: rpcBody(200) });
    expect(scansComplete(full.scans)).toBe(false);

    const http = observeSignatureScans(respond(0, 503));
    await http.fetch("https://rpc", { method: "POST", body: rpcBody(200) });
    expect(scansComplete(http.scans)).toBe(false);

    const thrown = observeSignatureScans(async () => {
      throw new TypeError("down");
    });
    await expect(
      thrown.fetch("https://rpc", { method: "POST", body: rpcBody(200) }),
    ).rejects.toThrow("down");
    expect(thrown.scans).toEqual([{ ok: false, limit: 200 }]);
    expect(scansComplete(thrown.scans)).toBe(false);

    const rpcError = observeSignatureScans(
      async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "x" } })),
    );
    await rpcError.fetch("https://rpc", { method: "POST", body: rpcBody(200) });
    expect(scansComplete(rpcError.scans)).toBe(false);

    expect(scansComplete([])).toBe(false);
  });

  it("non-scan requests are passed through and not recorded", async () => {
    const o = observeSignatureScans(respond(1));
    await o.fetch("https://relay/x");
    expect(o.scans).toEqual([]);
  });
});
