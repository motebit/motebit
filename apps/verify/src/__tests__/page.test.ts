/**
 * @vitest-environment jsdom
 *
 * The REAL page path: index.html's body + main.ts (DOM wiring) + the real
 * verifier (@motebit/state-export-client / @motebit/crypto), with only the
 * network mocked. These are the display-layer safety properties from the
 * receipt.computer cold review (F-1, F-2, F-3): the page must never show a
 * positive claim stronger than its evidence.
 *
 *   F-3  a new input, a share-link change, or a verification exception CLEARS
 *        the previous verdict at once; an exception renders "Not verified".
 *   F-1  the receipt-alone genesis commitment never renders SOVEREIGN (no
 *        time-windowed succession check backs it).
 *   F-1  a revocation scan that hit the 200-signature page limit never renders ✓.
 *   F-2  evidence read only through Motebit's own RPC proxy never renders
 *        ANCHORED / "confirmed on-chain" / revocation ✓.
 *
 * Fixtures are minted with the real signer from the public demo seeds
 * (rc-review probe/mint.mjs); the relay declaration is signed by a demo key.
 */
import { describe, it, expect } from "vitest";
import {
  FILLER_200,
  INDEX_HTML,
  container,
  grade,
  installPageHooks,
  linkHash,
  openPage,
  requestLog,
  rung,
  settled,
  showsPositiveVerdict,
  typeIn,
  type MockCtx,
} from "./page-harness.js";
import LLMS_TXT from "../../public/llms.txt?raw";
import A4 from "./fixtures/A4-victim-sovereign.json?raw";
import C4 from "./fixtures/C4-delegation-null-signed.json?raw";
import C5 from "./fixtures/C5-delegation-string-signed.json?raw";
import C5B from "./fixtures/C5b-delegation-object-signed.json?raw";
import D4A from "./fixtures/D4a-retired-genesis-after-rotation.json?raw";
import D4A_CTX from "./fixtures/D4a-retired-genesis-after-rotation.ctx.json?raw";
import D5 from "./fixtures/D5-pinned.json?raw";
import D5_CTX from "./fixtures/D5-pinned.ctx.json?raw";
import D6A from "./fixtures/D6a-anchored.json?raw";
import D6A_CTX from "./fixtures/D6a-anchored.ctx.json?raw";
import G1 from "./fixtures/G1-genesis-current-chain-served.json?raw";
import G1_CTX from "./fixtures/G1-genesis-current-chain-served.ctx.json?raw";
import G2 from "./fixtures/G2-historical-before-rotation-chain-served.json?raw";
import G2_CTX from "./fixtures/G2-historical-before-rotation-chain-served.ctx.json?raw";
import G3 from "./fixtures/G3-rotated-key-chain-served.json?raw";
import G3_CTX from "./fixtures/G3-rotated-key-chain-served.ctx.json?raw";
import FG from "./fixtures/FG-forged-guardian-recovery.json?raw";
import FG_CTX from "./fixtures/FG-forged-guardian-recovery.ctx.json?raw";
import FGL from "./fixtures/FGL-forged-guardian-recovery-legacy.json?raw";
import FGL_CTX from "./fixtures/FGL-forged-guardian-recovery-legacy.ctx.json?raw";
import FS from "./fixtures/FS-served-genesis-not-id-commitment.json?raw";
import FS_CTX from "./fixtures/FS-served-genesis-not-id-commitment.ctx.json?raw";

const FIXTURES: Record<string, string> = {
  "A4-victim-sovereign": A4,
  "C4-delegation-null-signed": C4,
  "C5-delegation-string-signed": C5,
  "C5b-delegation-object-signed": C5B,
  "D4a-retired-genesis-after-rotation": D4A,
  "D4a-retired-genesis-after-rotation.ctx": D4A_CTX,
  "D5-pinned": D5,
  "D5-pinned.ctx": D5_CTX,
  "D6a-anchored": D6A,
  "D6a-anchored.ctx": D6A_CTX,
  "G1-genesis-current-chain-served": G1,
  "G1-genesis-current-chain-served.ctx": G1_CTX,
  "G2-historical-before-rotation-chain-served": G2,
  "G2-historical-before-rotation-chain-served.ctx": G2_CTX,
  "G3-rotated-key-chain-served": G3,
  "G3-rotated-key-chain-served.ctx": G3_CTX,
  "FG-forged-guardian-recovery": FG,
  "FG-forged-guardian-recovery.ctx": FG_CTX,
  "FGL-forged-guardian-recovery-legacy": FGL,
  "FGL-forged-guardian-recovery-legacy.ctx": FGL_CTX,
  "FS-served-genesis-not-id-commitment": FS,
  "FS-served-genesis-not-id-commitment.ctx": FS_CTX,
};
const fixture = (name: string): string => {
  const text = FIXTURES[name];
  if (text === undefined) throw new Error(`no fixture ${name}`);
  return text;
};
const ctxOf = (name: string): MockCtx => JSON.parse(fixture(`${name}.ctx`)) as MockCtx;

