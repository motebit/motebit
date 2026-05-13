/**
 * Mobile slab chrome — React Native renderer for the matrix-shaped
 * dispatcher in `../slab-chrome.ts`.
 *
 * The dispatcher returns a pure `SlabChromeCell` description; this
 * component maps each variant to a React Native subtree. The split
 * (pure description vs surface render) is the load-bearing
 * structural commitment of the mobile pivot — it makes the
 * doctrine's "each register is an information shape, not a UI
 * component" claim ([`chrome-as-state-render.md`] § "The
 * principle") legible in code. The same cell description would
 * map to a different subtree on a future spatial renderer
 * without rewriting the dispatcher.
 *
 * Mounted in `App.tsx` between the chat banner and the chat list
 * (mobile's analog of web's `controlBandSlot` on the live_browser
 * slab item). Receives the dispatched cell as a prop; renders
 * nothing — including no surround — when the cell is null. The
 * chat surface stays unchanged when the matrix is in a deferred
 * cell.
 *
 * Surface affordances dispatch typed callbacks (`onTakeWheel`,
 * `onHandBack`, `onGrant`, `onDeny`, `onResume`) rather than
 * routing through a constructed prompt — the runtime invariant
 * `surface-determinism.md` (Principle 90) holds the same way
 * `cobrowse-chrome.ts` holds it on web (dispatch typed events
 * directly into the machine, no AI-loop construction).
 */

import React, { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { SlabChromeCell } from "../slab-chrome";
import { formatUrlHostForChip } from "../slab-chrome";
import { useTheme, type ThemeColors } from "../theme";

export interface SlabChromeProps {
  /**
   * Cell description from `dispatchSlabChrome`. Null collapses the
   * chrome entirely — the chat surface renders nothing in its
   * place. The dispatcher returns null for every embodiment column
   * except `virtual_browser` in PR 2; that's the right behavior
   * for mobile chat today (no virtual_browser session → no chrome
   * → no visual weight in the layout).
   */
  readonly cell: SlabChromeCell | null;
  /**
   * `motebit-narration` chip-tap → take the wheel. Fires
   * `machine.yieldControl("user")` (mirroring `/wheel` slash). On
   * mobile the chip is the spatial-natural handoff target, same
   * doctrine cell as the web URL chip.
   */
  readonly onTakeWheel?: () => void;
  /**
   * `user-cobrowse` "motebit waiting" chip-tap → hand back. Fires
   * `machine.reclaimControl()` (mirroring `/back` slash on mobile,
   * web's `motebit:cobrowse-back` event).
   */
  readonly onHandBack?: () => void;
  /** `handoff-pending` Grant button. Fires `machine.grantControl("user")`. */
  readonly onGrant?: () => void;
  /** `handoff-pending` Deny button. Fires `machine.denyControl("user")`. */
  readonly onDeny?: () => void;
  /** `paused` Resume button. Fires `machine.resume("user")`. */
  readonly onResume?: () => void;
}

export function SlabChrome(props: SlabChromeProps): React.ReactElement | null {
  const { cell, onTakeWheel, onHandBack, onGrant, onDeny, onResume } = props;
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (cell === null) return null;

  switch (cell.kind) {
    case "motebit-narration": {
      // Empty narration register — the doctrine's "calm-default"
      // posture per `chrome-as-state-render.md` § "URL bar
      // placement." Nothing visually loud, nothing fabricated;
      // mobile recedes the strip entirely when there's no
      // narration AND no URL, matching web's "recedes to the
      // existing cobrowse middle slot" behavior.
      if (cell.narration === null && cell.currentUrl === null) return null;
      return (
        <View style={styles.container} accessibilityRole="header">
          <View style={styles.mark} />
          <View style={styles.middle}>
            {cell.narration !== null ? (
              <Text style={styles.narrationText} numberOfLines={1}>
                {cell.narration}
              </Text>
            ) : null}
            {cell.currentUrl !== null ? (
              <TouchableOpacity
                onPress={onTakeWheel}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Take the wheel — switch into cobrowse mode on ${formatUrlHostForChip(cell.currentUrl)}`}
                testID="slab-chrome-narration-url-chip"
                style={styles.urlChip}
              >
                <Text style={styles.urlChipText}>{formatUrlHostForChip(cell.currentUrl)}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      );
    }
    case "user-cobrowse": {
      return (
        <View style={styles.container} accessibilityRole="header">
          <View style={[styles.mark, styles.markDim]} />
          <View style={styles.middle}>
            {cell.currentUrl !== null ? (
              <Text style={styles.urlDisplay} numberOfLines={1}>
                {formatUrlHostForChip(cell.currentUrl)}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={onHandBack}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Hand back to motebit — motebit is watching and will resume driving"
            testID="slab-chrome-motebit-waiting-chip"
            style={styles.waitingChip}
          >
            <Text style={styles.waitingChipText}>motebit waiting</Text>
          </TouchableOpacity>
        </View>
      );
    }
    case "handoff-pending": {
      // Web's cobrowse chrome only exposes Grant/Deny when
      // `current === "user"` — the user is the one giving up
      // control. Mirror that gate here so the affordance can't
      // appear in peer-side request scenarios that a future
      // protocol revision might introduce.
      const userIsGivingUp = cell.current === "user";
      return (
        <View style={[styles.container, styles.handoffPending]} accessibilityRole="header">
          <View style={[styles.mark, styles.markAsk]} />
          <View style={styles.middle}>
            <Text style={styles.caption}>asks to drive</Text>
          </View>
          {userIsGivingUp ? (
            <View style={styles.trail}>
              <TouchableOpacity
                onPress={onGrant}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Grant control to motebit"
                testID="slab-chrome-grant"
                style={styles.primaryBtn}
              >
                <Text style={styles.primaryBtnText}>Grant</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onDeny}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Deny control request"
                testID="slab-chrome-deny"
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>Deny</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      );
    }
    case "paused": {
      return (
        <View style={styles.container} accessibilityRole="header">
          <View style={[styles.mark, styles.markHeld]} />
          <View style={styles.middle}>
            <Text style={styles.caption}>paused</Text>
          </View>
          <TouchableOpacity
            onPress={onResume}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Resume"
            testID="slab-chrome-resume"
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>Resume</Text>
          </TouchableOpacity>
        </View>
      );
    }
  }
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.bgSecondary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 10,
    },
    handoffPending: {
      borderLeftWidth: 3,
      borderLeftColor: c.accent,
    },
    mark: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: c.accent,
      flex: 0,
    },
    markDim: { opacity: 0.5 },
    markAsk: { opacity: 1 },
    markHeld: { opacity: 0.4 },
    middle: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 0,
    },
    narrationText: {
      flex: 1,
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: "500",
    },
    urlChip: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      flex: 0,
    },
    urlChipText: {
      color: c.textMuted,
      fontSize: 12,
    },
    urlDisplay: {
      color: c.textSecondary,
      fontSize: 13,
      flex: 1,
    },
    waitingChip: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      flex: 0,
    },
    waitingChipText: {
      color: c.textMuted,
      fontSize: 12,
    },
    caption: {
      color: c.textSecondary,
      fontSize: 13,
      flex: 1,
    },
    trail: {
      flexDirection: "row",
      gap: 6,
      flex: 0,
    },
    primaryBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    primaryBtnText: {
      color: c.accent,
      fontSize: 13,
      fontWeight: "600",
    },
    secondaryBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    secondaryBtnText: {
      color: c.textMuted,
      fontSize: 13,
      fontWeight: "500",
    },
  });
}
