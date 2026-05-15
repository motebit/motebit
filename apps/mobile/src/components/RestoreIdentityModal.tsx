/**
 * Restore-identity modal — mobile. Sibling of the web/desktop flows
 * (apps/web/src/ui/restore-identity.ts,
 *  apps/desktop/src/ui/restore-identity.ts). Same three-layer split:
 *
 *   1. `MobileApp.importMotebitMd(content)` — pure read.
 *   2. UI-side guard: derive public key from pasted seed, compare to
 *      metadata.publicKey. Match is the precondition for any restore.
 *   3. `MobileApp.restoreIdentity(request)` — side-effecting; writes
 *      keystore + config via SecureStore; returns `needsReload: true`.
 *      Caller signals user to fully close + reopen the app.
 *
 * Per [[identity_restore_arc]] design call #1: hard overwrite + type-
 * to-confirm `REPLACE IDENTITY`. Per call #3: clear-by-default (via
 * natural filtering — old rows keyed to the prior motebit_id are
 * invisible under the new identity); the preserve checkbox opts into
 * the cross-store re-key migration shipped in `migrateMotebitIdExpo`
 * (apps/mobile/src/adapters/expo-sqlite.ts).
 */

import React, { useState } from "react";
import { Modal, View, Text, TouchableOpacity, TextInput, Alert, ScrollView } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { hexToBytes, bytesToHex, getPublicKeyBySuite } from "@motebit/encryption";
import type { ImportedIdentityMetadata, RestoreIdentityResult } from "@motebit/identity-file";

import type { MobileApp } from "../mobile-app";
import { useSettingsStyles } from "./settings/settings-shared";

export interface RestoreIdentityModalProps {
  visible: boolean;
  /** Which entry point is being used. The file path opens the file
   *  picker first; the seed path skips straight to the seed paste and
   *  synthesizes minimal metadata after a valid seed is entered. */
  mode: "file" | "seed";
  app: MobileApp;
  onClose: () => void;
  /** Fires after a successful restore. Parent should prompt the user to
   *  fully close + reopen the app so bootstrap picks up the new identity. */
  onRestored: () => void;
}

