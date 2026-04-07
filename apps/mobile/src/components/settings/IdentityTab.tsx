/**
 * Identity tab — displays motebit ID, DID, device ID, public key with
 * copy-to-clipboard; actions for rotate key, link device, export
 * identity file, export all data, open docs.
 *
 * Extracted from SettingsModal.tsx.
 */

import React, { useState } from "react";
import { View, Text, TouchableOpacity, Clipboard, Linking } from "react-native";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import { useSettingsStyles } from "./settings-shared";

export interface IdentityTabProps {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  onExport: () => void;
  onExportIdentity?: () => void;
  onLinkDevice?: () => void;
  onRotateKey?: () => void;
}

export function IdentityTab({
  motebitId,
  deviceId,
  publicKey,
  onExport,
  onExportIdentity,
  onLinkDevice,
  onRotateKey,
}: IdentityTabProps): React.ReactElement {
  const styles = useSettingsStyles();
  const [copiedField, setCopiedField] = useState<string | null>(null);

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
