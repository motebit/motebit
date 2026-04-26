#!/usr/bin/env tsx
/**
 * generate-llms-txt — regenerate llms.txt and llms-full.txt from the
 * fumadocs source tree.
 *
 * Why it exists:
 *
 *   The llms.txt convention is a public, LLM-readable site map. When the
 *   docs site grows or restructures, hand-maintained llms.txt files
 *   silently rot — pages get added, removed, or renumbered, and the
 *   index loses its claim to authority. (Verified: as of 2026-04-26 the
 *   committed llms.txt referenced developer/identity-crypto which
 *   doesn't exist, and was missing concepts/receipts, concepts/trust,
 *   concepts/federation, concepts/public-surface, and changelog.)
 *
 *   The doctrine is one canonical source per synchronization invariant.
 *   The page tree IS the canonical source for "what pages exist;" the
 *   index should derive from it, not duplicate it.
 *
 * What it emits:
 *
 *   - apps/docs/public/llms.txt — short index, one bullet per page,
 *     grouped by section per `meta.json` ordering.
 *   - apps/docs/public/llms-full.txt — same plus the full body of every
 *     page concatenated, with frontmatter stripped and JSX components
 *     left as text (LLMs read them fine; rendering is the docs site's
 *     job).
 *
 * Usage:
 *
 *   pnpm tsx scripts/generate-llms-txt.ts
 *
 * Wired into the docs build via apps/docs/package.json's `build` and
 * `dev` scripts so a `next build` produces a fresh index alongside the
 * static HTML.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DOCS_CONTENT_DIR = join(REPO_ROOT, "apps", "docs", "content", "docs");
const PUBLIC_DIR = join(REPO_ROOT, "apps", "docs", "public");
const SITE_BASE = "https://docs.motebit.com";

// ── Editorial preamble ──────────────────────────────────────────────────

const LLMS_PREAMBLE = `# Motebit

> Sovereign agent infrastructure. Persistent cryptographic identity that survives across devices, providers, and time. Trust accumulated through signed execution receipts. Governance enforced at the agent's boundary. Verifiable proof of what got done.

Motebit is the missing layer underneath today's agent protocols. MCP defines what an agent can do. A2A defines how agents talk. x402 and AP2 define how they pay. Motebit defines who the agent is, what it has done, and what it is allowed to do.

A motebit is a persistent, cryptographically-anchored, sovereign agent. The intelligence provider is pluggable. The identity — with its accumulated memory, trust, and governance — is the asset.

## Quick start

- \`npm create motebit\` generates a signed agent identity in 30 seconds
- \`@motebit/crypto\` signs and verifies any motebit artifact (identity files, receipts, credentials)
- \`motebit/identity@1.0\` is the open specification (Apache-2.0 licensed)
`;

const LLMS_FOOTER = `## Open specification

- [motebit/identity@1.0](https://github.com/motebit/motebit/blob/main/spec/identity-v1.md): the open specification for agent identity files. Apache-2.0.
- [motebit/execution-ledger@1.0](https://github.com/motebit/motebit/blob/main/spec/execution-ledger-v1.md): the signed-receipt ledger every motebit emits. Apache-2.0.
- [motebit/relay-federation@1.0](https://github.com/motebit/motebit/blob/main/spec/relay-federation-v1.md): bilateral peering between independent relays. Apache-2.0.
- All twenty-one specs are in [\`spec/\`](https://github.com/motebit/motebit/tree/main/spec).

## Published packages

- [\`create-motebit\`](https://www.npmjs.com/package/create-motebit) — scaffold a signed identity or runnable agent service. Apache-2.0.
- [\`@motebit/protocol\`](https://www.npmjs.com/package/@motebit/protocol) — types, semirings, routing primitives, crypto-suite registry. Apache-2.0.
- [\`@motebit/sdk\`](https://www.npmjs.com/package/@motebit/sdk) — developer contract; stable types, adapter interfaces. Apache-2.0.
- [\`@motebit/crypto\`](https://www.npmjs.com/package/@motebit/crypto) — sign and verify every motebit artifact. Cryptosuite-agile. Apache-2.0.
- [\`@motebit/verifier\`](https://www.npmjs.com/package/@motebit/verifier), [\`@motebit/verify\`](https://www.npmjs.com/package/@motebit/verify), [\`@motebit/crypto-{appattest,android-keystore,tpm,webauthn}\`](https://www.npmjs.com/org/motebit) — verification libraries. Apache-2.0. (Plus deprecated [\`@motebit/crypto-play-integrity\`](https://www.npmjs.com/package/@motebit/crypto-play-integrity) for one minor cycle.)
- [\`motebit\`](https://www.npmjs.com/package/motebit) — reference runtime and operator console. BSL-1.1, converging to Apache-2.0 four years after release.

## Optional

- [GitHub repository](https://github.com/motebit/motebit) — source, issues, discussions.
- [DROPLET.md](https://github.com/motebit/motebit/blob/main/DROPLET.md) — design thesis: the body derived from physics.
- [THE_SOVEREIGN_INTERIOR.md](https://github.com/motebit/motebit/blob/main/THE_SOVEREIGN_INTERIOR.md) — identity thesis.
- [THE_METABOLIC_PRINCIPLE.md](https://github.com/motebit/motebit/blob/main/THE_METABOLIC_PRINCIPLE.md) — build enzymes, absorb glucose.
`;

const LLMS_FULL_PREAMBLE = `# Motebit — full documentation

> Sovereign agent infrastructure. Persistent cryptographic identity, signed receipts, governance at the boundary. The intelligence is pluggable; the identity is the asset.

This file is the full text of every motebit documentation page, concatenated. It is auto-generated from the docs source tree on every build, so it always matches what the live site renders.

For the short index see [llms.txt](https://docs.motebit.com/llms.txt). For the spec, see [\`spec/\`](https://github.com/motebit/motebit/tree/main/spec).

`;

// ── Page model ──────────────────────────────────────────────────────────

interface PageEntry {
  /** URL path under the docs site, e.g. "/docs/concepts/identity". */
  readonly url: string;
  /** Page title from frontmatter. */
  readonly title: string;
  /** Page description from frontmatter (one-line). */
  readonly description: string;
  /** Body of the page with frontmatter stripped. */
  readonly body: string;
}