function synthesizeSeedOnlyMetadata(publicKeyHex: string): ImportedIdentityMetadata {
  return {
    motebitId:
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`,
    publicKey: publicKeyHex,
    ownerId: "Mobile",
    bornAt: new Date().toISOString(),
    devices: [],
    governance: {
      trust_mode: "guarded",
      max_risk_auto: "R1_DRAFT",
      require_approval_above: "R1_DRAFT",
      deny_above: "R4_MONEY",
      operator_mode: false,
    },
    memory: { half_life_days: 7, confidence_threshold: 0.3, per_turn_limit: 5 },
  };
}

function relativeBornAt(bornAt: string): string {
  const ms = Date.now() - Date.parse(bornAt);
  if (!Number.isFinite(ms)) return bornAt;
  const days = Math.floor(ms / 86400000);
  if (days < 0) return bornAt;
  if (days < 1) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function shortAddress(pubHex: string): string {
  if (pubHex.length < 12) return pubHex;
  return `${pubHex.slice(0, 6)}…${pubHex.slice(-4)}`;
}

export function RestoreIdentityModal({
  visible,
  mode,
  app,
  onClose,
  onRestored,
}: RestoreIdentityModalProps): React.ReactElement {
  const styles = useSettingsStyles();
  const [metadata, setMetadata] = useState<ImportedIdentityMetadata | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [seed, setSeed] = useState("");
  const [confirm, setConfirm] = useState("");
  const [seedStatus, setSeedStatus] = useState<{ kind: "none" | "ok" | "err"; text: string }>({
    kind: "none",
    text: "",
  });
  const [derivedPrivateKey, setDerivedPrivateKey] = useState<string | null>(null);
  const [preserveMemories, setPreserveMemories] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setMetadata(null);
    setOriginalContent(null);
    setSeed("");
    setConfirm("");
    setSeedStatus({ kind: "none", text: "" });
    setDerivedPrivateKey(null);
    setPreserveMemories(false);
    setErrorMsg(null);
    setBusy(false);
  }

  /** Validate a pasted seed (length + hex), derive its public key, and
   *  if valid synthesize metadata + advance to the preview step. Used by
   *  the seed-only mode entry point — no .md file, no public-key guard
   *  rail (the seed IS the authority). */
  async function handleSeedOnlyNext(): Promise<void> {
    const trimmed = seed.trim();
    if (trimmed.length !== 64 || !/^[0-9a-fA-F]+$/.test(trimmed)) return;
    try {
      const privBytes = hexToBytes(trimmed);
      const pubBytes = await getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1");
      const pubHex = bytesToHex(pubBytes);
      const synthesized = synthesizeSeedOnlyMetadata(pubHex);
      setMetadata(synthesized);
      setOriginalContent(null);
      setDerivedPrivateKey(trimmed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSeedStatus({ kind: "err", text: `Could not derive key — ${msg}` });
    }
  }

  function evaluateSeedOnlyFormat(value: string): void {
    setSeed(value);
    const trimmed = value.trim();
    if (trimmed === "") {
      setSeedStatus({ kind: "none", text: "" });
      return;
    }
    if (trimmed.length !== 64) {
      setSeedStatus({ kind: "none", text: `${trimmed.length}/64 hex chars` });
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      setSeedStatus({ kind: "err", text: "Seed must be 64 hex characters" });
      return;
    }
    setSeedStatus({ kind: "ok", text: "✓ Valid seed" });
  }

  function handleClose(): void {
    reset();
    onClose();
  }

  async function handlePickFile(): Promise<void> {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["text/markdown", "text/plain", "*/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0]!;
      const content = await FileSystem.readAsStringAsync(asset.uri);
      const imported = await app.importMotebitMd(content);
      if (!imported.valid) {
        Alert.alert("Could not import", imported.reason);
        return;
      }
      setMetadata(imported.metadata);
      setOriginalContent(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("File error", msg);
    }
  }

  async function evaluateSeed(value: string): Promise<void> {
    setSeed(value);
    setDerivedPrivateKey(null);
    const trimmed = value.trim();
    if (trimmed === "") {
      setSeedStatus({ kind: "none", text: "" });
      return;
    }
    if (trimmed.length !== 64) {
      setSeedStatus({ kind: "none", text: `${trimmed.length}/64 hex chars` });
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      setSeedStatus({ kind: "err", text: "Seed must be 64 hex characters" });
      return;
    }
    if (metadata === null) return;
    try {
      const privBytes = hexToBytes(trimmed);
      const pubBytes = await getPublicKeyBySuite(privBytes, "motebit-jcs-ed25519-hex-v1");
      const derivedPubHex = bytesToHex(pubBytes);
      if (derivedPubHex.toLowerCase() === metadata.publicKey.toLowerCase()) {
        setSeedStatus({ kind: "ok", text: "✓ Seed matches this identity" });
        setDerivedPrivateKey(trimmed);
      } else {
        setSeedStatus({
          kind: "err",
          text: "Seed does not match this motebit.md (different identity)",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSeedStatus({ kind: "err", text: `Could not derive key — ${msg}` });
    }
  }

  async function handleReplace(): Promise<void> {
    if (metadata === null || derivedPrivateKey === null) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const result: RestoreIdentityResult = await app.restoreIdentity({
        privateKeyHex: derivedPrivateKey,
        metadata,
        originalContent: originalContent ?? undefined,
        preserveMemories,
      });
      if (result.ok) {
        onRestored();
        reset();
      } else {
        setErrorMsg(`Restore failed — ${result.reason}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Restore failed — ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  const matchesPhrase = confirm.trim() === "REPLACE IDENTITY";
  const replaceEnabled = derivedPrivateKey !== null && matchesPhrase && !busy;
  const showPreviewStep = metadata !== null;
  const seedOnlyMode = mode === "seed";
  const seedFormatValid = seed.trim().length === 64 && /^[0-9a-fA-F]+$/.test(seed.trim());

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={handleClose}
    >
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
        {!showPreviewStep && !seedOnlyMode ? (
          <>
            <Text style={[styles.sectionTitle, { fontSize: 18, marginBottom: 12 }]}>
              Restore from motebit.md
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: "#888",
                lineHeight: 19,
                marginBottom: 20,
              }}
            >
              Select your motebit.md backup file. You'll provide your recovery seed in the next step
              to complete the restore.
            </Text>
            <TouchableOpacity
              style={[styles.exportButton, { marginBottom: 8 }]}
              onPress={() => void handlePickFile()}
              activeOpacity={0.7}
            >
              <Text style={styles.exportText}>Choose file…</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.exportButton} onPress={handleClose} activeOpacity={0.7}>
              <Text style={styles.exportText}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : !showPreviewStep && seedOnlyMode ? (
          <>
            <Text style={[styles.sectionTitle, { fontSize: 18, marginBottom: 12 }]}>
              Restore from recovery seed
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: "#888",
                lineHeight: 19,
                marginBottom: 16,
              }}
            >
              Paste your 64-hex-char recovery seed. The original motebit_id cannot be recovered from
              the seed alone — a new one will be assigned. Your cryptographic identity (private key
              + Solana address + funds) is preserved.
            </Text>
            <Text style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
              Recovery seed (64 hex chars)
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: "#3a3a3c",
                borderRadius: 10,
                padding: 10,
                color: "#fff",
                fontFamily: "monospace",
                fontSize: 12,
                marginBottom: 4,
              }}
              value={seed}
              onChangeText={evaluateSeedOnlyFormat}
              placeholder="Paste your recovery seed"
              placeholderTextColor="#555"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text
              style={{
                fontSize: 11,
                color:
                  seedStatus.kind === "ok"
                    ? "#6e82f0"
                    : seedStatus.kind === "err"
                      ? "#f0a030"
                      : "#888",
                marginBottom: 16,
                minHeight: 14,
              }}
            >
              {seedStatus.text}
            </Text>
            <TouchableOpacity
              style={[
                styles.exportButton,
                {
                  marginBottom: 8,
                  opacity: seedFormatValid ? 1 : 0.45,
                  backgroundColor: seedFormatValid ? "#6e82f0" : undefined,
                },
              ]}
              onPress={() => void handleSeedOnlyNext()}
              activeOpacity={0.7}
              disabled={!seedFormatValid}
            >
              <Text style={[styles.exportText, seedFormatValid && { color: "#fff" }]}>Next</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.exportButton} onPress={handleClose} activeOpacity={0.7}>
              <Text style={styles.exportText}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { fontSize: 18, marginBottom: 12 }]}>
              Restore identity
            </Text>
            <Text
              style={{
                fontSize: 13,
                color: "#888",
                marginBottom: 8,
              }}
            >
              Restoring will activate:
            </Text>
            {seedOnlyMode ? (
              <Text
                style={{
                  fontSize: 11,
                  color: "#f0a030",
                  backgroundColor: "rgba(240, 160, 48, 0.08)",
                  padding: 10,
                  borderRadius: 8,
                  marginBottom: 12,
                  lineHeight: 16,
                }}
              >
                ⚠ Seed-only restore — original motebit_id not recoverable, a new one will be
                assigned.
              </Text>
            ) : null}
            <View
              style={{
                backgroundColor: "#1c1c1e",
                borderRadius: 10,
                padding: 12,
                marginBottom: 16,
              }}
            >
              <Text
                style={{ color: "#fff", fontFamily: "monospace", fontSize: 12, lineHeight: 18 }}
              >
                <Text style={{ color: "#888" }}>motebit </Text>
                {metadata!.motebitId.slice(0, 12)}…{"\n"}
                <Text style={{ color: "#888" }}>Born </Text>
                {relativeBornAt(metadata!.bornAt)}
                {"\n"}
                <Text style={{ color: "#888" }}>Solana </Text>◆ {shortAddress(metadata!.publicKey)}
              </Text>
            </View>

            {seedOnlyMode ? null : (
              <>
                <Text
                  style={{
                    fontSize: 11,
                    color: "#888",
                    marginBottom: 4,
                  }}
                >
                  Recovery seed (64 hex chars)
                </Text>
                <TextInput
                  style={{
                    borderWidth: 1,
                    borderColor: "#3a3a3c",
                    borderRadius: 10,
                    padding: 10,
                    color: "#fff",
                    fontFamily: "monospace",
                    fontSize: 12,
                    marginBottom: 4,
                  }}
                  value={seed}
                  onChangeText={(v) => void evaluateSeed(v)}
                  placeholder="Paste your recovery seed"
                  placeholderTextColor="#555"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Text
                  style={{
                    fontSize: 11,
                    color:
                      seedStatus.kind === "ok"
                        ? "#6e82f0"
                        : seedStatus.kind === "err"
                          ? "#f0a030"
                          : "#888",
                    marginBottom: 16,
                    minHeight: 14,
                  }}
                >
                  {seedStatus.text}
                </Text>
              </>
            )}

            <TouchableOpacity
              onPress={() => setPreserveMemories(!preserveMemories)}
              activeOpacity={0.7}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                marginBottom: 16,
              }}
            >
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  borderWidth: 1,
                  borderColor: preserveMemories ? "#6e82f0" : "#3a3a3c",
                  backgroundColor: preserveMemories ? "#6e82f0" : "transparent",
                  marginRight: 8,
                  marginTop: 2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {preserveMemories ? (
                  <Text style={{ color: "#fff", fontSize: 11, lineHeight: 14 }}>✓</Text>
                ) : null}
              </View>
              <Text style={{ flex: 1, color: "#aaa", fontSize: 12, lineHeight: 17 }}>
                Preserve memories
                <Text style={{ color: "#666" }}>
                  {"\n"}Severs cryptographic chain to original signing identity
                </Text>
              </Text>
            </TouchableOpacity>

            <Text
              style={{
                fontSize: 11,
                color: "#f0a030",
                backgroundColor: "rgba(240, 160, 48, 0.08)",
                padding: 10,
                borderRadius: 8,
                marginBottom: 16,
                lineHeight: 16,
              }}
            >
              This replaces your current identity. Funds, credentials, and trust currently on this
              device will be ORPHANED. Cannot be undone.
            </Text>

            <Text style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
              Type <Text style={{ fontWeight: "600", color: "#fff" }}>REPLACE IDENTITY</Text> to
              confirm
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: "#3a3a3c",
                borderRadius: 10,
                padding: 10,
                color: "#fff",
                fontFamily: "monospace",
                fontSize: 12,
                marginBottom: 16,
              }}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="REPLACE IDENTITY"
              placeholderTextColor="#555"
              autoCapitalize="characters"
              autoCorrect={false}
            />

            {errorMsg != null ? (
              <Text style={{ color: "#f06030", fontSize: 12, marginBottom: 12 }}>{errorMsg}</Text>
            ) : null}

            <TouchableOpacity
              style={[
                styles.exportButton,
                {
                  marginBottom: 8,
                  opacity: replaceEnabled ? 1 : 0.45,
                  backgroundColor: replaceEnabled ? "#6e82f0" : undefined,
                },
              ]}
              onPress={() => void handleReplace()}
              activeOpacity={0.7}
              disabled={!replaceEnabled}
            >
              <Text style={[styles.exportText, replaceEnabled && { color: "#fff" }]}>
                {busy ? "Restoring…" : "Replace identity"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.exportButton} onPress={handleClose} activeOpacity={0.7}>
              <Text style={styles.exportText}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </Modal>
  );
}
