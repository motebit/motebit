/**
 * Every relay 402 the delegate paths can receive × every CLI delegate path.
 * Each cell must name the remedy that actually clears the refusal: `motebit
 * fund` ONLY when the 402 is genuinely insufficient relay balance, `--sovereign`
 * when paid delegation to another agent must settle P2P (locally or across a
 * federated peer), and the relay's own words for a refusal no deposit clears.
 *
 * Paths:
 *   - direct    — `motebit delegate` (the submission's 402 body, via the helper)
 *   - plan      — `motebit delegate --plan`, driven through the real step adapter
 *   - sovereign — `motebit delegate --sovereign` (the runtime's `DelegationError`)
 *   - repl      — the REPL's `/delegate`, driven through `handleSlashCommand`
 *                 against a relay answering the submission with the 402 body;
 *                 it prints `motebit delegate`'s lines, except that a P2P
 *                 remedy names the shell command (`/delegate` parses no flags)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DeviceCapability, StepStatus } from "@motebit/sdk";
import type { PlanStep, PlanId } from "@motebit/sdk";
import {
  createHttpPollingDelegationAdapter,
  describeDelegateSubmit402,
  describeSovereignDelegationRefusal,
} from "../subcommands/delegate.js";
import { handleSlashCommand, type ReplContext } from "../index.js";
import type { MotebitRuntime } from "@motebit/runtime";
import type { MotebitDatabase } from "@motebit/persistence";
import { parseCliArgs, type CliConfig } from "../args.js";

type Remedy = "fund" | "sovereign" | "relay-words";

interface Row {
  label: string;
  /** The 402 body as the relay serializes it (middleware onError / x402 gate). */
  body: string;
  /** The runtime's classification of that body (`classifyRelayError`). */
  runtimeCode: "payment_proof_required" | "insufficient_balance";
  /** A substring of the relay's words a `relay-words` remedy must carry. */
  words?: string;
  direct: Remedy;
  plan: Remedy;
}

const ROWS: Row[] = [
  {
    label: "INSUFFICIENT_FUNDS (empty virtual account)",
    body: JSON.stringify({ error: "Insufficient funds", code: "INSUFFICIENT_FUNDS", status: 402 }),
    runtimeCode: "insufficient_balance",
    direct: "fund",
    plan: "fund",
  },
  {
    label: "TASK_P2P_PROOF_REQUIRED (Arc 3.5 gate, local worker)",
    body: JSON.stringify({
      error: "Paid direct delegation requires a P2P payment_proof: ...",
      code: "TASK_P2P_PROOF_REQUIRED",
      status: 402,
    }),
    runtimeCode: "payment_proof_required",
    direct: "sovereign",
    plan: "sovereign",
  },
  {
    label: "TASK_P2P_PROOF_REQUIRED (paid federated forward, admitted task)",
    body: JSON.stringify({
      error: "Paid federated delegation requires a 3-leg P2P payment_proof ...",
      code: "TASK_P2P_PROOF_REQUIRED",
      status: 402,
      task_id: "task-fed",
    }),
    runtimeCode: "payment_proof_required",
    direct: "sovereign",
    plan: "sovereign",
  },
  {
    label: "TASK_X402_SETTLEMENT_FAILED",
    body: JSON.stringify({
      error:
        "The facilitator refused the x402 payment before submitting it (x). Retry with a fresh payment.",
      code: "TASK_X402_SETTLEMENT_FAILED",
      status: 402,
    }),
    runtimeCode: "insufficient_balance",
    words: "facilitator refused",
    direct: "relay-words",
    plan: "relay-words",
  },
  {
    label: "TASK_X402_OUTCOME_UNKNOWN",
    body: JSON.stringify({
      error: "The x402 payment outcome is unknown: the transfer may have landed. Do NOT pay again.",
      code: "TASK_X402_OUTCOME_UNKNOWN",
      status: 402,
    }),
    runtimeCode: "insufficient_balance",
    words: "Do NOT pay again",
    direct: "relay-words",
    plan: "relay-words",
  },
  {
    label: "a coded 402 this client does not know",
    body: JSON.stringify({ error: "Some future refusal", code: "TASK_FUTURE_402", status: 402 }),
    runtimeCode: "insufficient_balance",
    words: "Some future refusal",
    direct: "relay-words",
    plan: "relay-words",
  },
  {
    label: "x402 challenge (codeless: spendable balance below the price)",
    body: JSON.stringify({ x402Version: 2, error: "Payment required", accepts: [] }),
    runtimeCode: "insufficient_balance",
    direct: "fund",
    plan: "fund",
  },
  {
    label: "facilitator unavailable (codeless payment_required)",
    body: JSON.stringify({
      error: "payment_required",
      message: "Payment facilitator unavailable — deposit to virtual account or retry later",
    }),
    runtimeCode: "insufficient_balance",
    direct: "fund",
    plan: "fund",
  },
  {
    label: "non-JSON 402",
    body: "Payment Required",
    runtimeCode: "insufficient_balance",
    direct: "fund",
    plan: "fund",
  },
];

