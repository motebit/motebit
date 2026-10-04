/**
 * #654 cold review R3 — the launch pre-flight, by execution.
 *
 * C3: the interactive launch keyed the explicit-`--model` pre-flight and the
 * persisted-`max_tokens` override on argv. Reverting either to a bare
 * `argv.includes("--model")` / `includes("--max-tokens")` loses the `=`
 * spelling and kept every test green. These rows run both spellings.
 * C4: `motebit run` / `motebit serve` applied the persisted provider but ran
 * no pre-flight. All three entry points now call `applyLaunchProvider`; the
 * last block pins that no entry point calls the un-checked step directly.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_PROXY_MODEL,
  MOTEBIT_CLOUD_MODEL_ALIASES,
  motebitCloudAdmission,
} from "@motebit/sdk";
import { parseCliArgs } from "../args.js";
import { applyConfiguredMaxTokens, applyLaunchProvider } from "../provider-config.js";

/** A Cloud class alias the proxy resolves and serves (e.g. the Opus class alias). */
const SERVED_ALIAS = Object.keys(MOTEBIT_CLOUD_MODEL_ALIASES).find(
  (k) => motebitCloudAdmission(k).admitted,
)!;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The argv `process.argv` would carry, and the config parsed from it. */
function launch(args: string[], persisted: Record<string, string> = {}) {
  const config = parseCliArgs(args);
  const error = applyLaunchProvider(config, persisted, ["node", "motebit", ...args]);
  return { config, error };
}

describe("launch pre-flight — explicit --model (C3)", () => {
  // Served by no token the relay mints (#654 R3), and the BYOK default.
  for (const model of ["llama-3.3-70b-versatile", DEFAULT_ANTHROPIC_MODEL]) {
    it(`--provider proxy --model ${model} is refused (space form)`, () => {
      const { error } = launch(["--provider", "proxy", "--model", model]);
      expect(error).toContain(`Model "${model}"`);
      expect(error).toContain(DEFAULT_PROXY_MODEL);
    });
    it(`--provider=proxy --model=${model} is refused (= form)`, () => {
      const { error } = launch([`--provider=proxy`, `--model=${model}`]);
      expect(error).toContain(`Model "${model}"`);
    });
  }

  it("an id the proxy serves passes, in both spellings, unrewritten", () => {
    for (const args of [
      ["--provider", "proxy", "--model", SERVED_ALIAS],
      ["--provider=proxy", `--model=${SERVED_ALIAS}`],
    ]) {
      const { config, error } = launch(args);
      expect(error, args.join(" ")).toBeNull();
      expect(config.model).toBe(SERVED_ALIAS);
    }
  });

  it("a hosted id on local-server is refused in the = form too", () => {
    expect(launch(["--provider=local-server", `--model=${DEFAULT_PROXY_MODEL}`]).error).toContain(
      "local server",
    );
  });

  it("no explicit --model: a persisted default_model that yields is a notice, never an error", () => {
    const { config, error } = launch(["--provider", "proxy"], {
      default_model: "llama-3.3-70b-versatile",
    });
    expect(error).toBeNull();
    expect(config.model).toBe(DEFAULT_PROXY_MODEL);
  });
});

describe("persisted max_tokens vs --max-tokens (C3)", () => {
  it("--max-tokens=N (= form) outranks the persisted value", () => {
    const config = parseCliArgs(["--max-tokens=500"]);
    applyConfiguredMaxTokens(config, 9999, ["node", "motebit", "--max-tokens=500"]);
    expect(config.maxTokens).toBe(500);
  });

  it("--max-tokens N (space form) outranks the persisted value", () => {
    const config = parseCliArgs(["--max-tokens", "500"]);
    applyConfiguredMaxTokens(config, 9999, ["node", "motebit", "--max-tokens", "500"]);
    expect(config.maxTokens).toBe(500);
  });

  it("without the flag the persisted value applies; absent persisted leaves the default", () => {
    const config = parseCliArgs([]);
    const before = config.maxTokens;
    applyConfiguredMaxTokens(config, undefined, ["node", "motebit"]);
    expect(config.maxTokens).toBe(before);
    applyConfiguredMaxTokens(config, 1234, ["node", "motebit"]);
    expect(config.maxTokens).toBe(1234);
  });
});

describe("every launch path runs the pre-flight (C4)", () => {
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const index = strip(fs.readFileSync(path.join(SRC, "index.ts"), "utf-8"));
  const daemon = strip(fs.readFileSync(path.join(SRC, "daemon.ts"), "utf-8"));

  it("index.ts (interactive), and daemon.ts handleRun + handleServe call applyLaunchProvider", () => {
    expect(index.match(/applyLaunchProvider\(/g)?.length).toBe(1);
    expect(index.match(/applyConfiguredMaxTokens\(/g)?.length).toBe(1);
    for (const fn of ["handleRun", "handleServe"]) {
      const start = daemon.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThanOrEqual(0);
      const next = daemon.indexOf("\nexport ", start + 1);
      const body = daemon.slice(start, next === -1 ? undefined : next);
      expect(body, fn).toMatch(/applyLaunchProvider\(/);
      expect(body, fn).toMatch(/process\.exit\(1\)/);
    }
  });

  it("no entry point applies the persisted provider, reads --model or --max-tokens off argv by hand", () => {
    for (const [name, src] of [
      ["index.ts", index],
      ["daemon.ts", daemon],
    ] as const) {
      expect(src, name).not.toMatch(/applyConfiguredProvider\(/);
      expect(src, name).not.toMatch(/argv\.includes\(\s*["']--(model|max-tokens)["']/);
      expect(src, name).not.toMatch(
        /argvHasFlag\(\s*process\.argv,\s*["']--(model|max-tokens)["']/,
      );
    }
  });
});
