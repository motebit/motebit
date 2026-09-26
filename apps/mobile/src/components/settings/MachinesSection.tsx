/**
 * Settings → Identity → Machines — the phone's render of the shared
 * machine-roster section (`docs/proposals/machine-roster-surfaces-v1.md`
 * S5, C-2b). Everything it says comes from `machinesModel` (unit-tested in
 * node); this file only lays it out with the settings stylesheet.
 *
 * Calm software: no toast, no confirmation on Retire (C4 — the change is
 * visible and Enroll undoes it); results and errors inline; a `needs-force`
 * enroll is an explicit second tap.
 */

import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import type { MachineRosterSection, MachineRosterSectionState } from "@motebit/surface-kit";
import { machinesModel, type MachinesNote } from "../../machines-render-model";
import { useTheme } from "../../theme";
import { useSettingsStyles } from "./settings-shared";

export interface MachinesSectionProps {
  section: MachineRosterSection;
}

export function MachinesSection({ section }: MachinesSectionProps): React.ReactElement {
  const styles = useSettingsStyles();
  const colors = useTheme();
  const [state, setState] = useState<MachineRosterSectionState>(() => section.getState());

  useEffect(() => {
    setState(section.getState());
    const unsubscribe = section.subscribe(setState);
    void section.refresh();
    return unsubscribe;
  }, [section]);

  const model = machinesModel(state);
  const force = model.confirmForce;
  const noteStyle = (n: MachinesNote) => ({
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 4,
    paddingVertical: 4,
    color:
      n.tone === "error"
        ? colors.statusWarning
        : n.tone === "done"
          ? colors.textSecondary
          : colors.textMuted,
  });
  const action = (label: string, onPress: () => void, key: string): React.ReactElement => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      disabled={model.busy}
      activeOpacity={0.7}
      style={{ opacity: model.busy ? 0.4 : 1 }}
    >
      <Text style={styles.identityCopyLabel}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View>
      <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Machines</Text>
      {model.head.map((n, i) => (
        <Text key={`h${i}`} style={noteStyle(n)}>
          {n.text}
        </Text>
      ))}
      {model.claim != null ? (
        <Text style={[styles.fieldLabel, { paddingHorizontal: 4, paddingVertical: 4 }]}>
          {model.claim}
        </Text>
      ) : null}
      {model.noCount != null ? (
        <Text style={noteStyle({ text: model.noCount, tone: "plain" })}>{model.noCount}</Text>
      ) : null}
      {model.lines.map((line, i) => (
        <View key={`${line.deviceId}-${i}`} style={[styles.identityFieldRow, { marginBottom: 6 }]}>
          <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={3}>
            {line.text}
          </Text>
          {line.retire ? action("Retire", () => void section.retire(line.deviceId), "r") : null}
          {line.enroll ? action("Enroll", () => void section.enroll(line.deviceId), "e") : null}
        </View>
      ))}
      {model.tail.map((n, i) => (
        <Text key={`t${i}`} style={noteStyle(n)}>
          {n.text}
        </Text>
      ))}
      {force != null ? (
        <View>
          <Text style={noteStyle({ text: force.text, tone: "plain" })}>{force.text}</Text>
          <View style={[styles.identityFieldRow, { justifyContent: "flex-end" }]}>
            {action(
              "Enroll anyway",
              () => void section.enroll(force.deviceId, { force: true }),
              "force",
            )}
            {action("Cancel", () => section.cancelForce(), "cancel")}
          </View>
        </View>
      ) : null}
      {model.notice != null ? (
        <Text style={noteStyle(model.notice)}>{model.notice.text}</Text>
      ) : null}
    </View>
  );
}
