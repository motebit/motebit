/**
 * Live-self-knowledge registry drift gate.
 *
 * Mechanically enforces that the `[Now]` block — the boundary of the
 * motebit's LIVE self-knowledge — stays complete and grounded. The
 * `[Now]` block is a drift surface: the AI confabulates live self-state
 * ("the browser is open", "yes, I'm forming memories") whenever a facet
 * of its runtime state is NOT surfaced here for it to read. Each such
 * facet is a `SelfStateRenderer` entry in `SELF_STATE_RENDERERS`
 * (`packages/ai-core/src/prompt.ts`). For the read-don't-infer
 * discipline to be SAFE — for "it's not in [Now]" to reliably mean
 * "unknown" rather than "we forgot to wire it" — every facet MUST
 * travel with its full four-part structure:
 *
 *   1. **Renderer** — an entry in `SELF_STATE_RENDERERS` keyed by the
 *      snapshot field it reads (the [Now] line producer).
 *   2. **Producer field** — the `SessionStateSnapshot` field that the
 *      runtime composes in `getSessionStateSnapshot()`
 *      (`packages/runtime/src/motebit-runtime.ts`). Without it the
 *      renderer reads `undefined` and the line silently vanishes.
 *   3. **Prompt clause** — text in `prompt.ts` teaching the AI to read
 *      the facet (so a surfaced fact isn't ignored).
 *   4. **Test** — a pin in `prompt.test.ts` asserting the facet renders
 *      (so a silent removal goes red).
 *
 * Why a registry, not a free scan
 * --------------------------------
 * The historical failure was accretion: each witnessed confabulation
 * added one hand-wired `if` to `formatSessionState`, and NOTHING forced
 * the matching producer field + prompt clause + test to land with it
 * (the memory facet itself shipped a producer + render before this gate
 * existed; a sibling could ship a render with no producer and the line
 * would just never appear). The closed-registry shape — same idiom as
 * `check-typed-truth-perception` (#80), `check-tool-modes` (#36),
 * `check-mode-contract-readers` — makes the registry THE inventory and
 * forces all four parts to travel together. Adding a self-state facet
 * costs one renderer entry + one entry here; the gate fails until the
 * producer field, prompt clause, and test all exist.
 *
 * Bidirectional drift check:
 *   - renderer-without-registry: a `SELF_STATE_RENDERERS` key with no
 *     entry here (someone added a facet but skipped the discipline).
 *   - registry-without-renderer: an entry here whose key no longer
 *     appears in `SELF_STATE_RENDERERS` (a facet was removed but the
 *     registry/prompt/test weren't cleaned up).
 *
 * Doctrine: `docs/doctrine/typed-truth-perception.md` +
 * `docs/doctrine/runtime-invariants-over-prompt-rules.md` (the prompt
 * teaches WHERE truth lives — the [Now] boundary — not what's true) +
 * `docs/doctrine/registry-pattern-canonical.md`. Root principle:
 * CLAUDE.md `Typed truth on results, prompt for interpretation`.
 *
 * Usage:
 *   tsx scripts/check-self-state-registry.ts   # exit 1 on drift
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface SelfStateFacet {
  /**
   * The `SessionStateSnapshot` field the facet reads — MUST equal the
   * `key:` on its `SELF_STATE_RENDERERS` entry. The gate binds
   * renderer ⇄ producer ⇄ prompt ⇄ test by this key.
   */
  readonly key: string;
  /** String the gate greps for in `prompt.ts` — the AI's reading clause. */
  readonly promptText: string;
  /** String the gate greps for in the `getSessionStateSnapshot` producer. */
  readonly producerField: string;
  /** String the gate greps for in `prompt.test.ts` — the facet's render pin. */
  readonly testText: string;
  /** Brief why-the-shape note for forensics. */
  readonly notes?: string;
}

/**
 * The canonical inventory of live-self-knowledge facets. Adding an
 * entry is the discipline-trigger for any new `[Now]` facet — the gate
 * forces the renderer, producer field, prompt clause, and test to land
 * together. Keys MUST match `SELF_STATE_RENDERERS` keys exactly.
 */
