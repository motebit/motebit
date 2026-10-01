/**
 * #654 cold review R2 item 4 — `/model opus|sonnet|haiku` by EXECUTION.
 *
 * Drives the REAL `/model` slash handler (`handleSlashCommand("model", …)`)
 * and asserts the model the runtime is switched to IS the sdk picker's model
 * for that tier. Before #654 the handler hard-coded a haiku id
 * outside the registry; a source-regex check could not tell a literal that
 * happens to match from the derivation, this can.
 *
 * Plus the Motebit Cloud lane: `/model <id>` on `proxy` admits exactly what
 * the proxy admits (`motebitCloudAdmission`), alias ids included.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pickerModelForTier, type AnthropicPickerTier } from "@motebit/sdk";
import type { MotebitRuntime } from "@motebit/runtime";

// No network: the live catalog is unavailable, so the offline alias table +
// admission decide — the path that is load-bearing for every provider
// without a live adapter (proxy) and every keyless launch.
vi.mock("@motebit/ai-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/ai-core")>();
  return {
    ...actual,
    discoverModels: vi.fn(async ({ provider }: { provider: string }) => ({
      provider,
      source: "fallback",
      models: [],
      fallbackReason: "test: offline",
    })),
  };
});

import { handleSlashCommand } from "../slash-commands.js";
import { parseCliArgs } from "../args.js";

function fakeRuntime(): MotebitRuntime & { setModel: ReturnType<typeof vi.fn> } {
  const rt = {
    currentModel: "start",
    moneyToolsWithheld: false,
    setModel: vi.fn((m: string) => {
      rt.currentModel = m;
    }),
  };
  return rt as unknown as MotebitRuntime & { setModel: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function runModel(provider: string, arg: string): Promise<string | null> {
  const runtime = fakeRuntime();
  const config = parseCliArgs(["--provider", provider]);
  // No fullConfig: nothing is persisted to ~/.motebit during the test.
  await handleSlashCommand("model", arg, runtime, config);
  const calls = runtime.setModel.mock.calls;
  return calls.length > 0 ? (calls.at(-1)![0] as string) : null;
}

describe("/model opus|sonnet|haiku — the picker tier's model, by execution", () => {
  const TIERS: Array<[string, AnthropicPickerTier]> = [
    ["opus", "strongest"],
    ["sonnet", "default"],
    ["haiku", "fast"],
  ];
  for (const [alias, tier] of TIERS) {
    it(`/model ${alias} → pickerModelForTier("${tier}")`, async () => {
      expect(await runModel("anthropic", alias)).toBe(pickerModelForTier(tier));
    });
  }
});

describe("/model on Motebit Cloud admits what the proxy admits (R2)", () => {
  it("alias and legacy ids the proxy serves switch verbatim", async () => {
    for (const id of ["claude-opus", "claude-opus-4-20250115", "gpt-4o", "claude-sonnet-4-6"]) {
      expect(await runModel("proxy", id), id).toBe(id);
    }
  });

  it("an id the proxy refuses never reaches the runtime", async () => {
    expect(await runModel("proxy", "claude-sonnet-5")).toBeNull();
  });
});
