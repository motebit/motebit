/**
 * ReceiptArtifact — mobile surface's form of the receipt emergence.
 *
 * The DOM receipt card from @motebit/render-engine/buildReceiptArtifact
 * doesn't transplant: mobile uses React Native primitives (View/Text),
 * not HTML. What DOES port cleanly is the shared summary logic
 * (receiptSummary) and the shared verdict ladder (receipt-badge.ts →
 * render-engine's verifyReceiptVerdict) — those are pure + cross-surface.
 * This component renders the same data in RN idioms.
 *
 * Paradigm consistency: the user on web taps a receipt card and sees a
 * signed chain they can verify locally. Same experience here, same
 * cryptographic guarantee — zero server round trip, pure-JS Ed25519 — and
 * the same honesty: without a trusted anchor the badge says "identity not
 * anchored", never "verified".
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { ExecutionReceipt } from "@motebit/sdk";
import { displayName, priceFor, receiptSummary, type ReceiptSummary } from "@motebit/render-engine";
import { deriveReceiptBadge, PENDING_RECEIPT_BADGE, type ReceiptBadge } from "../receipt-badge";
import { useTheme, type ThemeColors } from "../theme";

interface ReceiptArtifactProps {
  receipt: ExecutionReceipt;
  /**
   * Independently-trusted keys (pinned transparency key / known-keys
   * registry) keyed by motebit_id. Never the receipt's own embedded keys.
   * Absent → the badge tops out at integrity-only.
   */
  trustedAnchor?: ReadonlyMap<string, Uint8Array>;
}

export function ReceiptArtifact({
  receipt,
  trustedAnchor,
}: ReceiptArtifactProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const summary: ReceiptSummary = useMemo(() => receiptSummary(receipt), [receipt]);
  const children = receipt.delegation_receipts ?? [];

  const [expanded, setExpanded] = useState(false);
  const [badge, setBadge] = useState<ReceiptBadge>(PENDING_RECEIPT_BADGE);

  useEffect(() => {
    let cancelled = false;
    setBadge(PENDING_RECEIPT_BADGE);
    void deriveReceiptBadge(receipt, trustedAnchor).then((next) => {
      if (!cancelled) setBadge(next);
    });
    return () => {
      cancelled = true;
    };
  }, [receipt, trustedAnchor]);

  const verifyColor =
    badge.tone === "accent"
      ? colors.accent
      : badge.tone === "muted"
        ? colors.textMuted
        : badge.tone === "integrity"
          ? "#4aa8c0"
          : badge.tone === "warn"
            ? "#c07040"
            : badge.tone === "warn-unanchored"
              ? "#9070b0"
              : "#d04050";
  const verifyLabel = badge.label;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>receipt</Text>

      {/* Chain: root row then children indented. Tap to expand details. */}
      <TouchableOpacity activeOpacity={0.85} onPress={() => setExpanded((v) => !v)}>
        <View style={styles.chainRow}>
          <Text style={styles.rowName}>{summary.rootName}</Text>
          <Text style={styles.rowCost}>{summary.rootPrice}</Text>
        </View>
        {children.map((child, i) => (
          <View key={child.task_id ?? i} style={styles.chainRowChild}>
            <Text style={styles.treeGlyph}>└</Text>
            <Text style={styles.rowName}>{displayName(child)}</Text>
            <Text style={styles.rowCost}>{priceFor(child)}</Text>
          </View>
        ))}

        {expanded && (
          <View style={styles.details}>
            <DetailRow label="signed by" value={summary.signer} styles={styles} />
            <DetailRow label="task_id" value={summary.taskIdShort} styles={styles} />
            <DetailRow label="signature" value={summary.signatureShort} styles={styles} />
            <DetailRow label="suite" value={summary.suite} styles={styles} />
          </View>
        )}
      </TouchableOpacity>

      <View style={styles.verifyRow}>
        <View style={[styles.verifyDot, { backgroundColor: verifyColor }]} />
        <Text style={[styles.verifyLabel, { color: verifyColor }]}>{verifyLabel}</Text>
      </View>
    </View>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}
function DetailRow({ label, value, styles }: DetailRowProps): React.ReactElement {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.bgSecondary,
      borderRadius: 12,
      padding: 12,
      marginVertical: 4,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    title: {
      fontSize: 11,
      fontWeight: "600",
      color: c.textMuted,
      textTransform: "lowercase",
      marginBottom: 8,
    },
    chainRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 2,
    },
    chainRowChild: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 2,
      paddingLeft: 8,
    },
    treeGlyph: {
      color: c.textMuted,
      marginRight: 6,
      fontSize: 12,
    },
    rowName: {
      flex: 1,
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: "500",
    },
    rowCost: {
      color: c.textSecondary,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
    },
    details: {
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderPrimary,
    },
    detailRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 2,
    },
    detailLabel: {
      color: c.textMuted,
      fontSize: 11,
    },
    detailValue: {
      color: c.textSecondary,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    verifyRow: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderPrimary,
    },
    verifyDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      marginRight: 6,
    },
    verifyLabel: {
      fontSize: 11,
      fontWeight: "500",
    },
  });
}
