/**
 * #654 cold review C1/C2 — every CLI path that lands on `provider: "proxy"`
 * without an explicit model must produce a model Motebit Cloud admits.
 * `motebitCloudAdmitsModel` is the sdk set the proxy's own admission
 * consumes (pinned both ways in services/proxy motebit-cloud-accepted.test).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_PROXY_MODEL,
  motebitCloudAdmitsModel,
  pickerModelForTier,
} from "@motebit/sdk";
import { parseCliArgs, defaultModelForProvider } from "../args.js";
import { applyConfiguredProvider, argvHasFlag } from "../provider-config.js";
import { admitModelForProvider } from "../model-admission.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("CLI → Motebit Cloud model (C1/C2)", () => {
  it("`--provider proxy` with no --model sends a Cloud-admitted model", () => {
    const config = parseCliArgs(["--provider", "proxy"]);
    expect(config.model).toBe(DEFAULT_PROXY_MODEL);
    expect(motebitCloudAdmitsModel(config.model)).toBe(true);
  });

  it("defaultModelForProvider('proxy') is the Cloud default", () => {
    expect(motebitCloudAdmitsModel(defaultModelForProvider("proxy"))).toBe(true);
  });

  it("config default_provider: proxy (no default_model) re-derives the model", () => {
    const config = parseCliArgs([]); // parse-time provider anthropic → the BYOK default
    applyConfiguredProvider(config, { default_provider: "proxy" }, ["node", "motebit"]);
    expect(config.provider).toBe("proxy");
    expect(motebitCloudAdmitsModel(config.model)).toBe(true);
  });

  it("a stale BYOK default_model on proxy yields to the Cloud default", () => {
    const config = parseCliArgs([]);
    const lines: string[] = [];
    applyConfiguredProvider(
      config,
      { default_provider: "proxy", default_model: DEFAULT_ANTHROPIC_MODEL },
      ["node", "motebit"],
      (l) => lines.push(l),
    );
    expect(config.model).toBe(DEFAULT_PROXY_MODEL);
    expect(lines.join("\n")).toContain(DEFAULT_ANTHROPIC_MODEL);
  });

  it("a Cloud-catalog default_model on proxy is kept", () => {
    const config = parseCliArgs([]);
    applyConfiguredProvider(config, { default_provider: "proxy", default_model: "gpt-5.4-mini" }, [
      "node",
      "motebit",
    ]);
    expect(config.model).toBe("gpt-5.4-mini");
  });

  // R2: the proxy resolves aliases before admitting — so must the CLI. A
  // stored alias / legacy id the proxy serves is never rewritten, and never
  // gets a "belongs to another provider" notice.
  it.each([
    "claude-opus-4-20250115",
    "claude-opus",
    "claude-sonnet",
    "claude-3-5-sonnet-20241022",
    "gpt-4o",
    "gemini-flash",
    "gemini-2.5-pro",
    "auto",
  ])("a stored Cloud default_model the proxy admits (%s) is kept verbatim", (m) => {
    const config = parseCliArgs([]);
    const lines: string[] = [];
    applyConfiguredProvider(config, { default_provider: "proxy", default_model: m }, [], (l) =>
      lines.push(l),
    );
    expect(config.model).toBe(m);
    expect(lines).toEqual([]);
    expect(admitModelForProvider("proxy", m).admissible).toBe(true);
  });

  // R3: accepted by the catalog but named by no token the relay mints, so the
  // proxy 400s it for every real account — the stored id yields.
  it.each(["llama-3.3-70b-versatile", "openai/gpt-oss-120b"])(
    "a stored Cloud default_model no minted token names (%s) yields to the Cloud default",
    (m) => {
      const config = parseCliArgs([]);
      const lines: string[] = [];
      applyConfiguredProvider(config, { default_provider: "proxy", default_model: m }, [], (l) =>
        lines.push(l),
      );
      expect(config.model).toBe(DEFAULT_PROXY_MODEL);
      expect(lines.join("\n")).toContain("not served by Motebit Cloud");
    },
  );

  it("the yield notice on proxy names Motebit Cloud, not 'another provider'", () => {
    const config = parseCliArgs([]);
    const lines: string[] = [];
    applyConfiguredProvider(
      config,
      { default_provider: "proxy", default_model: "claude-sonnet-5" },
      [],
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("not served by Motebit Cloud");
    expect(lines.join("\n")).not.toContain("another provider");
  });

  it("`--provider=x` / `--model=x` (= form) outrank the persisted pair", () => {
    const config = parseCliArgs(["--provider=proxy", "--model=gpt-4o"]);
    applyConfiguredProvider(
      config,
      { default_provider: "anthropic", default_model: "claude-sonnet-4-6" },
      ["node", "motebit", "--provider=proxy", "--model=gpt-4o"],
    );
    expect(config.provider).toBe("proxy");
    expect(config.model).toBe("gpt-4o");
    expect(argvHasFlag(["--model=x"], "--model")).toBe(true);
    expect(argvHasFlag(["--modelx"], "--model")).toBe(false);
  });

  it("an explicit --model is the user's word (provider flip keeps it)", () => {
    const haiku = pickerModelForTier("fast");
    const config = parseCliArgs(["--model", haiku]);
    applyConfiguredProvider(config, { default_provider: "proxy" }, [
      "node",
      "motebit",
      "--model",
      haiku,
    ]);
    expect(config.model).toBe(haiku);
  });

  it("explicit `--provider proxy --model <BYOK default>` is refused pre-flight", () => {
    const a = admitModelForProvider("proxy", DEFAULT_ANTHROPIC_MODEL);
    expect(a.admissible).toBe(false);
    expect(a.teach).toContain(DEFAULT_PROXY_MODEL);
    expect(admitModelForProvider("proxy", DEFAULT_PROXY_MODEL).admissible).toBe(true);
  });

  // The daemon's own `runDaemon` needs an identity, governance and a DB to
  // reach its config block, so its path is proven by the shared function
  // above PLUS this structural pin: both entry points route through
  // applyConfiguredProvider and neither keeps a private copy.
  it.each(["index.ts", "daemon.ts"])(
    "%s routes the persisted provider through applyLaunchProvider",
    (file) => {
      const src = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(src).toMatch(/applyLaunchProvider\(config, personalityConfig, process\.argv/);
      expect(src).not.toMatch(/config\.provider = personalityConfig\.default_provider/);
      expect(src).not.toMatch(/config\.model = personalityConfig\.default_model/);
    },
  );
});
