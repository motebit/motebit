/**
 * EXHAUSTIVE differential harness — well-formed text in the payment-receipt
 * family (ExecutionReceipt shape, incl. sovereign payment receipts).
 *
 * Design note + stop condition: docs/design/payment-receipt-wellformed-stop-condition.md
 *
 * RED BY DESIGN. It was committed on the payment-receipt hash-binding branch
 * to show the defect class, NOT to fix it. Every cell that fails today is
 * listed in fixtures/payment-receipt-wellformed.known-red.json and registered
 * with `it.fails`: the suite is green only while each listed cell still
 * FAILS its (unweakened) assertion. A cell that a structural fix turns green
 * makes its `it.fails` red — delete it from the list in that fix's PR. A cell
 * not on the list must hold. Never edit an assertion to move a cell.
 *
 * Cross product:
 *   legacy receipts (signed exactly as main's producers signed) =
 *     every signed text field × every input × every verifier path
 *   producer outputs =
 *     every producer × every caller-supplied text input × every input × checks
 *
 * Invariants (one per check id suffix):
 *   I1 producer.emits-well-formed      — no producer emits an unpaired surrogate (refusing is fine)
 *   I1 producer.result-hash-binds      — emitted result_hash = hex(SHA-256(UTF-8(result)))
 *   I1 producer.preserves-well-formed  — well-formed caller text is signed byte-identically
 *   I1 producer.strict-accepts-own     — the library's strict verifier accepts the producer's output
 *   I2 cli-strict (both CLIs)          — any unpaired surrogate ⇒ INVALID with the §11.4 diagnostic;
 *                                         well-formed free text ⇒ VALID; never a crash
 *   I3 cli-lenient (both CLIs)         — an old (legacy-signed) receipt with malformed free text is accepted
 *   I4 runtime/relay acceptance        — verifyExecutionReceipt accepts an old receipt (free text)
 *   I5 library default ≡ origin/main   — verifyArtifact / verify / verifyReceiptVerdict /
 *                                         verifyExecutionReceipt verdicts byte-identical to main
 *   I6 python reference                — strict: §11.4 rejection; agrees with the TS strict verdict
 *   I7 cli differential                — motebit verify receipt ≡ motebit-verify, strict and lenient
 *
 * Environment: WF_DUMP_CORPUS=<path> writes the legacy corpus (for the main
 * oracle, apps/cli/scripts/wellformed-main-oracle.mjs); WF_REPORT=<path>
 * writes every failing cell with its reason. The python leg runs when
 * python3 + pynacl + requests import (REQUIRE_PYTHON=1 makes it mandatory).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cryptoLib from "@motebit/crypto";
import { buildServiceReceipt } from "@motebit/mcp-server";

import { buildSmokeWorkerReceipt } from "../subcommands/smoke-x402.js";
import { verifyWire } from "../subcommands/verify-wire.js";
import {
  INPUTS,
  LEGACY_FIELDS,
  MOTEBIT_ID,
  PAYER_ID,
  T0,
  baseBody,
  buildLegacyCorpus,
  deepWellFormed,
  digestOf,
  fixedKey,
  sha256Utf8,
  signLegacy,
  type FixedKey,
  type LegacyCell,
  type TextInput,
} from "./helpers/wellformed-corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const FIXTURES = join(HERE, "fixtures");
const GOLDEN_PATH = join(FIXTURES, "payment-receipt-wellformed.main-verdicts.json");
const KNOWN_RED_PATH = join(FIXTURES, "payment-receipt-wellformed.known-red.json");
const PY_DIR = join(REPO, "examples", "python-receipt-verifier");

/** The §11.4 diagnostic a strict verifier must name (crypto's and python's message share it). */
const DIAG = "unpaired UTF-16 surrogate";

const KNOWN_RED: ReadonlySet<string> = new Set(
  (
    JSON.parse(readFileSync(KNOWN_RED_PATH, "utf8")) as { failing: Array<{ id: string }> }
  ).failing.map((f) => f.id),
);

interface Golden {
  origin_main: string;
  cells: Record<
    string,
    { receiptDigest: string; paths: Record<string, { digest: string; summary: string }> }
  >;
}
const DUMPING = process.env.WF_DUMP_CORPUS !== undefined;
const GOLDEN: Golden | null = DUMPING
  ? null
  : (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden);

// ── Paths outside this package's dependency graph (loaded by URL) ────────

