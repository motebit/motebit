/**
 * Property-based fuzz tests for `parseSkillFile` — the typed-error
 * envelope at the SKILL.md install boundary.
 *
 * `parseSkillFile` is the boundary at which arbitrary user-provided text
 * (SKILL.md files installed from disk, fetched from URLs, decoded from
 * cross-device install envelopes) becomes a typed `SkillManifest` object.
 * Per `packages/skills/CLAUDE.md` rule 1 (install is permissive,
 * auto-load is provenance-gated) the parser does not implement provenance
 * checks — but it MUST enforce that malformed input surfaces as
 * `SkillParseError`, never as an untyped throw, never as undefined, never
 * as a runtime crash propagated to a caller that wasn't expecting a parse
 * error type.
 *
 * The hand-written cases in `skills.test.ts` cover specific malformations
 * (missing opening delimiter, missing closing delimiter, malformed YAML,
 * schema-validation failures, BOM/CRLF normalization). The property tests
 * below complement those by generating arbitrary inputs and asserting the
 * typed-error envelope holds across the whole input space — fuzz coverage
 * that catches the failure modes hand-written tests structurally miss
 * (regex backtracking, YAML library throwing a non-SyntaxError, unbounded
 * recursion on adversarial delimiters, etc.).
 *
 * ### Determinism
 *
 * Same pattern as `packages/protocol/src/__tests__/semiring-laws.test.ts`
 * and `packages/virtual-accounts/src/__tests__/properties.test.ts`:
 * fast-check seed is pinned for CI reproducibility, bisectable
 * counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { parseSkillFile, SkillParseError, serializeSkillFile } from "../parse.js";

const FC_SEED = 0x5eed;
beforeAll(() => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 200 });
});

/** A minimal well-formed SKILL.md — frontmatter satisfies the schema. */
const KNOWN_GOOD = [
  "---",
  "name: hello-world",
  "description: A test skill.",
  "version: 1.0.0",
  "motebit:",
  '  spec_version: "1.0"',
  "---",
  "# Body",
  "",
  "Procedure.",
  "",
].join("\n");

// ── Property 1 — Typed-error envelope on arbitrary text ─────────────

describe("parseSkillFile: typed-error envelope on arbitrary text", () => {
  it("any string input either parses successfully OR throws SkillParseError — no other throw types", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 2048 }), (rawText) => {
        try {
          parseSkillFile(rawText);
          return true; // accepted
        } catch (err) {
          // The contract: any rejection MUST be a SkillParseError. Other
          // throws (TypeError from undefined access, RangeError, plain
          // Error, library SyntaxError) indicate the parser is leaking
          // implementation-detail errors past its typed boundary.
          return err instanceof SkillParseError;
        }
      }),
    );
  });

  it("Unicode-heavy inputs preserve the typed-error envelope", () => {
    // Unicode strings can break naive byte-counting. The parser strips
    // a BOM and normalizes line endings; this asserts those operations
    // don't introduce an untyped throw on adversarial Unicode.
    fc.assert(
      fc.property(fc.string({ unit: "binary", minLength: 0, maxLength: 512 }), (rawText) => {
        try {
          parseSkillFile(rawText);
          return true;
        } catch (err) {
          return err instanceof SkillParseError;
        }
      }),
    );
  });
});

// ── Property 2 — Byte-flip resistance on a known-good input ──────────

describe("parseSkillFile: byte-flip resistance on a known-good input", () => {
  it("any single-character substitution either parses cleanly OR throws SkillParseError", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: KNOWN_GOOD.length - 1 }),
        fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 \n\t:#-".split("")),
        (position, newChar) => {
          const mutated = KNOWN_GOOD.slice(0, position) + newChar + KNOWN_GOOD.slice(position + 1);
          try {
            parseSkillFile(mutated);
            return true;
          } catch (err) {
            return err instanceof SkillParseError;
          }
        },
      ),
    );
  });

  it("random byte INSERTION at any position preserves the typed-error envelope", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: KNOWN_GOOD.length }),
        fc.string({ minLength: 1, maxLength: 16 }),
        (position, inserted) => {
          const mutated = KNOWN_GOOD.slice(0, position) + inserted + KNOWN_GOOD.slice(position);
          try {
            parseSkillFile(mutated);
            return true;
          } catch (err) {
            return err instanceof SkillParseError;
          }
        },
      ),
    );
  });

  it("random byte DELETION at any position preserves the typed-error envelope", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: KNOWN_GOOD.length - 1 }),
        fc.integer({ min: 1, max: 32 }),
        (position, count) => {
          const mutated = KNOWN_GOOD.slice(0, position) + KNOWN_GOOD.slice(position + count);
          try {
            parseSkillFile(mutated);
            return true;
          } catch (err) {
            return err instanceof SkillParseError;
          }
        },
      ),
    );
  });
});

// ── Property 3 — Arbitrary frontmatter content ──────────────────────

describe("parseSkillFile: arbitrary frontmatter content between delimiters", () => {
  it("delimiters present, arbitrary content between — typed-error envelope holds", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 512 }), (yamlChunk) => {
        const text = `---\n${yamlChunk}\n---\nbody\n`;
        try {
          parseSkillFile(text);
          return true;
        } catch (err) {
          return err instanceof SkillParseError;
        }
      }),
    );
  });

  it("YAML-shaped frontmatter (alternating key:value lines) — typed-error envelope holds", () => {
    // Closer to realistic adversarial input than free-form bytes: things
    // that LOOK like YAML keys but mostly fail schema validation. Catches
    // the case where schema validation throws a non-SkillParseError.
    const keyValueLine = fc
      .tuple(fc.string({ minLength: 1, maxLength: 16 }), fc.string({ minLength: 0, maxLength: 32 }))
      .map(([k, v]) => `${k.replace(/[\n:#]/g, "x")}: ${v.replace(/\n/g, " ")}`);
    fc.assert(
      fc.property(fc.array(keyValueLine, { minLength: 0, maxLength: 20 }), (lines) => {
        const text = `---\n${lines.join("\n")}\n---\nbody\n`;
        try {
          parseSkillFile(text);
          return true;
        } catch (err) {
          return err instanceof SkillParseError;
        }
      }),
    );
  });
});

// ── Sanity smoke: round-trip identity ────────────────────────────────

// Single hand-written assertion because round-trip is a property on
// (manifest, body) inputs and building a SkillManifest generator costs
// more than it adds. Pinned smoke catches a regression in
// serialize→parse symmetry that the property tests above structurally
// cannot — they all start from raw text, never from a manifest object.
describe("parseSkillFile ↔ serializeSkillFile: round-trip", () => {
  it("serialize(parse(t)) parses to a structurally-equivalent manifest + body", () => {
    const { manifest, body } = parseSkillFile(KNOWN_GOOD);
    const reserialized = serializeSkillFile(manifest, body);
    const { manifest: m2, body: b2 } = parseSkillFile(reserialized);
    expect(m2.name).toBe(manifest.name);
    expect(m2.version).toBe(manifest.version);
    expect(m2.motebit.spec_version).toBe(manifest.motebit.spec_version);
    expect(new TextDecoder().decode(b2)).toBe(new TextDecoder().decode(body));
  });
});
