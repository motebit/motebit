#!/usr/bin/env tsx
/**
 * check-transparency-processors-canonical — closes the
 * services/relay/CLAUDE.md Rule 10 enforcement gap: every external
 * hostname the proxy or relay actually contacts at runtime MUST be
 * disclosed as a processor in `DECLARATION_CONTENT.third_party_processors`
 * (the source of truth that backs `services/relay/PRIVACY.md` + the
 * signed `/.well-known/motebit-transparency.json`).
 *
 * Pre-this-gate: Rule 10 is enforced only by code review. When proxy
 * routing for OpenAI + Google landed without the declaration moving,
 * the drift sat invisible until ChatGPT externally audited PRIVACY.md
 * on 2026-05-13. Witness: a third party caught a transparency lie
 * before any motebit gate did.
 *
 * The gate has three failure modes:
 *   1. Undeclared host — `services/{proxy,relay}/src/` contains
 *      `"https://X/..."` where X has no entry in HOSTNAME_TO_PROCESSOR.
 *      Action: add to gate map AND add a processor entry to the
 *      transparency declaration; regenerate PRIVACY.md.
 *   2. Missing processor — host has a map entry but the processor name
 *      does not appear in the declaration's `third_party_processors`.
 *      Action: add the processor entry to the declaration; regenerate
 *      PRIVACY.md.
 *   3. Stale gate map — gate names a host that no longer appears in
 *      code. Action: remove the map entry (and consider whether the
 *      declaration entry should follow it, or remain if the integration
 *      is feature-flag-dormant but legally still a potential processor).
 *
 * Same closed-registry / structural-lock shape as
 * `check-suite-declared` (#10), `check-audience-canonical` (#46),
 * `check-artifact-type-canonical` (#85), `check-state-export-signed`
 * (#86) — gate asks role questions (is host X disclosed as a
 * processor?), not instance questions.
 *
 * Scope: every .ts file under services/proxy/src and services/relay/src,
 * excluding `__tests__` (test fixtures contact arbitrary hosts).
 * Motebit-owned hosts (motebit.com, *.fly.dev, www.motebit.com,
 * motebit-embed.fly.dev) are skipped — they're operator infrastructure,
 * not third-party processors.
 *
 * Doctrine: services/relay/CLAUDE.md Rule 10; docs/doctrine/operator-transparency.md.
 *
 * Usage:
 *   tsx scripts/check-transparency-processors-canonical.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_DIRS = ["services/proxy/src", "services/relay/src"];

/**
 * Hosts owned by motebit operator infrastructure — not data-sharing
 * processors. Filtered out before drift analysis.
 */
const MOTEBIT_OWNED_HOSTS: ReadonlySet<string> = new Set([
  "motebit.com",
  "www.motebit.com",
  "relay.motebit.com",
  "motebit-embed.fly.dev",
]);

/**
 * Closed registry mapping external hostnames the proxy/relay
 * contacts to the processor names disclosed in
 * `DECLARATION_CONTENT.third_party_processors` (services/relay/src/transparency.ts).
 *
 * Adding a new external integration is a four-line change:
 *   1. Code adds `fetch("https://new.host/...")`.
 *   2. Add `"new.host"` here with the processor-name value.
 *   3. Add the processor entry to `DECLARATION_CONTENT`.
 *   4. Regenerate `services/relay/PRIVACY.md` from `renderMarkdown()`.
 *
 * The gate fires on omission of any step; CI catches the drift.
 */
const HOSTNAME_TO_PROCESSOR: Record<string, string> = {
  // AI inference (via services/proxy when motebit-cloud routes)
  "api.anthropic.com": "Anthropic",
  "api.openai.com": "OpenAI",
  "generativelanguage.googleapis.com": "Google (Generative Language API)",
  "api.groq.com": "Groq",

  // Mobile push (via services/relay push-adapter)
  "exp.host": "Expo Push Service",

  // Fiat payment processing
  "api.stripe.com": "Stripe",

  // Crypto facilitator + fiat off-ramp
  "x402.org": "x402 facilitator",
  "api.cdp.coinbase.com": "Coinbase Developer Platform (x402 production facilitator)",
  "api.bridge.xyz": "Bridge",

  // EVM JSON-RPC (multi-chain; one processor entry covers the role)
  "eth.llamarpc.com": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
  "mainnet.base.org": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
  "sepolia.base.org": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
  "mainnet.optimism.io": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
  "polygon-rpc.com": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",
  "arb1.arbitrum.io": "EVM JSON-RPC provider (Base mainnet, Coinbase-operated public endpoint)",

  // Solana RPC
  "api.mainnet-beta.solana.com": "Solana RPC provider",
};

const URL_LITERAL_PATTERN = /"https:\/\/([a-zA-Z0-9.-]+)(?:\/[^"\s]*)?"/g;

interface Finding {
  kind: "undeclared_host" | "missing_processor" | "stale_map";
  detail: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (st.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
      // Skip transparency.ts — it's the SOURCE OF TRUTH; its URL
      // literals are the processor DPA links, not runtime contacts.
      if (full.endsWith("/transparency.ts")) continue;
      out.push(full);
    }
  }
}

