/**
 * motebit.yaml schema, parser, and routine → Goal mapper.
 *
 * Covers the declarative surface that `motebit up` applies: personality,
 * governance, MCP servers, and routines. Routines compile to Goal rows; the
 * other three apply to `~/.motebit/config.json` via `loadFullConfig` /
 * `saveFullConfig`. The schema is the single source of truth for the yaml
 * contract; zod validation produces labeled diagnostics with file:line.
 *
 * Placement note: this module intentionally lives in the CLI, not in
 * `@motebit/sdk`. The SDK is a published npm package whose dependency
 * surface is deliberately minimal; adding `zod` + `yaml` there would bill
 * every SDK consumer for a feature only the CLI uses. If a future
 * programmatic `applyYaml()` lands on the SDK, this module is straightforward
 * to extract — the types don't depend on any CLI-only runtime.
 */

import * as crypto from "node:crypto";
import { z } from "zod";

import type { Goal, GoalMode } from "@motebit/persistence";

import { parseInterval } from "./intervals.js";
import type { FullConfig } from "./config.js";

// ---------------------------------------------------------------------------
// NON_DECLARATIVE_KEYS
//
// Keys on `FullConfig` that are deliberately NOT surfaced in motebit.yaml
// because they're device-local identity state (keys, ids, session-like
// server state) or user-imperative choices the yaml shouldn't overwrite.
// The drift defense test in the yaml-fullconfig-parity suite enumerates
// every `FullConfig` key and asserts it is either present in the yaml
// schema OR listed here. Adding a new `FullConfig` field that is neither
// will fail CI — a conscious declarative-vs-non-declarative choice is
// required, not accidental drift.
// ---------------------------------------------------------------------------

export const NON_DECLARATIVE_KEYS = new Set<keyof FullConfig>([
  // Identity — device-local, never yaml-managed.
  "motebit_id",
  "device_id",
  "device_public_key",
  "cli_private_key",
  "cli_encrypted_key",
  // Relay endpoint — set by `motebit register`, not a declarative choice.
  "sync_url",
  // Trusted-server list — mutated by runtime approval flow, not yaml.
  "mcp_trusted_servers",
  // Legacy provider fields migrated into `provider`. Read-only on load.
  "default_provider",
  "default_model",
]);

// ---------------------------------------------------------------------------
// Leaf schemas — personality, governance, MCP, provider
// ---------------------------------------------------------------------------

/**
 * Subset of `UnifiedProviderConfig` shape that makes sense in yaml. The full
 * runtime shape is a discriminated union over `mode`; for yaml we accept the
 * flat keys and let the loader normalize. API keys and paid-tier tokens are
 * NOT declared in yaml — they're secrets, read from env or keyring.
 */
const ProviderSchema = z
  .object({
    mode: z
      .enum(["byok", "paid", "sovereign"])
      .optional()
      .describe(
        "Provider mode. `byok` = bring-your-own API key (env var). `paid` = motebit cloud. `sovereign` = local on-device model (no external calls).",
      ),
    wireProtocol: z
      .enum(["anthropic", "openai"])
      .optional()
      .describe(
        "Wire protocol the endpoint speaks. `anthropic` for Claude, `openai` for OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio, vLLM).",
      ),
    model: z
      .string()
      .optional()
      .describe("Model identifier, e.g. `claude-sonnet-4-6`, `gpt-5.4-mini`, `llama3.2`."),
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Override the API base URL. Used for local inference servers (`http://localhost:11434/v1` for Ollama) or routing through a proxy.",
      ),
    maxTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Upper bound on response length (model output tokens)."),
  })
  .strict()
  .describe(
    "AI provider configuration. API keys are NEVER declared here — they're read from environment variables or the OS keyring.",
  );

