#!/usr/bin/env tsx
/**
 * probe-provider-live — does a real turn actually work through this vendor?
 *
 * `PROVIDER_VERIFICATION` (@motebit/sdk) distinguishes *supported* from
 * *witnessed*. This script is what moves a row from `available` to `verified`:
 * it runs a live turn through the SAME adapter and the SAME resolver defaults a
 * real surface would use, and reports what happened.
 *
 * WHY THROUGH THE ADAPTER, NOT RAW FETCH. A raw HTTP call proves the vendor is
 * up; it proves nothing about motebit. #476 was a REQUEST-SHAPE defect — the
 * endpoint was healthy and our serialization was wrong. A probe that bypasses
 * `OpenAIProvider`/`AnthropicProvider` cannot see that class of bug, which is
 * the only class worth a live key. Likewise the model id and base URL come from
 * `defaultModelForVendor` / `canonicalVendorBaseUrl` rather than being written
 * here: if the resolver's default names a retired model, the probe must fail —
 * that is the #474 class, and hardcoding a known-good id here would hide it.
 *
 * WHY TWO TURNS, NOT ONE. A prompt that forces a tool call frequently streams
 * ZERO text chunks, so `text && tool_call` in a single turn is flaky and — worse
 * — tells you nothing about WHICH half broke. Streaming (SSE assembly) and tool
 * calling (schema translation + argument reassembly across chunks) are separate
 * failure surfaces that fail independently, so they are probed independently.
 *
 * KEY-GATED, NEVER SILENTLY GREEN. A vendor with no key is reported NOT
 * ASSESSED and is never counted as passing. `--require=a,b` makes named vendors
 * fatal when their key is absent, mirroring `requiredInCi` in
 * check-model-catalog-drift: a secret that gets REMOVED must go red rather than
 * quietly downgrade the run to a no-op.
 *
 * This is a PROBE, not a gate — it costs money and needs secrets, so it is
 * manual-dispatch and is not in `pnpm check`.
 *
 * Usage:
 *   npx tsx scripts/probe-provider-live.ts                    # every vendor with a key
 *   npx tsx scripts/probe-provider-live.ts --vendor=openai
 *   npx tsx scripts/probe-provider-live.ts --require=openai   # missing key ⇒ red
 */

import { AnthropicProvider, OpenAIProvider } from "../packages/ai-core/src/index.js";
import type { StreamingProvider } from "../packages/ai-core/src/core.js";
import {
  canonicalVendorBaseUrl,
  defaultModelForVendor,
  PROVIDER_VERIFICATION,
  type ByokVendor,
  type ContextPack,
  type MotebitState,
} from "../packages/sdk/src/index.js";
import type { ToolDefinition } from "../packages/protocol/src/index.js";
// Reused, not reinvented: this is the same durable-vs-transient classifier the
// molecule runner uses to decide whether to stop advertising. A 401 here means
// "your key/account", never "your adapter", and sending a reader to the wrong
// file is precisely what the repair-instruction contract forbids.
import { classifyProviderFailure } from "../packages/molecule-runner/src/readiness.js";

const VENDORS: readonly ByokVendor[] = ["anthropic", "openai", "google", "groq", "deepseek"];

/** Env var holding each vendor's key. Named exactly as the repo secret. */
const KEY_ENV: Readonly<Record<ByokVendor, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Neutral resting state — the probe is about transport, not affect. */
const NEUTRAL_STATE: MotebitState = {
  attention: 0.5,
  processing: 0.5,
  confidence: 0.5,
  affect_valence: 0,
  affect_arousal: 0.3,
  social_distance: 0.5,
  curiosity: 0.5,
  trust_mode: "cautious",
  battery_mode: "normal",
};

/**
 * One required string property. Deliberately minimal: a rich schema would
 * conflate "this vendor cannot do tools" with "this vendor dislikes this
 * schema". The narrow shape is the floor every vendor claims to support.
 */
