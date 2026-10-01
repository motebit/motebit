/**
 * #654 cold review R2 — Motebit Cloud admission, differential by EXECUTION.
 *
 * Twice the clients' idea of what Motebit Cloud accepts disagreed with the
 * proxy's real rule (R1: clients sent `claude-sonnet-5`, refused; R2: the
 * client pre-flight skipped the proxy's alias step, so `claude-opus`,
 * `claude-opus-4-20250115`, `gpt-4o`, `gemini-flash` were refused / cleared
 * / silently rewritten though the proxy serves them). The structural fix is
 * one function (`motebitCloudAdmission` in `@motebit/sdk`) that the proxy
 * route and every client call. This test does not trust that claim: over a
 * corpus of every model id the repo knows plus 200 seeded garbled strings it
 *
 *   1. POSTs each id through the REAL proxy route (`services/proxy`
 *      `POST /v1/messages`, proxy-token path, only the token parse and the
 *      upstream fetch stubbed) and records whether the request reached a
 *      provider and with which model id — the proxy's actual verdict;
 *   2. runs every client admission / sanitizer on the same id — CLI launch
 *      pre-flight, CLI stored `default_model`, sdk `providerAcceptsModel`,
 *      spatial's model-field sanitizer — and asserts each agrees with (1),
 *      and that no client path rewrites an id the proxy admits.
 *
 * Web / desktop / mobile run no Cloud admission at all (they keep the stored
 * id verbatim); their never-rewrite tests live in their own packages.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PICKER,
  DEEPSEEK_MODELS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_LOCAL_SERVER_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_PROXY_MODEL,
  GOOGLE_MODELS,
  GROQ_MODELS,
  MOTEBIT_CLOUD_ACCEPTED_MODELS,
  MOTEBIT_CLOUD_MODEL_ALIASES,
  OPENAI_MODELS,
  PROXY_MODELS,
  motebitCloudAdmission,
  providerAcceptsModel,
  // The root has no workspace deps; this is the exact module the proxy and
  // the apps resolve `@motebit/sdk` to (workspace symlink → package main).
} from "../../packages/sdk/dist/index.js";
import * as validation from "../../services/proxy/src/validation";
import type { ProxyTokenPayload } from "../../services/proxy/src/validation";

vi.mock("../../services/proxy/src/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/proxy/src/validation")>();
  return { ...actual, parseProxyToken: vi.fn() };
});

import { POST } from "../../services/proxy/src/app/v1/messages/route";
import { memorySpendStore, setSpendStoreForTests } from "../../services/proxy/src/spend-controls";
import { admitModelForProvider } from "../../apps/cli/src/model-admission";
import { applyConfiguredProvider } from "../../apps/cli/src/provider-config";
import { parseCliArgs } from "../../apps/cli/src/args";
import { modelFieldValueForLane } from "../../apps/spatial/src/model-field";

// ── Corpus ───────────────────────────────────────────────────────────────

/** Ids found in the git history of packages/sdk/src/models.ts,
 *  services/proxy/src/validation.ts, services/relay/src/subscriptions.ts and
 *  every apps/<surface>/index.html (2026-10-01), plus provider spellings. */
const HISTORICAL = [
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-fable",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-mythos",
  "claude-opus",
  "claude-opus-4-20250115",
  "claude-opus-4-20250514",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-r1",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-flash",
  "gemini-flash-lite",
  "gemini-pro",
  "gpt-4",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "gpt-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-oss",
  "llama-3.3-70b-versatile",
  "llama3.2",
  "llama4",
  "mistral",
  "mistral-small3.2",
  "o3",
  "o3-mini",
  "on-device",
  "openai/gpt-oss-120b",
  "qwen3",
  "auto",
  "",
  // Prototype keys: a plain-object alias lookup would resolve these to
  // functions; the one rule must treat them as ordinary unknown ids.
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
];

