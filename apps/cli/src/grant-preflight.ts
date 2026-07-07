/**
 * Grant pre-flight — the refusal that teaches, applied to the product.
 *
 * Born from the first-metered-dollar ceremony (2026-07-06/07): the
 * founder walked `motebit --grant` into five silent boundaries in one
 * night — unwired rail, unpinned relay key, a governance preset that
 * hard-denies R4, an unfunded wallet, an undue tick. Every refusal was
 * CORRECT and every refusal was ILLEGIBLE: the model said "done", the
 * banner promised "R4 money clears within its signed ceiling" while
 * governance made that structurally impossible, and the truth lived in
 * an audit table only a debugger read.
 *
 * The repo already holds the doctrine for this — gate-repair-instructions:
 * a failing gate must emit the canonical source and the exact fix. This
 * module extends that contract from CI to the sovereign user: at grant
 * presentation, walk the ENTIRE authorization chain the turn will need
 * (artifact → tick → governance → rail → relay pin → working capital)
 * and print either one calm armed-line or each blocker with its exact
 * remedy. The checks are advisory legibility — the runtime's verifier,
 * gate, and meter remain the only authorities (a pre-flight pass never
 * grants anything; a pre-flight failure never blocks the session; it
 * predicts, the boundary decides).
 */

import { APPROVAL_PRESET_CONFIGS } from "@motebit/sdk";
import type { FullConfig } from "./config.js";
import { selectDueTick, type StoredGrant } from "./subcommands/grant.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** The exact next step when not ok — the repair-instruction contract. */
  remedy?: string;
}

export interface GrantPreflight {
  armed: boolean;
  checks: PreflightCheck[];
}

const R4 = 4;

export async function preflightGrant(deps: {
  stored: StoredGrant;
  now: number;
  fullConfig: FullConfig;
  /** Whether the sovereign rail was constructed this session (seed decrypted). */
  hasRail: boolean;
  /** Live USDC balance in micro-units; undefined = RPC unavailable (soft-skip). */
  getBalanceMicro?: () => Promise<bigint>;
}): Promise<GrantPreflight> {
  const { stored, now, fullConfig, hasRail } = deps;
  const checks: PreflightCheck[] = [];

  // 1. Grant artifact — revoked / expired are terminal states.
  if (stored.revocation != null) {
    checks.push({
      name: "grant",
      ok: false,
      detail: `grant ${stored.grant.grant_id.slice(0, 8)}… is REVOKED`,
      remedy: "revocation is terminal — mint a new grant: motebit grant create …",
    });
  } else if (stored.grant.expires_at <= now) {
    checks.push({
      name: "grant",
      ok: false,
      detail: `grant expired ${new Date(stored.grant.expires_at).toISOString()}`,
      remedy: "mint a new grant: motebit grant create …",
    });
  } else {
    checks.push({
      name: "grant",
      ok: true,
      detail: `scope=${stored.grant.scope}, expires ${new Date(stored.grant.expires_at).toISOString()}`,
    });
  }

  // 2. Tick due — the pre-minted schedule IS the cadence.
  const due = selectDueTick(stored, now);
  if (due != null) {
    checks.push({ name: "tick", ok: true, detail: "a pre-minted tick is due now" });
  } else {
    const next = stored.ticks
      .map((t) => t.not_before ?? t.issued_at)
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    checks.push({
      name: "tick",
      ok: false,
      detail: "no tick is due in the current slot",
      remedy:
        next != null
          ? `next tick unlocks ${new Date(next).toISOString()} — the signed schedule is the cadence; waiting is the remedy`
          : "all ticks consumed or expired — mint a new grant",
    });
  }

  // 3. Governance posture — denyAbove is a hard ceiling no grant overrides.
  const presetName = fullConfig.governance?.approvalPreset ?? "balanced";
  const preset = APPROVAL_PRESET_CONFIGS[presetName];
  const permitsMoney = preset != null && preset.denyAbove >= R4;
  checks.push({
    name: "governance",
    ok: permitsMoney,
    detail: `preset "${presetName}" (denyAbove=${preset?.denyAbove ?? "?"})`,
    ...(permitsMoney
      ? {}
      : {
          remedy:
            `your posture hard-denies R4 money — the grant never overrides a hard ceiling. ` +
            `To permit governed money: set governance.approvalPreset to "autonomous" in ~/.motebit/config.json`,
        }),
  });

  // 4. Sovereign rail — no seed, no payments.
  checks.push({
    name: "rail",
    ok: hasRail,
    detail: hasRail ? "sovereign Solana rail constructed" : "no payment rail this session",
    ...(hasRail
      ? {}
      : { remedy: "the identity seed was not decrypted — relaunch and enter the passphrase" }),
  });

  // 5. Relay pin — the P2P treasury derives FROM the pin.
  const pinned = fullConfig.relay_public_key;
  checks.push({
    name: "relay-pin",
    ok: pinned != null && pinned !== "",
    detail:
      pinned != null && pinned !== ""
        ? `relay key pinned (${pinned.slice(0, 12)}…)`
        : "relay operator key not pinned — P2P payment path unavailable",
    ...(pinned != null && pinned !== ""
      ? {}
      : { remedy: "run `motebit register` online to pin the relay's verified key" }),
  });

  // 6. Working capital — soft check; quotes vary, the meter decides.
  if (deps.getBalanceMicro != null) {
    try {
      const micro = await deps.getBalanceMicro();
      const usd = Number(micro) / 1_000_000;
      checks.push({
        name: "wallet",
        ok: micro > 0n,
        detail: `${usd.toFixed(2)} USDC working capital`,
        ...(micro > 0n
          ? {}
          : {
              remedy:
                "fund with USDC on the SOLANA network, or convert gas: motebit wallet swap <sol-amount>",
            }),
      });
    } catch {
      checks.push({
        name: "wallet",
        ok: true,
        detail: "balance unavailable (RPC) — the meter still bounds every spend",
      });
    }
  }

  return { armed: checks.every((c) => c.ok), checks };
}

/** Render the verdict in the calm register: one line armed, blockers taught. */
export function renderPreflight(pf: GrantPreflight, dim: (s: string) => string): string[] {
  if (pf.armed) {
    const brief = pf.checks.map((c) => c.detail.split(",")[0]).join(" · ");
    return [dim(`  [grant armed — ${brief}]`)];
  }
  const lines = [dim(`  [grant presented, NOT armed — the boundary will refuse:]`)];
  for (const c of pf.checks.filter((c) => !c.ok)) {
    lines.push(dim(`    ✗ ${c.name}: ${c.detail}`));
    if (c.remedy != null) lines.push(dim(`      → ${c.remedy}`));
  }
  return lines;
}
