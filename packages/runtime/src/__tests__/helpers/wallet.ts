/**
 * A mock sovereign wallet rail around a test's payment builder.
 *
 * The runtime binds a delegation's payment builder from its configured
 * `solanaWallet` (metered on the AI-loop path); a relay binding carries no
 * payment builder (`RelayBinding` is relay coordinates only). A test that
 * used to hand `buildP2pPayment` to `enableInteractiveDelegation` hands it
 * to the runtime through this rail instead. Moves no money.
 */
import type { SovereignWalletRail } from "@motebit/sdk";

export function walletWith(
  buildP2pPayment: (...args: never[]) => Promise<unknown>,
  confirmP2pPayment?: (...args: never[]) => Promise<unknown>,
): SovereignWalletRail {
  return {
    buildP2pPayment,
    ...(confirmP2pPayment != null ? { confirmP2pPayment } : {}),
  } as unknown as SovereignWalletRail;
}
