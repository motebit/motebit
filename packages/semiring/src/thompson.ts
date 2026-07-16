/**
 * Seeded Thompson-sampling primitives for exploration in trust routing.
 *
 * The whole point is REPRODUCIBILITY: exploration must be a deterministic
 * function of recorded, signed context (a delegation token's `jti`), never
 * `Math.random`. Given the seed anyone can recompute the exact draw offline and
 * verify *why* a newcomer was tried — the self-attesting system extended to a
 * routing decision. So this file uses NO `Math.random` and NO `Date`; every
 * number is a pure function of the seed.
 *
 * See docs/doctrine/exploration-as-market-vitality.md.
 */

/**
 * mulberry32 — a small, fast, well-distributed seeded PRNG. Returns a uniform
 * in [0, 1). Not cryptographic (exploration is not a security boundary — the
 * sybil resistance lives in the posterior + the bond, not the RNG), but stable
 * and identical across platforms so a draw reproduces from its seed anywhere.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit string hash → a seed. Deterministic and platform-stable, so
 * `hashSeed("jti|worker") ` yields the same seed in the runtime, an auditor's
 * reverification, and a test.
 */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Draw from Gamma(shape=k, scale=1) for INTEGER k ≥ 1 as the sum of k unit
 * exponentials (`-ln U`). Exact for integer shape — and our shapes are always
 * `prior + task_count`, integers by construction. Consumes k values from `rng`.
 */
function gammaInt(k: number, rng: () => number): number {
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const u = rng();
    // rng ∈ [0,1); guard the u===0 corner so -ln is finite. u<1 always ⇒ -ln u > 0.
    sum -= Math.log(u > 0 ? u : Number.MIN_VALUE);
  }
  return sum;
}

/**
 * Sample θ̃ ~ Beta(alpha, beta) for integer alpha, beta ≥ 1, via the ratio of
 * two Gamma draws: X~Gamma(alpha), Y~Gamma(beta) ⇒ X/(X+Y) ~ Beta(alpha,beta).
 * Exact for integer shapes; O(alpha+beta) — callers cap the counts (the
 * posterior is already tight past a few dozen observations) so this stays cheap.
 * Deterministic given `rng`.
 */
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  // Fail closed on invalid shapes: `gammaInt` (sum of k exponentials) is only
  // correct for positive INTEGER k — a non-integer or non-positive shape would
  // silently return a wrong draw. The routing path always passes integers
  // (prior + capped counts), so this only fires on external misuse.
  if (!Number.isInteger(alpha) || !Number.isInteger(beta) || alpha < 1 || beta < 1) {
    throw new RangeError(
      `sampleBeta requires positive integer shapes; got alpha=${alpha}, beta=${beta}`,
    );
  }
  const ga = gammaInt(alpha, rng);
  const gb = gammaInt(beta, rng);
  return ga / (ga + gb);
}

/**
 * One seeded Thompson draw from Beta(alpha, beta): seed the PRNG from `seed`,
 * draw θ̃. Same (seed, alpha, beta) → same θ̃, everywhere, forever.
 */
export function thompsonDraw(alpha: number, beta: number, seed: string): number {
  return sampleBeta(alpha, beta, mulberry32(hashSeed(seed)));
}
