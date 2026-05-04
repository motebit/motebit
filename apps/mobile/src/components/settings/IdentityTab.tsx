/**
 * Identity tab — displays motebit ID, DID, device ID, public key with
 * copy-to-clipboard; actions for rotate key, link device, export
 * identity file, export all data, open docs.
 */

import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, Clipboard, Linking, Alert } from "react-native";
import { hexPublicKeyToDidKey } from "@motebit/encryption";
import { useSettingsStyles } from "./settings-shared";

export interface IdentityTabProps {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  /** Sovereign wallet Solana address (from runtime.getSolanaAddress()). Null when no rail. */
  solanaAddress?: string | null;
  /** Sync state — drives the SYNC badge. Mirrors desktop's
   *  identity-sync-status. Caller passes mobileApp.syncStatus; React-side
   *  re-renders happen when the parent re-renders with a new value. */
  syncStatus?: "idle" | "syncing" | "error" | "offline";
  /** Reveal the 64-char hex private seed from secure-store. The caller wires
   *  this to MobileApp.revealRecoverySeed; the UI handles confirm + copy +
   *  auto-hide. */
  onRevealRecoverySeed?: () => Promise<string | null>;
  onExport: () => void;
  onExportIdentity?: () => void;
  onLinkDevice?: () => void;
  onRotateKey?: () => void;
}

const RECOVERY_SEED_AUTOHIDE_MS = 60_000;

