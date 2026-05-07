/**
 * ConversationManager — sensitivity floor on persisted messages.
 *
 * The fifth (and final) closure of the egress-shape arc. Messages
 * persisted during a high-tier turn (effective sensitivity elevated
 * above the static operator-manifest default) MUST carry their
 * actual provenance tier rather than the static default — otherwise
 * cross-device sync + retrieval at None tier would surface them in
 * trimmed history and ship to BYOK.
 *
 * Doctrine: motebit-computer.md §"Mode contract" + the closure of
 * the conversation-write boundary in the egress-shape arc (parallel
 * to memory-write floor in ai-core/loop.ts and tool-result
 * classification in motebit-runtime.ts).
 */

import { describe, expect, it, vi } from "vitest";
import { ConversationManager, type ConversationDeps } from "../conversation.js";
import type { ConversationStoreAdapter } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";

interface CapturedMessage {
  role: string;
  content: string;
  sensitivity?: SensitivityLevel;
}

function makeCapturingStore(): ConversationStoreAdapter & { _captured: CapturedMessage[] } {
  const captured: CapturedMessage[] = [];
  let nextId = 0;
  return {
    _captured: captured,
    createConversation(_motebitId: string): string {
      nextId += 1;
      return `conv-${nextId}`;
    },
    appendMessage(_conversationId, _motebitId, msg): void {
      captured.push({ role: msg.role, content: msg.content, sensitivity: msg.sensitivity });
    },
    loadMessages() {
      return [];
    },
    getActiveConversation() {
      return null;
    },
    updateSummary() {},
    updateTitle() {},
    listConversations() {
      return [];
    },
    deleteConversation() {},
  };
}

function makeDeps(
  store: ReturnType<typeof makeCapturingStore>,
  overrides: Partial<ConversationDeps> = {},
): ConversationDeps {
  const provider = { generate: vi.fn() } as unknown as NonNullable<
    ReturnType<ConversationDeps["getProvider"]>
  >;
  return {
    motebitId: "mb-1",
    maxHistory: 100,
    summarizeAfterMessages: 50,
    store,
    getProvider: () => provider,
    getTaskRouter: () => null,
    generateCompletion: vi.fn(async () => "AI Title"),
    ...overrides,
  };
}

describe("ConversationManager — sensitivity floor on persisted messages", () => {
  it("absent getter: pushExchange tags messages at the static default", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, { defaultSensitivity: SensitivityLevel.Personal });
    const cm = new ConversationManager(deps);
    cm.pushExchange("user msg", "assistant reply");
    expect(store._captured).toHaveLength(2);
    expect(store._captured[0]!.sensitivity).toBe(SensitivityLevel.Personal);
    expect(store._captured[1]!.sensitivity).toBe(SensitivityLevel.Personal);
  });

  it("default-only fallback when getter returns None: keeps default", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => SensitivityLevel.None,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("hello", "hi");
    expect(store._captured.every((m) => m.sensitivity === SensitivityLevel.Personal)).toBe(true);
  });

  it("default higher than effective: default wins (max composition)", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Medical,
      getEffectiveSensitivity: () => SensitivityLevel.Personal,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("hello", "hi");
    expect(store._captured.every((m) => m.sensitivity === SensitivityLevel.Medical)).toBe(true);
  });

  it("effective higher than default: effective wins", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => SensitivityLevel.Financial,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("hello", "hi");
    expect(store._captured.every((m) => m.sensitivity === SensitivityLevel.Financial)).toBe(true);
  });

  it("pushActivation also floors (parallel write path)", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => SensitivityLevel.Secret,
    });
    const cm = new ConversationManager(deps);
    cm.pushActivation("first-contact greeting");
    expect(store._captured).toHaveLength(1);
    expect(store._captured[0]!.sensitivity).toBe(SensitivityLevel.Secret);
  });

  it("BYPASS REGRESSION: Secret-effective turn persists messages at Secret, not Personal default", () => {
    // Money test for the fifth-egress closure. Pre-fix: a turn at
    // Secret-effective sensitivity (e.g., a Secret-tier slab item from
    // a tool result is on the slab; user switched to on-device to send)
    // would persist user/assistant messages at the operator-manifest
    // default (Personal). Cross-device sync would surface them to a
    // None-tier session whose CONTEXT_SAFE_SENSITIVITY filter sees only
    // the persisted tier — leak. Post-fix: the floor raises the
    // persisted tier to Secret; downstream filters (retention flush,
    // future read-side context filters) now see the actual provenance
    // tier and can correctly exclude the messages from low-tier
    // contexts.
    const store = makeCapturingStore();
    let effective = SensitivityLevel.None;
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => effective,
    });
    const cm = new ConversationManager(deps);

    // Turn 1: clean session. Messages persist at default (Personal).
    cm.pushExchange("hello", "hi there");
    expect(
      store._captured.slice(-2).every((m) => m.sensitivity === SensitivityLevel.Personal),
    ).toBe(true);

    // Effective sensitivity elevates (e.g., a Secret-tier slab item
    // arrived from classifyToolResult).
    effective = SensitivityLevel.Secret;

    // Turn 2: at high-effective tier. Messages MUST persist at Secret,
    // not Personal — the floor is the closure.
    cm.pushExchange("tell me more about that", "ok, here's more context");
    const turn2 = store._captured.slice(-2);
    expect(turn2.every((m) => m.sensitivity === SensitivityLevel.Secret)).toBe(true);

    // De-elevate. Subsequent messages persist at default again. The
    // floor is dynamic — it composes session × slab state at write
    // time, not session-start state.
    effective = SensitivityLevel.None;
    cm.pushExchange("clean again", "ok");
    expect(
      store._captured.slice(-2).every((m) => m.sensitivity === SensitivityLevel.Personal),
    ).toBe(true);
  });
});