const GovernanceSchema = z
  .object({
    approvalPreset: z
      .enum(["cautious", "balanced", "autonomous"])
      .describe(
        "Default gate for tool calls. `cautious` = approve every sensitive call. `balanced` = approve writes, auto-approve reads. `autonomous` = auto-approve most calls.",
      ),
    persistenceThreshold: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Memory-formation threshold [0, 1]. Higher = fewer memories formed; only strong signals persist. Typical: 0.6.",
      ),
    rejectSecrets: z
      .boolean()
      .describe(
        "When true, the privacy layer blocks any tool call or outbound message whose content is classified as `secret`. Fail-closed: error on classifier failure.",
      ),
    maxCallsPerTurn: z
      .number()
      .int()
      .positive()
      .describe(
        "Per-turn tool-call ceiling. Bounds runaway loops and protects the policy gate from exhaustion attacks.",
      ),
    maxMemoriesPerTurn: z
      .number()
      .int()
      .positive()
      .describe(
        "Per-turn memory-formation ceiling. Prevents a single turn from flooding the memory graph.",
      ),
  })
  .strict()
  .describe("Governance at the boundary — surface-tension constraints that apply to every turn.");

const McpServerSchema = z
  .object({
    name: z.string().min(1).describe("Local name for the MCP server. Must be unique."),
    transport: z
      .enum(["stdio", "http"])
      .describe("Transport. `stdio` spawns a child process; `http` connects to a URL."),
    command: z
      .string()
      .optional()
      .describe("Executable to spawn when `transport: stdio`. E.g. `npx`, `node`, `python`."),
    args: z
      .array(z.string())
      .optional()
      .describe("Argument vector passed to `command` when `transport: stdio`."),
    url: z
      .string()
      .url()
      .optional()
      .describe("Endpoint URL when `transport: http`. Must be a full URL including scheme."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables set for the child process (stdio transport)."),
    trusted: z
      .boolean()
      .optional()
      .describe(
        "Auto-approve tool calls from this server. Equivalent to promoting the server into `mcp_trusted_servers`. Off by default.",
      ),
    motebit: z
      .boolean()
      .optional()
      .describe(
        "This server is another motebit instance — enables motebit-to-motebit transport with caller identity injected into every call.",
      ),
    motebitType: z
      .enum(["personal", "service", "collaborative"])
      .optional()
      .describe(
        "Semantic role of the peer motebit. `personal` = another device of yours. `service` = paid worker. `collaborative` = peer agent.",
      ),
  })
  .strict()
  .refine((s) => (s.transport === "stdio" ? s.command != null : s.url != null), {
    message: "stdio transport requires 'command'; http transport requires 'url'",
  })
  .describe(
    "MCP server — a tool source. stdio transports spawn a subprocess; http transports dial a remote endpoint.",
  );

// ---------------------------------------------------------------------------
// Routine schema
//
// A routine is a named, scheduled unit that `motebit up` compiles into
// exactly one Goal row. The routine `id` is the stable key for upsert —
// changing the id effectively renames the routine (prune + add). Changing
// any other field updates the same row in place (detected via
// `routine_hash`).
// ---------------------------------------------------------------------------

const IntervalString = z
  .string()
  .min(1)
  .transform((raw, ctx): number => {
    try {
      return parseInterval(raw);
    } catch (err: unknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
  })
  .describe("Interval string: `<n>m` minutes, `<n>h` hours, `<n>d` days. E.g. `30m`, `1h`, `7d`.");

const RoutineSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: "routine id must be lowercase alphanumeric with _ or - (e.g. 'daily-digest')",
      })
      .describe(
        "Stable identifier for the routine. Used as the upsert key — changing the id renames the routine (old one is pruned, new one added). Lowercase alphanumeric with `-` or `_`.",
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Natural-language prompt the agent runs on each tick. Content changes update the same goal row (preserving `created_at`).",
      ),
    every: IntervalString.describe(
      "Run cadence. Interval string (`<n>m`, `<n>h`, `<n>d`). E.g. `1h` = hourly.",
    ),
    mode: z
      .enum(["recurring", "once"])
      .default("recurring")
      .describe(
        "`recurring` runs every `every` tick forever. `once` runs a single time then marks the goal completed.",
      ),
    wall_clock: IntervalString.optional().describe(
      "Hard wall-clock timeout per run. Kills the turn if it exceeds this. Default: 10m.",
    ),
    project: z
      .string()
      .min(1)
      .optional()
      .describe("Project identifier — groups goals that share context (shared memory scope)."),
    enabled: z
      .boolean()
      .default(true)
      .describe(
        "Set false to pause the routine without deleting it. Preserves state and history; resumable with no data loss.",
      ),
  })
  .strict()
  .describe(
    "A scheduled routine — compiles to exactly one Goal row. Changing fields other than `id` updates the same row in place.",
  );

