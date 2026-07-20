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
    // Tests fixture the gate as a no-op identity (returns a typed
    // empty cleared-deps shell) — these suites assert sensitivity
    // FLOOR semantics on persisted messages, not the gate's egress
    // throwing behavior. The runtime's `sensitivity-routing.test.ts`
    // is the canonical home for gate-firing assertions.
    assertSensitivityPermitsAiCall: () =>
      ({}) as ReturnType<ConversationDeps["assertSensitivityPermitsAiCall"]>,
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

describe("ConversationManager — read-side trimmed() filter by effective tier", () => {
  it("untagged legacy messages always pass through (backward compat)", () => {
    // Pre-floor data: messages persisted before the v1 sensitivity
    // tag landed have no `sensitivity` field. They MUST flow through
    // trimmed() regardless of effective tier — otherwise the read
    // filter retroactively erases the user's history.
    const legacyStore: ConversationStoreAdapter = {
      createConversation: () => "conv-legacy",
      appendMessage() {},
      loadMessages: () => [
        {
          messageId: "m1",
          conversationId: "conv-legacy",
          motebitId: "mb-1",
          role: "user",
          content: "legacy untagged user",
          toolCalls: null,
          toolCallId: null,
          createdAt: 0,
          tokenEstimate: 4,
        },
        {
          messageId: "m2",
          conversationId: "conv-legacy",
          motebitId: "mb-1",
          role: "assistant",
          content: "legacy untagged assistant",
          toolCalls: null,
          toolCallId: null,
          createdAt: 1,
          tokenEstimate: 4,
        },
      ],
      getActiveConversation: () => null,
      updateSummary() {},
      updateTitle() {},
      listConversations: () => [],
      deleteConversation() {},
    };
    const provider = { generate: vi.fn() } as unknown as NonNullable<
      ReturnType<ConversationDeps["getProvider"]>
    >;
    const deps: ConversationDeps = {
      motebitId: "mb-1",
      maxHistory: 100,
      summarizeAfterMessages: 50,
      store: legacyStore,
      getProvider: () => provider,
      getTaskRouter: () => null,
      generateCompletion: vi.fn(async () => "AI Title"),
      assertSensitivityPermitsAiCall: () =>
        ({}) as ReturnType<ConversationDeps["assertSensitivityPermitsAiCall"]>,
      // Non-permissive session tier — would block tagged messages.
      getEffectiveSensitivity: () => SensitivityLevel.None,
    };
    const cm = new ConversationManager(deps);
    cm.load("conv-legacy");
    const out = cm.trimmed();
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.sensitivity == null)).toBe(true);
  });

  it("absent getter: defaults to None effective; messages tagged above None excluded", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      // No getEffectiveSensitivity. trimmed() defaults effective to None,
      // so Personal-tagged messages are excluded.
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("hello", "hi");
    expect(cm.trimmed()).toHaveLength(0);
  });

  it("effective at or above message tier: included", () => {
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => SensitivityLevel.Personal,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("hello", "hi");
    expect(cm.trimmed()).toHaveLength(2);
  });

  it("effective below message tier: excluded", () => {
    const store = makeCapturingStore();
    let effective = SensitivityLevel.Secret;
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => effective,
    });
    const cm = new ConversationManager(deps);
    // Persist a Secret-effective turn.
    cm.pushExchange("secret prompt", "secret reply");
    // Drop back to None. Secret-tagged messages must be filtered out.
    effective = SensitivityLevel.None;
    expect(cm.trimmed()).toHaveLength(0);
  });

  it("dynamic re-elevation: same messages reappear when effective tier rises again", () => {
    // The filter is dynamic, not session-fixed. A session whose tier
    // elevates mid-conversation regains access to its own elevated
    // messages — the same posture the pre-call AI gate enforces.
    const store = makeCapturingStore();
    let effective = SensitivityLevel.Medical;
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => effective,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("medical-tier user", "medical-tier assistant");
    expect(cm.trimmed()).toHaveLength(2);

    effective = SensitivityLevel.None;
    expect(cm.trimmed()).toHaveLength(0);

    effective = SensitivityLevel.Medical;
    expect(cm.trimmed()).toHaveLength(2);
  });

  it("mixed history: only messages above effective are filtered, lower tagged + untagged remain", () => {
    const store = makeCapturingStore();
    let effective = SensitivityLevel.Personal;
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => effective,
    });
    const cm = new ConversationManager(deps);
    // Personal-tagged turn at Personal effective.
    cm.pushExchange("personal-user", "personal-assistant");
    // Elevate to Secret, persist Secret-tagged turn.
    effective = SensitivityLevel.Secret;
    cm.pushExchange("secret-user", "secret-assistant");
    // Drop to Personal. Secret turn must be filtered, Personal turn remains.
    effective = SensitivityLevel.Personal;
    const out = cm.trimmed();
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.content.startsWith("personal"))).toBe(true);
  });

  it("CALM-SESSION ROUND-TRIP: defaultSensitivity None + effective None — messages persist and re-read on the next turn", () => {
    // Regression pin from 2026-05-11. MotebitRuntime previously
    // constructed ConversationManager WITHOUT passing
    // `defaultSensitivity`, so the conversation.ts:117 fallback
    // (`?? SensitivityLevel.Personal`) was in force. Every persisted
    // message stamped at `max(Personal, effective)` = Personal in a
    // calm session. The read-side `trimmed()` filter defaulted
    // `effective` to None and `sensitivityPermits(None, Personal)` is
    // false — so every Personal-stamped message got dropped from the
    // trimmed history on the next turn. The AI told the user "I don't
    // have a previous message in this session" mid-chat while the
    // storage held all the prior turns.
    //
    // The fix: motebit-runtime.ts now passes `defaultSensitivity:
    // SensitivityLevel.None` so the write-side and read-side baselines
    // match. Cross-device leak protection is unchanged because real
    // elevation paths (`classifyToolResult`, drop classification,
    // `setSessionSensitivity`) still raise `effective` and floor the
    // stamp via `max(default, effective)`.
    //
    // This test pins the calm-session round-trip: no elevation, both
    // sides at None, messages MUST be readable on the next turn. If a
    // future change re-introduces the Personal-default asymmetry, this
    // test fails before pixels ship.
    const store = makeCapturingStore();
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.None,
      getEffectiveSensitivity: () => SensitivityLevel.None,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("open google.com", "Google's open.");
    cm.pushExchange("press enter", "got it.");
    // Write-side: messages stamped at None (max(None, None) = None).
    expect(store._captured.every((m) => m.sensitivity === SensitivityLevel.None)).toBe(true);
    // Read-side: trimmed() returns all four messages — the calm
    // session's own history is readable on its own next turn.
    const out = cm.trimmed();
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ role: "user", content: "open google.com" });
    expect(out[1]).toMatchObject({ role: "assistant", content: "Google's open." });
    expect(out[2]).toMatchObject({ role: "user", content: "press enter" });
    expect(out[3]).toMatchObject({ role: "assistant", content: "got it." });
  });

  it("BYPASS REGRESSION: high-tier persisted messages do NOT leak into low-tier session trimmed history", () => {
    // The money test for the read-side filter (closes the read side
    // of the fifth egress-write boundary). Pre-fix: a Secret-effective
    // turn persisted user/assistant messages at Secret (write-side
    // floor); cross-device sync surfaced them to another device whose
    // session is at None tier. The pre-call AI gate sees None × None
    // and passes — but trimmed() included the Secret-tagged history
    // verbatim → BYOK egress of Secret content while the gate
    // reported "Personal sufficient." The read-side filter closes the
    // bypass: tagged messages above the current effective tier are
    // excluded from trimmed history regardless of what the gate
    // permits, because trimmed history is itself an egress shape.
    const store = makeCapturingStore();
    let effective = SensitivityLevel.Secret;
    const deps = makeDeps(store, {
      defaultSensitivity: SensitivityLevel.Personal,
      getEffectiveSensitivity: () => effective,
    });
    const cm = new ConversationManager(deps);
    cm.pushExchange("medical-history detail", "noted");
    // Confirm write-side did its job.
    expect(store._captured.every((m) => m.sensitivity === SensitivityLevel.Secret)).toBe(true);
    // Sync horizon: another device, None-tier session, BYOK provider.
    effective = SensitivityLevel.None;
    const trimmedAtNone = cm.trimmed();
    expect(trimmedAtNone).toHaveLength(0);
    // Same conversation, on-device session that re-elevates to Secret
    // (e.g., user pulls in a Secret slab item): the messages reappear.
    effective = SensitivityLevel.Secret;
    expect(cm.trimmed()).toHaveLength(2);
  });
});