installPageHooks();

describe("F-3: a previous verdict never outlives the input it was for", () => {
  for (const name of [
    "C4-delegation-null-signed",
    "C5-delegation-string-signed",
    "C5b-delegation-object-signed",
  ]) {
    it(`typing ${name} after the sample clears the card at once and ends in "Not verified"`, async () => {
      await openPage();
      await settled();
      expect(showsPositiveVerdict()).toBe(true); // the sample's card is up

      typeIn(fixture(name));
      // Synchronously — before the debounce, before any verification — the
      // sample's verdict is gone.
      expect(showsPositiveVerdict()).toBe(false);

      await settled();
      expect(showsPositiveVerdict()).toBe(false);
      expect(container().textContent).toContain("Not verified — could not check this receipt");
    });
  }

  it("navigating from one share link to a throwing one (hashchange) clears the old verdict", async () => {
    const a4 = fixture("A4-victim-sovereign");
    await openPage({ hash: linkHash(a4), ctx: { relayDown: true } });
    await settled();
    expect(showsPositiveVerdict()).toBe(true);

    location.hash = linkHash(fixture("C4-delegation-null-signed"));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(showsPositiveVerdict()).toBe(false);
    await settled();
    expect(showsPositiveVerdict()).toBe(false);
    expect(container().textContent).toContain("Not verified — could not check this receipt");
  });
});

describe("F-1: the receipt-alone genesis commitment is not SOVEREIGN", () => {
  it("the sample (offline) shows integrity + an original-key commitment, never SOVEREIGN", async () => {
    await openPage();
    await settled();
    expect(grade()).not.toBe("SOVEREIGN");
    expect(container().textContent).not.toMatch(/sovereign/i);
    expect(rung("binding")?.querySelector(".check-mark.ok")).toBeNull();
    expect(rung("integrity")?.querySelector(".check-mark.ok")).not.toBeNull();
    expect(container().textContent).toContain(
      "identity commitment matches the motebit's original key; rotation and revocation not established",
    );
  });

  it("a retired genesis key signing after rotation (chain served) is not SOVEREIGN, revocation not ✓", async () => {
    const name = "D4a-retired-genesis-after-rotation";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    expect(grade()).not.toBe("SOVEREIGN");
    expect(container().textContent).not.toMatch(/sovereign/i);
    expect(container().querySelector(".tone-bound")).toBeNull();
    expect(rung("binding")?.querySelector(".check-mark.ok")).toBeNull();
    expect(rung("revocation")?.querySelector(".check-mark.ok")).toBeNull();
  });
});

describe("F-1: a revocation scan that is truncated or failed is never ✓", () => {
  const INDEPENDENT_RPC = "http://localhost:8899";

  it("independent RPC, 200 signatures returned (page limit hit) → revocation not established", async () => {
    const name = "D5-pinned";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: { ...ctxOf(name), memos: FILLER_200 },
      rpc: INDEPENDENT_RPC,
    });
    await settled();
    expect(grade()).toBe("PINNED");
    const rev = rung("revocation")!;
    expect(rev.querySelector(".check-mark.ok")).toBeNull();
    expect(rev.textContent).toContain("not established");
    expect(rev.textContent).not.toContain("no on-chain revocation found");
  });

  it("a revocation memo beyond the 200 window is not hidden behind ✓", async () => {
    const name = "D5-pinned";
    const legacyHex = (JSON.parse(fixture(name)) as { public_key: string }).public_key;
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: {
        ...ctxOf(name),
        memos: [...FILLER_200, `motebit:revocation:v1:${legacyHex}:1790000000500`],
      },
      rpc: INDEPENDENT_RPC,
    });
    await settled();
    expect(rung("revocation")?.querySelector(".check-mark.ok")).toBeNull();
    expect(rung("revocation")?.textContent).toContain("not established");
  });

  it("RPC failure → revocation not established, never ✓", async () => {
    const name = "D5-pinned";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: { ...ctxOf(name), rpcFail: true },
      rpc: INDEPENDENT_RPC,
    });
    await settled();
    expect(rung("revocation")?.querySelector(".check-mark.ok")).toBeNull();
    expect(rung("revocation")?.textContent).toContain("not established");
  });

  it("control: an independent, complete scan (under the page limit) may show ✓", async () => {
    const name = "D5-pinned";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name), rpc: INDEPENDENT_RPC });
    await settled();
    expect(rung("revocation")?.querySelector(".check-mark.ok")).not.toBeNull();
  });
});