function assertRemedy(text: string, remedy: Remedy, row: Row): void {
  if (remedy === "fund") {
    expect(text).toContain("motebit fund");
    return;
  }
  expect(text, "a deposit cannot clear this refusal").not.toContain("motebit fund");
  if (remedy === "sovereign") {
    expect(text).toMatch(/settles P2P/);
    expect(text).toContain("--sovereign");
  } else {
    expect(text).toContain(row.words!);
  }
}

type Path = "direct" | "plan" | "repl";

const REPL_TARGET = "00000000-0000-4000-8000-000000000402";
// `!` would trigger history expansion inside double quotes; `'` must survive single quotes.
const REPL_PROMPT = `do the "paid" thing, it's urgent!`;
/** The one capability the pinned REPL target lists and prices — not the `web_search` default. */
const REPL_CAPABILITY = "code_review";

/**
 * Split a shell command line into argv, honoring single quotes (literal, no
 * escapes), double quotes and backslash escapes. A `!` inside double quotes is
 * history expansion in an interactive shell, so a remedy must never put one there.
 */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'" && !quoted) {
      const end = line.indexOf("'", i + 1);
      expect(end, `unbalanced single quote in \`${line}\``).toBeGreaterThan(i);
      cur += line.slice(i + 1, end);
      i = end;
      inArg = true;
    } else if (ch === "!" && quoted) {
      throw new Error(`\`!\` inside double quotes triggers history expansion: \`${line}\``);
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      inArg = true;
    } else if (ch === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (ch === " " && !quoted) {
      if (inArg) out.push(cur);
      cur = "";
      inArg = false;
    } else {
      cur += ch;
      inArg = true;
    }
  }
  expect(quoted, `unbalanced quotes in \`${line}\``).toBe(false);
  if (inArg) out.push(cur);
  return out;
}

/**
 * Every remedy must be runnable on the path that printed it. A backticked
 * `motebit ...` command must parse under the real CLI parser; a bare
 * backticked `--flag` is advice to re-run THIS path with that flag, so the
 * path must parse it — `motebit delegate` does, the REPL's `/delegate` (all
 * text after the target id is the prompt) and a `--plan` step do not. On the
 * REPL a `motebit delegate` remedy must carry the prompt and target typed.
 */
function assertRunnable(text: string, path: Path): void {
  for (const [, fragment] of text.matchAll(/`([^`]+)`/g)) {
    const frag = fragment!;
    if (frag.startsWith("motebit ")) {
      const argv = shellSplit(frag.slice("motebit ".length));
      if (argv.some((a) => a.startsWith("<"))) continue; // a placeholder (`fund <amount>`)
      const parsed = (() => {
        try {
          return parseCliArgs(argv);
        } catch (err: unknown) {
          throw new Error(`remedy \`${frag}\` does not parse: ${String(err)}`);
        }
      })();
      if (path === "repl" && parsed.positionals[0] === "delegate") {
        expect(parsed.positionals.slice(1).join(" "), `\`${frag}\` drops the prompt`).toBe(
          REPL_PROMPT,
        );
        expect(parsed.target, `\`${frag}\` drops the target`).toBe(REPL_TARGET);
        // `motebit delegate` defaults to web_search and the sovereign resolver
        // discovers by capability: a target that does not list it is refused.
        expect(parsed.capability, `\`${frag}\` drops the target's capability`).toBe(
          REPL_CAPABILITY,
        );
      }
    } else if (frag.startsWith("--")) {
      expect(path, `\`${frag}\` is a flag the ${path} path does not parse`).toBe("direct");
      expect(() => parseCliArgs(["delegate", "x", ...frag.split(" ")])).not.toThrow();
    }
  }
}

const step: PlanStep = {
  step_id: "step-1",
  plan_id: "plan-1" as PlanId,
  ordinal: 0,
  description: "Paid step",
  prompt: "Do the paid thing",
  depends_on: [],
  optional: false,
  status: StepStatus.Pending,
  required_capabilities: [DeviceCapability.HttpMcp],
  result_summary: null,
  error_message: null,
  tool_calls_made: 0,
  started_at: null,
  completed_at: null,
  retry_count: 0,
  updated_at: 0,
};

/** Run one `--plan` step against a relay that answers every submission with `body` at 402. */
async function planStepError(body: string): Promise<{ message: string; posts: number }> {
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      // Strip task_id: a 402 naming a task is adoption (#888), a different cell.
      const parsed = (() => {
        try {
          const o = JSON.parse(body) as Record<string, unknown>;
          delete o["task_id"];
          return JSON.stringify(o);
        } catch {
          return body;
        }
      })();
      return new Response(parsed, { status: 402 });
    }),
  );
  const adapter = createHttpPollingDelegationAdapter({
    relayUrl: "http://relay.test",
    motebitId: "mote-1",
    submitHeaders: {},
    queryHeaders: async () => ({}),
    pollIntervalMs: 1,
    conflictBackoffMs: 1,
  });
  try {
    await adapter.delegateStep(step, 50);
  } catch (err: unknown) {
    return { message: err instanceof Error ? err.message : String(err), posts };
  }
  throw new Error("expected the step to be refused");
}

