/**
 * check-suite-dispatch — the detection rules and the waiver ledger.
 *
 * `analyzeSource` is exercised on in-memory sources (the tree is never
 * written): every Ed25519 shape the gate claims to see must produce a hit,
 * and the non-Ed25519 WebCrypto / noble shapes the hardware-attestation and
 * key-agreement code use legitimately must not. `evaluate` is exercised on
 * synthetic hit sets for the stale-waiver arm. The smoke test runs the real
 * gate against the real repo.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSource, evaluate, DISPATCHER, type Hit } from "../check-suite-dispatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-suite-dispatch.ts");

const kinds = (src: string, read?: Parameters<typeof analyzeSource>[2]): string[] =>
  analyzeSource("packages/x/src/probe.ts", src, read).map((h) => h.kind);

describe("check-suite-dispatch — WebCrypto Ed25519", () => {
  const flagged: Record<string, string> = {
    "string algorithm": `await crypto.subtle.verify("Ed25519", k, s, d);`,
    "lower-case string": `await crypto.subtle.sign("ed25519", k, d);`,
    "object algorithm": `await globalThis.crypto.subtle.importKey("raw", b, { name: "Ed25519" }, false, ["verify"]);`,
    "const string": `const ALG = "Ed25519";\nawait crypto.subtle.verify(ALG, k, s, d);`,
    "const object": `const ALG = { name: "Ed25519" } as const;\nawait crypto.subtle.generateKey(ALG, true, ["sign"]);`,
    "const object member": `const ALGS = { sig: { name: "Ed25519" } };\nawait crypto.subtle.verify(ALGS.sig, k, s, d);`,
    "bare subtle": `const { subtle } = globalThis.crypto;\nawait subtle.verify("Ed25519", k, s, d);`,
    "provider.subtle": `await provider.subtle.verify({ name: "Ed25519" }, k, s, d);`,
    unwrapKey: `await crypto.subtle.unwrapKey("raw", w, uk, "AES-KW", "Ed25519", false, ["verify"]);`,
  };
  for (const [label, src] of Object.entries(flagged)) {
    it(`flags ${label}`, () => {
      expect(kinds(src)).toContain("webcrypto-ed25519");
    });
  }

  it("resolves a const exported from a relative module", () => {
    const src = `import { ALG } from "./algs.js";\nawait crypto.subtle.verify(ALG, k, s, d);`;
    const read = (spec: string) =>
      spec === "./algs.js"
        ? { file: "algs.ts", text: `export const ALG = { name: "Ed25519" };` }
        : null;
    expect(kinds(src, read)).toEqual(["webcrypto-ed25519"]);
  });

  it("flags an Ed25519 literal beside an algorithm it cannot resolve", () => {
    const src = `const p = { name: "Ed25519" };\nfunction v(alg: AlgorithmIdentifier) { return crypto.subtle.verify(alg, k, s, d); }\nv(p);`;
    expect(kinds(src)).toEqual(["webcrypto-ed25519-unresolved"]);
  });

  const clean: Record<string, string> = {
    ECDSA: `await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, s, d);`,
    "ECDSA import": `await crypto.subtle.importKey("spki", b, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);`,
    RSA: `await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, k, s, d);`,
    HMAC: `await crypto.subtle.sign("HMAC", k, d);`,
    AES: `await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);`,
    X25519: `await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);`,
    "unresolved alg, no Ed25519 in file": `function v(alg: AlgorithmIdentifier) { return crypto.subtle.verify(alg, k, s, d); }`,
    "Ed25519 in a comment": `// Ed25519 is handled elsewhere\nawait crypto.subtle.verify("ECDSA", k, s, d);`,
  };
  for (const [label, src] of Object.entries(clean)) {
    it(`does not flag ${label}`, () => {
      expect(kinds(src)).toEqual([]);
    });
  }
});

describe("check-suite-dispatch — noble", () => {
  it("flags a named primitive import at its use", () => {
    expect(
      kinds(`import { verifyAsync } from "@noble/ed25519";\nawait verifyAsync(s, m, p);`),
    ).toEqual(["noble-ed25519"]);
  });

  it("flags a renamed namespace", () => {
    expect(kinds(`import * as noble from "@noble/ed25519";\nawait noble.signAsync(m, k);`)).toEqual(
      ["noble-ed25519"],
    );
  });

  it("flags the classic ed.* shape once", () => {
    expect(kinds(`import * as ed from "@noble/ed25519";\nawait ed.verifyAsync(s, m, p);`)).toEqual([
      "ed-namespace",
    ]);
  });

  it("flags ed.* even without an import", () => {
    expect(kinds(`declare const ed: any;\nawait ed.signAsync(m, k);`)).toEqual(["ed-namespace"]);
  });

  it("flags @noble/curves ed25519 signers", () => {
    expect(
      kinds(`import { ed25519 } from "@noble/curves/ed25519.js";\ned25519.verify(s, m, p);`),
    ).toEqual(["noble-ed25519"]);
  });

  it("flags a dynamic import", () => {
    expect(kinds(`const m = await import("@noble/ed25519");`)).toEqual(["noble-ed25519"]);
  });

  it("does not flag the SHA-512 binding or x25519", () => {
    const src = [
      `import * as ed from "@noble/ed25519";`,
      `import { x25519, edwardsToMontgomeryPub } from "@noble/curves/ed25519.js";`,
      `if (!ed.hashes.sha512) ed.hashes.sha512 = sha512;`,
      `x25519.getSharedSecret(a, b);`,
      `edwardsToMontgomeryPub(p);`,
    ].join("\n");
    expect(kinds(src)).toEqual([]);
  });
});

describe("check-suite-dispatch — waivers", () => {
  const hit = (file: string, line = 1): Hit => ({
    file,
    line,
    kind: "ed-namespace",
    what: "ed.signAsync",
    context: "",
    inlineWaived: false,
    inlineReason: null,
  });
  const W = { "a.ts": { hits: 2, reason: "r" } };

  it("waives an exact count", () => {
    const v = evaluate([hit("a.ts", 1), hit("a.ts", 2)], W, () => true);
    expect(v.active).toEqual([]);
    expect(v.stale).toEqual([]);
  });

  it("is stale when a waived file gains a call", () => {
    const v = evaluate([hit("a.ts", 1), hit("a.ts", 2), hit("a.ts", 3)], W, () => true);
    expect(v.stale.map((s) => s.found.length)).toEqual([3]);
  });

  it("is stale when a waived file no longer calls a primitive", () => {
    const v = evaluate([], W, () => true);
    expect(v.stale).toHaveLength(1);
  });

  it("is stale when a waived file is gone", () => {
    expect(evaluate([], W, () => false).stale[0]?.exists).toBe(false);
  });

  it("never waives a new file and always allows the dispatcher", () => {
    const v = evaluate([hit("b.ts"), hit(DISPATCHER)], {}, () => true);
    expect(v.active.map((h) => h.file)).toEqual(["b.ts"]);
  });
});

describe("check-suite-dispatch (smoke)", () => {
  it("passes against the real repo and discloses its aperture", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /\d+ source file\(s\) scanned under packages\/, apps\/, services\//,
    );
  });
});