const PROBE_TOOL: ToolDefinition = {
  name: "report_status",
  description: "Report a one-word status. Call this whenever the user asks for a status report.",
  inputSchema: {
    type: "object",
    properties: { status: { type: "string", description: "A single lowercase word." } },
    required: ["status"],
  },
};

function pack(userMessage: string, tools?: ToolDefinition[]): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: NEUTRAL_STATE,
    user_message: userMessage,
    ...(tools != null ? { tools } : {}),
  };
}

function buildProvider(vendor: ByokVendor, apiKey: string): StreamingProvider {
  const model = defaultModelForVendor(vendor);
  const baseUrl = canonicalVendorBaseUrl(vendor);
  // The anthropic/openai-compat split IS the provider matrix: four vendors ride
  // the compat shape via base_url, which is why openai passing is evidence
  // about the shape but NOT about google/groq/deepseek's own quirks.
  return vendor === "anthropic"
    ? new AnthropicProvider({ api_key: apiKey, model, base_url: baseUrl, max_tokens: 256 })
    : new OpenAIProvider({ api_key: apiKey, model, base_url: baseUrl, max_tokens: 256 });
}

interface TurnOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Turn A — does text arrive over SSE at all, and does it arrive in pieces?
 *
 * The PASS condition is "text arrived": a provider is free to buffer, and
 * failing it for that would be asserting an implementation detail no vendor
 * promises. But a one-word reply arrives in one chunk either way, which makes
 * the chunk count useless as evidence — so the prompt asks for output long
 * enough that a real SSE path shows many chunks and a buffered one shows 1.
 * The count is REPORTED, not asserted; a sudden drop to 1 is a signal for a
 * human, not an automatic red.
 */
async function probeStreaming(provider: StreamingProvider): Promise<TurnOutcome> {
  let chunks = 0;
  let text = "";
  for await (const chunk of provider.generateStream(
    pack("Count from one to twenty in words, separated by commas. No preamble."),
  )) {
    if (chunk.type === "text") {
      chunks += 1;
      text += chunk.text;
    }
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, detail: `stream produced ${chunks} chunk(s) and NO text` };
  }
  const shape = chunks === 1 ? "buffered (1 chunk — not incremental)" : `${chunks} chunks`;
  return { ok: true, detail: `${shape}, ${trimmed.length} char(s): "${trimmed.slice(0, 32)}…"` };
}

/** Turn B — does a tool schema survive translation, and do args reassemble? */
async function probeToolCall(provider: StreamingProvider): Promise<TurnOutcome> {
  let response;
  for await (const chunk of provider.generateStream(
    pack("Give me a status report. Use your tool. Set status to exactly: ok", [PROBE_TOOL]),
  )) {
    if (chunk.type === "done") response = chunk.response;
  }
  if (response == null) return { ok: false, detail: "stream ended with no `done` chunk" };

  const calls = response.tool_calls ?? [];
  if (calls.length === 0) {
    return {
      ok: false,
      detail: `no tool call (model replied with text: "${response.text.trim().slice(0, 60)}")`,
    };
  }
  const call = calls[0]!;
  if (call.name !== PROBE_TOOL.name) {
    return { ok: false, detail: `called "${call.name}", expected "${PROBE_TOOL.name}"` };
  }
  // Argument REASSEMBLY is the real assertion: OpenAI streams `arguments` as a
  // partial JSON string split across chunks, and a broken accumulator yields a
  // well-formed call with unparseable args. Assert presence + type, not the
  // exact value — a model paraphrasing "ok" is not a transport defect.
  const args = call.args as Record<string, unknown> | undefined;
  const status = args?.["status"];
  if (typeof status !== "string") {
    return {
      ok: false,
      detail: `arguments did not reassemble into {status: string}: ${JSON.stringify(args)}`,
    };
  }
  return { ok: true, detail: `${call.name}({status: ${JSON.stringify(status)}})` };
}

interface VendorResult {
  vendor: ByokVendor;
  status: "passed" | "failed" | "not-assessed";
  model: string;
  lines: string[];
  /** Non-null when the failure was a credential/billing condition, not a code defect. */
  durableReason: string | null;
}

