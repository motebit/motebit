/**
 * The seed-backup date proof (`legacyAckCoversCurrentKey` in seed-backup.ts)
 * reads an identity file's signed `created_at` as the time the file was
 * SIGNED. spec/identity-v1.md §3.1 defines it as the identity's creation
 * time; the proof is sound only while every writer in this repo stamps it
 * at write time. These tests pin that: a writer that starts preserving a
 * genesis `created_at` goes red here.
 *
 *   - `@motebit/identity-file` `generate` stamps "now" when no `createdAt`
 *     is given (behaviour);
 *   - no production caller of `generate` passes `createdAt` (a scan of every
 *     non-test source file under apps/, packages/ and services/ — the CLI's
 *     export, the desktop, web and mobile surfaces, the MCP server, …);
 *   - create-motebit's own writers are pinned by
 *     packages/create-motebit/src/__tests__/created-at-write-time.test.ts.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { generate, parse } from "@motebit/identity-file";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("identity-file generate stamps created_at at write time", () => {
  it("no createdAt given ⇒ created_at is the signing time, as a full zoned timestamp", async () => {
    const kp = await generateKeypair();
    const before = Date.now();
    const content = await generate(
      { motebitId: "m", ownerId: "o", publicKeyHex: bytesToHex(kp.publicKey) },
      kp.privateKey,
    );
    const after = Date.now();
    const createdAt = parse(content).frontmatter.created_at;
    expect(createdAt).toMatch(/Z$/);
    const ms = Date.parse(createdAt);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

/** Every non-test .ts/.tsx source file under the given roots. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "__tests__") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const top of ["apps", "packages", "services"]) {
    const base = path.join(REPO, top);
    for (const pkg of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      walk(path.join(base, pkg, "src"));
    }
  }
  return out;
}

/** The local names `@motebit/identity-file`'s `generate` is bound to in `src`. */
function generateAliases(src: string): string[] {
  const names = new Set<string>();
  const importRe = /import\s*\{([^{}]*)\}\s*from\s*["']@motebit\/identity-file["']/g;
  const dynRe = /\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']@motebit\/identity-file["']\s*\)/g;
  for (const re of [importRe, dynRe]) {
    for (const m of src.matchAll(re)) {
      for (const part of m[1]!.split(",")) {
        const p = part.trim();
        const asImport = /^generate\s+as\s+(\w+)$/.exec(p);
        const asDestructure = /^generate\s*:\s*(\w+)$/.exec(p);
        if (p === "generate") names.add("generate");
        else if (asImport) names.add(asImport[1]!);
        else if (asDestructure) names.add(asDestructure[1]!);
      }
    }
  }
  return [...names];
}

/** The argument text of every call `name(...)` in `src` (balanced parentheses). */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe("no production writer preserves a genesis created_at", () => {
  it("no call of identity-file generate passes createdAt", () => {
    const calls: { file: string; args: string }[] = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, "utf-8");
      if (!src.includes("@motebit/identity-file")) continue;
      for (const alias of generateAliases(src)) {
        for (const args of callArguments(src, alias)) {
          calls.push({ file: path.relative(REPO, file), args });
        }
      }
    }
    // Aperture: the scan must see the writers it exists for.
    const files = new Set(calls.map((c) => c.file));
    expect(files).toContain(path.join("apps", "cli", "src", "subcommands", "export.ts"));
    expect(files).toContain(path.join("apps", "desktop", "src", "identity-manager.ts"));
    expect(files).toContain(path.join("apps", "web", "src", "web-app.ts"));
    expect(files).toContain(path.join("apps", "mobile", "src", "mobile-app.ts"));
    const preserving = calls.filter((c) => /\bcreatedAt\b/.test(c.args)).map((c) => c.file);
    expect(preserving).toEqual([]);
  });
});