interface VerifierLib {
  verifyArtifact(content: object, opts?: { strictHashBinding?: boolean }): Promise<unknown>;
  verifyFile(
    path: string,
    opts?: { strictHashBinding?: boolean },
  ): Promise<{ valid: boolean; errors?: Array<{ message: string }> }>;
}
const loadVerifier = async (): Promise<VerifierLib> =>
  (await import(
    pathToFileURL(join(REPO, "packages", "verifier", "src", "index.ts")).href
  )) as VerifierLib;

type StreamChunk = { type: string; text?: string; receipt?: unknown };
interface AgentTaskHandlerModule {
  handleAgentTask(
    deps: unknown,
    task: unknown,
    privateKey: Uint8Array,
    deviceId: string,
    publicKey: Uint8Array,
  ): AsyncGenerator<StreamChunk>;
}
const loadAgentTaskHandler = async (): Promise<AgentTaskHandlerModule> =>
  (await import(
    pathToFileURL(join(REPO, "packages", "runtime", "src", "agent-task-handler.ts")).href
  )) as AgentTaskHandlerModule;

// ── Library paths whose DEFAULT must be byte-identical to origin/main ────
// Mirror of runLibPaths in apps/cli/scripts/wellformed-main-oracle.mjs.

const LIB_PATHS = [
  "verifier.verifyArtifact(default)",
  "crypto.verify(default)",
  "crypto.verifyReceiptVerdict",
  "runtime/relay verifyExecutionReceipt",
] as const;

async function settle(
  fn: () => Promise<unknown>,
): Promise<{ digest: string; summary: string; value?: unknown }> {
  try {
    const value = await fn();
    return { digest: digestOf(value), summary: summarize(value), value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { digest: digestOf({ threw: message }), summary: `threw: ${message}` };
  }
}

function summarize(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object") {
    const v = value as {
      valid?: unknown;
      errors?: Array<{ message: string }>;
      integrity?: unknown;
    };
    if ("valid" in v) {
      const errs = (v.errors ?? []).map((e) => e.message).join(" | ");
      return `valid=${String(v.valid)}${errs ? ` errors=${errs}` : ""}`;
    }
    if ("integrity" in v) return `integrity=${String(v.integrity)}`;
  }
  return JSON.stringify(value).slice(0, 200);
}

async function runLibPaths(
  verifier: VerifierLib,
  receipt: Record<string, unknown>,
): Promise<
  Record<(typeof LIB_PATHS)[number], { digest: string; summary: string; value?: unknown }>
> {
  const clone = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
  return {
    "verifier.verifyArtifact(default)": await settle(() => verifier.verifyArtifact(clone())),
    "crypto.verify(default)": await settle(() => cryptoLib.verify(clone())),
    "crypto.verifyReceiptVerdict": await settle(() =>
      cryptoLib.verifyReceiptVerdict(clone() as never),
    ),
    "runtime/relay verifyExecutionReceipt": await settle(() => {
      const r = clone();
      return cryptoLib.verifyExecutionReceipt(
        r as never,
        cryptoLib.hexToBytes(r.public_key as string),
      );
    }),
  };
}

// ── Producers ────────────────────────────────────────────────────────────

type Emit = { receipt: Record<string, unknown> } | { refused: string };

interface ProducerField {
  id: string;
  /** free: well-formed input ⇒ a valid receipt; format: value is format-constrained (hash hex). */
  cls: "free" | "format";
  run(text: string): Promise<Emit>;
  /** For a well-formed input: does the emitted receipt carry the caller's text unchanged? */
  preserved(r: Record<string, unknown>, text: string): boolean;
}

interface Producer {
  id: string;
  fields: ProducerField[];
}

async function emit(fn: () => Promise<unknown>): Promise<Emit> {
  try {
    const r = await fn();
    if (r === undefined || r === null) return { refused: "no receipt" };
    return { receipt: r as Record<string, unknown> };
  } catch (err: unknown) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
}

const childOf = (r: Record<string, unknown>): Record<string, unknown> =>
  ((r.delegation_receipts as Array<Record<string, unknown>> | undefined) ?? [])[0] ?? {};