/** mulberry32 — deterministic, so a red run reproduces exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCorpus(): string[] {
  const known = new Set<string>([
    ...ANTHROPIC_MODELS,
    ...OPENAI_MODELS,
    ...GOOGLE_MODELS,
    ...GROQ_MODELS,
    ...DEEPSEEK_MODELS,
    ...PROXY_MODELS,
    ...ANTHROPIC_PICKER.map((r) => r.id),
    ...MOTEBIT_CLOUD_ACCEPTED_MODELS,
    ...Object.keys(MOTEBIT_CLOUD_MODEL_ALIASES),
    ...Object.values(MOTEBIT_CLOUD_MODEL_ALIASES),
    ...validation.getSupportedModels(), // the proxy's MODEL_CONFIG
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_OPENAI_MODEL,
    DEFAULT_GOOGLE_MODEL,
    DEFAULT_GROQ_MODEL,
    DEFAULT_DEEPSEEK_MODEL,
    DEFAULT_LOCAL_SERVER_MODEL,
    DEFAULT_PROXY_MODEL,
    ...HISTORICAL,
  ]);
  const base = [...known].filter((m) => m !== "");
  const rand = prng(654);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._/: é\u0000‮";
  const garbled = new Set<string>();
  const fresh = (g: string): void => {
    if (!known.has(g)) garbled.add(g);
  };
  // 100 near-misses of real ids: the shapes a typo, a paste or a stale
  // client actually produces.
  const mutate: Array<(s: string) => string> = [
    (s) => s.toUpperCase(),
    (s) => ` ${s}`,
    (s) => `${s} `,
    (s) => `${s}\n`,
    (s) => s.slice(0, -1),
    (s) => s.slice(1),
    (s) => `${s}-latest`,
    (s) => `anthropic/${s}`,
    (s) => s.replace(/-/g, "_"),
    (s) => s.replace(/\./g, "-"),
  ];
  while (garbled.size < 100) fresh(pick(mutate)(pick(base)));
  // 100 random strings.
  while (garbled.size < 200) {
    const len = 1 + Math.floor(rand() * 30);
    let s = "";
    for (let j = 0; j < len; j++) s += pick([...alphabet]);
    fresh(s);
  }
  // Trimmed forms too: spatial sends the trimmed field value.
  return [...new Set([...known, ...garbled, ...[...garbled].map((g) => g.trim())])];
}

const GARBLED_COUNT = 200;
const CORPUS = buildCorpus();

// ── The proxy's actual verdict (execution) ───────────────────────────────

interface ProxyVerdict {
  admitted: boolean;
  /** Every upstream request (url + body), to find the model id routed. */
  upstream: string;
  status: number;
}

const ORIGIN = "http://localhost:3000";
const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "GROQ_API_KEY"];