export type MotebitYamlRoutine = z.infer<typeof RoutineSchema>;

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Raw top-level object shape — exported so drift tests can enumerate keys
 * without tripping over the `.strict().superRefine()` wrappers (those
 * produce a ZodEffects that doesn't expose `.shape`).
 */
export const MotebitYamlObjectSchema = z.object({
  // Pinning the version lets us rev the schema later without silently
  // interpreting v2 yaml as v1. Mismatch → the loader prints a targeted
  // error telling the user which CLI version expects which yaml version.
  version: z
    .literal(1)
    .describe(
      "Schema version. Currently `1`. Pinning lets future CLI versions print a targeted error on mismatch instead of silently misinterpreting the document.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Display name for this motebit. Surfaces in the REPL banner and delegation listings.",
    ),
  personality_notes: z
    .string()
    .optional()
    .describe(
      "Free-form personality guidance. Appended to the system prompt on every turn. Keep short — every token here costs on every call.",
    ),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe(
      "Sampling temperature for the default provider [0, 2]. Unset = model default. Only applied when explicitly set.",
    ),
  max_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Default max output tokens per response. Overridden by `--max-tokens` at the CLI."),
  provider: ProviderSchema.optional(),
  governance: GovernanceSchema.optional(),
  mcp_servers: z
    .array(McpServerSchema)
    .optional()
    .describe(
      "MCP tool servers to connect on start. Each entry declares transport, endpoint, and (optionally) trust status.",
    ),
  routines: z
    .array(RoutineSchema)
    .optional()
    .describe(
      "Scheduled routines. Each compiles to exactly one Goal row; `id` is the upsert key. Re-running `motebit up` on unchanged yaml is a true no-op.",
    ),
});

export const MotebitYamlSchema = MotebitYamlObjectSchema.strict().superRefine((data, ctx) => {
  // Duplicate routine ids would silently collapse at upsert time (same
  // deterministic goal_id → later one wins). Catch at parse time instead.
  if (data.routines) {
    const seen = new Map<string, number>();
    for (let i = 0; i < data.routines.length; i++) {
      const id = data.routines[i]!.id;
      const prev = seen.get(id);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routines", i, "id"],
          message: `duplicate routine id "${id}" (also used at routines[${prev}])`,
        });
      } else {
        seen.set(id, i);
      }
    }
  }
});

export type MotebitYamlV1 = z.infer<typeof MotebitYamlSchema>;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface YamlDiagnostic {
  filePath: string;
  line: number | null;
  column: number | null;
  path: (string | number)[];
  message: string;
}

export type ParseResult =
  | { ok: true; data: MotebitYamlV1 }
  | { ok: false; diagnostics: YamlDiagnostic[] };

/**
 * Format one diagnostic as a single line. Callers (e.g., `motebit up`) print
 * every entry before exiting non-zero. Stable wire format:
 *
 *     motebit.yaml:12:5: routines[0].every: Invalid interval "5x"...
 *
 * Absent line info ("<?>") only happens when yaml parsing itself failed
 * without a location — very rare in practice.
 */
export function formatDiagnostic(d: YamlDiagnostic): string {
  const loc = d.line != null ? `${d.filePath}:${d.line}:${d.column ?? 0}` : `${d.filePath}:<?>`;
  const pathStr = d.path.length === 0 ? "" : `${formatPath(d.path)}: `;
  return `${loc}: ${pathStr}${d.message}`;
}