function collectHostsInCode(): Map<string, string[]> {
  const files: string[] = [];
  for (const rel of SCAN_DIRS) walk(resolve(REPO_ROOT, rel), files);

  const hostToFiles = new Map<string, Set<string>>();
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    URL_LITERAL_PATTERN.lastIndex = 0;
    for (const match of src.matchAll(URL_LITERAL_PATTERN)) {
      const host = match[1];
      if (MOTEBIT_OWNED_HOSTS.has(host)) continue;
      if (!hostToFiles.has(host)) hostToFiles.set(host, new Set());
      hostToFiles.get(host)!.add(relative(REPO_ROOT, file));
    }
  }
  // Convert to ordered map by host
  return new Map(
    [...hostToFiles].sort(([a], [b]) => a.localeCompare(b)).map(([h, s]) => [h, [...s].sort()]),
  );
}

function declaredProcessorNames(): { names: ReadonlySet<string>; sourceFile: string } {
  // Parse transparency.ts source for processor `name:` fields inside the
  // third_party_processors array. Source-walking instead of dynamic import
  // keeps this script independent of @motebit/encryption + @motebit/protocol
  // build artifacts at gate-run time.
  const sourceFile = "services/relay/src/transparency.ts";
  const src = readFileSync(resolve(REPO_ROOT, sourceFile), "utf-8");
  const startIdx = src.indexOf("third_party_processors:");
  if (startIdx === -1) {
    throw new Error(`${sourceFile}: third_party_processors block not found`);
  }
  // Find the closing bracket of the array.
  const arrStart = src.indexOf("[", startIdx);
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd === -1) {
    throw new Error(`${sourceFile}: third_party_processors array close not found`);
  }
  const arrSrc = src.slice(arrStart, arrEnd);

  const namePattern = /name:\s*"([^"]+)"/g;
  const names = new Set<string>();
  for (const m of arrSrc.matchAll(namePattern)) {
    names.add(m[1]);
  }
  return { names, sourceFile };
}

function main(): void {
  const codeHosts = collectHostsInCode();
  const { names: declaredNames, sourceFile } = declaredProcessorNames();

  const findings: Finding[] = [];

  // 1. Undeclared host: external host in code with no map entry.
  for (const [host, files] of codeHosts) {
    if (!(host in HOSTNAME_TO_PROCESSOR)) {
      findings.push({
        kind: "undeclared_host",
        detail: `"${host}" contacted from ${files.join(", ")}, but no HOSTNAME_TO_PROCESSOR entry in this gate. Add a mapping AND a processor entry to ${sourceFile} (the data-sharing relationship must be disclosed in PRIVACY.md / /.well-known/motebit-transparency.json).`,
      });
    }
  }

  // 2. Missing processor: host has a map entry, but the processor name
  //    is absent from DECLARATION_CONTENT.third_party_processors.
  for (const [host, files] of codeHosts) {
    const processor = HOSTNAME_TO_PROCESSOR[host];
    if (processor !== undefined && !declaredNames.has(processor)) {
      findings.push({
        kind: "missing_processor",
        detail: `"${host}" (mapped to processor "${processor}") contacted from ${files.join(", ")}, but "${processor}" is NOT in DECLARATION_CONTENT.third_party_processors. Add the processor entry to ${sourceFile} and regenerate services/relay/PRIVACY.md.`,
      });
    }
  }

  // 3. Stale map: gate names a host that no longer appears in code.
  for (const host of Object.keys(HOSTNAME_TO_PROCESSOR)) {
    if (!codeHosts.has(host)) {
      findings.push({
        kind: "stale_map",
        detail: `"${host}" is in HOSTNAME_TO_PROCESSOR but no code in ${SCAN_DIRS.join(", ")} contacts it. If the integration is deliberately retired, remove the gate entry AND consider whether the declaration's processor entry should also be removed (or kept if the integration is feature-flag-dormant but legally still a potential processor).`,
      });
    }
  }

  console.log(
    `check-transparency-processors-canonical — scanned ${SCAN_DIRS.length} source tree(s)\n` +
      `  ${codeHosts.size} unique external host(s) in code\n` +
      `  ${declaredNames.size} processor(s) named in ${sourceFile}\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every external host the proxy/relay contacts is mapped to a disclosed processor;\n` +
        `  every gate-map entry has a matching processor entry in the transparency declaration;\n` +
        `  no stale gate-map entries.`,
    );
    return;
  }

  console.log(`✗ Transparency-processor drift:\n`);
  const byKind = findings.reduce<Record<string, Finding[]>>((acc, f) => {
    (acc[f.kind] ??= []).push(f);
    return acc;
  }, {});
  for (const kind of ["undeclared_host", "missing_processor", "stale_map"] as const) {
    const group = byKind[kind];
    if (!group || group.length === 0) continue;
    console.log(`  [${kind}] (${group.length})`);
    for (const f of group) console.log(`    - ${f.detail}`);
    console.log();
  }
  console.log(
    `  Doctrine: services/relay/CLAUDE.md Rule 10 ("any code change that adds a processor\n` +
      `  must update DECLARATION_CONTENT in the same PR"); docs/doctrine/operator-transparency.md.\n` +
      `  Regenerate PRIVACY.md after editing transparency.ts:\n` +
      `\n` +
      `    cd services/relay && pnpm exec tsx -e \\\n` +
      `      "import('./src/transparency.ts').then(({ renderMarkdown }) => process.stdout.write(renderMarkdown()))" \\\n` +
      `      > PRIVACY.md\n`,
  );
  process.exit(1);
}

main();
