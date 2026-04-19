/**
 * ReceiptArtifact — mobile surface's form of the receipt emergence.
 *
 * The DOM receipt card from @motebit/render-engine/buildReceiptArtifact
 * doesn't transplant: mobile uses React Native primitives (View/Text),
 * not HTML. What DOES port cleanly is the shared summary logic
 * (receiptSummary, collectKnownKeys) and the local verification
 * (verifyReceiptChain) — those are pure + cross-surface. This component
 * renders the same data in RN idioms.
 *
 * Paradigm consistency: the user on web taps a receipt card and sees a
 * signed chain they can verify locally. Same experience here, same
 * cryptographic guarantee — zero server round trip, pure-JS Ed25519.
 */
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain } from "@motebit/encryption";
import {
  collectKnownKeys,
  displayName,
  priceFor,
  receiptSummary,
  type ReceiptSummary,
} from "@motebit/render-engine";
import { useTheme, type ThemeColors } from "../theme";

interface ReceiptArtifactProps {
  receipt: ExecutionReceipt;
}

type VerifyState =
  | { kind: "pending" }
  | { kind: "verified" }
  | { kind: "failed-task" }
  | { kind: "unverified" };

export function ReceiptArtifact({ receipt }: ReceiptArtifactProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const summary: ReceiptSummary = useMemo(() => receiptSummary(receipt), [receipt]);
  const children = receipt.delegation_receipts ?? [];

  const [expanded, setExpanded] = useState(false);
  const [verify, setVerify] = useState<VerifyState>({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;
    const knownKeys = collectKnownKeys(receipt);
    void verifyReceiptChain(receipt, knownKeys)
      .then((tree) => {
        if (cancelled) return;
        if (!tree.verified) return setVerify({ kind: "unverified" });
        if (receipt.status === "failed") return setVerify({ kind: "failed-task" });
        setVerify({ kind: "verified" });
      })
      .catch(() => {
        if (!cancelled) setVerify({ kind: "unverified" });
      });
    return () => {
      cancelled = true;
    };
  }, [receipt]);

  const verifyColor =
    verify.kind === "verified"
      ? colors.accent
      : verify.kind === "pending"
        ? colors.textMuted
        : verify.kind === "failed-task"
          ? "#c07040"
          : "#d04050";
  const verifyLabel =
    verify.kind === "pending"
      ? "verifying locally…"
      : verify.kind === "verified"
        ? "verified locally · chain intact"
        : verify.kind === "failed-task"
          ? "verified · completed: failed"
          : "verification failed";

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
