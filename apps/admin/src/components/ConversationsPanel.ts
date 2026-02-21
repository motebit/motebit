import React, { useState, useCallback } from "react";
import type { ConversationEntry, ConversationMessageEntry } from "../api";
import { fetchConversationMessages } from "../api";

function truncate(s: string | null, maxLen: number): string {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

export function ConversationsPanel({ conversations }: { conversations: ConversationEntry[] }): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessageEntry[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const handleToggle = useCallback(async (conversationId: string) => {
    if (expandedId === conversationId) {
      setExpandedId(null);
      setMessages([]);
      return;
    }
    setExpandedId(conversationId);
    setLoadingMessages(true);
    try {
      const res = await fetchConversationMessages(conversationId);
      setMessages(res.messages);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, [expandedId]);

  const recent = [...conversations].sort((a, b) => b.last_active_at - a.last_active_at).slice(0, 30);

  return React.createElement("div", { className: "panel" },
    React.createElement("h2", null, "Conversations"),
    React.createElement("div", { className: "count" }, `${conversations.length} conversations total`),
    ...recent.map((c) =>
      React.createElement("div", { key: c.conversation_id, className: "conversation-entry" },
        React.createElement("div", {
          className: "conversation-header",
          onClick: () => { void handleToggle(c.conversation_id); },
          style: { cursor: "pointer" },
        },
          React.createElement("span", { className: "conversation-title" },
            c.title || "Untitled conversation",
          ),
          React.createElement("span", { className: "conversation-count" },
            `${c.message_count} messages`,
          ),
          React.createElement("span", { className: "timestamp" },
            new Date(c.last_active_at).toISOString(),
          ),
          React.createElement("span", { className: "expand-indicator" },
            expandedId === c.conversation_id ? "\u25B2" : "\u25BC",
          ),
        ),
        expandedId === c.conversation_id
          ? React.createElement("div", { className: "conversation-messages" },
            loadingMessages
              ? React.createElement("div", { className: "loading" }, "Loading messages...")
              : messages.length === 0
                ? React.createElement("div", { className: "empty" }, "No messages")
                : messages.map((m) =>
                  React.createElement("div", {
                    key: m.message_id,
                    className: `message message-${m.role}`,
                  },
                    React.createElement("span", { className: "message-role" }, m.role),
                    React.createElement("span", { className: "message-content" },
                      truncate(m.content, 500),
                    ),
                    React.createElement("span", { className: "timestamp" },
                      new Date(m.created_at).toISOString(),
                    ),
                  ),
                ),
          )
          : null,
      ),
    ),
  );
}
