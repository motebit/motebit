/**
 * #654 cold review R2 — mobile SettingsModal provider switch, by EXECUTION.
 *
 * Replaces a source-regex pin (`model: modelForProviderSwitch(p)`), which a
 * refactor could satisfy while the modal did something else. This mounts the
 * REAL `SettingsModal` (react-test-renderer over host-string react-native
 * stubs; the tab bodies other than the Intelligence tab's props are inert),
 * opens the Intelligence tab, drives the provider switch through the props
 * the modal hands IntelligenceTab, and presses Save — asserting what the
 * modal actually saves:
 *
 *   - switching to Motebit Cloud saves `defaultModelForProvider("proxy")`,
 *     a model the proxy admits (never the BYOK Anthropic default);
 *   - a stored Cloud model the proxy admits — alias / legacy included — is
 *     saved verbatim, never rewritten.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    Modal: host("Modal"),
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    TouchableOpacity: host("TouchableOpacity"),
    ScrollView: host("ScrollView"),
    Switch: host("Switch"),
    Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    Alert: { alert: vi.fn() },
    Clipboard: { setString: vi.fn() },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, flatten: (s: unknown) => s },
    Appearance: { getColorScheme: () => "light" },
  };
});
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => {}),
}));
vi.mock("expo-sharing", () => ({}));
vi.mock("expo-file-system/legacy", () => ({}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("../mobile-app", () => ({
  APPROVAL_PRESET_CONFIGS: { balanced: { maxRiskAuto: 1, requireApprovalAbove: 1, denyAbove: 3 } },
}));
vi.mock("../components/BillingPanel", () => ({ BillingPanel: () => null }));
vi.mock("../components/RestoreIdentityModal", () => ({ RestoreIdentityModal: () => null }));

/** The latest props the modal handed IntelligenceTab. */
const intelligence: { props: Record<string, unknown> | null } = { props: null };
vi.mock("../components/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/settings")>();
  return {
    TABS: actual.TABS,
    AppearanceTab: () => null,
    GovernanceTab: () => null,
    IdentityTab: () => null,
    IntelligenceTab: (p: Record<string, unknown>) => {
      intelligence.props = p;
      return null;
    },
    deriveInteriorColor: () => ({ r: 0, g: 0, b: 0 }),
    useSettingsStyles: () => new Proxy({}, { get: () => ({}) }),
  };
});

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import {
  DEFAULT_ANTHROPIC_MODEL,
  defaultModelForProvider,
  motebitCloudAdmission,
} from "@motebit/sdk";
import { SettingsModal } from "../components/SettingsModal";

function stubApp(): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "getSyncUrl") return async () => null;
        if (key === "getRuntime") return () => null;
        if (key === "isOperatorMode") return false;
        return vi.fn(() => undefined);
      },
    },
  );
}

function settings(provider: string, model: string): never {
  return {
    provider,
    model,
    localBackend: "apple-fm",
    localServerEndpoint: "",
    approvalPreset: "balanced",
    maxCallsPerTurn: 10,
    persistenceThreshold: 0.5,
    rejectSecrets: true,
    maxMemoriesPerTurn: 5,
    appearance: { colorPreset: "default" },
  } as never;
}

function pressText(r: TestRenderer.ReactTestRenderer, label: string): void {
  const btn = r.root.find(
    (n: ReactTestInstance) =>
      String(n.type) === "TouchableOpacity" &&
      n.findAll((c: ReactTestInstance) => c.children.includes(label)).length > 0,
  );
  act(() => {
    (btn.props.onPress as () => void)();
  });
}

async function mountOnIntelligence(provider: string, model: string) {
  intelligence.props = null;
  const onSave = vi.fn();
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(SettingsModal, {
        visible: true,
        app: stubApp() as never,
        settings: settings(provider, model),
        onSave,
        onClose: () => {},
        onRequestPin: () => {},
      }),
    );
  });
  pressText(r, "Intelligence");
  expect(intelligence.props).not.toBeNull();
  const save = async (): Promise<{ model: string; aiModel?: string }> => {
    await act(async () => {
      pressText(r, "Save");
    });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const [draft, ai] = onSave.mock.calls.at(-1) as [{ model: string }, { model?: string }?];
    return { model: draft.model, aiModel: ai?.model };
  };
  return { r, save };
}

describe("mobile SettingsModal — provider switch, executed (R2)", () => {
  it("switching Anthropic → Motebit Cloud saves the Cloud default, which the proxy admits", async () => {
    const { save } = await mountOnIntelligence("anthropic", DEFAULT_ANTHROPIC_MODEL);
    act(() => {
      (intelligence.props!.onChangeProvider as (p: string) => void)("proxy");
    });
    expect(intelligence.props!.model).toBe(defaultModelForProvider("proxy"));
    const saved = await save();
    expect(saved.model).toBe(defaultModelForProvider("proxy"));
    expect(saved.aiModel).toBe(defaultModelForProvider("proxy"));
    expect(motebitCloudAdmission(saved.model).admitted).toBe(true);
  });

  it.each(["claude-opus-4-20250115", "claude-opus", "gpt-4o", "claude-sonnet-4-6", "auto"])(
    "a stored Cloud model the proxy admits (%s) is shown and saved verbatim",
    async (stored) => {
      expect(motebitCloudAdmission(stored).admitted).toBe(true);
      const { save } = await mountOnIntelligence("proxy", stored);
      expect(intelligence.props!.model).toBe(stored);
      expect((await save()).model).toBe(stored);
    },
  );
});