describe("ConversationManager.searchHistory — sensitivity egress filter (read side)", () => {
  // The read-side complement of the write-side floor above: past transcripts
  // carry a per-message tier, and search_conversations must not surface a
  // medical/financial/secret message toward an external provider.
  const MSGS: Array<{ role: string; content: string; sensitivity?: SensitivityLevel }> = [
    { role: "user", content: "the auth refactor plan", sensitivity: SensitivityLevel.Personal },
    { role: "user", content: "my auth token is sk-secret", sensitivity: SensitivityLevel.Secret },
    { role: "user", content: "auth diagnosis lisinopril", sensitivity: SensitivityLevel.Medical },
    { role: "user", content: "auth legacy note unclassified", sensitivity: undefined },
  ];

  function seededStore(): ConversationStoreAdapter {
    return {
      ...makeCapturingStore(),
      listConversations: () => [
        {
          conversationId: "conv-1",
          startedAt: 0,
          lastActiveAt: 0,
          title: null,
          messageCount: MSGS.length,
          summary: null,
        },
      ],
      loadMessages: () =>
        MSGS.map((m, i) => ({
          messageId: `m-${i}`,
          conversationId: "conv-1",
          motebitId: "mb-1",
          role: m.role,
          content: m.content,
          toolCalls: null,
          toolCallId: null,
          createdAt: i,
          tokenEstimate: 0,
          sensitivity: m.sensitivity,
        })),
    } as ConversationStoreAdapter;
  }

  it("an external filter withholds ≥medical AND unclassified (null-tier) messages", () => {
    const cm = new ConversationManager(makeDeps(makeCapturingStore(), { store: seededStore() }));
    const contents = cm
      .searchHistory("auth", 10, [SensitivityLevel.None, SensitivityLevel.Personal])
      .map((h) => h.content);
    expect(contents).toContain("the auth refactor plan"); // personal — safe
    expect(contents).not.toContain("my auth token is sk-secret"); // secret withheld
    expect(contents).not.toContain("auth diagnosis lisinopril"); // medical withheld
    expect(contents.some((c) => c.includes("legacy note"))).toBe(false); // null → fail-closed
  });

  it("no filter (sovereign on-device) searches every tier", () => {
    const cm = new ConversationManager(makeDeps(makeCapturingStore(), { store: seededStore() }));
    const contents = cm.searchHistory("auth", 10).map((h) => h.content);
    expect(contents).toEqual(
      expect.arrayContaining([
        "the auth refactor plan",
        "my auth token is sk-secret",
        "auth diagnosis lisinopril",
      ]),
    );
  });
});
