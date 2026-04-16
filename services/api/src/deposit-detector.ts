/**
 * Re-export shim — deposit detector was moved into `deposit-detector/` so
 * the medium-plumbing (EVM JSON-RPC) can live next to the state machine
 * without polluting a single-file module. Kept here so existing imports
 * (`./deposit-detector.js`) continue to resolve; new code may import from
 * `./deposit-detector/index.js` directly.
 */
export {
  createDepositDetectorTable,
  detectDeposits,
  startDepositDetector,
  HttpJsonRpcEvmAdapter,
  type DepositDetectorConfig,
  type EvmRpcAdapter,
  type EvmTransferLog,
} from "./deposit-detector/index.js";
