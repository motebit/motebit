import React, { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Show or switch model" },
  { name: "conversations", description: "Browse conversations" },
  { name: "new", description: "New conversation" },
  { name: "memories", description: "Browse memories" },
  { name: "state", description: "Show state vector" },
  { name: "gradient", description: "Intelligence gradient + self-model" },
  { name: "audit", description: "Audit memory integrity" },
  { name: "reflect", description: "Trigger reflection" },
  { name: "graph", description: "Memory graph stats" },
  { name: "curious", description: "Fading memories" },
  { name: "forget", description: "Delete a memory" },
  { name: "clear", description: "Clear conversation" },
  { name: "tools", description: "List registered tools" },
  { name: "agents", description: "Trusted agents" },
  { name: "discover", description: "Discover agents on relay" },
  { name: "serve", description: "Toggle accepting delegations" },
  { name: "goals", description: "Browse goals" },
  { name: "skills", description: "Browse and install skills" },
  { name: "plan", description: "Break down a complex goal" },
  { name: "balance", description: "Account balance" },
  { name: "operator", description: "Operator mode status" },
  { name: "summarize", description: "Summarize conversation" },
  { name: "sync", description: "Sync with relay" },
  { name: "export", description: "Export all data" },
  { name: "settings", description: "Open settings" },
  { name: "help", description: "Show commands" },
];

function filterCommands(partial: string): SlashCommand[] {
  if (!partial) return SLASH_COMMANDS;
  const query = partial.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

interface SlashAutocompleteProps {
  inputText: string;
  onSelect: (command: string) => void;
}

export function SlashAutocomplete({
  inputText,
  onSelect,
}: SlashAutocompleteProps): React.ReactElement | null {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (!inputText.startsWith("/")) return null;

  const partial = inputText.slice(1);
  const matches = filterCommands(partial);

  if (matches.length === 0) return null;

  // Don't show if input exactly matches a command (already selected)
  if (matches.length === 1 && matches[0]!.name === partial) return null;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="always">
        {matches.map((cmd) => (
          <TouchableOpacity
            key={cmd.name}
            style={styles.item}
            onPress={() => onSelect(cmd.name)}
            activeOpacity={0.6}
          >
            <Text style={styles.name}>/{cmd.name}</Text>
            <Text style={styles.desc}>{cmd.description}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      maxHeight: 200,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderLight,
      backgroundColor: c.bgTertiary,
    },
    scroll: {
      flexGrow: 0,
    },
    item: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 10,
    },
    name: {
      color: c.textSecondary,
      fontSize: 14,
      fontWeight: "500",
      flexShrink: 0,
    },
    desc: {
      color: c.textGhost,
      fontSize: 12,
      flex: 1,
    },
  });
}
