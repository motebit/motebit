/**
 * Static gate: owner-interior content reaches a provider request only
 * through the one interior-egress rule (`@motebit/ai-core`
 * `interior-egress.ts`) at the tier the request is sent at. Sibling of
 * `egress-history-gate.test.ts` (conversation history); behavioural
 * repros in `egress-interior-tier.test.ts`.
 *
 * 1. Every `ContextPack` field is classified — owner content and where
 *    its filter lives, or why it carries none. A new field is red until
 *    it is classified here.
 * 2. Each filtered field's producer reads through the shared functions.
 * 3. Every owner-store read in the provider-bound packages passes the
 *    filter (or is named here as never leaving the device).
 * 4. Every content-bearing event the runtime stack writes is stamped
 *    with its tier — the filter withholds an unstamped one.
 *
 * Aperture: `ContextPack` in packages/sdk/src/index.ts; every non-test
 * `.ts` under packages/{ai-core,reflection,runtime}/src.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(__dirname, "..", "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") out.push(...sources(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const FILES = ["ai-core", "reflection", "runtime"]
  .flatMap((pkg) => sources(join(PACKAGES, pkg, "src")))
  .map((p) => ({ rel: relative(PACKAGES, p), text: readFileSync(p, "utf8") }));

function file(rel: string): string {
  const f = FILES.find((x) => x.rel === rel);
  if (!f) throw new Error(`gate aperture lost ${rel}`);
  return f.text;
}

const LOOP = "ai-core/src/loop.ts";
const ENGINE = "reflection/src/engine.ts";
const RUNTIME = "runtime/src/motebit-runtime.ts";
const GRADIENT = "runtime/src/gradient-manager.ts";

/**
 * Every ContextPack field. `filtered` — owner content, filtered at the send
 * tier where the named test below checks. `none` — why the field carries no
 * tiered owner content.
 */
const CONTEXT_PACK_FIELDS: Record<string, { filtered: string } | { none: string }> = {
  recent_events: { filtered: "interiorEventsPermittedAt in recallOwnerInterior" },
  relevant_memories: { filtered: "interiorEgressSensitivities / interiorEgressPermits" },
  memoryIndex: { filtered: "getMemoryIndex({ sensitivityFilter: permitted })" },
  curiosityHints: { filtered: "buildCuriosityHints(sendTier) → interiorEgressPermits" },
  conversation_history: { filtered: "ConversationManager.trimmed (egress-history-gate)" },
  current_state: { none: "numeric state vector" },
  user_message: { none: "this turn's own input, sent at this turn's tier" },
  behavior_cues: { none: "numeric render cues" },
  tools: { none: "tool definitions — capability metadata" },
  sessionInfo: { none: "a flag and a timestamp" },
  knownAgents: { none: "trust records over public motebit ids" },
  agentCapabilities: { none: "public service-listing capabilities" },
  precisionContext: { none: "gradient posture and counts" },
  firstConversation: { none: "a flag" },
  activationPrompt: { none: "fixed activation text" },
  selectedSkills: { none: "own gate: skills selector (tier ≤ session; medical+ never auto)" },
  sessionState: { none: "runtime status snapshot (browser, tier, counts, model)" },
};

