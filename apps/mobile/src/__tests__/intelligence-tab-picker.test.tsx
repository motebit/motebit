/**
 * #654 cold review C2 + C3 (mobile). Renders the REAL Settings →
 * Intelligence tab (react-test-renderer over host-string react-native
 * stubs) and asserts:
 *
 *   - BYOK Anthropic renders exactly the sdk ANTHROPIC_PICKER rows, in order,
 *     with the default checked; a stored claude-sonnet-4-6 renders as its own
 *     checked row (never migrated). Reverting IntelligenceTab's picker wiring
 *     turns this red.
 *   - Choosing Motebit Cloud lands, through the modal's provider-switch
 *     derivation, on a model Motebit Cloud admits (the sdk set the proxy's
 *     own admission consumes).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("react-native", () => {
  const host = (name: string) => name;
  return {
    View: host("View"),
    Text: host("Text"),
    TextInput: host("TextInput"),
    TouchableOpacity: host("TouchableOpacity"),
    Switch: host("Switch"),
    Platform: { OS: "ios", select: (o: Record<string, unknown>) => o.ios ?? o.default },
    Alert: { alert: vi.fn() },
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1, flatten: (s: unknown) => s },
    Appearance: { getColorScheme: () => "light" },
  };
});
vi.mock("../mobile-app", () => ({
  APPROVAL_PRESET_CONFIGS: { balanced: { maxRiskAuto: 1, requireApprovalAbove: 1, denyAbove: 3 } },
}));

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import {
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_VOICE_CONFIG,
  motebitCloudAdmitsModel,
} from "@motebit/sdk";
import { IntelligenceTab, type IntelligenceTabProps } from "../components/settings/IntelligenceTab";
import type { ProviderType } from "../components/settings/settings-shared";
import { modelForProviderSwitch } from "../provider-model";

// The app tsconfig carries no Node types (browser / React Native target), so
// the Node built-in is loaded through a non-literal specifier (the pattern
// expo-sqlite-sync-cursor.test.ts uses).
const NODE_FS = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (p: string, enc: "utf8") => string;
};
/** Read a file relative to this test file. */
const readRel = (rel: string): string =>
  readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), "utf8");

function props(over: Partial<IntelligenceTabProps>): IntelligenceTabProps {
  const noop = (): void => {};
  return {
    provider: "anthropic",
    model: "",
    apiKey: "",
    googleKey: "",
    deepseekKey: "",
    groqKey: "",
    localServerEndpoint: "",
    localBackend: "apple-fm",
    voice: DEFAULT_VOICE_CONFIG,
    openaiKey: "",
    elevenLabsKey: "",
    onChangeProvider: noop,
    onChangeModel: noop,
    onChangeApiKey: noop,
    onChangeGoogleKey: noop,
    onChangeDeepseekKey: noop,
    onChangeGroqKey: noop,
    onChangeLocalServerEndpoint: noop,
    onChangeLocalBackend: noop,
    onChangeVoice: noop,
    onChangeOpenaiKey: noop,
    onChangeElevenLabsKey: noop,
    ...over,
  };
}

function render(p: IntelligenceTabProps): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(React.createElement(IntelligenceTab, p));
  });
  return r;
}

/** The model radios: inside the radiogroup, each a `radio` with a label. */
function modelRows(r: TestRenderer.ReactTestRenderer): { label: string; checked: boolean }[] {
  const groups = r.root.findAll(
    (n: ReactTestInstance) =>
      typeof n.type === "string" && n.props.accessibilityRole === "radiogroup",
  );
  expect(groups).toHaveLength(1);
  return groups[0]!
    .findAll(
      (n: ReactTestInstance) => typeof n.type === "string" && n.props.accessibilityRole === "radio",
    )
    .map((n) => ({
      label: String(n.props.accessibilityLabel),
      checked: Boolean(n.props.accessibilityState?.checked),
    }));
}

describe("mobile IntelligenceTab — Anthropic picker (C3)", () => {
  it("renders ANTHROPIC_PICKER rows in order, default checked", () => {
    const r = render(props({ provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL }));
    const rows = modelRows(r);
    expect(rows.map((x) => x.label)).toEqual(ANTHROPIC_PICKER.map((o) => o.label));
    expect(rows.filter((x) => x.checked).map((x) => x.label)).toEqual([
      ANTHROPIC_PICKER.find((o) => o.id === DEFAULT_ANTHROPIC_MODEL)!.label,
    ]);
  });

  it("a stored claude-sonnet-4-6 shows as its own checked row, picker rows after it", () => {
    const r = render(props({ provider: "anthropic", model: "claude-sonnet-4-6" }));
    const rows = modelRows(r);
    expect(rows.map((x) => x.label)).toEqual([
      "claude-sonnet-4-6",
      ...ANTHROPIC_PICKER.map((o) => o.label),
    ]);
    expect(rows.filter((x) => x.checked).map((x) => x.label)).toEqual(["claude-sonnet-4-6"]);
  });

  it("tapping a picker row reports that row's sdk id", () => {
    const picked: string[] = [];
    const r = render(props({ onChangeModel: (m) => picked.push(m) }));
    const radios = r.root.findAll(
      (n: ReactTestInstance) => typeof n.type === "string" && n.props.accessibilityRole === "radio",
    );
    act(() => {
      for (const n of radios) (n.props.onPress as () => void)();
    });
    expect(picked).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
  });
});

describe("mobile provider switch → Motebit Cloud (C2)", () => {
  it("tapping Motebit Cloud derives a model the proxy admits", () => {
    const switched: ProviderType[] = [];
    const r = render(props({ provider: "anthropic", onChangeProvider: (p) => switched.push(p) }));
    const cloud = r.root.find(
      (n: ReactTestInstance) =>
        typeof n.type === "string" &&
        String(n.type) === "TouchableOpacity" &&
        n.findAll((c: ReactTestInstance) => c.children.includes("Motebit Cloud")).length > 0,
    );
    act(() => (cloud.props.onPress as () => void)());
    expect(switched).toEqual(["proxy"]);
    const model = modelForProviderSwitch(switched[0]!);
    expect(motebitCloudAdmitsModel(model)).toBe(true);
  });

  it("SettingsModal derives the switched model through modelForProviderSwitch", () => {
    // The modal itself needs SecureStore/FileSystem/the whole app to mount;
    // pin that its onChangeProvider has no private derivation left.
    const src = readRel("../components/SettingsModal.tsx");
    expect(src).toMatch(/model: modelForProviderSwitch\(p\)/);
    expect(src).not.toMatch(/DEFAULT_ANTHROPIC_MODEL/);
  });
});