async function proxyVerdict(model: string): Promise<ProxyVerdict> {
  vi.mocked(validation.parseProxyToken).mockResolvedValue({
    mid: "mote-diff",
    jti: `jti-${Math.random()}`,
    bal: 100_000_000,
    // Empty = no per-token allowlist: the route's catalog rule alone decides.
    models: [],
    iat: Date.now(),
    exp: Date.now() + 3_600_000,
  } as ProxyTokenPayload);
  const fetchSpy = vi.fn(
    async () =>
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  try {
    let status: number;
    try {
      const res = await POST(
        new Request("https://proxy.example/api/v1/messages", {
          method: "POST",
          headers: { origin: ORIGIN, "x-proxy-token": "tok", "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        }),
      );
      await res.text().catch(() => "");
      status = res.status;
    } catch {
      // A throw AFTER admission (e.g. building the streamed response) still
      // means the request reached a provider; `fetchSpy` is the verdict.
      status = -1;
    }
    const calls = fetchSpy.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    return {
      admitted: calls.length > 0,
      upstream: calls.map(([u, init]) => `${String(u)} ${String(init?.body ?? "")}`).join("\n"),
      status,
    };
  } finally {
    vi.unstubAllGlobals();
  }
}

const verdicts = new Map<string, ProxyVerdict>();

beforeAll(async () => {
  process.env.RELAY_PUBLIC_KEY = "test-pubkey";
  for (const k of PROVIDER_ENV) process.env[k] = `sk-${k}`;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const m of CORPUS) {
    setSpendStoreForTests(memorySpendStore());
    verdicts.set(m, await proxyVerdict(m));
  }
}, 120_000);

afterAll(() => {
  setSpendStoreForTests(undefined);
  for (const k of PROVIDER_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

const admittedByProxy = (m: string): boolean => verdicts.get(m)!.admitted;

/** Report every disagreement at once, not just the first. */
function disagreements(client: (m: string) => boolean): string[] {
  return CORPUS.filter((m) => client(m) !== admittedByProxy(m)).map(
    (m) => `${JSON.stringify(m)}: proxy=${admittedByProxy(m)} client=${client(m)}`,
  );
}

// ── Assertions ───────────────────────────────────────────────────────────

describe("Motebit Cloud admission — proxy route ⇔ every client (#654 R2)", () => {
  it(`corpus covers every known id plus 200 garbled strings (${CORPUS.length} ids)`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(GARBLED_COUNT + 50);
    // The R2 witnesses are in it, and the proxy really serves them.
    for (const m of [
      "claude-opus",
      "claude-sonnet",
      "claude-opus-4-20250115",
      "gpt-4o",
      "gemini-flash",
    ]) {
      expect(admittedByProxy(m), m).toBe(true);
    }
    // And the R1 witness, which the proxy really refuses.
    expect(admittedByProxy("claude-sonnet-5")).toBe(false);
  });

  it("the shared function IS the route's verdict, resolved id included", () => {
    expect(disagreements((m) => motebitCloudAdmission(m).admitted)).toEqual([]);
    for (const m of CORPUS) {
      const a = motebitCloudAdmission(m);
      if (!a.admitted || m === "auto") continue;
      // The upstream request carries the resolved id, quoted.
      expect(verdicts.get(m)!.upstream, m).toContain(a.resolved);
    }
  });

  it("CLI launch pre-flight (`--provider proxy --model <id>`) agrees", () => {
    expect(disagreements((m) => admitModelForProvider("proxy", m).admissible)).toEqual([]);
  });

  it("CLI `--provider proxy --model <id>` parses to exactly <id> (no rewrite)", () => {
    for (const m of CORPUS.filter((x) => x !== "" && !x.startsWith("-"))) {
      if (!admittedByProxy(m)) continue;
      expect(parseCliArgs(["--provider", "proxy", "--model", m]).model, m).toBe(m);
      expect(parseCliArgs([`--provider=proxy`, `--model=${m}`]).model, m).toBe(m);
    }
  });

  it("CLI stored default_model on proxy: kept iff the proxy admits it, never rewritten", () => {
    const kept = (m: string): boolean => {
      const config = parseCliArgs(["--provider", "proxy"]);
      applyConfiguredProvider(config, { default_provider: "proxy", default_model: m }, []);
      return config.model === m;
    };
    // "" is "no stored model" (the default applies), not a stored id.
    const stored = CORPUS.filter((m) => m !== "");
    const bad = stored
      .filter((m) => kept(m) !== admittedByProxy(m))
      .map((m) => `${JSON.stringify(m)}: proxy=${admittedByProxy(m)} kept=${kept(m)}`);
    expect(bad).toEqual([]);
  });

  it("sdk providerAcceptsModel('proxy' | 'motebit-cloud') agrees", () => {
    expect(disagreements((m) => providerAcceptsModel("proxy", m))).toEqual([]);
    expect(disagreements((m) => providerAcceptsModel("motebit-cloud", m))).toEqual([]);
  });

  it("spatial model field (Cloud lane): keeps exactly what the proxy admits", () => {
    // Spatial saves the TRIMMED field value, so the verdict that matters is
    // the proxy's on the trimmed id — run the route on it too.
    const bad: string[] = [];
    for (const m of CORPUS) {
      const typed = m.trim();
      if (typed === "") continue;
      const kept = modelFieldValueForLane("motebit-cloud", "anthropic", typed) === typed;
      const proxy = admittedByProxy(typed);
      if (kept !== proxy) bad.push(`${JSON.stringify(typed)}: proxy=${proxy} kept=${kept}`);
    }
    expect(bad).toEqual([]);
  });
});
