#!/usr/bin/env tsx
/**
 * check-model-picker-canonical — every surface's Anthropic model picker is
 * rendered from `@motebit/sdk` (`ANTHROPIC_PICKER`, `pickerModelForTier`,
 * `DEFAULT_ANTHROPIC_MODEL`), never hand-copied (#654).
 *
 * Born 2026-09-30: after Opus 5.5 and Sonnet 5 shipped, the surfaces
 * disagreed about which Claude models exist. Web's BYOK <select> offered
 * Opus 4.7 / Sonnet 4.6 (hand-typed in index.html), desktop's placeholder
 * pinned an old id, the CLI's `/model haiku` alias named a non-registry id,
 * and `--help` printed a default the code no longer used. Each copy was
 * correct the day it was typed; nothing tied it to the registry, so every
 * Claude release silently staled N copies.
 *
 * Rule — DENY BY DEFAULT over the whole aperture (#654 cold review C4). The
 * first version scanned only quoted literals in `src/**` .ts/.tsx/.html with
 * comments stripped and a line-substring allowlist; a cold review exited 0
 * on concatenation, template literals, `.join`, UPPERCASE, the legacy
 * `claude-3-5-sonnet-…` shape, unquoted attributes, `<option>` text content,
 * `public/*.html`, `.js/.mjs/.json`, root-level `.ts`, `.mdx`, an id after
 * " // " inside a string, and a stale `<option>` appended to an allowlisted
 * line. That is the pattern-match class; the fix is to stop pattern-matching
 * on CONTEXT and match on the TOKEN, everywhere:
 *
 *   Aperture: EVERY git-tracked (and untracked, non-ignored) text file under
 *   `apps/` — all extensions, `public/`, app roots, tests, docs, changelogs.
 *   Case-insensitive. No comment stripping (a comment is a copy too).
 *
 *   Flagged tokens:
 *     ID       `claude` + optional `-`/`_` + a family (opus|sonnet|haiku|
 *              fable|mythos|instant) or a digit, then the id tail —
 *              `claude-sonnet-5`, `CLAUDE_OPUS_5_5`, `claude-3-5-sonnet-…`.
 *     LABEL    the spaced display form with a version — `Claude Opus 4.7`.
 *     FRAGMENT `claude` / `claude-` immediately followed by a quote, backtick
 *              or `${` — the visible head of a concatenation, template
 *              literal or `[...].join` that assembles an id at runtime.
 *
 *   Allowlist: per (file, EXACT token as written, why) — never per line. A
 *   listed token is exempt only in its file, only in that exact spelling;
 *   every listed (file, token) pair that no longer occurs is itself red.
 *
 *   Decoding (#654 cold review R2): a line ending in `\` is joined to the
 *   next (string continuation) and `\uXXXX` / `\u{…}` / `\xNN` / `&#…;`
 *   escapes — plus legacy octal `\143` and identity escapes `\-` — are
 *   decoded BEFORE the rules run, so `"claude-\⏎sonnet-5"`,
 *   `"\u0063laude-sonnet-5"` and `"claude\-opus-5-5"` are the token they spell.
 *
 *   Scope (declared limit): this gate guards against ACCIDENTAL hand-copied
 *   ids — the copy a person types or pastes. Deliberately obfuscated ids are
 *   OUT OF SCOPE and the decoder is not extended to chase them: a `\`
 *   continuation followed by CR, U+2028 or U+2029 (or any other exotic line
 *   terminator), and ids assembled at runtime. Those are covered by the
 *   per-surface picker tests below, which render from `@motebit/sdk`.
 *
 *   What the scan cannot see: an id assembled from pieces that never spell
 *   `claude` next to a quote (`"cla" + "ude-…"`, a lookup table keyed by
 *   tier). Those are covered by EXECUTION — but only for the five picker /
 *   alias consumers, each of which has a test that runs the real code and
 *   compares against the sdk:
 *     web      settings-anthropic-picker.test   real index.html + initSettings
 *     desktop  settings-anthropic-picker.test   real index.html + initSettings
 *     spatial  settings-anthropic-picker.test   boots the real app.ts
 *     mobile   intelligence-tab-picker.test     renders the real IntelligenceTab
 *     cli      slash-model-tiers.test           runs `/model opus|sonnet|haiku`
 *   NOT execution-covered: any OTHER apps/ code path that constructs a
 *   Claude id dynamically (CLI `--help` / motebit.yaml schema text are
 *   interpolated from sdk constants and not executed against the picker).
 *
 * Docs picker arm (#654 cold review of 27814cf). The docs NAME the picker
 * rows in prose, so they cannot import them; the allowlist alone only proved
 * the tokens still occurred, not that they were still the picker (moving the
 * strongest row to `claude-fable-5-1` left this gate and
 * check-docs-default-models green). Over every docs page
 * (`apps/docs/content/**\/*.md[x]`) and every generated LLM artifact
 * (`apps/docs/public/llms*.txt`), each Claude token is checked against
 * `ANTHROPIC_PICKER`, loaded by EXECUTING packages/sdk/src/models.ts (or the
 * copy named by `--models <path>`, which the self-test mutates):
 *   LABEL    must equal a row's label head (the text before " — ");
 *   ID       must equal a row's id, or be a DOCS_TYPED_IDS entry — an id the
 *            docs name as "typed by id", which must be in ANTHROPIC_MODELS
 *            and must NOT be a picker row (else the docs call a picker row
 *            "other");
 *   FRAGMENT never allowed in docs.
 * The llms*.txt files are regenerated from the pages by
 * scripts/generate-llms-txt.ts and held byte-fresh by check-llms-txt-fresh,
 * and this arm scans them directly too.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { formatRepair } from "./lib/gate-report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const FAMILY = "(?:opus|sonnet|haiku|fable|mythos|instant)";
const RULES: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: "id", re: new RegExp(`claude[-_]?(?:${FAMILY}|\\d)[a-z0-9._-]*`, "gi") },
  { kind: "label", re: new RegExp(`claude\\s+${FAMILY}\\s+\\d+(?:\\.\\d+)?`, "gi") },
  { kind: "fragment", re: /claude[-_]?(?=["'`]|\$\{)/gi },
];

interface AllowEntry {
  /** Repo-relative path. */
  readonly file: string;
  /** Exact tokens as written (case-sensitive) exempt in this file only. */
  readonly ids: readonly string[];
  /** Why these are not a hand-copied Anthropic picker / default. */
  readonly why: string;
}

