import type { WebContext } from "../types";
import { loadSubscriptionTier, loadProxyToken, loadSyncUrl } from "../storage";

export interface SubscriptionAPI {
  updateTierDisplay(): void;
}

export function initSubscription(ctx: WebContext): SubscriptionAPI {
  const badge = document.getElementById("subscription-tier-badge");
  const detail = document.getElementById("subscription-tier-detail");
  const upgradeDiv = document.getElementById("subscription-upgrade");
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

    if (badge) {
      badge.className = `tier-badge tier-${tier}`;
      badge.textContent =
        tier === "ultra" ? "Ultra" : tier === "pro" ? "Pro" : tier === "byok" ? "BYOK" : "Free";
    }

    if (detail) {
      switch (tier) {
        case "ultra":
          detail.textContent = "Opus · 1,000 msgs/day";
          break;
        case "pro":
          detail.textContent = "Sonnet · 500 msgs/day";
          break;
        case "byok":
          detail.textContent = "Your own API key";
          break;
        default:
          detail.textContent = "Running locally";
      }
    }

    // Hide upgrade buttons if already subscribed or BYOK
    if (upgradeDiv) {
      upgradeDiv.style.display =
        tier === "pro" || tier === "ultra" || tier === "byok" ? "none" : "";
    }
  }

  updateTierDisplay();

  return { updateTierDisplay };
}
