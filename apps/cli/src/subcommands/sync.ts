/**
 * `motebit sync …` and `motebit status` — the operator's doors onto the
 * compaction floor (#962 round 6).
 *
 *   motebit sync enable [url]                    opt in: persist the relay (default: the public relay)
 *   motebit sync disable                         opt out: remove the persisted relay
 *   motebit sync status [--json]                 each relay stream behind the floor
 *   motebit sync retire <relay-url> [--force]    remove a stream from the floor
 *   motebit sync clear-intent [--force]          clear "this identity syncs"
 *   motebit status                               identity, relay, floor; a pinned floor said once
 *
 * The law: absence is never evidence, but a pinned floor must never be
 * SILENT or DOORLESS. Every relay a process connected to bounds the floor
 * (MIN over the identity's streams), so one connect to a mistyped relay, or
 * a relay switch, holds compaction back for good. A stream is never retired
 * automatically — a relay that has not acknowledged is no proof it never
 * will — so the operator retires it: confirmed before it acts, recorded as
 * an `audit_entry` event, undone by connecting to that relay again.
 *
 * Scope (stated): the marker and the streams live in a DATABASE
 * (`motebit.db`, or the one `--db` / `MOTEBIT_DB_PATH` names); these doors
 * act on that database. Not CLI-only by nature: web (and any surface with a
 * relay-URL setting) can pin the floor too — web's relay-URL panel
 * (`apps/web/src/ui/gated-panels.ts`) connects whatever URL is typed, so a
 * typo-then-fix leaves a stream at 0 that holds compaction. These doors are
 * the CLI's; that surface's notice and retire door are tracked as a
 * follow-up. Until then its storage grows; no data is lost.
 */
import * as readline from "node:readline";
import { EventType } from "@motebit/sdk";
import type { EventStoreAdapter } from "@motebit/event-log";
import { openMotebitDatabase } from "@motebit/persistence";
import {
  clearSyncIntent,
  pinnedFloor,
  relayStreamOfUrl,
  retireRelayStream,
  sanitizeRelayText,
  syncFloorReport,
  type RelayStreamReport,
  type SyncFloorReport,
} from "@motebit/sync-engine";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig, type FullConfig } from "../config.js";
import { getDbPath } from "../runtime-factory.js";
import { PUBLIC_RELAY_URL, normalizeRelayUrl } from "../sync-opt-in.js";
import { requireMotebitId, resolveRelayUrl } from "./_helpers.js";

const USAGE =
  "Usage: motebit sync enable [url] | motebit sync disable | motebit sync status [--json] | motebit sync retire <relay-url> [--force] [--yes] | motebit sync clear-intent [--force] [--yes]";

/** What a sync door acts on, and how it talks to the operator. */
export interface SyncCommandContext {
  /** The database the doors act on (`motebit.db`). */
  dbPath: string;
  motebitId: string;
  /** The relay this identity is configured for (flag > env > config.json), or undefined: sync is off. */
  configuredUrl: string | undefined;
  /** Act even where the door refuses (the configured relay; unacked events). */
  force: boolean;
  /** Skip the confirmation prompt. */
  yes: boolean;
  json?: boolean;
  /** Ask before acting; true = go ahead. */
  confirm: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  now?: number;
}

const sameUrl = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a != null && b != null && a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/** A URL or stream id, safe to print. */
const shown = (text: string): string => sanitizeRelayText(text);

const when = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

/** The argument that names a stream to `motebit sync retire`. */
const retireArg = (s: RelayStreamReport): string => s.relayUrl ?? s.stream;

/** One line per stream. */
function streamLine(s: RelayStreamReport, configuredUrl: string | undefined): string {
  const name = shown(s.relayUrl ?? `${s.stream} (a remote that names no relay)`);
  const configured = sameUrl(s.relayUrl, configuredUrl) ? " (configured)" : "";
  const last = s.lastAckAt != null ? when(s.lastAckAt) : "never";
  let state = "";
  if (s.retiredAt != null) state = ` — retired ${when(s.retiredAt)}, no longer bounds the floor`;
  else if (s.holdsFloor) {
    // #962 round 7: a stream tied at the floor frees nothing ALONE — its
    // twin still holds it — so the tied set's count is what the line says.
    const others = s.tiedWith.length;
    state =
      others > 0 && s.heldBackTied > 0
        ? ` — holds the floor, tied with ${others} other relay stream${others === 1 ? "" : "s"} at this clock: retiring all of them frees ${s.heldBackTied} events`
        : s.heldBack > 0
          ? ` — holds the floor: ${s.heldBack} events held back`
          : " — holds the floor (retiring it frees nothing: no other relay acknowledged more)";
  }
  return `    ${name}${configured} — acked clock ${s.acked}, last ack ${last}${state}`;
}

