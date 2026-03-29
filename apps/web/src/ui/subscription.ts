import type { WebContext } from "../types";
import { loadSubscriptionTier, loadProxyToken, loadSyncUrl } from "../storage";

export interface SubscriptionAPI {
  updateTierDisplay(): void;
}

export function initSubscription(ctx: WebContext): SubscriptionAPI {
  const badge = document.getElementById("subscription-tier-badge") as HTMLElement | null;
  const detail = document.getElementById("subscription-tier-detail") as HTMLElement | null;
  const upgradeDiv = document.getElementById("subscription-upgrade") as HTMLElement | null;
  const proBtn = document.getElementById("upgrade-pro-btn");
  const ultraBtn = document.getElementById("upgrade-ultra-btn");

  function openCheckout(tier: "pro" | "ultra"): void {
    const syncUrl = loadSyncUrl();
    const motebitId = localStorage.getItem("motebit:motebit_id");

    if (!syncUrl || !motebitId) {
      ctx.showToast("Connect to a relay first to subscribe");
      return;
    }

    const returnUrl = encodeURIComponent(window.location.href);
    const checkoutUrl = `${syncUrl}/api/v1/subscriptions/checkout?motebit_id=${motebitId}&tier=${tier}&return_url=${returnUrl}`;
    window.open(checkoutUrl, "_blank");
  }

  proBtn?.addEventListener("click", () => openCheckout("pro"));
  ultraBtn?.addEventListener("click", () => openCheckout("ultra"));

  function updateTierDisplay(): void {
    const tier = loadProxyToken()?.tier ?? loadSubscriptionTier();
    const isSubscribed = tier === "pro" || tier === "ultra";
    const isByok = tier === "byok";

    // Badge: only show for active subscribers
    if (badge) {
      if (isSubscribed) {
        badge.style.display = "";
        badge.className = `tier-badge tier-${tier}`;
        badge.textContent = tier === "ultra" ? "Ultra" : "Pro";
      } else if (isByok) {
        badge.style.display = "";
        badge.className = "tier-badge tier-byok";
        badge.textContent = "BYOK";
      } else {
        badge.style.display = "none";
      }
    }

    // Detail text
    if (detail) {
      if (tier === "ultra") {
        detail.textContent = "Opus · 1,000 msgs/day";
      } else if (tier === "pro") {
        detail.textContent = "Sonnet · 500 msgs/day";
      } else if (isByok) {
        detail.textContent = "Using your own API key";
      } else {
        detail.textContent = "Don\u2019t want to manage API keys?";
      }
    }

    // Upgrade buttons: hide if subscribed or BYOK
    if (upgradeDiv) {
      upgradeDiv.style.display = isSubscribed || isByok ? "none" : "";
    }
  }

  updateTierDisplay();

  return { updateTierDisplay };
}
