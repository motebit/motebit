/**
 * The model mobile settles on when the user switches provider in Settings →
 * Intelligence (#654 cold review C2). The modal used to inline a ternary
 * chain whose fall-through arm was `DEFAULT_ANTHROPIC_MODEL` and which had
 * no `proxy` arm — so choosing Motebit Cloud sent the BYOK Anthropic default
 * (DEFAULT_ANTHROPIC_MODEL), which the proxy refuses. Every non-on-device provider
 * now derives through the sdk's one `defaultModelForProvider`.
 */
import { defaultModelForProvider } from "@motebit/sdk";
import type { MobileProvider } from "./mobile-app";

export function modelForProviderSwitch(provider: MobileProvider): string {
  return provider === "on-device" ? "on-device" : defaultModelForProvider(provider);
}