async function producers(keys: { p: FixedKey; child: FixedKey }): Promise<Producer[]> {
  const { p, child } = keys;
  const legacyChild = async (text: string): Promise<Record<string, unknown>> => {
    const b = baseBody();
    b.task_id = "task-wf-child";
    b.result = text;
    b.result_hash = sha256Utf8(text);
    return signLegacy(b, child);
  };

  // P1 — @motebit/crypto signExecutionReceipt, fed by a correct caller
  // (result_hash = SHA-256 over a UTF-8 encoding of the result it passes).
  const p1 =
    (mutate: (b: Record<string, unknown>, t: string) => void | Promise<void>) =>
    async (text: string): Promise<Emit> =>
      emit(async () => {
        const b = baseBody();
        await mutate(b, text);
        if (typeof b.result === "string") b.result_hash = sha256Utf8(b.result);
        return cryptoLib.signExecutionReceipt(b as never, p.privateKey, p.publicKey);
      });
  const eq =
    (path: (r: Record<string, unknown>) => unknown) => (r: Record<string, unknown>, t: string) =>
      path(r) === t;

  const P1: Producer = {
    id: "P1 crypto.signExecutionReceipt",
    fields: [
      {
        id: "task_id",
        cls: "free",
        run: p1((b, t) => void (b.task_id = t)),
        preserved: eq((r) => r.task_id),
      },
      {
        id: "motebit_id",
        cls: "free",
        run: p1((b, t) => void (b.motebit_id = t)),
        preserved: eq((r) => r.motebit_id),
      },
      {
        id: "device_id",
        cls: "free",
        run: p1((b, t) => void (b.device_id = t)),
        preserved: eq((r) => r.device_id),
      },
      {
        id: "result",
        cls: "free",
        run: p1((b, t) => void (b.result = t)),
        preserved: eq((r) => r.result),
      },
      {
        id: "tools_used[0]",
        cls: "free",
        run: p1((b, t) => void (b.tools_used = [t])),
        preserved: eq((r) => (r.tools_used as string[])[0]),
      },
      {
        id: "relay_task_id",
        cls: "free",
        run: p1((b, t) => void (b.relay_task_id = t)),
        preserved: eq((r) => r.relay_task_id),
      },
      {
        id: "delegated_scope",
        cls: "free",
        run: p1((b, t) => void (b.delegated_scope = t)),
        preserved: eq((r) => r.delegated_scope),
      },
      {
        id: "source_projection",
        cls: "free",
        run: p1((b, t) => {
          b.source_digest = { algorithm: "sha-256", value: "b".repeat(64) };
          b.source_projection = t;
        }),
        preserved: eq((r) => r.source_projection),
      },
      {
        id: "prompt_hash",
        cls: "format",
        run: p1((b, t) => void (b.prompt_hash = t)),
        preserved: eq((r) => r.prompt_hash),
      },
      {
        id: "delegation_receipts[0] (old child, text in result)",
        cls: "free",
        run: p1(async (b, t) => void (b.delegation_receipts = [await legacyChild(t)])),
        preserved: eq((r) => childOf(r).result),
      },
    ],
  };

  // P2 — @motebit/crypto signSovereignPaymentReceipt. The runtime's payee
  // handler (MotebitRuntime.handleSovereignReceiptRequest) passes the PAYER's
  // request fields straight in, so every input here is payer-controlled text.
  const baseSovereign = (): Record<string, unknown> => ({
    payee_motebit_id: MOTEBIT_ID,
    payee_device_id: "device-wf",
    payer_motebit_id: PAYER_ID,
    rail: "solana",
    tx_hash:
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    amount_micro: 1_000_000n,
    asset: "USDC",
    service_description: "web search",
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    tools_used: ["web_search"],
    submitted_at: T0,
    completed_at: T0 + 1000,
  });
  const p2 =
    (key: string, wrap: (t: string) => unknown = (t) => t) =>
    async (text: string): Promise<Emit> =>
      emit(() =>
        cryptoLib.signSovereignPaymentReceipt(
          { ...baseSovereign(), [key]: wrap(text) } as never,
          p.privateKey,
          p.publicKey,
        ),
      );
  const inResult = (r: Record<string, unknown>, t: string): boolean =>
    typeof r.result === "string" && r.result.includes(t);
  const P2: Producer = {
    id: "P2 crypto.signSovereignPaymentReceipt",
    fields: [
      {
        id: "payee_motebit_id",
        cls: "free",
        run: p2("payee_motebit_id"),
        preserved: eq((r) => r.motebit_id),
      },
      {
        id: "payee_device_id",
        cls: "free",
        run: p2("payee_device_id"),
        preserved: eq((r) => r.device_id),
      },
      { id: "payer_motebit_id", cls: "free", run: p2("payer_motebit_id"), preserved: inResult },
      {
        id: "service_description",
        cls: "free",
        run: p2("service_description"),
        preserved: inResult,
      },
      { id: "asset", cls: "free", run: p2("asset"), preserved: inResult },
      {
        id: "rail",
        cls: "free",
        run: p2("rail"),
        preserved: (r, t) => inResult(r, t) && String(r.task_id).startsWith(`${t}:tx:`),
      },
      {
        id: "tx_hash",
        cls: "free",
        run: p2("tx_hash"),
        preserved: (r, t) => String(r.task_id).endsWith(`:tx:${t}`),
      },
      {
        id: "tools_used[0]",
        cls: "free",
        run: p2("tools_used", (t) => [t]),
        preserved: eq((r) => (r.tools_used as string[])[0]),
      },
      {
        id: "prompt_hash",
        cls: "format",
        run: p2("prompt_hash"),
        preserved: eq((r) => r.prompt_hash),
      },
      {
        id: "result_hash (→ service_result_hash)",
        cls: "format",
        run: p2("result_hash"),
        preserved: eq((r) => r.service_result_hash),
      },
    ],
  };

  // P3 — @motebit/mcp-server buildServiceReceipt (every MCP service's signer).
  const p3 =
    (patch: (t: string) => Record<string, unknown> | Promise<Record<string, unknown>>) =>
    async (text: string): Promise<Emit> =>
      emit(async () =>
        buildServiceReceipt({
          motebitId: MOTEBIT_ID,
          deviceId: "device-wf",
          privateKey: p.privateKey,
          publicKey: p.publicKey,
          prompt: "prompt",
          taskId: "task-wf",
          submittedAt: T0,
          completedAt: T0 + 1000,
          result: "ok",
          ok: true,
          toolsUsed: ["web_search"],
          ...(await patch(text)),
        } as never),
      );
  const P3: Producer = {
    id: "P3 mcp-server.buildServiceReceipt",
    fields: [
      {
        id: "taskId",
        cls: "free",
        run: p3((t) => ({ taskId: t })),
        preserved: eq((r) => r.task_id),
      },
      {
        id: "motebitId",
        cls: "free",
        run: p3((t) => ({ motebitId: t })),
        preserved: eq((r) => r.motebit_id),
      },
      {
        id: "deviceId",
        cls: "free",
        run: p3((t) => ({ deviceId: t })),
        preserved: eq((r) => r.device_id),
      },
      {
        id: "result",
        cls: "free",
        run: p3((t) => ({ result: t })),
        preserved: eq((r) => r.result),
      },
      {
        id: "toolsUsed[0]",
        cls: "free",
        run: p3((t) => ({ toolsUsed: [t] })),
        preserved: eq((r) => (r.tools_used as string[])[0]),
      },
      {
        id: "relayTaskId",
        cls: "free",
        run: p3((t) => ({ relayTaskId: t })),
        preserved: eq((r) => r.relay_task_id),
      },
      {
        id: "delegatedScope",
        cls: "free",
        run: p3((t) => ({ delegatedScope: t })),
        preserved: eq((r) => r.delegated_scope),
      },
      {
        id: "sourceProjection",
        cls: "free",
        run: p3((t) => ({
          sourceDigest: { algorithm: "sha-256", value: "b".repeat(64) },
          sourceProjection: t,
        })),
        preserved: eq((r) => r.source_projection),
      },
      {
        id: "delegationReceipts[0] (old child, text in result)",
        cls: "free",
        run: p3(async (t) => ({ delegationReceipts: [await legacyChild(t)] })),
        preserved: eq((r) => childOf(r).result),
      },
    ],
  };

  // P4 — @motebit/runtime handleAgentTask (every served task's receipt).
  const handler = await loadAgentTaskHandler();
  const noop = (): Promise<undefined> => Promise.resolve(undefined);
  const deps = (stream: () => AsyncGenerator<StreamChunk>): unknown => ({
    motebitId: MOTEBIT_ID,
    events: {
      appendWithClock: () => Promise.resolve(1),
      append: noop,
      query: () => Promise.resolve([]),
      getLatestClock: () => Promise.resolve(0),
      tombstone: noop,
    },
    agentTrustStore: null,
    agentGraph: { addReceiptEdges: noop },
    latencyStatsStore: null,
    logger: { warn: () => undefined },
    sendMessageStreaming: stream,
    bumpTrustFromReceipt: noop,
    clock: () => T0 + 1000,
  });
  const p4 = (opts: {
    taskId?: string;
    motebitId?: string;
    deviceId?: string;
    response?: string;
  }) =>
    emit(async () => {
      const response = opts.response ?? "ok";
      async function* stream(): AsyncGenerator<StreamChunk> {
        yield { type: "text", text: response };
      }
      let receipt: unknown;
      for await (const chunk of handler.handleAgentTask(
        deps(stream),
        {
          task_id: opts.taskId ?? "task-wf",
          motebit_id: opts.motebitId ?? MOTEBIT_ID,
          prompt: "prompt",
          submitted_at: T0,
          status: "claimed",
          capabilities: [],
        },
        p.privateKey,
        opts.deviceId ?? "device-wf",
        p.publicKey,
      )) {
        if (chunk.type === "task_result") receipt = chunk.receipt;
      }
      return receipt;
    });
  const P4: Producer = {
    id: "P4 runtime.handleAgentTask",
    fields: [
      {
        id: "task.task_id",
        cls: "free",
        run: (t) => p4({ taskId: t }),
        preserved: (r, t) => r.task_id === t && r.relay_task_id === t,
      },
      {
        id: "task.motebit_id",
        cls: "free",
        run: (t) => p4({ motebitId: t }),
        preserved: eq((r) => r.motebit_id),
      },
      {
        id: "deviceId",
        cls: "free",
        run: (t) => p4({ deviceId: t }),
        preserved: eq((r) => r.device_id),
      },
      {
        id: "model response",
        cls: "free",
        run: (t) => p4({ response: t }),
        preserved: eq((r) => r.result),
      },
    ],
  };

  // P5 — motebit smoke-x402 worker receipt (result = `echo-ack-${taskId.slice(0, 8)}`).
  // The "abcdefg" prefix puts the input's first code unit at index 7, so the
  // slice cuts an astral pair in two.
  const p5 = (o: { taskId?: string; motebitId?: string; deviceId?: string }) =>
    emit(() =>
      buildSmokeWorkerReceipt({
        worker: {
          motebitId: o.motebitId ?? MOTEBIT_ID,
          deviceId: o.deviceId ?? "device-wf",
          publicKey: p.publicKey,
          privateKey: p.privateKey,
        },
        taskId: o.taskId ?? "task-wf-smoke",
        submittedAtMs: T0,
        completedAt: T0 + 1000,
      }),
    );
  const P5: Producer = {
    id: "P5 cli.smoke-x402 worker receipt",
    fields: [
      {
        id: "taskId",
        cls: "free",
        run: (t) => p5({ taskId: `abcdefg${t}` }),
        preserved: (r, t) => r.task_id === `abcdefg${t}` && r.relay_task_id === `abcdefg${t}`,
      },
      {
        id: "worker.motebitId",
        cls: "free",
        run: (t) => p5({ motebitId: t }),
        preserved: eq((r) => r.motebit_id),
      },
      {
        id: "worker.deviceId",
        cls: "free",
        run: (t) => p5({ deviceId: t }),
        preserved: eq((r) => r.device_id),
      },
    ],
  };

  return [P1, P2, P3, P4, P5];
}

