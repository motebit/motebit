import React, { useState, useEffect, useMemo, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

interface BillingPanelProps {
  motebitId: string | null;
  relayUrl: string | null;
  /** Current cached balance in USD */
  balanceUsd: number;
  onBalanceUpdate?: (balanceUsd: number) => void;
}

const LOW_BALANCE_THRESHOLD = 5;
const TOPUP_AMOUNTS = [5, 10, 25];

export function BillingPanel({
  motebitId,
  relayUrl,
  balanceUsd: initialBalance,
  onBalanceUpdate,
}: BillingPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [balance, setBalance] = useState(initialBalance);
  const [status, setStatus] = useState<string>("loading");
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>("none");
  const [activeUntil, setActiveUntil] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [topupMessage, setTopupMessage] = useState<string | null>(null);

  const isSubscribed = subscriptionStatus === "active" || subscriptionStatus === "cancelling";

  const fetchStatus = useCallback(async () => {
    if (!motebitId || !relayUrl) {
      setStatus("no_relay");
      return;
    }
    try {
      const res = await fetch(`${relayUrl}/api/v1/subscriptions/${motebitId}/status`);
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const data = (await res.json()) as {
        subscribed?: boolean;
        subscription_status?: string;
        balance_usd?: number;
        active_until?: number;
      };
      setSubscriptionStatus(data.subscription_status ?? "none");
      if (data.balance_usd != null) {
        setBalance(data.balance_usd);
        onBalanceUpdate?.(data.balance_usd);
      }
      if (data.active_until != null) setActiveUntil(data.active_until);
      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  }, [motebitId, relayUrl, onBalanceUpdate]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleSubscribe = useCallback(async () => {
    if (!motebitId || !relayUrl) return;
    setLoading(true);
    try {
      const res = await fetch(`${relayUrl}/api/v1/subscriptions/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motebit_id: motebitId }),
      });
      const data = (await res.json()) as { checkout_url?: string; error?: string };
      if (data.checkout_url) {
        await Linking.openURL(data.checkout_url);
        setTopupMessage("Complete payment in browser — balance updates automatically");
        // Poll for balance update
        pollBalance();
      } else {
        setTopupMessage(data.error ?? "Could not start checkout");
      }
    } catch {
      setTopupMessage("Network error — try again");
    } finally {
      setLoading(false);
    }
  }, [motebitId, relayUrl]);

  const handleTopup = useCallback(
    async (amount: number) => {
      if (!motebitId || !relayUrl) return;
      setTopupMessage("Opening checkout…");
      try {
        const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount }),
        });
        const data = (await res.json()) as { checkout_url?: string; error?: string };
        if (data.checkout_url) {
          await Linking.openURL(data.checkout_url);
          setTopupMessage("Complete payment in browser");
          pollBalance();
        } else {
          setTopupMessage(data.error ?? "Checkout failed");
        }
      } catch {
        setTopupMessage("Network error");
      }
    },
    [motebitId, relayUrl],
  );

  const handleCancel = useCallback(async () => {
    if (!motebitId || !relayUrl) return;
    setLoading(true);
    try {
      const res = await fetch(`${relayUrl}/api/v1/subscriptions/${motebitId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        void fetchStatus();
      } else {
        setTopupMessage("Cancel failed");
      }
    } catch {
      setTopupMessage("Network error");
    } finally {
      setLoading(false);
    }
  }, [motebitId, relayUrl, fetchStatus]);

  const handleResubscribe = useCallback(async () => {
    if (!motebitId || !relayUrl) return;
    setLoading(true);
    try {
      const res = await fetch(`${relayUrl}/api/v1/subscriptions/${motebitId}/resubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        void fetchStatus();
      } else {
        setTopupMessage("Resume failed");
      }
    } catch {
      setTopupMessage("Network error");
    } finally {
      setLoading(false);
    }
  }, [motebitId, relayUrl, fetchStatus]);

  const pollBalance = useCallback(() => {
    if (!motebitId || !relayUrl) return;
    const startBalance = balance;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (attempts > 30) {
        clearInterval(interval);
        setTopupMessage("Balance will update shortly");
        return;
      }
      void (async () => {
        try {
          const res = await fetch(`${relayUrl}/api/v1/agents/${motebitId}/balance`);
          if (!res.ok) return;
          const data = (await res.json()) as { balance?: number };
          if (data.balance != null) {
            const usd = data.balance / 1_000_000;
            if (usd > startBalance) {
              clearInterval(interval);
              setBalance(usd);
              onBalanceUpdate?.(usd);
              setTopupMessage(null);
            }
          }
        } catch {
          // Keep trying
        }
      })();
    }, 2000);
  }, [motebitId, relayUrl, balance, onBalanceUpdate]);

  if (status === "loading") {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  if (status === "no_relay") {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>Connect to a relay in Sync settings to manage billing.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Balance */}
      <Text style={styles.balance}>${balance.toFixed(2)} remaining</Text>

      {isSubscribed ? (
        <>
          {/* Top-up when low */}
          {balance < LOW_BALANCE_THRESHOLD && (
            <View style={styles.topupRow}>
              {TOPUP_AMOUNTS.map((amt) => (
                <TouchableOpacity
                  key={amt}
                  style={styles.topupBtn}
                  onPress={() => void handleTopup(amt)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.topupBtnText}>+${amt}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Cancel / Resubscribe */}
          {subscriptionStatus === "cancelling" ? (
            <View style={styles.cancelArea}>
              <Text style={styles.muted}>
                Plan cancels{activeUntil ? ` on ${new Date(activeUntil).toLocaleDateString()}` : ""}
                . Credits remain until used.
              </Text>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => void handleResubscribe()}
                disabled={loading}
                activeOpacity={0.7}
              >
                <Text style={styles.actionBtnText}>{loading ? "Resuming…" : "Resubscribe"}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => void handleCancel()} disabled={loading}>
              <Text style={styles.cancelLink}>{loading ? "Cancelling…" : "Cancel plan"}</Text>
            </TouchableOpacity>
          )}
        </>
      ) : (
        /* Subscribe */
        <TouchableOpacity
          style={styles.subscribeBtn}
          onPress={() => void handleSubscribe()}
          disabled={loading}
          activeOpacity={0.7}
        >
          <Text style={styles.subscribeBtnText}>
            {loading ? "Opening checkout…" : "Subscribe — $20/mo"}
          </Text>
        </TouchableOpacity>
      )}

      {topupMessage != null && <Text style={styles.statusText}>{topupMessage}</Text>}

      {status === "error" && (
        <Text style={styles.muted}>Could not reach relay — balance may be stale</Text>
      )}
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      padding: 16,
      gap: 12,
    },
    balance: {
      fontSize: 18,
      fontWeight: "600",
      color: c.textPrimary,
      textAlign: "center",
    },
    topupRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 10,
    },
    topupBtn: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: c.borderLight,
      borderRadius: 6,
    },
    topupBtnText: {
      color: c.textPrimary,
      fontSize: 13,
    },
    subscribeBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    subscribeBtnText: {
      color: c.buttonPrimaryText,
      fontSize: 15,
      fontWeight: "600",
    },
    actionBtn: {
      borderWidth: 1,
      borderColor: c.textPrimary,
      borderRadius: 6,
      paddingHorizontal: 20,
      paddingVertical: 6,
      alignSelf: "center",
      marginTop: 8,
    },
    actionBtnText: {
      color: c.textPrimary,
      fontSize: 13,
    },
    cancelArea: {
      alignItems: "center",
      gap: 4,
    },
    cancelLink: {
      color: c.textGhost,
      fontSize: 11,
      textAlign: "center",
      textDecorationLine: "underline",
    },
    muted: {
      color: c.textMuted,
      fontSize: 12,
      textAlign: "center",
    },
    statusText: {
      color: c.textMuted,
      fontSize: 12,
      textAlign: "center",
      marginTop: 4,
    },
  });
}
