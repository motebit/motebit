/**
 * money-identity-path — the closed registry of packages on the money / identity
 * path, the dependency-trigger set that forces membership, and the per-tier
 * coverage floors.
 *
 * This is the canonical source consumed by:
 *   - `check-money-identity-path-canonical` — membership is fail-closed: any
 *     package whose DIRECT dependencies include a trigger must be a registry
 *     member (you cannot create a money/attestation package and dodge the floor).
 *   - `check-coverage-config-present` — every registry member declares a
 *     `vitest.config.ts` with explicit coverage thresholds at or above its tier
 *     floor (graduation entries excepted), and — universally — every publishable
 *     test-bearing package declares *some* explicit threshold.
 *
 * Why a `scripts/` sibling and not `@motebit/protocol`: protocol is
 * permissive-floor, types/algebra only (packages/protocol/CLAUDE.md). A CI
 * package-name list is neither a type nor algebra; it is build tooling, consumed
 * only by `check-*`. Placing it in protocol would trip the purity gate and leak
 * a CI concern into the runtime surface.
 *
 * Design (see the review thread that landed this):
 *   - The registry (members that MUST declare floors) is a SUPERSET of the
 *     trigger set (deps that FORCE membership).
 *   - The rule for trigger membership is FUNCTIONAL, not a dependent-count
 *     threshold: a trigger encapsulates a primitive's domain-specific concerns
 *     (money flows, attestation chains), so depending on it means you are in that
 *     domain. core-identity, identity-file, and crypto are excluded because they
 *     provide cross-cutting infrastructure that crosses every domain boundary —
 *     depending on them does not place you on the money/identity path, it is
 *     ambient. (Dependent counts at landing — money primitives 2–5, platform
 *     verifiers 2, vs core-identity 11 / identity-file 12 / crypto 25 — merely
 *     CORROBORATE this; they are not the rule. If a money primitive accreted 11
 *     dependents by becoming the platform accounting primitive it would still be
 *     a trigger by function, and a future audit must not re-classify it on a
 *     count.) crypto in particular carries its own dedicated gates
 *     (check-suite-dispatch / check-suite-declared); this gate owns only its
 *     coverage floor. KEEP crypto out of TRIGGERS — re-adding it dilutes the
 *     registry's meaning back to "most of the repo."
 *   - No WAIVERS escape hatch in v1: a per-diff waiver list is the same fail-open
 *     the gate exists to close, relocated one level up. If the dependency walk
 *     ever produces a genuinely-unfilterable false positive, that is the data
 *     point that earns an escape hatch built right (named reason + required
 *     expiry + its own check-waiver-canonical) — not a pre-built footgun.
 */

export type PathTier = "money" | "identity";

/** Per-axis coverage thresholds (vitest `coverage.thresholds`). */
export interface CoverageFloor {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/**
 * Tier floors (Option A from the review thread). Money members all already meet
 * 90/85/90/90 (settlement-rails is the current min). Identity floor is set at
 * 85/80/85/85 as the target; the laggards below it (core-identity 82/93/83/82,
 * crypto-tpm 85/70/100/85, crypto-webauthn 85/75/100/85) are carried in
 * coverage-graduation.json with raise-by dates rather than blocking the floor —
 * coverage-quality work is not done as a side effect of a presence-gate change.
 */
export const TIER_FLOOR: Readonly<Record<PathTier, CoverageFloor>> = {
  money: { statements: 90, branches: 85, functions: 90, lines: 90 },
  identity: { statements: 85, branches: 80, functions: 85, lines: 85 },
};

/**
 * The registry: packages that MUST declare a coverage floor, by tier.
 * Eight-artifact closed-registry shape — adding a money/identity primitive means
 * an entry here (cross-locked by check-money-identity-path-canonical).
 *
 * Membership is fail-closed: `check-money-identity-path-canonical`'s Amendment-2
 * derivation flags any package under packages/ whose direct dependencies include
 * a MEMBERSHIP_TRIGGER but which is not listed here — so a forgotten entry is a
 * CI failure, not a silent omission. (Unconditionally enforced — issue #110's
 * runtime sovereign-rail refactor removed the lone over-fire.)
 */
export const MONEY_IDENTITY_PATH: ReadonlyMap<string, PathTier> = new Map([
  ["@motebit/virtual-accounts", "money"],
  ["@motebit/wallet-solana", "money"],
  ["@motebit/settlement-rails", "money"],
  ["@motebit/evm-rpc", "money"],
  ["@motebit/deposit-detector", "money"],
  ["@motebit/treasury-reconciliation", "money"],
  // Worker boot kernel — derives a service's sovereign settlement address and
  // sweeps its accrued P2P earnings (constructs SolanaWalletRail from the
  // identity seed). Genuinely money-path (unlike the runtime core, which #110
  // moved OFF the path via the SovereignWalletRail port): a worker handles its
  // own funds, so the kernel that wires that gets the registry's scrutiny.
  ["@motebit/molecule-runner", "money"],
  ["@motebit/core-identity", "identity"],
  ["@motebit/identity-file", "identity"],
  ["@motebit/crypto", "identity"], // member-by-declaration; NOT a trigger (see header)
  ["@motebit/crypto-appattest", "identity"],
  ["@motebit/crypto-android-keystore", "identity"],
  ["@motebit/crypto-tpm", "identity"],
  ["@motebit/crypto-webauthn", "identity"],
  ["@motebit/verify", "identity"], // canonical motebit-verify aggregator — verification IS the identity path
  ["@motebit/verifier", "identity"], // dep-thin verification library third parties (agency) consume — verification IS the identity path. Member-by-declaration (NOT a trigger), like crypto
]);

/**
 * The trigger set ⊊ registry. A DIRECT (`dependencies` or `peerDependencies`,
 * never `devDependencies`) dependency on one of these places the dependent in a
 * money/attestation domain, so the dependent must be a registry member. Excludes
 * core-identity / identity-file / crypto — cross-cutting infrastructure, not a
 * domain (see header: the rule is functional, not a dependent count).
 */
export const MEMBERSHIP_TRIGGERS: ReadonlySet<string> = new Set([
  "@motebit/virtual-accounts",
  "@motebit/wallet-solana",
  "@motebit/settlement-rails",
  "@motebit/evm-rpc",
  "@motebit/deposit-detector",
  "@motebit/treasury-reconciliation",
  "@motebit/crypto-appattest",
  "@motebit/crypto-android-keystore",
  "@motebit/crypto-tpm",
  "@motebit/crypto-webauthn",
]);