// ── Static cell ids (registered synchronously; evaluated in beforeAll) ───

const LEGACY_CHECKS = [
  ...LIB_PATHS.map((p) => `I5 ${p} ≡ origin/main`),
  "I4 runtime/relay accepts old receipt",
  "I2 motebit verify receipt (strict)",
  "I2 motebit-verify (strict)",
  "I3 motebit verify receipt --lenient",
  "I3 motebit-verify --lenient",
  "I7 strict verdicts agree",
  "I7 lenient verdicts agree",
] as const;
const PY_CHECKS = ["I6 python reference (strict)", "I6 python ≡ TS strict verdict"] as const;
const PRODUCER_CHECKS = [
  "I1 emits-well-formed",
  "I1 result-hash-binds",
  "I1 preserves-well-formed",
  "I1 strict-accepts-own",
] as const;

/**
 * Which legacy checks apply to a (field class, input). Format/enum fields
 * (hash hex, key hex, suite, status, origin, an unknown key) already differ
 * between the wire schema, crypto and python on main for WELL-FORMED values
 * — a format-validation divergence, not this defect class — so for them only
 * malformed inputs are asserted, plus "never crash" everywhere.
 */
function applicable(cls: "free" | "format", input: TextInput, check: string): boolean {
  if (cls === "free") return true;
  if (check === "I4 runtime/relay accepts old receipt") return false;
  if (check === "I7 lenient verdicts agree") return false;
  if (check === "I7 strict verdicts agree" || check === "I6 python ≡ TS strict verdict") {
    return !input.wellFormed;
  }
  return true;
}

