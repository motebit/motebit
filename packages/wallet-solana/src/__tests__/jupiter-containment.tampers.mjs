#!/usr/bin/env node
// Tamper check for the Jupiter containment (2026-11-14): the swap choke point,
// the gas-floor refusal before signing, the factory's autoGas default, the
// confirmSend classification of a gas refusal, and the
// check-third-party-tx-signing gate's core detection.
//
// Each entry reverts one fix and names the test expected to go red. The shared
// runner (scripts/lib/tamper-runner.ts) applies each tamper in an isolated
// copy of the tree.
//
//   node packages/wallet-solana/src/__tests__/jupiter-containment.tampers.mjs [--concurrency=N]

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const WALLET = "@motebit/wallet-solana";
const JUPITER = "packages/wallet-solana/src/jupiter.ts";
const RAIL = "packages/wallet-solana/src/rail.ts";
const GATE = "scripts/check-third-party-tx-signing.ts";

// The choke point: refuseJupiterSwap stops refusing.
const CHOKE = {
  file: JUPITER,
  from: "  throw new JupiterSwapDisabledError(operation);",
  // `void operation` keeps the package's noUnusedParameters build green (the
  // CLI entry rebuilds the dist).
  to: "  void operation;\n  return undefined as never;",
};
const JUP_DESC = "Jupiter swaps refuse before fetching or signing (containment)";
const BELOW = "transfers below the gas floor fail closed before signing";
// The gas-floor refusal before signing is removed.
const REQUIRE_GAS = {
  file: RAIL,
  from: "    if (!ok) throw new InsufficientSolForGasError(balance, GAS_FLOOR_LAMPORTS);\n",
  to: "",
};
const GATE_TEST = "scripts/__tests__/check-third-party-tx-signing.test.ts";
const GATE_RED =
  "check-third-party-tx-signing flags every planted deserialize-then-sign shape and no clean one";

const TAMPERS = [
  {
    name: "choke point removed: swapUsdcToSol",
    pkg: WALLET,
    test: "src/__tests__/jupiter.test.ts",
    red: `${JUP_DESC} swapUsdcToSol: a malicious /swap response is never fetched, deserialized, signed or broadcast`,
    edits: [CHOKE],
  },
  {
    name: "choke point removed: swapSolToUsdc",
    pkg: WALLET,
    test: "src/__tests__/jupiter.test.ts",
    red: `${JUP_DESC} swapSolToUsdc: a malicious /swap response is never fetched, deserialized, signed or broadcast`,
    edits: [CHOKE],
  },
  {
    name: "choke point removed: ensureGas (legacy autoGas: true) reports gas",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: "ensureGas below the floor never reaches a Jupiter signature legacy autoGas: true — ensureGas returns false; no fetch, no signature, no broadcast",
    edits: [CHOKE],
  },
  {
    name: "choke point removed: CLI `wallet swap` stops refusing",
    pkg: "motebit",
    test: "src/__tests__/wallet-swap-refused.test.ts",
    red: "motebit wallet swap (disabled) prints the refusal and the next step, exits 1, and never unlocks the key or touches the network",
    rebuild: [WALLET],
    edits: [CHOKE],
  },
  {
    name: "gas floor not enforced: send",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: `${BELOW} send throws InsufficientSolForGasError; nothing broadcast; balances unchanged`,
    edits: [REQUIRE_GAS],
  },
  {
    name: "gas floor not enforced: sendBatch",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: `${BELOW} sendBatch throws InsufficientSolForGasError; nothing broadcast; balances unchanged`,
    edits: [REQUIRE_GAS],
  },
  {
    name: "gas floor not enforced: buildP2pPayment",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: `${BELOW} buildP2pPayment throws InsufficientSolForGasError; nothing broadcast; balances unchanged`,
    edits: [REQUIRE_GAS],
  },
  {
    name: "factory honours the old flag again (autoGas on by default)",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: "the factory cannot turn automatic gas back on disableAutoGas: undefined ⇒ autoGas off, ensureGas false below the floor, nothing signed",
    edits: [
      {
        file: RAIL,
        from: "  return new SolanaWalletRail(adapter, { autoGas: false });",
        to: "  return new SolanaWalletRail(adapter, { autoGas: !config.disableAutoGas });",
      },
    ],
  },
  {
    name: "confirmSend no longer reads a gas refusal as not-paid",
    pkg: WALLET,
    test: "src/__tests__/gas-containment.test.ts",
    red: `${BELOW} a send refused for gas is authoritatively not paid (confirmSend ⇒ absent)`,
    edits: [
      {
        file: RAIL,
        from: "      query.error instanceof InsufficientSolForGasError ||\n",
        to: "",
      },
    ],
  },
  {
    name: "gate core detection deleted: decode sites no longer taint",
    test: GATE_TEST,
    red: GATE_RED,
    edits: [
      {
        file: GATE,
        from: "        if (isDecodeCall(n, this.p)) {\n          hit = true;\n          return;\n        }\n",
        to: "",
      },
    ],
  },
  {
    name: "gate core detection deleted: tx.sign on a decoded receiver is not a sink",
    test: GATE_TEST,
    red: GATE_RED,
    edits: [
      {
        file: GATE,
        from: "  if (TX_METHOD_SIGNERS.has(name) && recv !== null && t.isTainted(recv)) return name;\n",
        to: "",
      },
    ],
  },
];

await runTampers(TAMPERS, { root: ROOT });
