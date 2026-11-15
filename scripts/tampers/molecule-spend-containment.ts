/**
 * Tamper checks for mint-allowlist spend containment of first-party molecules
 * (2026-11-14): no configuration of a `runMolecule` process yields a signed
 * mainnet-USDC transfer. Each entry re-opens ONE door and names the test that
 * must go red.
 *
 *   - the constant: `MOLECULE_SPENDABLE_MINTS` widened with the mainnet mint
 *     (the value test, a behavioural test, and the static gate);
 *   - the rail (the choke): the refusal's throw, each of the three call sites,
 *     the fail-closed rule for an adapter that reports no mint, and
 *     `confirmSend`'s reading of the refusal as "nothing was sent";
 *   - the adapter: the throw and each of the three send functions, and the
 *     factory binding the allowlist to the adapter and to the rail;
 *   - the runtime: the metered wrapper's pre-check (before the meter commits
 *     spend), the wrapper's reader at the loop-path call site, the early
 *     return at the top of `executeGrantedDelegation`'s live branch, and the
 *     pre-sign classification in `resolveAndSubmitP2pDelegation`;
 *   - the runner: the boot check on the money-execution rail and on the sweep
 *     rail, the exactness of that check, and the factory passing the constant;
 *   - Research: the tool-result wording that stops a retry.
 *
 * Entries whose test lives in another package than the edit rebuild the edited
 * package in the copy (molecule-runner's tests load `@motebit/runtime` and
 * `@motebit/wallet-solana` from their `dist`).
 *
 *   node scripts/tampers/molecule-spend-containment.ts [--concurrency=N]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const WALLET = "@motebit/wallet-solana";
const RUNTIME = "@motebit/runtime";
const RUNNER = "@motebit/molecule-runner";
const RESEARCH = "@motebit/research";

const RAIL = "packages/wallet-solana/src/rail.ts";
const ADAPTER = "packages/wallet-solana/src/web3js-adapter.ts";
const WALLET_CONSTANTS = "packages/wallet-solana/src/constants.ts";
const METER = "packages/runtime/src/money-meter.ts";
const MOTEBIT_RUNTIME = "packages/runtime/src/motebit-runtime.ts";
const RELAY_DELEGATION = "packages/runtime/src/relay-delegation.ts";
const RUNNER_INDEX = "packages/molecule-runner/src/index.ts";
const RESEARCH_SRC = "services/research/src/research.ts";

const WALLET_TEST = "src/__tests__/spend-allowlist.test.ts";
const RUNNER_TEST = "src/__tests__/money-refused.test.ts";

const RAIL_DESC = "spendable-mint allowlist: the rail refuses before the gas check";
const ADAPTER_DESC = "spendable-mint allowlist: the web3 adapter repeats the refusal";
const MAINNET_HOOKS = "a molecule over a MAINNET-mint rail moves nothing (hooks honoured)";
const MAINNET_NO_HOOKS = "a molecule over a MAINNET-mint rail moves nothing (hooks absent)";
const BOOT_DESC = "the runner refuses to start with a rail lacking the exact allowlist";

/** The allowlist constant, widened to include mainnet USDC. */
const WIDEN: TamperEntry["edits"] = [
  {
    file: RUNNER_INDEX,
    from: "Object.freeze([USDC_MINT_DEVNET])",
    to: 'Object.freeze([USDC_MINT_DEVNET, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"])',
  },
];

const EARLY_RETURN: TamperEntry["edits"] = [
  {
    file: MOTEBIT_RUNTIME,
    from:
      "      if (railSpendRefusedOf(this._solanaWallet)) {\n" +
      '        return { ok: false, code: "rail_spend_refused" };\n' +
      "      }\n",
    to: "",
  },
];

const PRE_SIGN_CLASS: TamperEntry["edits"] = [
  {
    file: RELAY_DELEGATION,
    from:
      "    if (err instanceof Error && err.name === RAIL_SPEND_REFUSED_ERROR_NAME) {\n" +
      '      return fail("rail_spend_refused", err.message);\n' +
      "    }\n",
    to: "",
  },
];

