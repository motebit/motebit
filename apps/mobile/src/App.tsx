/**
 * @motebit/mobile — React Native app
 *
 * Thin platform shell around MotebitRuntime.
 * The runtime handles AI, state, memory, rendering.
 * This file is just React Native views wired to runtime methods.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { GLView } from "expo-gl";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import { OllamaProvider } from "@motebit/ai-core";
import { createExpoStorage } from "./adapters/expo-sqlite";
import { ExpoGLAdapter } from "./adapters/expo-gl";
import { SecureStoreAdapter } from "./adapters/secure-store";

// === Types ===

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// === Runtime singleton (created once, persists across re-renders) ===

let runtimeInstance: MotebitRuntime | null = null;

function getOrCreateRuntime(): MotebitRuntime {
  if (runtimeInstance) return runtimeInstance;

  const storage = createExpoStorage("motebit.db");
  const renderer = new ExpoGLAdapter();
  const provider = new OllamaProvider({ model: "llama3.2", max_tokens: 1024, temperature: 0.7 });

  runtimeInstance = new MotebitRuntime(
    { motebitId: "mobile-local", tickRateHz: 2 },
    { storage, renderer, ai: provider, keyring: new SecureStoreAdapter() },
  );

  return runtimeInstance;
}

// === Main App Component ===

export function App(): React.ReactElement {
  const runtime = useRef<MotebitRuntime>(getOrCreateRuntime());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [state, setState] = useState<MotebitState | null>(null);
  const [cues, setCues] = useState<BehaviorCues | null>(null);
  const [initialized, setInitialized] = useState(false);
  const animFrameRef = useRef<number>(0);
  const glRef = useRef<ExpoWebGLRenderingContext | null>(null);
  const flatListRef = useRef<FlatList>(null);

  // Subscribe to state changes
  useEffect(() => {
    const rt = runtime.current;
    rt.start();
    setInitialized(true);

    const unsub = rt.subscribe((s) => {
      setState(s);
      setCues(rt.getCues());
    });

    return () => {
      unsub();
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  // GL context setup + render loop
  const onGLContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    glRef.current = gl;
    const rt = runtime.current;
    await rt.init(gl);

    let lastTime = 0;
    const animate = (time: number): void => {
      const dt = lastTime ? (time - lastTime) / 1000 : 0.016;
      lastTime = time;
      rt.renderFrame(dt, time / 1000);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
  }, []);

  // Send message
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isProcessing) return;

    const rt = runtime.current;
    setInputText("");
    setIsProcessing(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      let assistantContent = "";
      const assistantId = crypto.randomUUID();

      // Add placeholder for streaming
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "...", timestamp: Date.now() },
      ]);

      for await (const chunk of rt.sendMessageStreaming(text)) {
        if (chunk.type === "text") {
          assistantContent += chunk.text;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: assistantContent } : m,
            ),
          );
        }
      }

      // Final update
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: assistantContent || "...", timestamp: Date.now() }
            : m,
        ),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: `[Error: ${errMsg}]`, timestamp: Date.now() },
      ]);
    } finally {
      setIsProcessing(false);
    }
  }, [inputText, isProcessing]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (flatListRef.current && messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  if (!initialized) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#607080" />
        <Text style={styles.loadingText}>Initializing Motebit...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
    >
      {/* 3D Rendering */}
      <View style={styles.glContainer}>
        <GLView style={styles.glView} onContextCreate={onGLContextCreate} />
        {state && (
          <View style={styles.stateOverlay}>
            <Text style={styles.stateText}>
              attn {state.attention.toFixed(2)} · conf {state.confidence.toFixed(2)} · val {state.affect_valence.toFixed(2)}
            </Text>
          </View>
        )}
      </View>

      {/* Chat Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        style={styles.chatList}
        contentContainerStyle={styles.chatContent}
        renderItem={({ item }) => (
          <View style={[styles.messageBubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
            <Text style={[styles.messageText, item.role === "user" ? styles.userText : styles.assistantText]}>
              {item.content}
            </Text>
          </View>
        )}
      />

      {/* Input Bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Talk to your motebit..."
          placeholderTextColor="#405060"
          returnKeyType="send"
          onSubmitEditing={() => void handleSend()}
          editable={!isProcessing}
        />
        <TouchableOpacity
          style={[styles.sendButton, isProcessing && styles.sendButtonDisabled]}
          onPress={() => void handleSend()}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator size="small" color="#0a0a0a" />
          ) : (
            <Text style={styles.sendButtonText}>↑</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

// === Styles ===

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  loadingText: {
    color: "#607080",
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
  },

  // GL View
  glContainer: {
    height: 240,
    position: "relative",
  },
  glView: {
    flex: 1,
  },
  stateOverlay: {
    position: "absolute",
    bottom: 8,
    left: 12,
    right: 12,
  },
  stateText: {
    color: "#405060",
    fontSize: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },

  // Chat
  chatList: {
    flex: 1,
  },
  chatContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  messageBubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    marginVertical: 3,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#1a2a3a",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#0f1820",
  },
  messageText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userText: {
    color: "#c0d0e0",
  },
  assistantText: {
    color: "#8098b0",
  },

  // Input
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: Platform.OS === "ios" ? 28 : 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1a2030",
    backgroundColor: "#0a0a0a",
  },
  textInput: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
    backgroundColor: "#0f1820",
    color: "#c0d0e0",
    fontSize: 15,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2a4060",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: "#c0d0e0",
    fontSize: 18,
    fontWeight: "600",
  },
});
