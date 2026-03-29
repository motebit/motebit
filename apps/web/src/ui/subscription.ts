import type { WebContext } from "../types";
import { loadSubscriptionTier, loadProxyToken, loadSyncUrl } from "../storage";
/** Relay URL for subscription checkout when no sync URL is saved. Override via VITE_RELAY_URL. */
const DEFAULT_RELAY_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_RELAY_URL ?? "https://motebit-sync.fly.dev";

export interface SubscriptionAPI {
  updateTierDisplay(): void;
}

const PLAN_MODELS: Record<string, string> = {
  pro: "Claude Sonnet 4",
  ultra: "Claude Opus 4",
};

export function initSubscription(ctx: WebContext): SubscriptionAPI {
  const activeDiv = document.getElementById("subscription-active") as HTMLElement | null;
  const badge = document.getElementById("subscription-tier-badge") as HTMLElement | null;
  const detail = document.getElementById("subscription-tier-detail") as HTMLElement | null;
  const upgradeDiv = document.getElementById("subscription-upgrade") as HTMLElement | null;
  const planSelect = document.getElementById("subscription-plan") as HTMLSelectElement | null;
  const modelPreview = document.getElementById(
    "subscription-model-preview",
  ) as HTMLInputElement | null;
  const subscribeBtn = document.getElementById("upgrade-pro-btn") as HTMLButtonElement | null;

  // Plan selector updates model preview
  planSelect?.addEventListener("change", () => {
    if (modelPreview) modelPreview.value = PLAN_MODELS[planSelect.value] ?? "";
  });

  // Subscribe button opens checkout for selected plan
  subscribeBtn?.addEventListener("click", () => {
    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    const plan = planSelect?.value ?? "pro";

    if (!motebitId) {
      ctx.showToast("Identity not ready — try again in a moment");
      return;
    }

    const returnUrl = encodeURIComponent(window.location.href);
    const checkoutUrl = `${relayUrl}/api/v1/subscriptions/checkout?motebit_id=${motebitId}&tier=${plan}&return_url=${returnUrl}`;
    window.open(checkoutUrl, "_blank");
  });

  function updateTierDisplay(): void {
    const tier = loadProxyToken()?.tier ?? loadSubscriptionTier();
    const isSubscribed = tier === "pro" || tier === "ultra";

    // Subscribed: show tier badge + detail, hide upgrade form
    if (activeDiv) activeDiv.style.display = isSubscribed ? "" : "none";
    if (upgradeDiv) upgradeDiv.style.display = isSubscribed ? "none" : "";

    if (isSubscribed && badge) {
      badge.className = `tier-badge tier-${tier}`;
      badge.textContent = tier === "ultra" ? "Ultra" : "Pro";
    }
    if (isSubscribed && detail) {
      detail.textContent = tier === "ultra" ? "Opus · 1,000 msgs/day" : "Sonnet · 500 msgs/day";
    }
  }

  updateTierDisplay();

  return { updateTierDisplay };
}