const TAMPERS: TamperEntry[] = [
  // ── The constant ─────────────────────────────────────────────────────────
  {
    name: "constant widened with mainnet USDC: the value test",
    edits: WIDEN,
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: "the allowlist constant MOLECULE_SPENDABLE_MINTS is exactly [devnet USDC], frozen",
  },
  {
    name: "constant widened with mainnet USDC: a mainnet transfer goes through",
    edits: WIDEN,
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: `${MAINNET_HOOKS} runtime sendUsdc: throws rail_spend_refused`,
  },
  {
    name: "constant widened with mainnet USDC: the static gate",
    edits: WIDEN,
    command: ["npx", "tsx", "scripts/check-molecule-spend-containment.ts"],
    redMarker: "MOLECULE_SPENDABLE_MINTS must be the top-level",
  },

  // ── The rail ─────────────────────────────────────────────────────────────
  {
    name: "rail check removed: requireSpendable no longer throws",
    edits: [
      {
        file: RAIL,
        from: "      throw new RailSpendRefusedError(this.adapter.usdcMint ?? null, allowed);\n",
        to: "      void allowed;\n",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} send is refused before getSolBalance is called`,
  },
  {
    name: "rail check removed: send",
    edits: [
      {
        file: RAIL,
        from:
          "    this.requireSpendable();\n" +
          "    await this.requireGas();\n" +
          "    return this.adapter.sendUsdc({ toAddress, microAmount });",
        to: "    await this.requireGas();\n    return this.adapter.sendUsdc({ toAddress, microAmount });",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} send is refused before getSolBalance is called`,
  },
  {
    name: "rail check removed: sendBatch",
    edits: [
      {
        file: RAIL,
        from:
          "    this.requireSpendable();\n" +
          "    await this.requireGas();\n" +
          "    return this.adapter.sendUsdcBatch(items);",
        to: "    await this.requireGas();\n    return this.adapter.sendUsdcBatch(items);",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} sendBatch is refused before getSolBalance is called`,
  },
  {
    name: "rail check removed: buildP2pPayment",
    edits: [
      {
        file: RAIL,
        from:
          "    this.requireSpendable();\n" +
          "    await this.requireGas();\n" +
          "    return buildP2pPaymentProof(",
        to: "    await this.requireGas();\n    return buildP2pPaymentProof(",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} buildP2pPayment is refused before getSolBalance is called, and reports no signature`,
  },
  {
    name: "rail check moved AFTER the gas check: send",
    edits: [
      {
        file: RAIL,
        from:
          "    this.requireSpendable();\n" +
          "    await this.requireGas();\n" +
          "    return this.adapter.sendUsdc({ toAddress, microAmount });",
        to:
          "    await this.requireGas();\n" +
          "    this.requireSpendable();\n" +
          "    return this.adapter.sendUsdc({ toAddress, microAmount });",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} send is refused before getSolBalance is called`,
  },
  {
    name: "fail-closed rule removed: an adapter that reports no mint is allowed",
    edits: [
      {
        file: WALLET_CONSTANTS,
        from: "  return mint === undefined || !spendableMints.includes(mint);",
        to: "  return mint !== undefined && !spendableMints.includes(mint);",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} an allowlist over an adapter that reports no mint refuses every transfer`,
  },
  {
    name: "confirmSend no longer reads the refusal as absent",
    edits: [
      {
        file: RAIL,
        from:
          "      query.error instanceof InvalidSolanaAddressError ||\n" +
          "      query.error instanceof RailSpendRefusedError\n",
        to: "      query.error instanceof InvalidSolanaAddressError\n",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${RAIL_DESC} confirmSend reads a spend refusal as absent, without a lookup`,
  },

  // ── The adapter ──────────────────────────────────────────────────────────
  {
    name: "adapter check removed: requireSpendableMint no longer throws",
    edits: [
      {
        file: ADAPTER,
        from: "      throw new RailSpendRefusedError(mint, allowed);\n",
        to: "      void mint;\n",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} sendUsdc is refused before any read or signature`,
  },
  {
    name: "adapter check removed: sendUsdc",
    edits: [
      {
        file: ADAPTER,
        from: "    this.requireSpendableMint();\n    // 1. Validate recipient.",
        to: "    // 1. Validate recipient.",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} sendUsdc is refused before any read or signature`,
  },
  {
    name: "adapter check removed: sendUsdcBatch",
    edits: [
      {
        file: ADAPTER,
        from: "    this.requireSpendableMint();\n    if (items.length === 0) return [];",
        to: "    if (items.length === 0) return [];",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} sendUsdcBatch is refused before any read or signature`,
  },
  {
    name: "adapter check removed: sendUsdcDurable",
    edits: [
      {
        file: ADAPTER,
        from: "    this.requireSpendableMint();\n    let recipient: PublicKey;",
        to: "    let recipient: PublicKey;",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} sendUsdcDurable is refused before any read or signature`,
  },
  {
    name: "factory stops binding the allowlist to the adapter",
    edits: [
      {
        file: RAIL,
        from: "    spendableMints: config.spendableMints,\n  });",
        to: "  });",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} createSolanaWalletRail binds the allowlist to the rail AND to its adapter`,
  },
  {
    name: "factory stops binding the allowlist to the rail",
    edits: [
      {
        file: RAIL,
        from: "{ autoGas: false, spendableMints: config.spendableMints }",
        to: "{ autoGas: false }",
      },
    ],
    pkg: WALLET,
    test: WALLET_TEST,
    red: `${ADAPTER_DESC} createSolanaWalletRail binds the allowlist to the rail AND to its adapter`,
  },

  // ── The runtime ──────────────────────────────────────────────────────────
  {
    name: "wrapper pre-check removed: the meter runs before the refusal",
    edits: [
      {
        file: METER,
        from: "    if (isRailSpendRefused?.() === true) throw new RailSpendRefusedError();\n",
        to: "    void isRailSpendRefused;\n",
      },
    ],
    pkg: RUNTIME,
    test: "src/__tests__/money-meter.test.ts",
    red: "wrapP2pPaymentWithMeter — a rail that refuses every spend is refused BEFORE the meter a refusing rail throws RailSpendRefusedError: the meter is never called and nothing is charged",
  },
  {
    name: "wrapper pre-check removed: delegate_to_agent charges the grant store before the rail refuses",
    edits: [
      {
        file: METER,
        from: "    if (isRailSpendRefused?.() === true) throw new RailSpendRefusedError();\n",
        to: "    void isRailSpendRefused;\n",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    rebuild: [RUNTIME],
    red: `${MAINNET_HOOKS} delegate_to_agent through executeToolGated: refused before the meter is charged`,
  },
  {
    name: "wrapper's rail reader dropped at the loop-path call site (enableInteractiveDelegation)",
    edits: [
      {
        file: MOTEBIT_RUNTIME,
        from:
          "          () => railSpendRefusedOf(this._solanaWallet),\n" +
          "        )\n" +
          "      : undefined;",
        to: "        )\n      : undefined;",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    rebuild: [RUNTIME],
    red: `${MAINNET_HOOKS} delegate_to_agent through executeToolGated: refused before the meter is charged`,
  },
  {
    name: "runtime early return removed: the live branch reaches discovery",
    edits: EARLY_RETURN,
    pkg: RUNTIME,
    test: "src/__tests__/execute-granted-delegation.test.ts",
    red: "executeGrantedDelegation — a rail that refuses every spend (rail_spend_refused) the live branch returns rail_spend_refused before discovery, the meter and the rail",
    only: true,
  },
  {
    name: "runtime early return removed: the spend handle asks the relay",
    edits: EARLY_RETURN,
    pkg: RUNNER,
    test: RUNNER_TEST,
    rebuild: [RUNTIME],
    red: `${MAINNET_HOOKS} spend handle, live: rail_spend_refused before discovery`,
  },
  {
    name: "pre-sign classification removed: no confirmer ⇒ payment_status_unknown + a ledger row",
    edits: PRE_SIGN_CLASS,
    pkg: RUNTIME,
    test: "src/__tests__/relay-delegation.test.ts",
    red: "resolveAndSubmitP2pDelegation a rail spend refusal is rail_spend_refused with NO confirmer: nothing recorded, never payment_status_unknown",
    only: true,
  },
  {
    name: "pre-sign classification removed: with a confirmer ⇒ payment_broadcast_failed",
    edits: PRE_SIGN_CLASS,
    pkg: RUNTIME,
    test: "src/__tests__/relay-delegation.test.ts",
    red: "resolveAndSubmitP2pDelegation a rail spend refusal is rail_spend_refused WITH a confirmer too (not payment_broadcast_failed)",
    only: true,
  },
  {
    name: "pre-sign classification removed: invokeCapability over an adapter without broadcast hooks",
    edits: PRE_SIGN_CLASS,
    pkg: RUNNER,
    test: RUNNER_TEST,
    rebuild: [RUNTIME],
    red: `${MAINNET_NO_HOOKS} invokeCapability: rail_spend_refused, nothing recorded as unconfirmed`,
  },

  // ── The runner ───────────────────────────────────────────────────────────
  {
    name: "runner boot check removed: the money-execution rail",
    edits: [
      {
        file: RUNNER_INDEX,
        from: '  assertMoleculeRailContained(wallet, "money-execution");\n',
        to: "",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: `${BOOT_DESC} money-execution rail override with no allowlist`,
  },
  {
    name: "runner boot check removed: the earnings-sweep rail",
    edits: [
      {
        file: RUNNER_INDEX,
        from: '    assertMoleculeRailContained(wallet, "earnings-sweep");\n',
        to: "",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: `${BOOT_DESC} earnings-sweep rail override with no allowlist`,
  },
  {
    name: "runner boot check loosened: a superset of the constant is accepted",
    edits: [
      {
        file: RUNNER_INDEX,
        from:
          "    spendableMints.length === MOLECULE_SPENDABLE_MINTS.length &&\n" +
          "    spendableMints.every((mint, i) => mint === MOLECULE_SPENDABLE_MINTS[i]);",
        to: "    MOLECULE_SPENDABLE_MINTS.every((mint) => spendableMints.includes(mint));",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: `${BOOT_DESC} money-execution rail override with a wider allowlist`,
  },
  {
    name: "runner stops passing the allowlist to the rail it builds",
    edits: [
      {
        file: RUNNER_INDEX,
        from: "    spendableMints: MOLECULE_SPENDABLE_MINTS,\n",
        to: "",
      },
    ],
    pkg: RUNNER,
    test: RUNNER_TEST,
    red: "the runner's own rails (no override): env and config cannot widen them createMoleculeWalletRail always carries exactly the constant, whatever mint it is given",
  },

  // ── Research ─────────────────────────────────────────────────────────────
  {
    name: "Research no longer tells the model to stop calling a rail-refused tool",
    edits: [
      {
        file: RESEARCH_SRC,
        from: '        if (!paid.ok && paid.code === "rail_spend_refused") {',
        to: '        if (!paid.ok && paid.code === "rail_spend_refused_never") {',
      },
    ],
    pkg: RESEARCH,
    test: "src/__tests__/spend-budget.test.ts",
    red: "paid-spend budget — ledger and seam failures degrade conservatively rail_spend_refused: the model is told not to call the tool again; nothing is charged and no free lane runs",
  },
];

void runTampers(TAMPERS, { root: ROOT });