describe("F-2: evidence read only through Motebit's RPC proxy is labelled, never ANCHORED or ✓", () => {
  it("the default RPC is the operator proxy: an anchor found there does not render ANCHORED", async () => {
    const name = "D6a-anchored";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    expect(
      requestLog().some((r) => r.startsWith("POST https://api.motebit.com/v1/solana-rpc")),
    ).toBe(true);
    expect(grade()).not.toBe("ANCHORED");
    const text = container().textContent ?? "";
    expect(text).not.toMatch(/confirmed on-chain|anchored on-chain|whose root is on-chain/i);
    expect(text).toContain("via Motebit's RPC proxy (not independently confirmed)");
    expect(rung("revocation")?.querySelector(".check-mark.ok")).toBeNull();
  });

  it("the proxy reporting no revocation is not a ✓", async () => {
    const name = "D5-pinned";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    const rev = rung("revocation")!;
    expect(rev.querySelector(".check-mark.ok")).toBeNull();
    expect(rev.textContent).toContain("via Motebit's RPC proxy (not independently confirmed)");
  });

  it("control: the same anchor through an independent RPC may render ANCHORED", async () => {
    const name = "D6a-anchored";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: ctxOf(name),
      rpc: "http://localhost:8899",
    });
    await settled();
    expect(grade()).toBe("ANCHORED");
  });

  it("llms.txt states that completed_at is claimed and that any memo is reported (round 3)", () => {
    expect(LLMS_TXT).not.toMatch(/time-valid at the receipt's time|before signing|when it signed/);
    expect(LLMS_TXT).toContain(
      "which the signer writes, so pinned does not prove when the receipt was issued",
    );
    expect(LLMS_TXT).toContain("whatever its date relative to the receipt's `completed_at`");
    expect(LLMS_TXT).toContain("Only an exactly canonical id binds at all");
    expect(LLMS_TXT).toContain("a did:key that encodes it");
  });

  it("llms.txt states the canonical-form rule for every field and the scan's scope (round 4)", () => {
    expect(LLMS_TXT).toContain("`public_key` exactly 64 lowercase hex characters");
    expect(LLMS_TXT).toContain("`signature` exactly unpadded base64url of 64 bytes");
    expect(LLMS_TXT).toContain("`suite` exactly `motebit-jcs-ed25519-b64-v1`");
    expect(LLMS_TXT).toContain("uses the decoded key");
    expect(LLMS_TXT).toContain("a complete scan of the anchor address the relay declares");
    expect(LLMS_TXT).toContain("A memo naming the key with no usable date is reported too.");
  });

  it("the page copy does not claim the browser queries Solana itself", () => {
    expect(INDEX_HTML).not.toContain("and Solana, with its public key");
    expect(INDEX_HTML).toContain("Motebit's RPC proxy");
    expect(INDEX_HTML).not.toMatch(/so it verifies <em>sovereign<\/em>/);
  });
});

/** Statements that are only true when the motebit_id commits to the key AND no chain was checked. */
const NO_CHAIN_COMMITMENT_COPY = /hash of this key|no succession check ran|original key/;

describe("B: the relay-served chain binds the key at the receipt's time → the strongest rung it supports", () => {
  for (const [name, why] of [
    ["G1-genesis-current-chain-served", "genesis key, never rotated"],
    ["G2-historical-before-rotation-chain-served", "genesis key, signed before a later rotation"],
    ["G3-rotated-key-chain-served", "the rotated-to key, after a signed rotation"],
  ] as const) {
    it(`${why} (${name}) → PINNED, not KEY COMMITMENT, never SOVEREIGN`, async () => {
      await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
      await settled();
      expect(grade()).toBe("PINNED");
      expect(rung("binding")?.querySelector(".check-mark.ok")).not.toBeNull();
      const text = container().textContent ?? "";
      expect(text).not.toMatch(/sovereign/i);
      expect(text).not.toContain("KEY COMMITMENT");
      expect(text).not.toMatch(/non-equivocable/);
      expect(text).not.toContain("supplied by you");
    });
  }

  it("G3: the rotated-to key is never described as the key the id hashes, or as unchecked", async () => {
    const name = "G3-rotated-key-chain-served";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    expect(container().textContent ?? "").not.toMatch(NO_CHAIN_COMMITMENT_COPY);
  });

  it("G3 with the relay unreachable → INTEGRITY ONLY (the id does not commit to this key)", async () => {
    const name = "G3-rotated-key-chain-served";
    await openPage({ hash: linkHash(fixture(name)), ctx: { relayDown: true } });
    await settled();
    expect(grade()).toBe("INTEGRITY ONLY");
    expect(container().textContent ?? "").not.toMatch(NO_CHAIN_COMMITMENT_COPY);
  });

  it("legacy UUID id with its chain served is unchanged → PINNED", async () => {
    const name = "D5-pinned";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    expect(grade()).toBe("PINNED");
  });
});

