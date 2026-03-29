import type { WebContext } from "../types";
import { loadSubscriptionTier, loadProxyToken, loadSyncUrl } from "../storage";

export interface SubscriptionAPI {
  updateTierDisplay(): void;
  openUpgrade(): void;
}

export function initSubscription(ctx: WebContext): SubscriptionAPI {
  // Inject tier badge into settings panel if the container exists
  const container = document.getElementById("subscription-tier");

  function updateTierDisplay(): void {
    if (!container) return;
    const tier = loadSubscriptionTier();
    const token = loadProxyToken();
    const displayTier = token?.tier ?? tier;

    container.textContent = "";

    const badge = document.createElement("span");
    badge.className = `tier-badge tier-${displayTier}`;
    badge.textContent = displayTier === "pro" ? "Pro" : "Free";
    badge.style.cssText =
      displayTier === "pro"
        ? "background: rgba(139, 92, 246, 0.2); color: #a78bfa; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;"
        : "background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.5); padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600;";
    container.appendChild(badge);

    // Show upgrade button for free tier
    if (displayTier !== "pro") {
      const upgradeBtn = document.createElement("button");
      upgradeBtn.className = "upgrade-btn";
      upgradeBtn.textContent = "Upgrade to Pro";
      upgradeBtn.style.cssText =
        "margin-left: 8px; background: rgba(139, 92, 246, 0.15); color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; transition: background 0.15s;";
      upgradeBtn.addEventListener("mouseenter", () => {
        upgradeBtn.style.background = "rgba(139, 92, 246, 0.3)";
      });
      upgradeBtn.addEventListener("mouseleave", () => {
        upgradeBtn.style.background = "rgba(139, 92, 246, 0.15)";
      });
      upgradeBtn.addEventListener("click", () => openUpgrade());
      container.appendChild(upgradeBtn);
    }
  }

  function openUpgrade(): void {
    const syncUrl = loadSyncUrl();
    const motebitId = localStorage.getItem("motebit:motebit_id");

    if (!syncUrl || !motebitId) {
      ctx.showToast("Connect to a relay first to upgrade");
      return;
    }

    // Redirect to relay's Stripe Checkout endpoint
    const checkoutUrl = `${syncUrl}/api/v1/subscriptions/${motebitId}/checkout?return_url=${encodeURIComponent(window.location.href)}`;
    window.open(checkoutUrl, "_blank");
  }

  // Initial render
  updateTierDisplay();

  return { updateTierDisplay, openUpgrade };
}