/**
 * The one calm line a pinned floor gets (#962 rounds 6-7), or null: the
 * streams holding compaction back — one, or several tied at the floor —
 * have acknowledged nothing, or not advanced in more than 7 days while
 * another stream acknowledged past them (`pinnedFloor`). A tied set is named
 * whole, with what retiring all of it frees.
 */
export function pinnedFloorLine(
  report: SyncFloorReport,
  configuredUrl: string | undefined,
  now?: number,
): string | null {
  const pinned = pinnedFloor(report, now);
  if (!pinned) return null;
  const tied = pinned.streams;
  const one = tied.length === 1;
  const s = pinned.stream;
  const why =
    pinned.reason === "never-acked"
      ? `${one ? "it has" : "they have"} acknowledged nothing`
      : one && s.lastAckAt != null
        ? `no acknowledgment since ${when(s.lastAckAt)}`
        : one
          ? "no acknowledgment time recorded"
          : "none has acknowledged in more than 7 days";
  const names = tied.map((x) => shown(retireArg(x)));
  const head = one
    ? `Compaction is held at clock ${report.floor} by relay ${names[0]} (${why}; ${pinned.heldBack} events wait on it).`
    : `Compaction is held at clock ${report.floor} by ${tied.length} relays tied there: ${names.join(", ")} (${why}; ${pinned.heldBack} events wait on all of them).`;
  const configured = tied.filter((x) => sameUrl(x.relayUrl, configuredUrl));
  const others = tied.filter((x) => !sameUrl(x.relayUrl, configuredUrl));
  const retire = others.map((x) => `motebit sync retire ${shown(retireArg(x))}`).join("; ");
  if (configured.length === 0) {
    return `${head} If ${one ? "it is" : "they are"} no longer used: ${retire}`;
  }
  if (others.length === 0) {
    return `${head} It is the configured relay: they are freed once it acknowledges.`;
  }
  return `${head} ${shown(retireArg(configured[0]!))} is the configured relay: they are freed once it acknowledges and the others, if no longer used, are retired: ${retire}`;
}

/** `pinnedFloorLine` over a store: what the REPL prints once at start. */
export async function pinnedFloorNotice(
  store: EventStoreAdapter,
  motebitId: string,
  configuredUrl: string | undefined,
  now?: number,
): Promise<string | null> {
  return pinnedFloorLine(await syncFloorReport(store, motebitId), configuredUrl, now);
}