/** Drive the REPL's `/delegate` against a relay answering the submission with `body` at 402. */
async function replDelegateOutput(
  body: string,
  opts: { discoverable?: boolean } = {},
): Promise<{ lines: string[]; posts: number }> {
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        return new Response(body, { status: 402 });
      }
      if (opts.discoverable !== false && String(url).includes("/api/v1/agents/discover")) {
        return Response.json({
          agents: [
            {
              motebit_id: REPL_TARGET,
              capabilities: [REPL_CAPABILITY],
              pricing: [{ capability: REPL_CAPABILITY, unit_cost: 0.5 }],
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  const lines: string[] = [];
  const capture = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  const repl: ReplContext = {
    moteDb: {} as MotebitDatabase,
    motebitId: "mote-repl402",
    mcpAdapters: [],
  };
  const config = {
    syncUrl: "http://relay.test",
    syncToken: "operator-token",
  } as unknown as CliConfig;
  await handleSlashCommand(
    "delegate",
    `${REPL_TARGET} ${REPL_PROMPT}`,
    {} as MotebitRuntime,
    config,
    undefined,
    repl,
  );
  return { lines, posts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("delegate 402 remedy table (relay code × CLI path)", () => {
  for (const row of ROWS) {
    describe(row.label, () => {
      it(`direct: ${row.direct}`, () => {
        const text = describeDelegateSubmit402(row.body).join("\n");
        assertRemedy(text, row.direct, row);
        assertRunnable(text, "direct");
      });

      it(`plan: ${row.plan}`, async () => {
        const { message, posts } = await planStepError(row.body);
        assertRemedy(message, row.plan, row);
        assertRunnable(message, "plan");
        if (row.plan === "sovereign") {
          // `--plan` cannot pay P2P yet (#887): send the paid step on its own.
          expect(message).toContain("#887");
          expect(message).toContain("motebit delegate --sovereign");
        }
        expect(posts, "a 402 refusal is not retried").toBe(1);
      });

      it(`repl /delegate: ${row.direct}, a remedy runnable from the REPL`, async () => {
        const { lines, posts } = await replDelegateOutput(row.body);
        const expected = describeDelegateSubmit402(row.body, {
          repl: { prompt: REPL_PROMPT, target: REPL_TARGET, capabilities: [REPL_CAPABILITY] },
        });
        expect(lines).toEqual(expect.arrayContaining(expected));
        if (row.direct === "sovereign") {
          // `/delegate` parses no flags: the remedy is the shell command, filled
          // in with the prompt (single-quoted), the target, and its capability.
          expect(lines.join("\n")).toContain(
            `\`motebit delegate --sovereign 'do the "paid" thing, it'\\''s urgent!' --target ${REPL_TARGET} --capability ${REPL_CAPABILITY}\``,
          );
        } else {
          // Off the P2P row, the REPL prints exactly what `motebit delegate` prints.
          expect(expected).toEqual(describeDelegateSubmit402(row.body));
        }
        assertRemedy(lines.join("\n"), row.direct, row);
        assertRunnable(lines.join("\n"), "repl");
        expect(lines.join("\n"), "never the raw relay body").not.toMatch(/"status":\s*402/);
        expect(posts, "a 402 refusal is not retried").toBe(1);
      });

      it("sovereign: never `motebit fund` (it pays from the Solana wallet)", () => {
        let message = "";
        try {
          message = (JSON.parse(row.body) as { error?: string }).error ?? row.body;
        } catch {
          message = row.body;
        }
        const text = describeSovereignDelegationRefusal({
          code: row.runtimeCode,
          message,
          status: 402,
        }).join("\n");
        expect(text.length, "a 402 always gets a remedy line").toBeGreaterThan(0);
        expect(text).not.toContain("motebit fund");
        expect(text).toContain("Solana wallet");
      });
    });
  }

  it("repl /delegate: a P2P remedy whose capability cannot be resolved says to add it", async () => {
    const p2p = ROWS.find((r) => r.direct === "sovereign")!;
    const { lines, posts } = await replDelegateOutput(p2p.body, { discoverable: false });
    const text = lines.join("\n");
    expect(text).toContain("--capability <capability>");
    expect(text).toMatch(/replace `<capability>` with the capability the worker lists/i);
    expect(text).toContain("web_search");
    expect(posts, "a 402 refusal is not retried").toBe(1);
  });

  it("a non-402 sovereign refusal adds no 402 remedy", () => {
    expect(
      describeSovereignDelegationRefusal({ code: "unauthorized", message: "no", status: 403 }),
    ).toEqual([]);
  });
});
