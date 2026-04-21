/**
 * Governance tab — operator mode toggle + PIN, tool approval preset,
 * memory persistence threshold, reject-secrets switch, max tool calls
 * per turn.
 *
 * PolicySummary lives in settings-shared.tsx because it's reusable
 * across tabs.
 */

import React from "react";
import { View, Text, TextInput, TouchableOpacity, Switch } from "react-native";
import type { MobileSettings } from "../../mobile-app";
import { APPROVAL_PRESET_CONFIGS } from "../../mobile-app";
import { useTheme } from "../../theme";
import { PolicySummary, useSettingsStyles } from "./settings-shared";

export interface GovernanceTabProps {
  draft: MobileSettings;
  isOperatorMode: boolean;
  onUpdate: (patch: Partial<MobileSettings>) => void;
  onRequestPin: (mode: "setup" | "verify" | "reset") => void;
}

export function GovernanceTab({
  draft,
  isOperatorMode,
  onUpdate,
  onRequestPin,
}: GovernanceTabProps): React.ReactElement {
  const colors = useTheme();
  const styles = useSettingsStyles();
  return (
    <View>
      <Text style={styles.sectionTitle}>Operator Mode</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{isOperatorMode ? "Active" : "Inactive"}</Text>
        <TouchableOpacity
          style={styles.pinButton}
          onPress={() => onRequestPin(isOperatorMode ? "verify" : "setup")}
          activeOpacity={0.7}
        >
          <Text style={styles.pinButtonText}>{isOperatorMode ? "Disable" : "Enable"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Tool Approval</Text>
      <View style={styles.radioGroup}>
        {Object.entries(APPROVAL_PRESET_CONFIGS).map(([key, config]) => (
          <TouchableOpacity
            key={key}
            style={[styles.radioItem, draft.approvalPreset === key && styles.radioActive]}
            onPress={() => onUpdate({ approvalPreset: key })}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.radioText, draft.approvalPreset === key && styles.radioTextActive]}
            >
              {config.label}
            </Text>
            <Text style={styles.radioDesc}>{config.description}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <PolicySummary preset={draft.approvalPreset} isOperatorMode={isOperatorMode} />

      <Text style={styles.sectionTitle}>Memory</Text>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Persistence threshold</Text>
        <TextInput
          style={styles.numberField}
          value={String(draft.persistenceThreshold)}
          onChangeText={(v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n >= 0 && n <= 1) onUpdate({ persistenceThreshold: n });
          }}
          keyboardType="decimal-pad"
          placeholderTextColor={colors.inputPlaceholder}
        />
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Reject secrets</Text>
        <Switch
          value={draft.rejectSecrets}
          onValueChange={(v) => onUpdate({ rejectSecrets: v })}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={draft.rejectSecrets ? colors.textPrimary : colors.textMuted}
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Max tool calls / turn</Text>
        <TextInput
          style={styles.numberField}
          value={String(draft.maxCallsPerTurn)}
          onChangeText={(v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) onUpdate({ maxCallsPerTurn: n });
          }}
          keyboardType="number-pad"
          placeholderTextColor={colors.inputPlaceholder}
        />
      </View>

      <Text style={styles.sectionTitle}>Proactive Interior</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Memory consolidation while idle</Text>
        <Switch
          value={draft.proactive.enabled}
          onValueChange={(v) => onUpdate({ proactive: { ...draft.proactive, enabled: v } })}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={draft.proactive.enabled ? colors.textPrimary : colors.textMuted}
        />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Publish proofs onchain (Solana, ~$0.001/batch)</Text>
        <Switch
          value={draft.proactive.anchorOnchain}
          onValueChange={(v) => onUpdate({ proactive: { ...draft.proactive, anchorOnchain: v } })}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={draft.proactive.anchorOnchain ? colors.textPrimary : colors.textMuted}
        />
      </View>
    </View>
  );
}