async function withDb<T>(
  dbPath: string,
  fn: (db: Awaited<ReturnType<typeof openMotebitDatabase>>) => Promise<T>,
): Promise<T> {
  const db = await openMotebitDatabase(dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** An operator act, recorded in the identity's event log (and pushed with it). */
async function recordAct(
  store: EventStoreAdapter,
  motebitId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const entry = {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId as never,
    timestamp: Date.now(),
    event_type: EventType.AuditEntry,
    payload,
    tombstoned: false,
  };
  if (store.appendWithClock) {
    await store.appendWithClock(entry);
  } else {
    await store.append({ ...entry, version_clock: (await store.getLatestClock(motebitId)) + 1 });
  }
}

function statusReportLines(
  report: SyncFloorReport,
  ctx: { dbPath: string; configuredUrl: string | undefined },
): string[] {
  const out: string[] = [];
  out.push(`Sync status — ${report.motebitId}`);
  out.push(`  Database:         ${shown(ctx.dbPath)}`);
  out.push(`  Configured relay: ${ctx.configuredUrl != null ? shown(ctx.configuredUrl) : "none"}`);
  out.push(`  Sync intent:      ${report.intent}`);
  out.push(
    report.floor < report.requested
      ? `  Compaction floor: clock ${report.floor} (compaction asks for ${report.requested})`
      : `  Compaction floor: clock ${report.floor} (nothing held back)`,
  );
  if (report.streams.length === 0) {
    out.push(
      report.intent === "recorded"
        ? "  Relay streams:    none yet — the recorded intent holds every event until a relay acknowledges"
        : "  Relay streams:    none",
    );
  } else {
    out.push("  Relay streams:");
    for (const s of report.streams) out.push(streamLine(s, ctx.configuredUrl));
  }
  return out;
}

async function status(ctx: SyncCommandContext): Promise<number> {
  const report = await withDb(ctx.dbPath, (db) => syncFloorReport(db.eventStore, ctx.motebitId));
  if (ctx.json) {
    ctx.print(JSON.stringify({ ...report, configuredUrl: ctx.configuredUrl ?? null }, null, 2));
    return 0;
  }
  for (const l of statusReportLines(report, ctx)) ctx.print(l);
  const notice = pinnedFloorLine(report, ctx.configuredUrl, ctx.now);
  if (notice) {
    ctx.print("");
    ctx.print(`  ${notice}`);
  }
  return 0;
}

async function retire(url: string | undefined, ctx: SyncCommandContext): Promise<number> {
  if (url == null || url === "") {
    ctx.print(USAGE);
    return 2;
  }
  return withDb(ctx.dbPath, async (db) => {
    const store = db.eventStore;
    const report = await syncFloorReport(store, ctx.motebitId);
    const stream = url.includes("#") ? url : relayStreamOfUrl(url, ctx.motebitId);
    const s = report.streams.find((x) => x.stream === stream);
    if (!s) {
      ctx.print(`No relay stream ${shown(url)} for ${ctx.motebitId}.`);
      ctx.print(
        report.streams.length > 0
          ? `Streams: ${report.streams.map((x) => shown(retireArg(x))).join(", ")}`
          : "This database holds no relay stream for it.",
      );
      return 1;
    }
    if (s.retiredAt != null) {
      ctx.print(`${shown(retireArg(s))} was already retired on ${when(s.retiredAt)}.`);
      return 0;
    }
    const configured = sameUrl(s.relayUrl, ctx.configuredUrl);
    if (configured && !ctx.force) {
      ctx.print(
        `${shown(retireArg(s))} is the configured relay: its unacknowledged events would be compacted before it holds them.`,
      );
      ctx.print("Configure another relay first, or pass --force to retire it anyway.");
      return 1;
    }
    const frees = s.heldBack;
    // #962 round 7: retiring one of several streams tied at the floor frees
    // nothing alone; say so, naming the twins and what retiring all frees.
    const twins = report.streams.filter((x) => s.tiedWith.includes(x.stream));
    const tie =
      twins.length > 0 && frees === 0
        ? ` It is tied at clock ${s.acked} with ${twins.map((x) => shown(retireArg(x))).join(", ")}, which still hold the floor: retiring all of them frees ${s.heldBackTied} events.`
        : "";
    const question =
      `Retire relay ${shown(retireArg(s))} from ${ctx.motebitId}'s compaction floor? ` +
      `It acknowledged clock ${s.acked}; compaction will then free ${frees} events it now holds back.${tie}`;
    if (!ctx.yes && !(await ctx.confirm(question))) {
      ctx.print("Not retired.");
      return 1;
    }
    await retireRelayStream(store, ctx.motebitId, s.stream);
    await recordAct(store, ctx.motebitId, {
      action: "sync_stream_retired",
      stream: s.stream,
      relay_url: s.relayUrl,
      acked: s.acked,
      frees,
      forced: configured,
    });
    ctx.print(
      `Retired ${shown(retireArg(s))}: compaction will then free ${frees} events.${tie} Connecting to it again restores it.`,
    );
    return 0;
  });
}

async function clearIntent(ctx: SyncCommandContext): Promise<number> {
  return withDb(ctx.dbPath, async (db) => {
    const store = db.eventStore;
    const report = await syncFloorReport(store, ctx.motebitId);
    if (report.intent !== "recorded") {
      ctx.print(`No sync intent is recorded for ${ctx.motebitId} (${report.intent}).`);
      return 0;
    }
    const cs =
      ctx.configuredUrl != null
        ? report.streams.find((x) => sameUrl(x.relayUrl, ctx.configuredUrl))
        : undefined;
    const acked = cs?.acked ?? 0;
    const latest = await store.getLatestClock(ctx.motebitId);
    const unacked =
      ctx.configuredUrl != null && latest > acked
        ? (await store.query({ motebit_id: ctx.motebitId, after_version_clock: acked })).length
        : 0;
    if (unacked > 0 && !ctx.force) {
      ctx.print(
        `${unacked} events are still unacknowledged by the configured relay ${shown(ctx.configuredUrl ?? "")}: clearing the intent could let compaction delete them.`,
      );
      ctx.print("Sync first, or pass --force to clear it anyway.");
      return 1;
    }
    const question =
      `Clear ${ctx.motebitId}'s sync intent? A process with no relay will then compact ` +
      `events no relay has acknowledged (relay streams that exist still bound the floor).`;
    if (!ctx.yes && !(await ctx.confirm(question))) {
      ctx.print("Not cleared.");
      return 1;
    }
    await clearSyncIntent(store, ctx.motebitId);
    await recordAct(store, ctx.motebitId, {
      action: "sync_intent_cleared",
      relay_url: ctx.configuredUrl ?? null,
      unacked,
      forced: unacked > 0,
    });
    ctx.print(
      "Sync intent cleared. A process configured for a relay records it again; relay streams still bound the floor.",
    );
    return 0;
  });
}

/** `motebit sync <sub>`: the exit code. */
export async function runSyncCommand(
  sub: string,
  args: string[],
  ctx: SyncCommandContext,
): Promise<number> {
  switch (sub) {
    case "":
    case "status":
      return status(ctx);
    case "retire":
      return retire(args[0], ctx);
    case "clear-intent":
      return clearIntent(ctx);
    default:
      ctx.print(USAGE);
      return 2;
  }
}

/** `motebit status`: the identity, its relay, the floor — and a pinned floor, said once. */
export async function statusLines(ctx: {
  dbPath: string;
  motebitId: string;
  configuredUrl: string | undefined;
  now?: number;
}): Promise<string[]> {
  const report = await withDb(ctx.dbPath, (db) => syncFloorReport(db.eventStore, ctx.motebitId));
  const out = [
    `motebit ${ctx.motebitId}`,
    `  Database:         ${shown(ctx.dbPath)}`,
    `  Relay:            ${ctx.configuredUrl != null ? shown(ctx.configuredUrl) : "none"}`,
    `  Sync intent:      ${report.intent}`,
    `  Compaction floor: clock ${report.floor} of ${report.requested} (${report.streams.filter((s) => s.retiredAt == null).length} relay streams; \`motebit sync status\` lists them)`,
  ];
  const notice = pinnedFloorLine(report, ctx.configuredUrl, ctx.now);
  if (notice) out.push(`  ${notice}`);
  return out;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function cliContext(config: CliConfig): SyncCommandContext {
  const fullConfig = loadFullConfig();
  return {
    dbPath: getDbPath(config.dbPath),
    motebitId: requireMotebitId(fullConfig),
    configuredUrl: resolveRelayUrl(config, fullConfig),
    force: config.force === true,
    yes: config.yes === true,
    json: config.json === true,
    confirm: askYesNo,
    print: (l) => console.log(l),
  };
}

/** What `motebit sync enable | disable` read and write: `~/.motebit/config.json`. */
export interface SyncOptInContext {
  load: () => FullConfig;
  save: (config: FullConfig) => void;
  print: (line: string) => void;
}

/**
 * `motebit sync enable [url]` — the persisted opt-in to relay sync
 * (`sync-opt-in.ts`): writes `sync_url` to config.json. With no url, the
 * public relay. Only http(s) URLs are accepted.
 */
export function syncEnable(urlArg: string | undefined, ctx: SyncOptInContext): number {
  const url = normalizeRelayUrl(urlArg) ?? PUBLIC_RELAY_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    ctx.print(`Error: not a URL: ${shown(url)}`);
    return 2;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    ctx.print(`Error: relay URL must be http(s): ${shown(url)}`);
    return 2;
  }
  const config = ctx.load();
  config.sync_url = url;
  ctx.save(config);
  ctx.print(`Relay sync on: ${shown(url)}`);
  return 0;
}

/**
 * `motebit sync disable` — remove the persisted `sync_url`. A flag or
 * `MOTEBIT_SYNC_URL` still names a relay for the process that passes it.
 */
export function syncDisable(ctx: SyncOptInContext): number {
  const config = ctx.load();
  if (config.sync_url == null) {
    ctx.print("Relay sync is already off in config.json.");
    return 0;
  }
  delete config.sync_url;
  ctx.save(config);
  ctx.print("Relay sync off.");
  if (process.env["MOTEBIT_SYNC_URL"]) {
    ctx.print("Note: MOTEBIT_SYNC_URL is set and still names a relay for this shell.");
  }
  return 0;
}

/** `motebit sync …` from the command line. */
export async function handleSync(config: CliConfig): Promise<void> {
  const [, sub = "", ...rest] = config.positionals;
  // enable/disable act on config.json only — no identity or database needed.
  const optIn: SyncOptInContext = {
    load: loadFullConfig,
    save: (c) => {
      saveFullConfig(c);
    },
    print: (l) => console.log(l),
  };
  if (sub === "enable") {
    process.exitCode = syncEnable(rest[0], optIn);
    return;
  }
  if (sub === "disable") {
    process.exitCode = syncDisable(optIn);
    return;
  }
  process.exitCode = await runSyncCommand(sub, rest, cliContext(config));
}

/** `motebit status` from the command line. */
export async function handleStatus(config: CliConfig): Promise<void> {
  const ctx = cliContext(config);
  for (const l of await statusLines(ctx)) console.log(l);
}