const TEST_FIXTURE =
  "test fixture: a stored / typed / legacy id the test feeds in to prove it is shown, admitted or refused — the test's subject, not a picker copy.";
const DOCS_PICKER =
  "docs prose naming the current picker rows; the docs picker arm of THIS gate requires every label token here to equal an ANTHROPIC_PICKER row's label head and every id token to equal an ANTHROPIC_PICKER row id or a DOCS_TYPED_IDS entry (in ANTHROPIC_MODELS, not a picker row) — loaded from @motebit/sdk's models.ts, so a picker change with stale docs is RED.";
const CHANGELOG = "release history: records what shipped at that version; immutable by design.";
const GENERATED =
  "generated JSON Schema: the default is interpolated from DEFAULT_ANTHROPIC_MODEL in apps/cli/src/yaml-config.ts and the committed file is regenerated from it.";
const LLMS_FULL =
  "generated concatenation of the docs content (the DOCS_PICKER pages above), held byte-fresh against them by check-llms-txt-fresh; the docs picker arm of THIS gate checks its tokens against ANTHROPIC_PICKER exactly as for the pages.";

/** Docs pages + generated LLM artifacts the docs picker arm governs. */
function isDocsSurface(rel: string): boolean {
  return (
    (rel.startsWith("apps/docs/content/") && /\.mdx?$/.test(rel)) ||
    /^apps\/docs\/public\/llms[^/]*\.txt$/.test(rel)
  );
}

/**
 * Non-picker Claude ids the docs name as "typed by id" examples. Each must be
 * an ANTHROPIC_MODELS id and must NOT be an ANTHROPIC_PICKER row; an entry no
 * docs surface names is stale (red).
 */