describe("B: a served chain that does not bind the key never binds it", () => {
  it("a guardian named only inside the relay-served file does not establish a recovery link (sovereign id)", async () => {
    const name = "FG-forged-guardian-recovery";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: ctxOf(name),
      rpc: "http://localhost:8899",
    });
    await settled();
    expect(grade()).toBe("INTEGRITY ONLY");
    expect(container().querySelector(".tone-bound")).toBeNull();
    expect(rung("binding")?.querySelector(".check-mark.ok")).toBeNull();
    const text = container().textContent ?? "";
    expect(text).not.toMatch(/sovereign|KEY COMMITMENT|PINNED|ANCHORED/);
    expect(rung("binding")?.textContent).toContain("guardian");
  });

  it("the same forged guardian on a legacy id does not reach PINNED", async () => {
    const name = "FGL-forged-guardian-recovery-legacy";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: ctxOf(name),
      rpc: "http://localhost:8899",
    });
    await settled();
    expect(grade()).toBe("INTEGRITY ONLY");
    expect(container().querySelector(".tone-bound")).toBeNull();
  });

  it("a served chain whose genesis is not the key a self-certifying id commits to does not bind", async () => {
    const name = "FS-served-genesis-not-id-commitment";
    await openPage({
      hash: linkHash(fixture(name)),
      ctx: ctxOf(name),
      rpc: "http://localhost:8899",
    });
    await settled();
    expect(grade()).toBe("INTEGRITY ONLY");
    expect(container().querySelector(".tone-bound")).toBeNull();
  });

  it("a retired genesis key signing after rotation → KEY COMMITMENT, and says the succession check ran", async () => {
    const name = "D4a-retired-genesis-after-rotation";
    await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
    await settled();
    expect(grade()).toBe("KEY COMMITMENT");
    const text = container().textContent ?? "";
    expect(text).not.toContain("no succession check ran");
    expect(rung("binding")?.textContent).toContain("not active");
  });
});

describe("G: a revocation memo is unauthenticated — reported, never a definitive 'Key revoked'", () => {
  const name = "D5-pinned";
  const legacyHex = (): string => (JSON.parse(fixture(name)) as { public_key: string }).public_key;
  const junk = (): string => `[42] gm ser motebit:revocation:v1:${legacyHex()}:0 lol`;

  for (const [label, rpc, sourceText] of [
    ["the operator proxy", undefined, "via Motebit's RPC proxy (not independently confirmed)"],
    ["an independent RPC", "http://localhost:8899", "through an RPC the operator does not run"],
  ] as const) {
    it(`a third-party memo read through ${label} → REVOCATION REPORTED (unauthenticated), fail-closed`, async () => {
      await openPage({
        hash: linkHash(fixture(name)),
        ctx: { ...ctxOf(name), memos: [junk()] },
        ...(rpc ? { rpc } : {}),
      });
      await settled();
      expect(grade()).toBe("REVOCATION REPORTED");
      expect(container().querySelector(".claim .chip")?.textContent).toBe("REVOCATION REPORTED");
      const text = container().textContent ?? "";
      expect(text).toContain("REVOCATION REPORTED (unauthenticated)");
      expect(text).toContain(sourceText);
      expect(text).not.toMatch(/Key revoked|revoked on-chain at/);
      expect(container().querySelector(".tone-failed")).not.toBeNull();
      expect(container().querySelector(".chip-ok")).toBeNull();
      expect(rung("revocation")?.querySelector(".check-mark.ok")).toBeNull();
      expect(rung("binding")?.querySelector(".check-mark.ok")).toBeNull();
    });
  }
});

describe("PINNED is conditional ON THE CARD, not only further down the page (round 3: F3)", () => {
  for (const name of ["D5-pinned", "G1-genesis-current-chain-served"] as const) {
    it(`${name}: the grade block itself states what PINNED rests on and what it does not prove`, async () => {
      await openPage({ hash: linkHash(fixture(name)), ctx: ctxOf(name) });
      await settled();
      expect(grade()).toBe("PINNED");
      // The verdict card's own grade block (badge + headline + detail), not the
      // ladder or the "does not prove" list below it.
      const card = container().querySelector(".result-card .proof > .grade")?.textContent ?? "";
      expect(card).toContain("PINNED");
      // What it rests on: the served succession evidence AND the claimed timestamp.
      expect(card).toContain("the succession chain the relay served");
      expect(card).toContain("at the time this receipt claims");
      expect(card).toContain("completed_at is the signer's own claim");
      // What it does not prove.
      expect(card).toContain("does not prove when the receipt was issued");
      expect(card).toContain("that the relay served the complete history");
      expect(card).toContain("that the key was uncompromised");
      expect(card).not.toMatch(/time-valid at this receipt's time|when it signed|before signing/);
    });
  }
});
