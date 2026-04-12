// === Sovereign wallet helpers ===
//
// Fetching the motebit's onchain USDC balance and opening the Stripe crypto
// onramp flow are primitives used in more than one panel (historically only
// Settings; now also the Sovereign panel's Balances block). Lifting these
// out of settings.ts keeps the two callers in sync — follows the sibling-
// boundary rule: two copies of the same RPC + onramp plumbing would drift.
//
// The motebit's Ed25519 identity key IS its Solana address, so these helpers
// operate against the sovereign wallet at all times. The relay is a session
// broker for onramp; it never touches keys or funds.

import type { WebContext } from "../types";
import { loadSyncUrl } from "../storage";

/**
 * Fetch the motebit's onchain USDC balance via RPC through the runtime.
 * Returns null when the runtime has no wallet configured or the RPC call
 * fails — callers should render "—" in that case (fail-quiet, not loud).
 */
export async function fetchSolanaBalanceUsdc(
  runtime: ReturnType<WebContext["app"]["getRuntime"]>,
): Promise<number | null> {
  if (!runtime) return null;
  const address = runtime.getSolanaAddress?.() ?? null;
  if (!address) return null;
  try {
    const microUsdc = await runtime.getSolanaBalance?.();
    if (microUsdc == null) return null;
    // USDC is 6-decimal native; display resolution is 2 decimals elsewhere,
    // but we return the exact value so callers can format as they wish.
    return Number(microUsdc) / 1_000_000;
  } catch {
    return null;
  }
}

/**
 * Open the Stripe crypto onramp flow. Pops a blank tab synchronously (user-
 * gesture context, dodges popup blockers) then navigates it to the URL the
 * relay returns. On focus-return the caller's `onReturn` callback fires so
 * the Sovereign balance can refresh after the purchase completes.
 *
 * Not a custodial flow: the relay brokers the session, Stripe handles the
 * card + conversion, USDC lands directly at the motebit's sovereign address.
 */
export async function openSovereignFundingFlow(
  ctx: WebContext,
  address: string,
  motebitId: string,
  onReturn: () => void,
): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const relayUrl = loadSyncUrl() || "https://relay.motebit.com";
    const token = await ctx.app.createSyncToken("device:auth");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const response = await fetch(`${relayUrl}/api/v1/onramp/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ motebit_id: motebitId, destination_address: address }),
    });
    if (!response.ok) {
      tab?.close();
      if (response.status === 503) {
        ctx.showToast("Funding is not yet available on this relay");
      } else {
        ctx.showToast(`Funding failed: HTTP ${response.status}`);
      }
      return;
    }
    const body = (await response.json()) as { redirect_url: string; provider: string };
    if (tab) {
      tab.location.href = body.redirect_url;
    } else {
      window.open(body.redirect_url, "_blank", "noopener,noreferrer");
    }
    const onFocus = (): void => {
      window.removeEventListener("focus", onFocus);
      onReturn();
    };
    window.addEventListener("focus", onFocus);
  } catch (err: unknown) {
    tab?.close();
    const msg = err instanceof Error ? err.message : String(err);
    ctx.showToast(`Funding error: ${msg}`);
  }
}