function formatPath(path: (string | number)[]): string {
  const parts: string[] = [];
  for (const seg of path) {
    if (typeof seg === "number") {
      parts.push(`[${seg}]`);
    } else if (parts.length === 0) {
      parts.push(seg);
    } else {
      parts.push(`.${seg}`);
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// parseMotebitYaml — lazy-imports `yaml` so the CLI subcommands that
// never touch yaml don't pull it in on cold start.
// ---------------------------------------------------------------------------

/**
 * Parse `raw` as a motebit.yaml document, validate it, and return either the
 * typed data or a list of labeled diagnostics. On yaml syntax error, returns
 * one diagnostic with file:line; on schema validation error, returns one
 * diagnostic per zod issue, each with the yaml field's original line/col
 * when the yaml CST still knows it.
 */
export async function parseMotebitYaml(raw: string, filePath: string): Promise<ParseResult> {
  const { parseDocument, isMap, isSeq, isScalar, LineCounter } = await import("yaml");
  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter, prettyErrors: false });

  if (doc.errors.length > 0) {
    const diagnostics = doc.errors.map((e): YamlDiagnostic => {
      const pos = e.linePos?.[0];
      return {
        filePath,
        line: pos?.line ?? null,
        column: pos?.col ?? null,
        path: [],
        message: e.message,
      };
    });
    return { ok: false, diagnostics };
  }

  const plain = doc.toJS() as unknown;
  const result = MotebitYamlSchema.safeParse(plain);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  // Walk each zod issue, resolve it back to a yaml node, and read the node's
  // source range → line/col. Done as a best-effort enrichment; missing info
  // falls back to no location (the field path alone is still identifying).
  const diagnostics: YamlDiagnostic[] = result.error.issues.map((issue): YamlDiagnostic => {
    let node: unknown = doc.contents;
    for (const seg of issue.path) {
      if (isMap(node)) {
        node = node.get(String(seg), true);
      } else if (isSeq(node) && typeof seg === "number") {
        node = node.get(seg, true);
      } else {
        node = undefined;
        break;
      }
    }
    let line: number | null = null;
    let column: number | null = null;
    // yaml nodes expose `range: [start, valueEnd, nodeEnd]` byte offsets.
    // Convert with the lineCounter we threaded through `parseDocument`.
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    if (range) {
      const pos = lineCounter.linePos(range[0]);
      line = pos.line;
      column = pos.col;
    } else if (isScalar(node)) {
      // Fallback for scalars whose range was normalized away.
      line = null;
      column = null;
    }
    return {
      filePath,
      line,
      column,
      path: [...issue.path] as (string | number)[],
      message: issue.message,
    };
  });
  return { ok: false, diagnostics };
}

// ---------------------------------------------------------------------------
// routineToGoal — pure mapper.
//
// Deterministic `goal_id = sha256(source + "\0" + id).slice(0, 16)` gives
// idempotent upsert keyed on (source file, routine id). Renaming the file or
// the id produces a new goal_id → old row becomes a prune candidate. Content
// changes keep the same goal_id but produce a new `routine_hash` → detected
// as UPDATE.
//
// The `satisfies Goal` at the return site is a static drift guard: adding a
// new required Goal column without routing it through this mapper becomes a
// build-time TypeScript error.
// ---------------------------------------------------------------------------

export interface RoutineToGoalContext {
  motebitId: string;
  sourceFilePath: string;
  sourceFileSha: string;
  now: number;
}

export function hashRoutine(routine: MotebitYamlRoutine): string {
  return crypto.createHash("sha256").update(canonicalJson(routine)).digest("hex").slice(0, 16);
}

export function deriveGoalId(sourceFileSha: string, routineId: string): string {
  return crypto
    .createHash("sha256")
    .update(`${sourceFileSha}\0${routineId}`)
    .digest("hex")
    .slice(0, 16);
}

export function routineToGoal(routine: MotebitYamlRoutine, ctx: RoutineToGoalContext): Goal {
  const goal = {
    goal_id: deriveGoalId(ctx.sourceFileSha, routine.id),
    motebit_id: ctx.motebitId,
    prompt: routine.prompt,
    interval_ms: routine.every,
    last_run_at: null,
    enabled: routine.enabled,
    created_at: ctx.now,
    mode: routine.mode as GoalMode,
    status: "active" as const,
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: routine.wall_clock ?? null,
    project_id: routine.project ?? null,
    routine_id: routine.id,
    routine_source: ctx.sourceFilePath,
    routine_hash: hashRoutine(routine),
  } satisfies Goal;
  return goal;
}

/**
 * Canonical JSON — sorted keys, no whitespace. Matches the `canonicalJson`
 * pattern already used throughout motebit for receipt signing, so two
 * equivalent routines always hash identically regardless of key order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Hash of the yaml source file itself. Used to derive `goal_id` so that two
 * different yaml files in the same repo can each declare a routine with the
 * same local `id` without colliding. Deterministic across re-reads of the
 * same unchanged file.
 */
export function hashSourceFile(filePath: string, rawContents: string): string {
  return crypto
    .createHash("sha256")
    .update(`${filePath}\0${rawContents}`)
    .digest("hex")
    .slice(0, 16);
}
