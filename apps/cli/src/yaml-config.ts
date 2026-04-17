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
    mode: z.enum(["byok", "paid", "sovereign"]).optional(),
    wireProtocol: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

const GovernanceSchema = z
  .object({
    approvalPreset: z.enum(["cautious", "balanced", "autonomous"]),
    persistenceThreshold: z.number().min(0).max(1),
    rejectSecrets: z.boolean(),
    maxCallsPerTurn: z.number().int().positive(),
    maxMemoriesPerTurn: z.number().int().positive(),
  })
  .strict();

const McpServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: z.record(z.string(), z.string()).optional(),
    trusted: z.boolean().optional(),
    motebit: z.boolean().optional(),
    motebitType: z.enum(["personal", "service", "collaborative"]).optional(),
  })
  .strict()
  .refine((s) => (s.transport === "stdio" ? s.command != null : s.url != null), {
    message: "stdio transport requires 'command'; http transport requires 'url'",
  });

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
  });

const RoutineSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, {
        message: "routine id must be lowercase alphanumeric with _ or - (e.g. 'daily-digest')",
      }),
    prompt: z.string().min(1),
    every: IntervalString,
    mode: z.enum(["recurring", "once"]).default("recurring"),
    wall_clock: IntervalString.optional(),
    project: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

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
  version: z.literal(1),
  name: z.string().optional(),
  personality_notes: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  provider: ProviderSchema.optional(),
  governance: GovernanceSchema.optional(),
  mcp_servers: z.array(McpServerSchema).optional(),
  routines: z.array(RoutineSchema).optional(),
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
