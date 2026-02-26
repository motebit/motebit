import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from "react-native";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";

interface ConversationItem {
  conversationId: string;
  startedAt: number;
  lastActiveAt: number;
  title: string | null;
  messageCount: number;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface ConversationPanelProps {
  visible: boolean;
  app: MobileApp;
  currentConversationId: string | null;
  onLoad: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function ConversationPanel({
  visible,
  app,
  currentConversationId,
  onLoad,
  onNew,
  onClose,
}: ConversationPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);

  const refresh = useCallback(() => {
    const list = app.listConversations(50);
    setConversations(list);
  }, [app]);

  useEffect(() => {
    if (visible) {
      refresh();
    }
  }, [visible, refresh]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Conversations</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.newBtn}
              onPress={() => {
                onNew();
                onClose();
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.newBtnText}>New</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.closeBtn}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* List */}
        {conversations.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No conversations yet.</Text>
          </View>
        ) : (
          <FlatList
            data={conversations}
            keyExtractor={(item) => item.conversationId}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const isActive = item.conversationId === currentConversationId;
              return (
                <TouchableOpacity
                  style={[styles.conversationItem, isActive && styles.conversationItemActive]}
                  onPress={() => {
                    onLoad(item.conversationId);
                    onClose();
                  }}
                  activeOpacity={0.7}
                >
                  <View style={styles.conversationContent}>
                    <Text
                      style={[styles.conversationTitle, isActive && styles.conversationTitleActive]}
                      numberOfLines={1}
                    >
                      {item.title ?? "Untitled"}
                    </Text>
                    <View style={styles.metaRow}>
                      <Text style={styles.metaText}>{formatTimeAgo(item.lastActiveAt)}</Text>
                      <View style={styles.messageBadge}>
                        <Text style={styles.messageBadgeText}>{item.messageCount}</Text>
                      </View>
                    </View>
                  </View>
                  {isActive && <View style={styles.activeDot} />}
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.bgPrimary,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: Platform.OS === "ios" ? 56 : 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
    },
    headerTitle: {
      color: c.textPrimary,
      fontSize: 17,
      fontWeight: "600",
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
    },
    newBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    newBtnText: {
      color: c.buttonPrimaryText,
      fontSize: 14,
      fontWeight: "600",
    },
    closeBtn: {
      color: c.accent,
      fontSize: 16,
      fontWeight: "600",
    },

    // List
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 40,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    emptyText: {
      color: c.textMuted,
      fontSize: 14,
      fontStyle: "italic",
    },

    // Conversation item
    conversationItem: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 14,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    conversationItemActive: {
      borderColor: c.accent,
      backgroundColor: c.accentSoft,
    },
    conversationContent: {
      flex: 1,
    },
    conversationTitle: {
      color: c.textSecondary,
      fontSize: 15,
      fontWeight: "500",
      marginBottom: 4,
    },
    conversationTitleActive: {
      color: c.textPrimary,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    metaText: {
      color: c.textMuted,
      fontSize: 12,
    },
    messageBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    messageBadgeText: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: "600",
    },
    activeDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.accent,
      marginLeft: 8,
    },
  });
}