// Producer field ids, statically (mirrors producers()).
const PRODUCER_FIELD_IDS: Record<string, string[]> = {
  "P1 crypto.signExecutionReceipt": [
    "task_id",
    "motebit_id",
    "device_id",
    "result",
    "tools_used[0]",
    "relay_task_id",
    "delegated_scope",
    "source_projection",
    "prompt_hash",
    "delegation_receipts[0] (old child, text in result)",
  ],
  "P2 crypto.signSovereignPaymentReceipt": [
    "payee_motebit_id",
    "payee_device_id",
    "payer_motebit_id",
    "service_description",
    "asset",
    "rail",
    "tx_hash",
    "tools_used[0]",
    "prompt_hash",
    "result_hash (→ service_result_hash)",
  ],
  "P3 mcp-server.buildServiceReceipt": [
    "taskId",
    "motebitId",
    "deviceId",
    "result",
    "toolsUsed[0]",
    "relayTaskId",
    "delegatedScope",
    "sourceProjection",
    "delegationReceipts[0] (old child, text in result)",
  ],
  "P4 runtime.handleAgentTask": ["task.task_id", "task.motebit_id", "deviceId", "model response"],
  "P5 cli.smoke-x402 worker receipt": ["taskId", "worker.motebitId", "worker.deviceId"],
};