const SELF_STATE_FACETS: ReadonlyArray<SelfStateFacet> = [
  {
    key: "browser",
    promptText: "browser line",
    producerField: "browser",
    testText: "Browser: closed",
    notes:
      "Cloud-browser session status/url/control. The original confabulation (2026-05-08: 'browser is already open on Hacker News' after a refresh closed it) that motivated the [Now] block.",
  },
  {
    key: "sensitivity",
    promptText: "current sensitivity tier",
    producerField: "sensitivity",
    testText: "Sensitivity: medical",
    notes: "Effective session sensitivity tier — runtime-owned. Rendered only when non-default.",
  },
  {
    key: "pixelConsent",
    promptText: "pixel-passthrough state",
    producerField: "pixelConsent",
    testText: "Pixel passthrough: session",
    notes: "Per-session pixel-passthrough consent. Rendered only when non-default (`denied`).",
  },
  {
    key: "staleBytesOmissionReason",
    promptText: "Stale pixel-omission:",
    producerField: "staleBytesOmissionReason",
    testText: "Stale pixel-omission",
    notes:
      "Stale bytes_omitted_reason — the runtime computes that a prior omission's gate has flipped. Pin from 2026-05-11 (telling the user to /vision grant a thing already granted).",
  },
  {
    key: "memory",
    promptText: "Your own memory state is in the [Now] block",
    producerField: "memory",
    testText: "0 formed this session",
    notes:
      "Memory self-state (total / newest age / formed-this-session). Closes the self-state sibling of the browser slip (2026-05-31: 'yes, I'm forming memories' with 0 formed that session).",
  },
];

interface Violation {
  key: string;
  reason: string;
  remediation: string;
}

function readFile(path: string): string {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return "";
  }
}

/**
 * Extract the `SELF_STATE_RENDERERS` array literal from prompt.ts and
 * return the set of `key: "..."` values declared inside it. Scoped to
 * the array block so unrelated `key:` occurrences elsewhere in the file
 * don't leak in.
 */
function parseRendererKeys(promptSource: string): Set<string> {
  const block = promptSource.match(/const SELF_STATE_RENDERERS[\s\S]*?\n\];/);
  const keys = new Set<string>();
  if (!block) return keys;
  const keyRegex = /\bkey:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = keyRegex.exec(block[0])) !== null) keys.add(m[1]!);
  return keys;
}

/**
 * Slice the `getSessionStateSnapshot` producer body from the runtime
 * source. A generous window from the method start covers the one
 * method; the gate only needs field-presence within the producer.
 */
