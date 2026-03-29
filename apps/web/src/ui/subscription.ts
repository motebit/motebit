import type { WebContext } from "../types";
import { loadSubscriptionTier, loadProxyToken, loadSyncUrl } from "../storage";
/** Relay URL for subscription checkout when no sync URL is saved. Override via VITE_RELAY_URL. */
const DEFAULT_RELAY_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_RELAY_URL ?? "https://motebit-sync.fly.dev";

const STRIPE_PUBLISHABLE_KEY: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_STRIPE_PUBLISHABLE_KEY ?? "";

export interface SubscriptionAPI {
  updateTierDisplay(): void;
}

const PLAN_MODELS: Record<string, string> = {
  pro: "Claude Sonnet 4",
  ultra: "Claude Opus 4",
};

/** Dynamically load Stripe.js on first use. Cached after first load. */
let stripePromise: Promise<unknown> | null = null;
function loadStripeJs(): Promise<unknown> {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://js.stripe.com/dahlia/stripe.js";
    script.onload = () => {
      const Stripe = (window as unknown as Record<string, unknown>).Stripe;
      if (typeof Stripe === "function") {
        resolve((Stripe as (key: string) => unknown)(STRIPE_PUBLISHABLE_KEY));
      } else {
        reject(new Error("Stripe.js loaded but Stripe constructor not found"));
      }
    };
    script.onerror = () => {
      stripePromise = null;
      reject(new Error("Failed to load Stripe.js"));
    };
    document.head.appendChild(script);
  });
  return stripePromise;
}

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
  const checkoutContainer = document.getElementById(
    "stripe-checkout-container",
  ) as HTMLElement | null;

  // Plan selector updates model preview
  planSelect?.addEventListener("change", () => {
    if (modelPreview) modelPreview.value = PLAN_MODELS[planSelect.value] ?? "";
  });

  /** Hide the checkout form and restore the plan selector UI. */
  function hideCheckoutForm(): void {
    if (checkoutContainer) {
      checkoutContainer.style.display = "none";
      checkoutContainer.innerHTML = "";
    }
    if (upgradeDiv) upgradeDiv.style.display = "";
  }

  /** Show embedded checkout, hiding the plan selector while active. */
  async function openEmbeddedCheckout(): Promise<void> {
    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    const plan = planSelect?.value ?? "pro";

    if (!motebitId) {
      ctx.showToast("Identity not ready — try again in a moment");
      return;
    }

    if (!STRIPE_PUBLISHABLE_KEY) {
      // Fallback to hosted mode if no publishable key configured
      openHostedCheckout(relayUrl, motebitId, plan);
      return;
    }

    // Hide plan selector, show checkout container
    if (upgradeDiv) upgradeDiv.style.display = "none";
    if (checkoutContainer) {
      checkoutContainer.style.display = "";
      checkoutContainer.innerHTML =
        '<p style="color:var(--text-muted); text-align:center; padding:20px;">Loading checkout…</p>';
    }

    try {
      const stripe = (await loadStripeJs()) as {
        createEmbeddedCheckoutPage(opts: {
          fetchClientSecret: () => Promise<string>;
        }): Promise<{ mount(el: HTMLElement | string): void; destroy(): void }>;
      };

      const fetchClientSecret = async (): Promise<string> => {
        const res = await fetch(`${relayUrl}/api/v1/subscriptions/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            motebit_id: motebitId,
            tier: plan,
            ui_mode: "embedded",
            return_url: window.location.href + "?checkout_session_id={CHECKOUT_SESSION_ID}",
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "checkout request failed" }));
          throw new Error((err as { error?: string }).error ?? "checkout request failed");
        }
        const data = (await res.json()) as { clientSecret: string };
        return data.clientSecret;
      };

      const checkout = await stripe.createEmbeddedCheckoutPage({ fetchClientSecret });

      if (checkoutContainer) {
        checkoutContainer.innerHTML = "";
        checkout.mount(checkoutContainer);
      }

      // Poll for completion: when the URL has a checkout_session_id, the redirect happened
      const checkCompletion = setInterval(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.has("checkout_session_id")) {
          clearInterval(checkCompletion);
          checkout.destroy();
          hideCheckoutForm();
          // Clean up URL param
          params.delete("checkout_session_id");
          const cleanUrl =
            window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
          window.history.replaceState({}, "", cleanUrl);
          updateTierDisplay();
        }
      }, 1000);
    } catch (err) {
      hideCheckoutForm();
      ctx.showToast(err instanceof Error ? err.message : "Checkout failed");
    }
  }

  /** Fallback: hosted Stripe Checkout (opens in new tab). */
  function openHostedCheckout(relayUrl: string, motebitId: string, plan: string): void {
    fetch(`${relayUrl}/api/v1/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitId,
        tier: plan,
        ui_mode: "hosted",
        return_url: window.location.href,
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        const url = (data as { checkout_url?: string }).checkout_url;
        if (url) window.open(url, "_blank");
        else ctx.showToast("Could not start checkout");
      })
      .catch(() => ctx.showToast("Checkout request failed"));
  }

  // Subscribe button opens embedded checkout
  subscribeBtn?.addEventListener("click", () => {
    openEmbeddedCheckout().catch(() => {});
  });

  // Check for checkout completion on page load (redirect back from Stripe)
  const params = new URLSearchParams(window.location.search);
  if (params.has("checkout_session_id")) {
    params.delete("checkout_session_id");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl);
    // Tier will be updated by the next proxy token refresh
  }

  function updateTierDisplay(): void {
    const tier = loadProxyToken()?.tier ?? loadSubscriptionTier();
    const isSubscribed = tier === "pro" || tier === "ultra";

    // Subscribed: show tier badge + detail, hide upgrade form + checkout
    if (activeDiv) activeDiv.style.display = isSubscribed ? "" : "none";
    if (upgradeDiv) upgradeDiv.style.display = isSubscribed ? "none" : "";
    if (isSubscribed && checkoutContainer) {
      checkoutContainer.style.display = "none";
      checkoutContainer.innerHTML = "";
    }

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
