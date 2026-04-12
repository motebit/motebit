import type { WebContext } from "../types";
import { loadProxyToken, loadBalance, saveBalance, loadSyncUrl } from "../storage";

/** Relay URL. Override via VITE_RELAY_URL. */
const DEFAULT_RELAY_URL: string =
  (import.meta as unknown as Record<string, Record<string, string> | undefined>).env
    ?.VITE_RELAY_URL ?? "https://relay.motebit.com";

export interface SubscriptionAPI {
  updateBalanceDisplay(): void;
}

/** Balance threshold (USD) below which top-up buttons appear. */
const LOW_BALANCE_THRESHOLD = 5;
const TOPUP_AMOUNTS = [5, 10, 25];

export function initSubscription(ctx: WebContext): SubscriptionAPI {
  const balanceEl = document.getElementById("balance-display");
  const subscribeBtn = document.getElementById("subscribe-btn") as HTMLButtonElement | null;
  const subscribedSection = document.getElementById("subscribed-section");
  const unsubscribedSection = document.getElementById("unsubscribed-section");
  const topupSection = document.getElementById("topup-section");
  const topupButtons = document.getElementById("topup-buttons");
  const topupStatus = document.getElementById("topup-status");
  const cancelLink = document.getElementById("subscription-cancel-link");
  const cancelArea = document.getElementById("subscription-cancel-area");

  // Wire up top-up buttons once
  if (topupButtons) {
    for (const amount of TOPUP_AMOUNTS) {
      const btn = document.createElement("button");
      btn.className = "deposit-btn";
      btn.style.cssText =
        "padding:6px 14px; border:1px solid var(--border-light); border-radius:6px; background:transparent; color:var(--text-heading); font-size:12px; cursor:pointer;";
      btn.textContent = `+$${amount}`;
      btn.addEventListener("click", () => {
        void openTopup(amount);
      });
      topupButtons.appendChild(btn);
    }
  }

  function updateBalanceDisplay(): void {
    const token = loadProxyToken();
    const balanceUsd = token?.balanceUsd ?? loadBalance();

    if (balanceEl) {
      balanceEl.textContent = `$${balanceUsd.toFixed(2)} remaining`;
    }

    // Check subscription status to show/hide sections
    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    if (!motebitId) return;

    void fetch(`${relayUrl}/api/v1/subscriptions/${motebitId}/status`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            subscribed?: boolean;
            balance_usd?: number;
            subscription_status?: string;
            active_until?: number;
          } | null,
        ) => {
          if (!data) return;
          if (data.balance_usd != null) {
            saveBalance(data.balance_usd);
            if (balanceEl) balanceEl.textContent = `$${data.balance_usd.toFixed(2)} remaining`;
          }

          const isSubscribed = data.subscribed === true;
          if (subscribedSection) subscribedSection.style.display = isSubscribed ? "" : "none";
          if (unsubscribedSection) unsubscribedSection.style.display = isSubscribed ? "none" : "";

          // Show top-up when balance is low
          if (topupSection && isSubscribed) {
            topupSection.style.display =
              data.balance_usd != null && data.balance_usd < LOW_BALANCE_THRESHOLD ? "" : "none";
          }

          // Show cancel/resubscribe state
          if (cancelArea) {
            if (data.subscription_status === "cancelling") {
              const until =
                data.active_until != null
                  ? ` on ${new Date(data.active_until).toLocaleDateString()}`
                  : "";
              cancelArea.style.textAlign = "center";
              cancelArea.innerHTML =
                `<div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Plan cancels${until}. Credits remain until used.</div>` +
                '<button id="resubscribe-btn" style="font-size:13px; padding:6px 20px; border:1px solid var(--text-heading); border-radius:6px; background:transparent; color:var(--text-heading); cursor:pointer;">Resubscribe</button>';
              document.getElementById("resubscribe-btn")?.addEventListener("click", () => {
                const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
                const mid = localStorage.getItem("motebit:motebit_id");
                if (!mid) return;
                const btn = document.getElementById("resubscribe-btn") as HTMLButtonElement | null;
                if (btn) {
                  btn.disabled = true;
                  btn.textContent = "Resuming…";
                }
                fetch(`${relayUrl}/api/v1/subscriptions/${mid}/resubscribe`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                })
                  .then((res) => {
                    if (res.ok) {
                      ctx.showToast("Plan resumed");
                      updateBalanceDisplay();
                    } else {
                      ctx.showToast("Failed to resume");
                      if (btn) {
                        btn.disabled = false;
                        btn.textContent = "Resubscribe";
                      }
                    }
                  })
                  .catch(() => {
                    ctx.showToast("Network error");
                    if (btn) {
                      btn.disabled = false;
                      btn.textContent = "Resubscribe";
                    }
                  });
              });
            } else if (data.subscription_status === "active") {
              cancelArea.innerHTML =
                '<a id="subscription-cancel-link" href="#" style="font-size:11px; color:var(--text-muted); opacity:0.5; text-decoration:none; cursor:pointer;">Cancel plan</a>';
              // Re-attach cancel handler
              document
                .getElementById("subscription-cancel-link")
                ?.addEventListener("click", (e) => {
                  e.preventDefault();
                  cancelLink?.click();
                });
            }
          }
        },
      )
      .catch(() => {
        // Relay unreachable — show unsubscribed state (safe default)
        if (subscribedSection) subscribedSection.style.display = "none";
        if (unsubscribedSection) unsubscribedSection.style.display = "";
      });
  }

  async function openTopup(amount: number): Promise<void> {
    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    if (!motebitId) return;

    if (topupStatus) topupStatus.textContent = "Opening checkout…";

    try {
      const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, return_url: window.location.origin }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "checkout failed" }))) as {
          error?: string;
        };
        ctx.showToast(err.error ?? "Checkout failed");
        if (topupStatus) topupStatus.textContent = "";
        return;
      }

      const data = (await res.json()) as { checkout_url?: string };
      if (data.checkout_url) {
        window.open(data.checkout_url, "_blank");
        if (topupStatus) topupStatus.textContent = "Complete payment in the new tab";
        pollForBalanceUpdate(relayUrl, motebitId);
      } else {
        ctx.showToast("Could not start checkout");
        if (topupStatus) topupStatus.textContent = "";
      }
    } catch {
      ctx.showToast("Network error — try again");
      if (topupStatus) topupStatus.textContent = "";
    }
  }

  function pollForBalanceUpdate(relayUrl: string, motebitId: string): void {
    let attempts = 0;
    const startBalance = loadBalance();
    const interval = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        clearInterval(interval);
        if (topupStatus)
          topupStatus.textContent =
            "Payment may still be processing — balance will update shortly.";
        return;
      }

      void fetch(`${relayUrl}/api/v1/agents/${motebitId}/balance`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { balance?: number } | null) => {
          if (data?.balance != null) {
            const newUsd = data.balance / 1_000_000;
            if (newUsd > startBalance) {
              clearInterval(interval);
              saveBalance(newUsd);
              updateBalanceDisplay();
              if (topupStatus) topupStatus.textContent = "";
              ctx.showToast("Credits added");
            }
          }
        })
        .catch(() => {
          // Individual poll failure — keep trying until attempts exhausted
        });
    }, 2000);
  }

  // Subscribe button
  subscribeBtn?.addEventListener("click", () => {
    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    if (!motebitId) {
      ctx.showToast("Identity not ready — try again in a moment");
      return;
    }

    subscribeBtn.disabled = true;
    subscribeBtn.textContent = "Opening checkout…";

    fetch(`${relayUrl}/api/v1/subscriptions/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: motebitId,
        return_url: window.location.origin + "/?checkout_session_id={CHECKOUT_SESSION_ID}",
      }),
    })
      .then((res) => res.json())
      .then((data: { checkout_url?: string; error?: string }) => {
        if (data.checkout_url) {
          window.location.href = data.checkout_url;
        } else {
          ctx.showToast(data.error ?? "Checkout failed");
          subscribeBtn.disabled = false;
          subscribeBtn.textContent = "Subscribe — $20/mo";
        }
      })
      .catch(() => {
        ctx.showToast("Network error — try again");
        subscribeBtn.disabled = false;
        subscribeBtn.textContent = "Subscribe — $20/mo";
      });
  });

  // Cancel link
  cancelLink?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!cancelArea) return;

    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    const motebitId = localStorage.getItem("motebit:motebit_id");
    if (!motebitId) return;

    cancelArea.innerHTML =
      '<span style="font-size:12px; color:var(--text-muted);">Cancel? You keep remaining credits.</span>' +
      '<div style="display:flex; gap:8px; justify-content:center; margin-top:6px;">' +
      '<button id="cancel-confirm" style="font-size:11px; padding:4px 12px; border:1px solid #e55; border-radius:4px; background:transparent; color:#e55; cursor:pointer;">Yes, cancel</button>' +
      '<button id="cancel-dismiss" style="font-size:11px; padding:4px 12px; border:1px solid var(--border-light); border-radius:4px; background:transparent; color:var(--text-muted); cursor:pointer;">Keep plan</button>' +
      "</div>";

    document.getElementById("cancel-dismiss")?.addEventListener("click", () => {
      cancelArea.innerHTML =
        '<a id="subscription-cancel-link" href="#" style="font-size:11px; color:var(--text-muted); opacity:0.6; text-decoration:none; cursor:pointer;">Cancel plan</a>';
    });

    document.getElementById("cancel-confirm")?.addEventListener("click", () => {
      const btn = document.getElementById("cancel-confirm") as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Cancelling…";
      }

      fetch(`${relayUrl}/api/v1/subscriptions/${motebitId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
        .then((res) => {
          if (res.ok) {
            void res.json().then((data: { active_until?: number }) => {
              const until =
                data.active_until != null && data.active_until > 0
                  ? new Date(data.active_until).toLocaleDateString()
                  : "";
              cancelArea.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">Cancels${until ? ` on ${until}` : ""}. Credits remain until used.</span>`;
            });
          } else {
            void res
              .json()
              .catch(() => ({ error: "cancel failed" }))
              .then((err: { error?: string }) => {
                ctx.showToast(err.error ?? "Cancel failed");
              });
          }
        })
        .catch(() => ctx.showToast("Network error — try again"));
    });
  });

  // Check for checkout return — verify and activate subscription
  const params = new URLSearchParams(window.location.search);
  const checkoutSessionId = params.get("checkout_session_id");
  if (checkoutSessionId) {
    params.delete("checkout_session_id");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl);

    const relayUrl = loadSyncUrl() ?? DEFAULT_RELAY_URL;
    void verifyCheckout(relayUrl, checkoutSessionId);
  }

  async function verifyCheckout(relayUrl: string, sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(
          `${relayUrl}/api/v1/subscriptions/session-status?session_id=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok) break;

        const data = (await res.json()) as {
          status: string;
          balance_usd?: number;
        };

        if (data.status === "complete") {
          if (data.balance_usd != null) saveBalance(data.balance_usd);
          updateBalanceDisplay();
          // Bootstrap proxy to switch from local to cloud AI
          void ctx.bootstrapProxy();
          ctx.showToast("Subscription activated");
          return;
        }
        if (data.status === "expired") {
          ctx.showToast("Checkout expired");
          return;
        }

        // Still open — wait and retry
        if (attempt < 4) await new Promise((r) => setTimeout(r, 2000));
      } catch {
        break;
      }
    }

    // All attempts exhausted without confirmation — let user know
    ctx.showToast("Checkout verification pending — your balance will update shortly");
  }

  updateBalanceDisplay();

  return { updateBalanceDisplay };
}