export function IdentityTab({
  motebitId,
  deviceId,
  publicKey,
  solanaAddress,
  syncStatus,
  onRevealRecoverySeed,
  onExport,
  onExportIdentity,
  onLinkDevice,
  onRotateKey,
}: IdentityTabProps): React.ReactElement {
  const styles = useSettingsStyles();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Always clear the auto-hide timer when the component unmounts so the
  // seed never lingers after the user closes settings.
  useEffect(() => {
    return () => {
      if (autoHideTimer.current != null) clearTimeout(autoHideTimer.current);
    };
  }, []);

  function clearRevealedSeed(): void {
    setRevealedSeed(null);
    if (autoHideTimer.current != null) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }
  }

  function handleRevealSeed(): void {
    if (onRevealRecoverySeed == null) return;
    Alert.alert(
      "Reveal recovery seed?",
      "Anyone with this string can sign as your motebit forever and spend any SOL at your sovereign address. Make sure no one else can see your screen.\n\nThe seed will auto-hide in 60 seconds.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reveal",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                const seed = await onRevealRecoverySeed();
                if (seed == null || seed === "") {
                  Alert.alert("No seed found", "The keyring is empty.");
                  return;
                }
                setRevealedSeed(seed);
                if (autoHideTimer.current != null) clearTimeout(autoHideTimer.current);
                autoHideTimer.current = setTimeout(() => {
                  setRevealedSeed(null);
                  autoHideTimer.current = null;
                }, RECOVERY_SEED_AUTOHIDE_MS);
              } catch (err: unknown) {
                Alert.alert("Reveal failed", err instanceof Error ? err.message : String(err));
              }
            })();
          },
        },
      ],
    );
  }

  let did = "";
  try {
    if (publicKey) did = hexPublicKeyToDidKey(publicKey);
  } catch {
    // Non-fatal
  }

  const copyToClipboard = (field: string, value: string): void => {
    Clipboard.setString(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1500);
  };

  return (
    <View>
      <Text style={styles.sectionTitle}>Motebit ID</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("motebitId", motebitId)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={1}>
          {motebitId}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "motebitId" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "motebitId" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      {did ? (
        <>
          <Text style={styles.sectionTitle}>DID</Text>
          <TouchableOpacity
            onPress={() => copyToClipboard("did", did)}
            style={styles.identityFieldRow}
          >
            <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
              {did}
            </Text>
            <Text
              style={[
                styles.identityCopyLabel,
                copiedField === "did" && styles.identityCopiedLabel,
              ]}
            >
              {copiedField === "did" ? "Copied!" : "Copy"}
            </Text>
          </TouchableOpacity>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Device ID</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("deviceId", deviceId)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={1}>
          {deviceId}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "deviceId" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "deviceId" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Public Key</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("publicKey", publicKey)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
          {publicKey || "(not generated)"}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "publicKey" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "publicKey" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Sync</Text>
      <View style={styles.identityFieldRow}>
        <Text style={styles.identityFieldValue}>
          {syncStatus === "idle"
            ? "Connected"
            : syncStatus === "syncing"
              ? "Syncing…"
              : syncStatus === "error"
                ? "Error"
                : "Not connected"}
        </Text>
      </View>

      {solanaAddress ? (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Sovereign Wallet</Text>
          <TouchableOpacity
            onPress={() => copyToClipboard("solanaAddress", solanaAddress)}
            style={styles.identityFieldRow}
          >
            <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
              {solanaAddress}
            </Text>
            <Text
              style={[
                styles.identityCopyLabel,
                copiedField === "solanaAddress" && styles.identityCopiedLabel,
              ]}
            >
              {copiedField === "solanaAddress" ? "Copied!" : "Copy"}
            </Text>
          </TouchableOpacity>
          <Text
            style={{
              fontSize: 11,
              color: "#888",
              paddingHorizontal: 12,
              paddingBottom: 8,
            }}
          >
            The address <Text style={{ fontStyle: "italic" }}>is</Text> your Ed25519 public key,
            base58-encoded — one key, two uses, by mathematical coincidence. No relay, no custody,
            no intermediary. See the Sovereign panel for live balance and funding.
          </Text>
        </>
      ) : null}

      {onRevealRecoverySeed != null ? (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Recovery Seed</Text>
          {revealedSeed == null ? (
            <TouchableOpacity
              onPress={handleRevealSeed}
              style={styles.identityFieldRow}
              activeOpacity={0.7}
            >
              <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={1}>
                — hidden —
              </Text>
              <Text style={styles.identityCopyLabel}>Reveal</Text>
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity
                onPress={() => copyToClipboard("recoverySeed", revealedSeed)}
                style={styles.identityFieldRow}
                activeOpacity={0.7}
              >
                <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
                  {revealedSeed}
                </Text>
                <Text
                  style={[
                    styles.identityCopyLabel,
                    copiedField === "recoverySeed" && styles.identityCopiedLabel,
                  ]}
                >
                  {copiedField === "recoverySeed" ? "Copied!" : "Copy"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={clearRevealedSeed}
                style={styles.identityFieldRow}
                activeOpacity={0.7}
              >
                <Text style={[styles.identityFieldValue, { textAlign: "center" }]}>Hide now</Text>
              </TouchableOpacity>
            </>
          )}
          <Text
            style={{
              fontSize: 11,
              color: "#888",
              paddingHorizontal: 12,
              paddingBottom: 8,
              lineHeight: 16,
            }}
          >
            Anyone with this string can sign as your motebit forever and spend any SOL at your
            sovereign address. Save it in a password manager (1Password, Bitwarden, paper backup)
            and never paste it in chat, email, or screenshots. Lose it without a paired device or
            guardian — the identity is gone, no recovery path. Auto-hides after 60 seconds.
          </Text>
        </>
      ) : null}

      {onRotateKey && (
        <TouchableOpacity style={styles.rotateKeyButton} onPress={onRotateKey} activeOpacity={0.7}>
          <Text style={styles.rotateKeyText}>Rotate Key</Text>
        </TouchableOpacity>
      )}

      {onLinkDevice && (
        <TouchableOpacity
          style={styles.linkDeviceButton}
          onPress={onLinkDevice}
          activeOpacity={0.7}
        >
          <Text style={styles.linkDeviceText}>Link Another Device</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.docsButton}
        onPress={() => void Linking.openURL("https://docs.motebit.com")}
        activeOpacity={0.7}
      >
        <Text style={styles.docsText}>Documentation</Text>
      </TouchableOpacity>

      {onExportIdentity && (
        <TouchableOpacity
          style={styles.exportButton}
          onPress={onExportIdentity}
          activeOpacity={0.7}
        >
          <Text style={styles.exportText}>Export Identity</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.exportButton} onPress={onExport} activeOpacity={0.7}>
        <Text style={styles.exportText}>Export All Data</Text>
      </TouchableOpacity>
    </View>
  );
}