const legacyId = (field: string, input: string, check: string): string =>
  `legacy | ${field} | ${input} | ${check}`;
const producerId = (prod: string, field: string, input: string, check: string): string =>
  `${prod} | ${field} | ${input} | ${check}`;

// ── Evaluation ───────────────────────────────────────────────────────────

/** check id → null (invariant holds) or the reason it does not. */
const results = new Map<string, string | null>();

function hasDiag(messages: readonly string[]): boolean {
  return messages.some((m) => m.includes(DIAG) && m.includes("§11.4"));
}

const pythonProbe = spawnSync("python3", ["-c", "import nacl, requests"], { encoding: "utf8" });
const PYTHON_OK = pythonProbe.status === 0;
if (!PYTHON_OK && process.env.REQUIRE_PYTHON === "1") {
  throw new Error(
    `REQUIRE_PYTHON=1 but python3 + pynacl + requests are unavailable: ${pythonProbe.stderr}`,
  );
}

const PY_DRIVER = `
import json, sys
sys.path.insert(0, sys.argv[1])
import verify as v
out = []
for r in json.load(sys.stdin):
    try:
        res = v.verify_receipt(r)
        out.append({"valid": bool(res.valid), "reasons": list(res.reasons)})
    except Exception as e:
        out.append({"threw": repr(e)})
sys.stdout.write(json.dumps(out))
`;