const DOCS_TYPED_IDS: readonly string[] = ["claude-fable-5-1"];

interface PickerSource {
  readonly ids: ReadonlySet<string>;
  readonly labels: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
  readonly path: string;
}

async function loadPicker(modelsPath: string): Promise<PickerSource> {
  const mod = (await import(pathToFileURL(modelsPath).href)) as {
    ANTHROPIC_PICKER: readonly { id: string; label: string }[];
    ANTHROPIC_MODELS: readonly string[];
  };
  return {
    ids: new Set(mod.ANTHROPIC_PICKER.map((r) => r.id)),
    labels: new Set(mod.ANTHROPIC_PICKER.map((r) => r.label.split(" — ")[0]!.trim())),
    models: new Set(mod.ANTHROPIC_MODELS),
    path: path.relative(REPO_ROOT, modelsPath).startsWith("..")
      ? modelsPath
      : path.relative(REPO_ROOT, modelsPath),
  };
}

function modelsPathFromArgs(argv: readonly string[]): string {
  const i = argv.indexOf("--models");
  if (i === -1) return path.join(REPO_ROOT, "packages/sdk/src/models.ts");
  const v = argv[i + 1];
  if (v == null || v === "") throw new Error("--models requires a path");
  return path.resolve(v);
}

/** Why a docs token is not the current picker, or null when it is. */
function docsVerdict(kind: string, token: string, p: PickerSource): string | null {
  if (kind === "label") {
    return p.labels.has(token)
      ? null
      : `label is not an ANTHROPIC_PICKER label head (${[...p.labels].join(" | ")})`;
  }
  if (kind === "id") {
    if (p.ids.has(token)) return null;
    if (DOCS_TYPED_IDS.includes(token)) return null; // validated separately
    return `id is neither an ANTHROPIC_PICKER id (${[...p.ids].join(" | ")}) nor a DOCS_TYPED_IDS entry`;
  }
  return "a runtime-assembled id fragment has no place in docs";
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "apps/cli/schema/motebit-yaml-v1.json",
    ids: ["claude-sonnet-5"],
    why: GENERATED,
  },
  {
    file: "apps/cli/CHANGELOG.md",
    ids: [
      "Claude-5",
      "claude-haiku-4-5",
      "claude-opus",
      "claude-opus-4-6",
      "claude-opus-4-6-20250414",
      "claude-opus-5",
      "claude-sonnet-4-5-latest",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
    ],
    why: CHANGELOG,
  },
  {
    file: "apps/docs/content/docs/apps/cli.mdx",
    ids: ["claude-sonnet-5"],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/content/docs/apps/configuration.mdx",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/content/docs/apps/desktop.mdx",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-sonnet-5",
    ],
    why: DOCS_PICKER,
  },
  {
    file: "apps/docs/public/llms-full.txt",
    ids: [
      "Claude Haiku 4.5",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5",
    ],
    why: LLMS_FULL,
  },
  {
    file: "apps/cli/src/__tests__/bare-command-routing.test.ts",
    ids: ["claude-opus-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/index.test.ts",
    ids: ["claude-haiku-3"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/mode-render.test.ts",
    ids: ["claude-opus-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/model-admission.test.ts",
    ids: ["claude-opus-5", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/money-flows.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/terminal-render.test.ts",
    ids: ["claude-haiku-4-5", "claude-opus-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/desktop/src/__tests__/index.test.ts",
    ids: ["claude-haiku-4-5-20251001"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/desktop/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-opus", "claude-opus-4-20250115", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/intelligence-tab-picker.test.tsx",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/mobile-app.test.ts",
    ids: ["claude-haiku-4-5-20251001", "claude-sonnet"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/slash-commands.test.ts",
    ids: ["claude-haiku-4-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/spatial/src/__tests__/providers.test.ts",
    ids: ["claude-3"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/spatial/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-opus", "claude-opus-4-20250115", "claude-sonnet-4-6", "claude-sonnet-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/anthropic-picker.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/bootstrap.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/providers.test.ts",
    ids: ["claude-sonnet-4-20250514"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/settings-anthropic-picker.test.ts",
    ids: ["claude-opus", "claude-opus-4-20250115", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/storage.test.ts",
    ids: ["claude-opus-4-6", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/web/src/__tests__/web-app.test.ts",
    ids: ["claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/proxy-default-model.test.ts",
    ids: [
      "claude-3-5-sonnet-20241022",
      "claude-opus",
      "claude-opus-4-20250115",
      "claude-sonnet",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
    ],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/cli/src/__tests__/slash-model-tiers.test.ts",
    ids: ["claude-opus", "claude-opus-4-20250115", "claude-sonnet-4-6", "claude-sonnet-5"],
    why: TEST_FIXTURE,
  },
  {
    file: "apps/mobile/src/__tests__/settings-modal-provider-switch.test.tsx",
    ids: ["claude-opus", "claude-opus-4-20250115", "claude-sonnet-4-6"],
    why: TEST_FIXTURE,
  },
];

function trackedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "apps"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(out.split("\0").filter((f) => f !== ""))].sort();
}

/** Text = readable and no NUL in the first 8 KiB (git's own heuristic). */
function readText(rel: string): string | null {
  const abs = path.join(REPO_ROOT, rel);
  let buf: Buffer;
  try {
    if (!fs.statSync(abs).isFile()) return null;
    buf = fs.readFileSync(abs);
  } catch {
    return null; // deleted in the worktree but still in the index
  }
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString("utf8");
}

/**
 * The source as the scan sees it (#654 cold review R2, item 5). Two encodings
 * spell an id without the bytes `claude-…` ever sitting on one physical line:
 *
 *   - a string CONTINUATION — a line ending in `\` joins the next line
 *     (`"claude-\⏎sonnet-5"` is `"claude-sonnet-5"` at runtime);
 *   - an ESCAPE — `\u0063laude`, `\u{63}laude`, `\x63laude`, `&#99;laude`,
 *     `&#x63;laude` all decode to `claude`, as do zero-padded forms
 *     (`\u{0000063}`, `&#0000000099;`, `&#x00000063;`) and numeric references
 *     without the `;` (`&#99laude`, `claude&#45sonnet`), legacy octal
 *     (`\143laude`) and identity escapes (`claude\-opus-5-5`, `\claude`).
 *
 * Continuations are joined into one logical line (reported at its first
 * physical line), then escapes are decoded before the rules run.
 */
function logicalLines(src: string): { line: string; at: number }[] {
  const physical = src.split("\n");
  const out: { line: string; at: number }[] = [];
  let buf = "";
  let start = 1;
  let continuing = false;
  physical.forEach((raw, i) => {
    const l = raw.replace(/\r$/, "");
    if (!continuing) start = i + 1;
    // An odd run of trailing backslashes = a continuation (`\\` is a literal).
    const trailing = /\\+$/.exec(l)?.[0].length ?? 0;
    if (trailing % 2 === 1) {
      buf += l.slice(0, -1);
      continuing = true;
      return;
    }
    out.push({ line: decodeEscapes(buf + l), at: start });
    buf = "";
    continuing = false;
  });
  if (continuing) out.push({ line: decodeEscapes(buf), at: start });
  return out;
}

function decodeEscapes(line: string): string {
  const cp = (n: number): string => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return (
    line
      // ONE left-to-right pass over backslash escapes, so `\\` (a literal
      // backslash) consumes its pair and never starts a second escape.
      // Leading zeros are unbounded (`\u{0000063}`) (#654 cold review R3).
      // Legacy octal (`\143` = `c`, sloppy-mode .js / inline <script>) and
      // IDENTITY escapes — a backslash before a char with no escape meaning
      // (`\-` = `-`, `\c` = `c`; node and tsc --strict both accept them in
      // strings) — decode to the char they spell (#654 lane split). The
      // recognised single-char escapes (\b \f \n \r \t \v) stay verbatim:
      // they spell control chars, never an id letter.
      .replace(
        /\\(?:u\{0*([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|([bfnrtv])|([\s\S]))/gi,
        (m, ub?: string, u4?: string, x2?: string, oct?: string, ctl?: string, id?: string) => {
          if (ub != null) return cp(parseInt(ub, 16));
          if (u4 != null) return cp(parseInt(u4, 16));
          if (x2 != null) return cp(parseInt(x2, 16));
          if (oct != null) return cp(parseInt(oct, 8));
          if (ctl != null) return m;
          return id ?? m;
        },
      )
      // A numeric reference's `;` is optional (`&#99laude`, `claude&#45sonnet`) —
      // how HTML parsers read them.
      .replace(/&#x0*([0-9a-f]{1,6});?/gi, (_m, h: string) => cp(parseInt(h, 16)))
      .replace(/&#0*(\d{1,7});?/g, (_m, d: string) => cp(parseInt(d, 10)))
  );
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly token: string;
  readonly kind: string;
  readonly source: string;
}

async function main(): Promise<void> {
  const picker = await loadPicker(modelsPathFromArgs(process.argv.slice(2)));
  const files = trackedFiles();
  const findings: Finding[] = [];
  const docsFindings: (Finding & { readonly why: string })[] = [];
  const docsTypedSeen = new Set<string>();
  let docsFiles = 0;
  let docsTokens = 0;
  const seenAllow = new Set<string>(); // `${file}\0${token}`
  const allowed = new Map<string, Set<string>>();
  for (const a of ALLOWLIST) {
    const s = allowed.get(a.file) ?? new Set<string>();
    for (const id of a.ids) s.add(id);
    allowed.set(a.file, s);
  }

  let textFiles = 0;
  for (const rel of files) {
    const src = readText(rel);
    if (src == null) continue;
    textFiles++;
    const docs = isDocsSurface(rel);
    if (docs) docsFiles++;
    for (const { line, at } of logicalLines(src)) {
      for (const { kind, re } of RULES) {
        for (const m of line.matchAll(re)) {
          // A sentence-final "." / "-" is punctuation, not part of the id.
          const token = m[0].replace(/[._-]+$/, "");
          if (docs) {
            docsTokens++;
            if (DOCS_TYPED_IDS.includes(token)) docsTypedSeen.add(token);
            const why = docsVerdict(kind, token, picker);
            if (why != null) {
              docsFindings.push({ file: rel, line: at, token, kind, source: line.trim(), why });
            }
          }
          if (allowed.get(rel)?.has(token)) {
            seenAllow.add(`${rel}\0${token}`);
            continue;
          }
          findings.push({ file: rel, line: at, token, kind, source: line.trim() });
        }
      }
    }
  }

  const stale = ALLOWLIST.flatMap((a) =>
    a.ids.filter((id) => !seenAllow.has(`${a.file}\0${id}`)).map((id) => ({ file: a.file, id })),
  );
  const pairs = ALLOWLIST.reduce((n, a) => n + a.ids.length, 0);
  const typedBad = DOCS_TYPED_IDS.flatMap((id) => {
    if (!picker.models.has(id)) return [`${id}: not in ANTHROPIC_MODELS`];
    if (picker.ids.has(id))
      return [
        `${id}: is now an ANTHROPIC_PICKER row — the docs call it a typed-by-id "other" model`,
      ];
    if (!docsTypedSeen.has(id)) return [`${id}: no docs surface names it (stale entry)`];
    return [];
  });

  console.log(
    `▸ check-model-picker-canonical — aperture: ${textFiles} text file(s) of ${files.length} git-tracked/untracked-unignored path(s) under apps/ (all extensions, case-insensitive, comments included); ${seenAllow.size} of ${pairs} allowlisted (file, token) pair(s) matched. Line continuations joined and \\u/\\x/&#, legacy-octal (\\143) and identity (\\-) escapes decoded before scanning. Scope: guards ACCIDENTAL hand-copied ids; deliberately obfuscated ids (a \\ continuation before CR/U+2028/U+2029, runtime assembly) are out of scope, covered by the per-surface picker tests that render from @motebit/sdk. Dynamically-assembled ids that never spell "claude" beside a quote are NOT seen by this scan; execution tests cover only the five picker/alias consumers — web/desktop/spatial settings-anthropic-picker.test, mobile intelligence-tab-picker.test, CLI slash-model-tiers.test — and no other apps/ code path.`,
  );

  console.log(
    `▸ docs picker arm — ${docsFiles} docs surface(s) (apps/docs/content/**/*.md[x] + apps/docs/public/llms*.txt), ${docsTokens} Claude token(s) checked against ANTHROPIC_PICKER (${picker.ids.size} row(s)) executed from ${picker.path}; ${DOCS_TYPED_IDS.length} DOCS_TYPED_IDS entry(ies).`,
  );

  if (
    findings.length === 0 &&
    stale.length === 0 &&
    docsFindings.length === 0 &&
    typedBad.length === 0
  ) {
    console.log(
      `✓ check-model-picker-canonical: 0 Claude model-id tokens outside the allowlist across ${textFiles} file(s); every Anthropic picker renders from @motebit/sdk ANTHROPIC_PICKER.`,
    );
    return;
  }

  let out = "";
  if (findings.length > 0) {
    out += formatRepair({
      invariant: `${findings.length} Claude model-id token(s) under apps/ outside the allowlist — a hand-copied picker row, default, alias or label that will stale on the next Claude release.`,
      canonical:
        "packages/sdk/src/models.ts (ANTHROPIC_PICKER, pickerModelForTier, pickerOptionsWithStored, DEFAULT_ANTHROPIC_MODEL, defaultModelForProvider)",
      fix:
        "import the id from @motebit/sdk instead — render picker rows with pickerOptionsWithStored()/ANTHROPIC_PICKER, " +
        "resolve a tier with pickerModelForTier(), a provider default with defaultModelForProvider(). Do not assemble an " +
        "id from pieces. If the token is genuinely not a picker copy (a test fixture, release history), " +
        "add {file, ids: [exact token], why} to ALLOWLIST in scripts/check-model-picker-canonical.ts.",
      sites: findings.map(
        (f) => `${f.file}:${f.line}  [${f.kind}] ${f.token}  — ${f.source.slice(0, 110)}`,
      ),
      doctrine: "docs/doctrine/intelligence-pluggability-contract.md; docs/drift-defenses.md",
    });
  }
  if (docsFindings.length > 0 || typedBad.length > 0) {
    out += formatRepair({
      invariant: `${docsFindings.length + typedBad.length} docs picker token(s) disagree with ANTHROPIC_PICKER — the docs present a model as a picker option that the sdk no longer offers (or a picker row as "other").`,
      canonical: `${picker.path} (ANTHROPIC_PICKER, ANTHROPIC_MODELS)`,
      fix:
        'edit the .mdx page(s) under apps/docs/content to name the current ANTHROPIC_PICKER rows (label head before " — ", and id), ' +
        "then regenerate apps/docs/public/llms*.txt with `npx tsx scripts/generate-llms-txt.ts` (check-llms-txt-fresh holds them fresh); " +
        "update DOCS_TYPED_IDS in scripts/check-model-picker-canonical.ts only for a non-picker id the docs name as typed-by-id.",
      sites: [
        ...docsFindings.map(
          (f) =>
            `${f.file}:${f.line}  [${f.kind}] ${f.token}  — ${f.why}  — ${f.source.slice(0, 90)}`,
        ),
        ...typedBad.map((t) => `DOCS_TYPED_IDS ${t}`),
      ],
    });
  }
  if (stale.length > 0) {
    out += formatRepair({
      invariant: `${stale.length} stale ALLOWLIST (file, token) pair(s) — the argued exception no longer occurs in that file.`,
      canonical: "scripts/check-model-picker-canonical.ts (ALLOWLIST)",
      fix: "remove the stale token from the entry's `ids` (drop the entry when it empties).",
      sites: stale.map((s) => `${s.file}: ${s.id}`),
    });
  }
  process.stderr.write(out);
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `✗ check-model-picker-canonical: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
