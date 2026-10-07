/**
 * Static gate for the CLASS behind round-5 finding 1: an owner-interior
 * write path that DEFAULTS its sensitivity — to `none`, or to an absent /
 * null stamp. A memory, goal or outcome written that way is read back as
 * the lowest tier (or the legacy exception) whatever it was derived from,
 * and enters later requests on an external provider. The write APIs take
 * the tier by type (`write-tier-required.test.ts` in persistence and
 * memory-graph); this gate catches the caller that satisfies the type with
 * a literal default.
 *
 * Rule: no `sensitivity: <none literal>` / `sensitivity: x ?? <none
 * literal>` property, and no `sensitivity = null | none` parameter
 * default, in non-test source — except the named read-side / display
 * sites below, each with the reason it is not a write.
 *
 * Aperture: every non-test `.ts` / `.tsx` file under packages/<pkg>/src
 * and apps/<app>/src. Not seen: a None tier reached through a variable or
 * helper (`const t = SensitivityLevel.None; … sensitivity: t`) — the
 * typed write APIs and the egress canaries are the guard there.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FILES: string[] = [];
for (const top of ["packages", "apps"]) {
  for (const pkg of readdirSync(join(ROOT, top))) {
    const src = join(ROOT, top, pkg, "src");
    try {
      if (statSync(src).isDirectory()) sources(src, FILES);
    } catch {
      // no src/
    }
  }
}

const NONE = String.raw`(?:SensitivityLevel(?:Enum)?\.None|"none")`;
/** `sensitivity: NONE` or `sensitivity: <expr> ?? NONE` (a property). */
const PROPERTY_DEFAULT = new RegExp(String.raw`\bsensitivity\??:\s*(?:[^,;\n]*\?\?\s*)?${NONE}`);
/** `sensitivity: T = null | NONE | undefined` (a parameter or variable default). */
const PARAM_DEFAULT = new RegExp(
  String.raw`\bsensitivity\??:\s*[^=,;\n)]*=\s*(?:null|undefined|${NONE})\s*[,);]`,
);

/** Not writes: `file` + a line fragment, and why. */
const ALLOWED: Array<{ file: string; line: RegExp; why: string }> = [
  {
    file: "packages/ai-core/src/loop.ts",
    line: /^const DEFAULT_PROJECTION_CONTEXT|^\s*sensitivity: SensitivityLevel\.None,$/,
    why: "pixel-projection default context (read side; providerMode null = external, fail-closed)",
  },
  {
    file: "packages/ai-core/src/foreign-turn.ts",
    line: /sensitivity: SensitivityLevel\.None,/,
    why: "a foreign turn's session snapshot: the owner's tier is never shown to a foreign principal",
  },
  {
    file: "packages/panels/src/skills/registry-backed-adapter.ts",
    line: /manifest\.motebit\?\.sensitivity \?\? "none"/,
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/cli/src/subcommands/skills.ts",
    line: /manifest\.motebit\.sensitivity \?\? "none"/,
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/cli/src/slash-commands.ts",
    line: /dim\("sensitivity:"\)/,
    why: "display of a skill manifest's declared sensitivity",
  },
  {
    file: "apps/desktop/src/ui/chat.ts",
    line: /`Session sensitivity: \$\{/,
    why: "display of the session tier in a system message",
  },
  {
    file: "apps/mobile/src/slash-commands.ts",
    line: /`Session sensitivity: \$\{/,
    why: "display of the session tier in a system message",
  },
];

describe("write-tier gate: no write path defaults its sensitivity", () => {
  it(`scanned ${FILES.length} source files under packages/*/src and apps/*/src`, () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("no sensitivity property or parameter defaults to none / null outside the named read sites", () => {
    const bad: string[] = [];
    for (const path of FILES) {
      const rel = relative(ROOT, path);
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (!PROPERTY_DEFAULT.test(text) && !PARAM_DEFAULT.test(text)) return;
        if (ALLOWED.some((a) => a.file === rel && a.line.test(text))) return;
        bad.push(`${rel}:${i + 1}: ${text.trim()}`);
      });
    }
    expect(
      bad,
      `examined ${FILES.length} files. Repair: pass the tier the content was produced at — ` +
        `the run's \`outcomeSensitivity()\`, the turn's effective tier, ` +
        `\`runtime.goalCreationSensitivity()\`, or \`sessionlessGoalSensitivity()\` for owner-authored ` +
        `text written outside a session (@motebit/runtime goal-run.ts). A read / display site goes ` +
        `in ALLOWED with its reason.`,
    ).toEqual([]);
  });
});