async function evaluateLegacy(
  verifier: VerifierLib,
  corpus: LegacyCell[],
  dir: string,
): Promise<void> {
  const py: Array<{ valid?: boolean; reasons?: string[]; threw?: string }> = PYTHON_OK
    ? (JSON.parse(
        spawnSync("python3", ["-c", PY_DRIVER, PY_DIR], {
          input: JSON.stringify(corpus.map((c) => c.receipt)),
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }).stdout,
      ) as Array<{ valid?: boolean; reasons?: string[]; threw?: string }>)
    : [];

  for (const [i, c] of corpus.entries()) {
    const { field, input, receipt } = c;
    const malformed = !input.wellFormed;
    const free = field.cls === "free";
    const set = (check: string, reason: string | null): void => {
      if (applicable(field.cls, input, check))
        results.set(legacyId(field.id, input.id, check), reason);
    };

    // I5 / I4 — library paths.
    const lib = await runLibPaths(verifier, receipt);
    const golden = GOLDEN?.cells[c.cell];
    for (const p of LIB_PATHS) {
      const check = `I5 ${p} ≡ origin/main`;
      if (!golden) set(check, "no origin/main verdict recorded for this cell");
      else if (golden.receiptDigest !== digestOf(receipt))
        set(check, "corpus drifted from the recorded main verdicts");
      else {
        const m = golden.paths[p]!;
        set(
          check,
          m.digest === lib[p].digest ? null : `main: ${m.summary} ≠ branch: ${lib[p].summary}`,
        );
      }
    }
    if (free) {
      const r = lib["runtime/relay verifyExecutionReceipt"];
      set("I4 runtime/relay accepts old receipt", r.value === true ? null : `got ${r.summary}`);
    }

    // CLIs (in-process — the exact calls each binary's exit code is computed from).
    const file = join(dir, `${i}.json`);
    writeFileSync(file, JSON.stringify(receipt));
    const wire = async (
      lenient: boolean,
    ): Promise<{ ok: boolean; msgs: string[] } | { threw: string }> => {
      try {
        const rep = await verifyWire("receipt", file, Date.now(), { lenient });
        return {
          ok: rep.ok,
          msgs: rep.checks.filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`),
        };
      } catch (err: unknown) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    };
    const mv = async (
      strict: boolean,
    ): Promise<{ ok: boolean; msgs: string[] } | { threw: string }> => {
      try {
        const res = await verifier.verifyFile(file, { strictHashBinding: strict });
        return { ok: res.valid, msgs: (res.errors ?? []).map((e) => e.message) };
      } catch (err: unknown) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    };
    const [ws, wl, ms, ml] = [await wire(false), await wire(true), await mv(true), await mv(false)];

    const strictCheck = (r: typeof ws): string | null => {
      if ("threw" in r) return `crashed: ${r.threw}`;
      if (malformed) {
        if (r.ok) return "accepted a receipt carrying an unpaired surrogate";
        return hasDiag(r.msgs)
          ? null
          : `rejected without the §11.4 diagnostic: ${r.msgs.join(" ; ")}`;
      }
      if (free) return r.ok ? null : `rejected well-formed text: ${r.msgs.join(" ; ")}`;
      return hasDiag(r.msgs) ? "named §11.4 for well-formed text" : null;
    };
    set("I2 motebit verify receipt (strict)", strictCheck(ws));
    set("I2 motebit-verify (strict)", strictCheck(ms));

    const lenientCheck = (r: typeof wl): string | null => {
      if ("threw" in r) return `crashed: ${r.threw}`;
      if (!free) return null; // format fields: only "never crash" is asserted under lenient
      return r.ok ? null : `rejected an old receipt: ${r.msgs.join(" ; ")}`;
    };
    set("I3 motebit verify receipt --lenient", lenientCheck(wl));
    set("I3 motebit-verify --lenient", lenientCheck(ml));

    const okOf = (r: typeof ws): string => ("threw" in r ? "crash" : r.ok ? "VALID" : "INVALID");
    set(
      "I7 strict verdicts agree",
      okOf(ws) === okOf(ms) ? null : `motebit ${okOf(ws)} ≠ motebit-verify ${okOf(ms)}`,
    );
    set(
      "I7 lenient verdicts agree",
      okOf(wl) === okOf(ml) ? null : `motebit ${okOf(wl)} ≠ motebit-verify ${okOf(ml)}`,
    );

    if (PYTHON_OK) {
      const p = py[i]!;
      let reason: string | null;
      if (p.threw !== undefined) reason = `crashed: ${p.threw}`;
      else if (malformed)
        reason = p.valid
          ? "accepted an unpaired surrogate"
          : hasDiag(p.reasons ?? [])
            ? null
            : `rejected without §11.4: ${(p.reasons ?? []).join(" ; ")}`;
      else if (free)
        reason = p.valid ? null : `rejected well-formed text: ${(p.reasons ?? []).join(" ; ")}`;
      else reason = hasDiag(p.reasons ?? []) ? "named §11.4 for well-formed text" : null;
      set("I6 python reference (strict)", reason);
      const pyOk = p.threw !== undefined ? "crash" : p.valid ? "VALID" : "INVALID";
      set(
        "I6 python ≡ TS strict verdict",
        pyOk === okOf(ms) ? null : `python ${pyOk} ≠ motebit-verify ${okOf(ms)}`,
      );
    }
  }
}

async function evaluateProducers(verifier: VerifierLib): Promise<void> {
  const prods = await producers({ p: await fixedKey(0x09), child: await fixedKey(0x08) });
  for (const prod of prods) {
    for (const f of prod.fields) {
      for (const input of INPUTS) {
        const set = (check: string, reason: string | null): void => {
          results.set(producerId(prod.id, f.id, input.id, check), reason);
        };
        const out = await f.run(input.text);
        if ("refused" in out) {
          // Refusing malformed input satisfies I1; refusing well-formed free text does not.
          const bad =
            input.wellFormed && f.cls === "free"
              ? `refused well-formed text: ${out.refused}`
              : null;
          set("I1 emits-well-formed", null);
          set("I1 result-hash-binds", null);
          set("I1 preserves-well-formed", bad);
          set("I1 strict-accepts-own", f.cls === "free" ? bad : null);
          continue;
        }
        const r = out.receipt;
        set(
          "I1 emits-well-formed",
          deepWellFormed(r)
            ? null
            : `emitted an unpaired surrogate: ${JSON.stringify(r).match(/"[^"]*\\ud[89a-f][0-9a-f]{2}[^"]*"/i)?.[0] ?? "(nested)"}`,
        );
        set(
          "I1 result-hash-binds",
          typeof r.result === "string" && r.result_hash === sha256Utf8(r.result)
            ? null
            : "result_hash ≠ hex(SHA-256(UTF-8(result)))",
        );
        set(
          "I1 preserves-well-formed",
          !input.wellFormed || f.preserved(r, input.text)
            ? null
            : "well-formed caller text altered",
        );
        if (f.cls === "free") {
          const res = (await verifier.verifyArtifact(JSON.parse(JSON.stringify(r)) as object, {
            strictHashBinding: true,
          })) as { valid: boolean; errors?: Array<{ message: string }> };
          set(
            "I1 strict-accepts-own",
            res.valid
              ? null
              : `strict rejects own output: ${(res.errors ?? []).map((e) => e.message).join(" | ")}`,
          );
        } else set("I1 strict-accepts-own", null);
      }
    }
  }
}

// ── Registration ─────────────────────────────────────────────────────────

let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wf-harness-"));
  const corpus = await buildLegacyCorpus();
  if (DUMPING) {
    writeFileSync(
      process.env.WF_DUMP_CORPUS!,
      JSON.stringify(
        corpus.map((c) => ({
          cell: c.cell,
          receiptDigest: digestOf(c.receipt),
          receipt: c.receipt,
        })),
      ),
    );
  }
  const verifier = await loadVerifier();
  await evaluateLegacy(verifier, corpus, dir);
  await evaluateProducers(verifier);
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  const out = process.env.WF_REPORT;
  if (out) {
    const failing = [...results.entries()]
      .filter(([, reason]) => reason !== null)
      .map(([id, reason]) => ({ id, reason }));
    writeFileSync(out, `${JSON.stringify({ failing }, null, 2)}\n`);
  }
});

function cell(id: string): void {
  const red = KNOWN_RED.has(id);
  (red ? it.fails : it)(id, () => {
    expect(results.has(id), `cell ${id} was not evaluated`).toBe(true);
    expect(results.get(id) ?? null).toBeNull();
  });
}

describe.skipIf(DUMPING)("payment-receipt well-formed text — legacy receipts × verifiers", () => {
  for (const field of LEGACY_FIELDS) {
    describe(field.id, () => {
      for (const input of INPUTS) {
        for (const check of LEGACY_CHECKS) {
          if (applicable(field.cls, input, check)) cell(legacyId(field.id, input.id, check));
        }
      }
    });
  }
});

// Environment-gated (python3 + pynacl + requests), like check-receipt-conformance's python leg.
describe.skipIf(DUMPING || !PYTHON_OK)(
  "payment-receipt well-formed text — python reference verifier",
  () => {
    for (const field of LEGACY_FIELDS) {
      for (const input of INPUTS) {
        for (const check of PY_CHECKS) {
          if (applicable(field.cls, input, check)) cell(legacyId(field.id, input.id, check));
        }
      }
    }
  },
);

describe.skipIf(DUMPING)("payment-receipt well-formed text — producers", () => {
  for (const [prod, fields] of Object.entries(PRODUCER_FIELD_IDS)) {
    describe(prod, () => {
      for (const f of fields) {
        for (const input of INPUTS as readonly TextInput[]) {
          for (const check of PRODUCER_CHECKS) cell(producerId(prod, f, input.id, check));
        }
      }
    });
  }
});

describe("payment-receipt well-formed text — harness integrity", () => {
  it("every known-red id names a registered cell", () => {
    if (DUMPING) return;
    const registered = new Set(results.keys());
    const stale = [...KNOWN_RED].filter(
      (id) => !registered.has(id) && (PYTHON_OK || !id.includes("| I6 ")),
    );
    expect(stale).toEqual([]);
  });
  it("the input corpus covers both malformed and well-formed text", () => {
    expect(INPUTS.filter((x) => !x.wellFormed).length).toBeGreaterThanOrEqual(8);
    expect(INPUTS.filter((x) => x.wellFormed).length).toBeGreaterThanOrEqual(6);
  });
});