function producerBody(runtimeSource: string): string {
  // Anchor on the method DECLARATION, not a `this.getSessionStateSnapshot()`
  // callsite (those appear earlier in the file and carry none of the
  // composed fields). The declaration is the only `async getSessionStateSnapshot(`.
  const start = runtimeSource.indexOf("async getSessionStateSnapshot(");
  if (start === -1) return "";
  return runtimeSource.slice(start, start + 3000);
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const PROMPT = "packages/ai-core/src/prompt.ts";
  const PRODUCER = "packages/runtime/src/motebit-runtime.ts";
  const TEST = "packages/ai-core/src/__tests__/prompt.test.ts";

  const promptSource = readFile(PROMPT);
  if (promptSource === "") {
    return [
      {
        key: "(N/A)",
        reason: `could not read ${PROMPT}`,
        remediation: "Verify the prompt source exists and is readable.",
      },
    ];
  }
  const runtimeSource = readFile(PRODUCER);
  const testSource = readFile(TEST);
  const producer = producerBody(runtimeSource);
  const rendererKeys = parseRendererKeys(promptSource);
  const registryKeys = new Set(SELF_STATE_FACETS.map((f) => f.key));

  // Bidirectional drift between SELF_STATE_RENDERERS and this registry.
  for (const key of rendererKeys) {
    if (!registryKeys.has(key)) {
      violations.push({
        key,
        reason: `SELF_STATE_RENDERERS has key "${key}" with no entry in SELF_STATE_FACETS (${"scripts/check-self-state-registry.ts"})`,
        remediation: `Add a SELF_STATE_FACETS entry for "${key}" naming its promptText (the AI's reading clause), producerField (the SessionStateSnapshot field), and testText (a prompt.test.ts pin). This is the discipline that keeps a new [Now] facet from shipping un-grounded.`,
      });
    }
  }
  for (const key of registryKeys) {
    if (!rendererKeys.has(key)) {
      violations.push({
        key,
        reason: `SELF_STATE_FACETS has entry "${key}" but no matching key in SELF_STATE_RENDERERS (${PROMPT})`,
        remediation: `Either restore the SELF_STATE_RENDERERS entry for "${key}" or, if the facet was intentionally removed, delete its SELF_STATE_FACETS entry AND its prompt clause AND its test in the same pass.`,
      });
    }
  }

  // Four-part completeness for every registered facet.
  for (const facet of SELF_STATE_FACETS) {
    if (!promptSource.includes(facet.promptText)) {
      violations.push({
        key: facet.key,
        reason: `prompt clause missing — promptText "${facet.promptText}" not found in ${PROMPT}`,
        remediation: `Restore the clause that teaches the AI to read the "${facet.key}" facet (so a surfaced fact isn't ignored), or update this facet's promptText if the wording moved.`,
      });
    }
    if (producer !== "" && !new RegExp(`\\b${facet.producerField}\\b`).test(producer)) {
      violations.push({
        key: facet.key,
        reason: `producer field missing — "${facet.producerField}" not found in getSessionStateSnapshot (${PRODUCER})`,
        remediation: `Have getSessionStateSnapshot compose the "${facet.producerField}" field on the SessionStateSnapshot, or update this facet's producerField if it was renamed. Without the producer the renderer reads undefined and the [Now] line silently vanishes.`,
      });
    }
    if (testSource !== "" && !testSource.includes(facet.testText)) {
      violations.push({
        key: facet.key,
        reason: `test pin missing — testText "${facet.testText}" not found in ${TEST}`,
        remediation: `Add/restore a prompt.test.ts assertion that the "${facet.key}" facet renders (containing "${facet.testText}"), so a silent removal goes red.`,
      });
    }
  }

  // The boundary clause itself — the rule that makes the whole registry
  // honest. Three sources must stay named in PERCEPTION_DOCTRINE: the
  // design block (what you ARE), [Now] (what is TRUE), and absorbed
  // conversation content (what is POSSIBLE — never self-state). The
  // third was added 2026-07-05 after a live confabulation: a motebit
  // read a pasted doctrine doc staging an UNBUILT intervention and
  // claimed it first-person ("ranked tensions… I can feel it"). A
  // budget-pressure prompt trim that drops these markers silently
  // reopens that channel — so they are locked here, beside the facets
  // they govern. Doctrine: docs/doctrine/typed-truth-perception.md
  // §"The third source".
  const BOUNDARY_MARKERS: readonly string[] = [
    "boundary of your live self-knowledge",
    "content absorbed through the conversation",
    "A document staging an intervention does not install it",
  ];
  for (const marker of BOUNDARY_MARKERS) {
    if (!promptSource.includes(marker)) {
      violations.push({
        key: "(boundary clause)",
        reason: `live-state boundary marker missing from ${PROMPT}: "${marker}"`,
        remediation:
          `Restore the live-state boundary clause in PERCEPTION_DOCTRINE (packages/ai-core/src/prompt.ts) — ` +
          `all three self-description sources must stay named (design block / [Now] / absorbed content), ` +
          `per docs/doctrine/typed-truth-perception.md §"The third source" and the falsifier in ` +
          `packages/ai-core/src/__tests__/live-state-boundary.test.ts.`,
      });
    }
  }

  return violations;
}

function main(): void {
  const banner =
    "▸ check-self-state-registry — every live-self-knowledge facet in the [Now] block travels with its full four-part structure: renderer (SELF_STATE_RENDERERS) + producer field (getSessionStateSnapshot) + prompt clause + test. The [Now] block is the boundary of the motebit's live self-knowledge; this gate keeps that boundary complete so 'it's not in [Now]' reliably means 'unknown', not 'we forgot to wire it'. Closed-registry shape with bidirectional drift, same idiom as check-typed-truth-perception. Doctrine: docs/doctrine/typed-truth-perception.md + runtime-invariants-over-prompt-rules.md.";
  process.stderr.write(banner + "\n");

  const violations = scan();
  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-self-state-registry: ${SELF_STATE_FACETS.length} self-state facet(s) registered, all four-part-complete (renderer + producer + prompt + test).\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-self-state-registry: ${violations.length} drift violation(s)\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  [${v.key}] ${v.reason}\n      → ${v.remediation}\n\n`);
  }
  process.exit(1);
}

main();