interface MetaFile {
  readonly title?: string;
  readonly pages: ReadonlyArray<string>;
}

/**
 * Parse YAML frontmatter (just title + description for our purposes).
 * Returns { title, description, body } where body is the post-
 * frontmatter content. Tolerant: a page without frontmatter still
 * works, with derived defaults.
 */
function parseFrontmatter(
  slug: string,
  raw: string,
): {
  title: string;
  description: string;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return {
      title: slug,
      description: "",
      body: raw,
    };
  }
  const front = match[1]!;
  const body = match[2]!;
  const titleMatch = front.match(/^title:\s*(.+)$/m);
  const descMatch = front.match(/^description:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim().replace(/^["']|["']$/g, "") : slug;
  const description = descMatch ? descMatch[1]!.trim().replace(/^["']|["']$/g, "") : "";
  return { title, description, body };
}

/**
 * Read meta.json from a directory. Returns null if absent.
 */
function readMeta(dir: string): MetaFile | null {
  const path = join(dir, "meta.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MetaFile;
  } catch {
    return null;
  }
}

/**
 * Walk a directory tree, returning a per-directory map of slug → page.
 */
function loadPages(dir: string, urlPrefix: string): Map<string, PageEntry> {
  const out = new Map<string, PageEntry>();
  for (const entry of readdirSync(dir)) {
    if (entry === "meta.json") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) continue;
    if (!entry.endsWith(".mdx")) continue;
    const slug = entry.replace(/\.mdx$/, "");
    const raw = readFileSync(full, "utf-8");
    const { title, description, body } = parseFrontmatter(slug, raw);
    out.set(slug, {
      url: `${urlPrefix}/${slug}`,
      title,
      description,
      body,
    });
  }
  return out;
}

interface Section {
  /** Section header, e.g. "Concepts", or null for top-level pages. */
  readonly heading: string | null;
  readonly pages: PageEntry[];
}

/**
 * Resolve the meta.json `pages` array into ordered sections.
 *
 * Conventions used by motebit's meta.json:
 *   - "..." prefix on a slug means "expand this subdirectory's pages
 *     in their own meta.json order"
 *   - "---Heading---" entries become section headings
 *   - Anything else is a page slug at the current level
 */
function resolveSections(rootDir: string, urlPrefix: string): Section[] {
  const meta = readMeta(rootDir);
  const rootPages = loadPages(rootDir, urlPrefix);
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentPages: PageEntry[] = [];

  const flush = () => {
    if (currentPages.length > 0) {
      sections.push({ heading: currentHeading, pages: currentPages });
      currentPages = [];
    }
  };

  if (!meta) {
    // No meta.json — emit pages in filesystem order under a single anonymous section.
    return [{ heading: null, pages: [...rootPages.values()] }];
  }

  for (const entry of meta.pages) {
    if (entry.startsWith("---") && entry.endsWith("---")) {
      flush();
      currentHeading = entry.slice(3, -3).trim();
      continue;
    }
    if (entry.startsWith("...")) {
      const subdir = entry.slice(3);
      const subdirPath = join(rootDir, subdir);
      const subUrlPrefix = `${urlPrefix}/${subdir}`;
      const subMeta = readMeta(subdirPath);
      const subPages = loadPages(subdirPath, subUrlPrefix);
      if (subMeta) {
        for (const subSlug of subMeta.pages) {
          const page = subPages.get(subSlug);
          if (page) currentPages.push(page);
        }
      } else {
        currentPages.push(...subPages.values());
      }
      continue;
    }
    const page = rootPages.get(entry);
    if (page) currentPages.push(page);
  }
  flush();
  return sections;
}

// ── Emit ────────────────────────────────────────────────────────────────

function makeAbsoluteUrl(url: string): string {
  return `${SITE_BASE}${url}`;
}

function emitLlmsTxt(sections: Section[]): string {
  const lines: string[] = [LLMS_PREAMBLE];
  for (const section of sections) {
    if (section.heading) {
      lines.push(`## ${section.heading}\n`);
    }
    for (const page of section.pages) {
      const desc = page.description ? `: ${page.description}` : "";
      lines.push(`- [${page.title}](${makeAbsoluteUrl(page.url)})${desc}`);
    }
    lines.push("");
  }
  lines.push(LLMS_FOOTER);
  return lines.join("\n");
}

function emitLlmsFullTxt(sections: Section[]): string {
  const lines: string[] = [LLMS_FULL_PREAMBLE];
  for (const section of sections) {
    if (section.heading) {
      lines.push(`---\n\n# ${section.heading}\n`);
    }
    for (const page of section.pages) {
      lines.push(`---\n`);
      lines.push(`# ${page.title}`);
      lines.push(`Source: ${makeAbsoluteUrl(page.url)}`);
      if (page.description) lines.push(`\n> ${page.description}`);
      lines.push("");
      lines.push(page.body.trim());
      lines.push("");
    }
  }
  return lines.join("\n");
}

function main(): void {
  const sections = resolveSections(DOCS_CONTENT_DIR, "/docs");
  const llmsTxt = emitLlmsTxt(sections);
  const llmsFullTxt = emitLlmsFullTxt(sections);

  writeFileSync(join(PUBLIC_DIR, "llms.txt"), llmsTxt);
  writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt);

  const totalPages = sections.reduce((acc, s) => acc + s.pages.length, 0);
  console.log(
    `generate-llms-txt: emitted ${totalPages} page(s) across ${sections.length} section(s) →`,
  );
  console.log(`  ${relative(REPO_ROOT, join(PUBLIC_DIR, "llms.txt"))} (${llmsTxt.length} bytes)`);
  console.log(
    `  ${relative(REPO_ROOT, join(PUBLIC_DIR, "llms-full.txt"))} (${llmsFullTxt.length} bytes)`,
  );
}

main();
