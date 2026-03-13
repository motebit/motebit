/**
 * Storage module tests — localStorage persistence for provider config,
 * soul color, sync URL, and legacy conversation migration.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveProviderConfig,
  loadProviderConfig,
  clearProviderConfig,
  saveSoulColor,
  loadSoulColor,
  saveSyncUrl,
  loadSyncUrl,
  clearSyncUrl,
  hasCeilingBeenShown,
  markCeilingShown,
  needsMigration,
  loadLegacyConversations,
  markMigrationDone,
} from "../storage.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("ProviderConfig persistence", () => {
  it("saves and loads provider config", () => {
    const config = {
      type: "anthropic" as const,
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-test",
    };
    saveProviderConfig(config);
    const loaded = loadProviderConfig();
    expect(loaded).toEqual(config);
  });

  it("returns null when no config saved", () => {
    expect(loadProviderConfig()).toBeNull();
  });

  it("clears provider config", () => {
    saveProviderConfig({ type: "anthropic" as const, model: "claude-sonnet-4-20250514" });
    clearProviderConfig();
    expect(loadProviderConfig()).toBeNull();
  });
});

describe("SoulColor persistence", () => {
  it("saves and loads soul color", () => {
    const config = { preset: "violet", customHue: 270, customSaturation: 0.8 };
    saveSoulColor(config);
    expect(loadSoulColor()).toEqual(config);
  });

  it("returns null when no color saved", () => {
    expect(loadSoulColor()).toBeNull();
  });
});

describe("SyncUrl persistence", () => {
  it("saves and loads sync URL", () => {
    saveSyncUrl("https://relay.motebit.com");
    expect(loadSyncUrl()).toBe("https://relay.motebit.com");
  });

  it("clears sync URL", () => {
    saveSyncUrl("https://relay.motebit.com");
    clearSyncUrl();
    expect(loadSyncUrl()).toBeNull();
  });
});

describe("Ceiling CTA", () => {
  it("tracks session-scoped ceiling display", () => {
    expect(hasCeilingBeenShown()).toBe(false);
    markCeilingShown();
    expect(hasCeilingBeenShown()).toBe(true);
  });
});

describe("Legacy conversation migration", () => {
  it("reports no migration needed when no legacy data exists", () => {
    expect(needsMigration()).toBe(false);
  });

  it("reports migration needed when legacy index exists", () => {
    localStorage.setItem(
      "motebit-conv-index",
      JSON.stringify([{ id: "c1", title: "Test", lastActiveAt: Date.now(), messageCount: 2 }]),
    );
    expect(needsMigration()).toBe(true);
  });

  it("reports no migration needed after migration is done", () => {
    localStorage.setItem("motebit-conv-index", JSON.stringify([]));
    markMigrationDone();
    expect(needsMigration()).toBe(false);
  });

  it("loads legacy conversations from localStorage", () => {
    const messages = [
      { role: "user", content: "hello", timestamp: 1000 },
      { role: "assistant", content: "hi", timestamp: 1001 },
    ];
    localStorage.setItem(
      "motebit-conv-index",
      JSON.stringify([{ id: "c1", title: "Chat 1", lastActiveAt: 1001, messageCount: 2 }]),
    );
    localStorage.setItem("motebit-conv-c1", JSON.stringify(messages));

    const legacy = loadLegacyConversations();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.title).toBe("Chat 1");
    expect(legacy[0]!.messages).toHaveLength(2);
    expect(legacy[0]!.messages[0]!.content).toBe("hello");
  });

  it("returns empty array for corrupted index", () => {
    localStorage.setItem("motebit-conv-index", "not json");
    expect(loadLegacyConversations()).toEqual([]);
  });
});
