/**
 * Tools tab — MCP server list (connected servers with tool counts,
 * trust toggles, motebit pinned public keys), add-server form, and
 * remove confirmation.
 *
 * Rendered underneath IntelligenceTab in the Intelligence pane because
 * MCP tools are the intelligence-adjacent capability surface. Kept as
 * a separate component for testability and so the prop shape mirrors
 * the desktop pattern.
 */

import React, { useCallback, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, Alert } from "react-native";
import { useTheme } from "../../theme";
import { useSettingsStyles } from "./settings-shared";

export interface ToolsTabProps {
  servers: Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
    motebitPublicKey?: string;
  }>;
  onAdd?: (url: string, name: string, trusted?: boolean, motebit?: boolean) => Promise<void>;
  onRemove?: (name: string) => Promise<void>;
  onToggleTrust?: (name: string, trusted: boolean) => Promise<void>;
}

export function ToolsTab({
  servers,
  onAdd,
  onRemove,
  onToggleTrust,
}: ToolsTabProps): React.ReactElement {
  const colors = useTheme();
  const styles = useSettingsStyles();
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTrusted, setNewTrusted] = useState(false);
  const [newMotebit, setNewMotebit] = useState(false);
  const [adding, setAdding] = useState(false);

  const handleConnect = useCallback(async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url || !onAdd) return;

    try {
      new URL(url);
    } catch {
      Alert.alert("Invalid URL", "Please enter a valid server URL.");
      return;
    }

    setAdding(true);
    try {
      await onAdd(url, name, newTrusted, newMotebit);
      setNewName("");
      setNewUrl("");
      setNewTrusted(false);
      setNewMotebit(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("Connection Failed", msg);
    } finally {
      setAdding(false);
    }
  }, [newName, newUrl, newTrusted, newMotebit, onAdd]);

  const handleRemove = useCallback(
    (name: string) => {
      Alert.alert("Remove Server", `Disconnect and remove "${name}"?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void onRemove?.(name),
        },
      ]);
    },
    [onRemove],
  );

  return (
    <View>
      <Text style={styles.sectionTitle}>MCP Servers</Text>
      {servers.length === 0 ? (
        <Text style={styles.toolsEmptyText}>
          No MCP servers connected. Add an HTTP MCP server to extend your motebit's capabilities.
        </Text>
      ) : (
        servers.map((server) => (
          <View key={server.name} style={styles.toolsServerRow}>
            <View style={styles.toolsServerInfo}>
              <View style={styles.toolsServerHeader}>
                <View
                  style={[
                    styles.toolsStatusDot,
                    {
                      backgroundColor: server.connected ? colors.statusSuccess : colors.statusError,
                    },
                  ]}
                />
                <Text style={styles.toolsServerName}>{server.name}</Text>
                {server.toolCount > 0 && (
                  <View style={styles.toolsCountBadge}>
                    <Text style={styles.toolsCountText}>{server.toolCount}</Text>
                  </View>
                )}
                {server.trusted && (
                  <View style={styles.toolsTrustBadge}>
                    <Text style={styles.toolsTrustText}>trusted</Text>
                  </View>
                )}
              </View>
              <Text style={styles.toolsServerUrl} numberOfLines={1}>
                {server.url}
              </Text>
              <View style={styles.toolsTrustRow}>
                <Text style={styles.toolsTrustLabel}>Auto-approve tools</Text>
                <Switch
                  value={server.trusted}
                  onValueChange={(v) => void onToggleTrust?.(server.name, v)}
                  trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
                  thumbColor={server.trusted ? colors.textPrimary : colors.textMuted}
                />
              </View>
              {server.motebit && (
                <View style={styles.toolsTrustRow}>
                  <Text style={styles.toolsTrustLabel}>Motebit</Text>
                  <Text style={[styles.toolsTrustLabel, { opacity: 0.7 }]}>Yes</Text>
                </View>
              )}
              {server.motebit && server.motebitPublicKey ? (
                <View style={styles.toolsTrustRow}>
                  <Text style={styles.toolsTrustLabel}>Pinned Public Key</Text>
                  <Text style={[styles.toolsTrustLabel, { opacity: 0.7 }]} numberOfLines={1}>
                    {server.motebitPublicKey.slice(0, 16)}...
                  </Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => handleRemove(server.name)}
              activeOpacity={0.7}
              style={styles.toolsRemoveBtn}
            >
              <Text style={styles.toolsRemoveText}>X</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>Add Server</Text>
      <TextInput
        style={styles.textField}
        value={newName}
        onChangeText={setNewName}
        placeholder="Server name"
        placeholderTextColor={colors.inputPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={{ height: 8 }} />
      <TextInput
        style={styles.textField}
        value={newUrl}
        onChangeText={setNewUrl}
        placeholder="https://example.com/mcp"
        placeholderTextColor={colors.inputPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <View style={styles.toolsTrustRow}>
        <Text style={styles.toolsTrustLabel}>Trusted (auto-approve all tools)</Text>
        <Switch
          value={newTrusted}
          onValueChange={setNewTrusted}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={newTrusted ? colors.textPrimary : colors.textMuted}
        />
      </View>
      <View style={styles.toolsTrustRow}>
        <Text style={styles.toolsTrustLabel}>Motebit</Text>
        <Switch
          value={newMotebit}
          onValueChange={setNewMotebit}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={newMotebit ? colors.textPrimary : colors.textMuted}
        />
      </View>

      <TouchableOpacity
        style={[
          styles.toolsConnectBtn,
          (!newName.trim() || !newUrl.trim() || adding) && styles.toolsConnectBtnDisabled,
        ]}
        onPress={() => void handleConnect()}
        disabled={!newName.trim() || !newUrl.trim() || adding}
        activeOpacity={0.7}
      >
        <Text style={styles.toolsConnectText}>{adding ? "Connecting..." : "Connect"}</Text>
      </TouchableOpacity>

      <Text style={styles.toolsNote}>
        Mobile supports HTTP MCP servers only. Stdio servers require the desktop or CLI app.
        {"\n"}Untrusted servers require approval for each tool call.
      </Text>
    </View>
  );
}