async function probeVendor(vendor: ByokVendor): Promise<VendorResult> {
  const model = defaultModelForVendor(vendor);
  const apiKey = process.env[KEY_ENV[vendor]];
  if (apiKey == null || apiKey.trim().length === 0) {
    return {
      vendor,
      status: "not-assessed",
      model,
      lines: [`no ${KEY_ENV[vendor]} in env`],
      durableReason: null,
    };
  }

  const provider = buildProvider(vendor, apiKey);
  const lines: string[] = [];
  let ok = true;
  let durableReason: string | null = null;

  for (const [label, run] of [
    ["stream", probeStreaming],
    ["tool  ", probeToolCall],
  ] as const) {
    try {
      const outcome = await run(provider);
      lines.push(`${outcome.ok ? "✓" : "✗"} ${label}  ${outcome.detail}`);
      if (!outcome.ok) ok = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // First line only: provider error bodies are multi-line JSON and the
      // status line carries the signal. Trailing `{` is the opening brace of the
      // body that follows, so it is noise once the body is dropped.
      const headline = message
        .split("\n")[0]!
        .trim()
        .replace(/\s*\{$/, "");
      lines.push(`✗ ${label}  threw: ${headline}`);
      durableReason ??= classifyProviderFailure(message);
      ok = false;
    }
  }
  return { vendor, status: ok ? "passed" : "failed", model, lines, durableReason };
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const only = arg("vendor");
  const required = (arg("require") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const targets = only != null ? VENDORS.filter((v) => v === only) : VENDORS;
  if (targets.length === 0) {
    console.error(`Unknown vendor "${only}". Known: ${VENDORS.join(", ")}`);
    process.exit(1);
  }

  console.log(`probe-provider-live — live turn through the real adapter\n`);

  const results: VendorResult[] = [];
  for (const vendor of targets) {
    const r = await probeVendor(vendor);
    results.push(r);
    const shipped = PROVIDER_VERIFICATION[vendor];
    console.log(`${vendor}  (${r.model}, shipped as "${shipped}")`);
    for (const line of r.lines) console.log(`    ${line}`);
    console.log("");
  }

  const passed = results.filter((r) => r.status === "passed");
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "not-assessed");

  // A required vendor whose key is absent is a FAILURE, not a skip — otherwise
  // deleting a secret silently turns the probe into a no-op that still exits 0.
  const missingRequired = skipped.filter((r) => required.includes(r.vendor));

  // The loudest case: the shipped record CLAIMS verified and the live turn says
  // otherwise. That is a user-facing false claim, not just a red probe.
  const contradicted = failed.filter((r) => PROVIDER_VERIFICATION[r.vendor] === "verified");
  // The useful case: probe passes but the record still says `available`.
  const promotable = passed.filter((r) => PROVIDER_VERIFICATION[r.vendor] === "available");

  console.log(
    `probed ${results.length - skipped.length}/${targets.length} vendor(s): ` +
      `${passed.length} passed, ${failed.length} failed, ${skipped.length} not assessed` +
      (skipped.length > 0 ? ` (${skipped.map((r) => r.vendor).join(", ")})` : ""),
  );

  // Aperture. PROVIDER_VERIFICATION carries rows this probe structurally cannot
  // reach — `local-server` is the user's own machine, with no canonical URL and
  // no key to hold. Derived by SUBTRACTION from the shipped record rather than
  // listed here, so adding a seventh provider to VerifiableProvider without a
  // ByokVendor entry surfaces it automatically instead of silently narrowing
  // what "all vendors passed" means.
  const unreachable = Object.keys(PROVIDER_VERIFICATION).filter(
    (p) => !(VENDORS as readonly string[]).includes(p),
  );
  if (unreachable.length > 0) {
    console.log(
      `  aperture: ${VENDORS.length}/${Object.keys(PROVIDER_VERIFICATION).length} rows in ` +
        `PROVIDER_VERIFICATION are reachable by this probe; ${unreachable.join(", ")} ` +
        `${unreachable.length === 1 ? "is" : "are"} not (no key, no canonical endpoint) and ` +
        `${unreachable.length === 1 ? "its" : "their"} shipped status rests on other evidence.`,
    );
  }

  if (contradicted.length > 0) {
    console.error(
      `\nFAILED — shipped as "verified" but the live turn did not pass: ` +
        `${contradicted.map((r) => r.vendor).join(", ")}\n` +
        `  → Surfaces are telling users these vendors are witnessed working. Either fix the\n` +
        `    adapter or downgrade the row in packages/sdk/src/models.ts (PROVIDER_VERIFICATION)\n` +
        `    and its PROVIDER_NOTE in the same edit — the note's prose must not outlive the status.`,
    );
  }
  const plainFailures = failed.filter((r) => !contradicted.includes(r));
  // Split the repair instruction by CAUSE. A 401 and a malformed request both
  // surface as "the turn failed", but they are repaired in different places, and
  // a rejected key routed to "go read the adapter" is a repair instruction that
  // actively misleads — worse than none.
  const credentialFailures = failed.filter((r) => r.durableReason != null);
  const codeFailures = plainFailures.filter((r) => r.durableReason == null);

  if (credentialFailures.length > 0) {
    console.error(
      `\nFAILED — the account, not the code:\n` +
        credentialFailures.map((r) => `    ${r.vendor}: ${r.durableReason}`).join("\n") +
        `\n  → Nothing to fix in the adapter. Rotate or top up the credential behind ` +
        `${credentialFailures.map((r) => KEY_ENV[r.vendor]).join(", ")},\n` +
        `    then re-run. A rejected or unfunded key is NOT evidence that the vendor is\n` +
        `    broken, so do NOT downgrade its PROVIDER_VERIFICATION row on this result —\n` +
        `    the probe never got to look.`,
    );
  }
  if (codeFailures.length > 0) {
    console.error(
      `\nFAILED — live turn broke for: ${codeFailures.map((r) => r.vendor).join(", ")}\n` +
        `  → Read the ✗ line above: a \`stream\` failure is SSE assembly, a \`tool\` failure is\n` +
        `    schema translation or argument reassembly. Both live in the adapter for that wire\n` +
        `    protocol (packages/ai-core/src/openai-provider.ts or core.ts's AnthropicProvider),\n` +
        `    NOT in the resolver. If the model id itself is retired, fix the default in\n` +
        `    packages/sdk/src/provider-resolver.ts — do not pin a known-good id in this probe.`,
    );
  }
  if (missingRequired.length > 0) {
    console.error(
      `\nFAILED — required vendor(s) had no key: ${missingRequired.map((r) => r.vendor).join(", ")}\n` +
        `  → These were named in --require, so a missing key is red by design. Restore the\n` +
        `    secret(s) ${missingRequired.map((r) => KEY_ENV[r.vendor]).join(", ")} in repo settings,\n` +
        `    or drop them from --require in .github/workflows/provider-probe.yml if the vendor\n` +
        `    is genuinely no longer probed.`,
    );
  }

  if (promotable.length > 0) {
    console.log(
      `\n${promotable.length} vendor(s) passed while shipped as "available": ` +
        `${promotable.map((r) => r.vendor).join(", ")}\n` +
        `  → A passing probe is the evidence required to promote. In packages/sdk/src/models.ts\n` +
        `    set PROVIDER_VERIFICATION.<vendor> = "verified" and rewrite that vendor's\n` +
        `    PROVIDER_NOTE (drop "no live turn witnessed yet"). Promote only the vendors listed\n` +
        `    here: passing openai is evidence about the openai-compat SHAPE, never about\n` +
        `    google/groq/deepseek, which have their own quirks behind the same wire format.`,
    );
  }

  if (contradicted.length + plainFailures.length + missingRequired.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`probe-provider-live crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
