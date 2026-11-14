/**
 * A committed key rotation changes the recovery seed (the seed IS the key).
 * Mounts the REAL `SettingsModal` (react-test-renderer over host-string
 * react-native stubs, the harness `settings-modal-provider-switch.test.tsx`
 * uses), opens the Identity tab, drives Rotate Key through the props the
 * modal hands IdentityTab, confirms, and reads what the owner is told: the
 * seed notice in the "Key Rotated" alert, only when the rotation committed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
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
    Alert: { alert },
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

/** The latest props the modal handed IdentityTab. */
const identity: { props: Record<string, unknown> | null } = { props: null };
vi.mock("../components/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/settings")>();
  return {
    TABS: actual.TABS,
    AppearanceTab: () => null,
    GovernanceTab: () => null,
    IntelligenceTab: () => null,
    IdentityTab: (p: Record<string, unknown>) => {
      identity.props = p;
      return null;
    },
    deriveInteriorColor: () => ({ r: 0, g: 0, b: 0 }),
    useSettingsStyles: () => new Proxy({}, { get: () => ({}) }),
  };
});

import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { ROTATION_SEED_BACKUP_NOTICE } from "@motebit/surface-kit";
import { SettingsModal } from "../components/SettingsModal";

function stubApp(rotateKey: () => Promise<unknown>): unknown {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "rotateKey") return rotateKey;
        if (key === "getIdentityInfo") {
          return () => ({ motebitId: "m", deviceId: "d", publicKey: "" });
        }
        if (key === "getSyncUrl") return async () => null;
        if (key === "getRuntime") return () => null;
        if (key === "isOperatorMode") return false;
        return vi.fn(() => undefined);
      },
    },
  );
}

const SETTINGS = {
  provider: "anthropic",
  model: "m",
  localBackend: "apple-fm",
  localServerEndpoint: "",
  approvalPreset: "balanced",
  maxCallsPerTurn: 10,
  persistenceThreshold: 0.5,
  rejectSecrets: true,
  maxMemoriesPerTurn: 5,
  appearance: { colorPreset: "default" },
} as never;

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

type AlertButton = { text: string; onPress?: () => void };

/** Mount, open Identity, press Rotate Key, confirm "Rotate". */
async function rotate(rotateKey: () => Promise<unknown>): Promise<void> {
  identity.props = null;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(SettingsModal, {
        visible: true,
        app: stubApp(rotateKey) as never,
        settings: SETTINGS,
        onSave: vi.fn(),
        onClose: () => {},
        onRequestPin: () => {},
      }),
    );
  });
  pressText(r, "Identity");
  expect(identity.props).not.toBeNull();
  act(() => {
    (identity.props!.onRotateKey as () => void)();
  });
  const confirm = alert.mock.calls.at(-1)!;
  expect(confirm[0]).toBe("Rotate Key");
  const yes = (confirm[2] as AlertButton[]).find((b) => b.text === "Rotate")!;
  await act(async () => {
    yes.onPress!();
    await new Promise((res) => setTimeout(res, 0));
  });
}

beforeEach(() => {
  alert.mockClear();
});

describe("mobile SettingsModal — Rotate Key tells the owner the seed changed", () => {
  it("a committed rotation's alert carries the seed notice", async () => {
    await rotate(async () => ({ newPublicKey: "ab".repeat(32) }));
    const done = alert.mock.calls.find((c) => c[0] === "Key Rotated");
    expect(done).toBeDefined();
    expect(String(done![1])).toContain(ROTATION_SEED_BACKUP_NOTICE);
  });

  it("a failed rotation (the old key stays) says nothing about the seed", async () => {
    await rotate(async () => {
      throw new Error("the relay refused the rotation");
    });
    expect(alert.mock.calls.some((c) => c[0] === "Key Rotated")).toBe(false);
    expect(alert.mock.calls.some((c) => String(c[1]).includes(ROTATION_SEED_BACKUP_NOTICE))).toBe(
      false,
    );
  });
});