describe("owner-interior egress gate", () => {
  it(`scanned ${FILES.length} source files across ai-core, reflection and runtime`, () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("every ContextPack field is classified", () => {
    const sdk = readFileSync(join(PACKAGES, "sdk", "src", "index.ts"), "utf8");
    const body = /export interface ContextPack \{([\s\S]*?)\n\}/.exec(sdk)?.[1];
    expect(body, "ContextPack not found in packages/sdk/src/index.ts").toBeDefined();
    const fields = [...body!.matchAll(/^ {2}([A-Za-z_]+)\??:/gm)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(10);
    const unclassified = fields.filter((f) => !(f in CONTEXT_PACK_FIELDS));
    expect(
      unclassified,
      "classify the new ContextPack field in CONTEXT_PACK_FIELDS: if it carries owner content, " +
        "produce it through interiorEgressPermits / interiorEventsPermittedAt at the send tier",
    ).toEqual([]);
    expect(Object.keys(CONTEXT_PACK_FIELDS).sort()).toEqual([...fields].sort());
  });

  it("the turn's recall reads through the shared rule at the send tier", () => {
    const loop = file(LOOP);
    expect(loop).toMatch(/const sendTier = deps\.getEffectiveSensitivity\?\.\(\);/);
    expect(loop).toMatch(/const permitted = interiorEgressSensitivities\(sendTier\);/);
    expect(loop).toMatch(
      /pinnedMemoriesRaw\.filter\(\(m\) =>\s*interiorEgressPermits\(sendTier, m\.sensitivity\)/,
    );
    expect(loop).toMatch(/recallRelevant\(queryEmbedding, \{[^}]*sensitivityFilter: permitted,/);
    expect(loop).toMatch(/getMemoryIndex\?\.\(\{ sensitivityFilter: permitted \}\)/);
    expect(loop).toMatch(/recentEvents: interiorEventsPermittedAt\(recentEvents, sendTier\),/);
    // No second, static filter beside the rule.
    expect(loop).not.toMatch(/sensitivityFilter: (?!permitted\b)/);
  });

  it("curiosity hints read through the shared rule at the turn's tier", () => {
    expect(file(RUNTIME)).toMatch(
      /curiosityHints: this\.gradientManager\.buildCuriosityHints\(\s*this\.getEffectiveSessionSensitivity\(\),?\s*\)/,
    );
    expect(file(GRADIENT)).toMatch(
      /this\._curiosityTargets\.filter\(\(t\) =>\s*interiorEgressPermits\(sendTier, t\.node\.sensitivity\)/,
    );
  });

  it("reflection reads memories and past reflections through the shared rule", () => {
    const engine = file(ENGINE);
    expect(engine).toMatch(/const sendTier = deps\.getEffectiveSensitivity\(\);/);
    expect(engine).toMatch(
      /const nodes = exported\.nodes\.filter\(\(n\) => interiorEgressPermits\(sendTier, n\.sensitivity\)\);/,
    );
    // The raw export is read only by the filters.
    const rawUses = engine.split("\n").filter((l) => /\bexported\./.test(l));
    expect(rawUses.map((l) => l.trim())).toEqual([
      "const nodes = exported.nodes.filter((n) => interiorEgressPermits(sendTier, n.sensitivity));",
      "const edges = exported.edges.filter((e) => kept.has(e.source_id) && kept.has(e.target_id));",
    ]);
    expect(engine).toMatch(/return interiorEventsPermittedAt\(events, sendTier\)/);
    expect(engine).toMatch(/buildAuditSummary\(nodes, edges\)/);
    expect(engine).toMatch(/const sourceNodes = nodes\.slice\(/);
  });

  it("every owner-store read in the provider-bound packages passes the filter", () => {
    /** Reads that never reach a provider request. */
    const LOCAL_ONLY = [
      // Reflection's novelty check: a cosine comparison, never sent.
      /const similar = await deps\.memory\.recallRelevant\(embedding, \{ limit: 3 \}\);/,
    ];
    const bad: string[] = [];
    for (const f of FILES.filter((x) => !x.rel.startsWith("runtime/"))) {
      f.text.split("\n").forEach((line, i) => {
        if (!/\.(getMemoryIndex|recallRelevant|getPinnedMemories|exportAll)\??\.?\(/.test(line))
          return;
        if (LOCAL_ONLY.some((r) => r.test(line))) return;
        const ok =
          /getMemoryIndex\?\.\(\{ sensitivityFilter: permitted \}\)/.test(line) ||
          /recallRelevant\(queryEmbedding, \{/.test(line) ||
          /memoryGraph\.getPinnedMemories\(\)/.test(line) ||
          /const exported = await deps\.memory\.exportAll\(\);/.test(line);
        if (!ok) bad.push(`${f.rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, "filter the read through interiorEgressPermits at the send tier").toEqual([]);
  });

  it("every content-bearing event the runtime stack writes is stamped with its tier", () => {
    const loop = file(LOOP);
    expect(loop).toMatch(
      /event_type: EventType\.StateUpdated,[\s\S]{0,400}sensitivity: deps\.getEffectiveSensitivity\?\.\(\) \?\? SensitivityLevel\.None,/,
    );
    const rt = file(RUNTIME);
    expect(rt).toMatch(
      /event_type: EventType\.ToolUsed,\s*payload: \{[\s\S]{0,300}sensitivity: this\.getEffectiveSessionSensitivity\(\),/,
    );
    expect(rt).toMatch(
      /event_type: EventType\.HousekeepingRun,\s*payload: \{[\s\S]{0,300}sensitivity: this\.getEffectiveSessionSensitivity\(\),/,
    );
    expect(file(ENGINE)).toMatch(
      /event_type: EventType\.ReflectionCompleted,\s*payload: \{[\s\S]{0,900}sensitivity: sendTier,/,
    );
  });
});
