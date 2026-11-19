#!/usr/bin/env tsx
/**
 * check-cli-operator-token-reader — the CLI reads the relay operator (master)
 * token in ONE module, and that module returns it only for the relay URL it
 * is bound to.
 *
 * The defect this locks behind: a credential sent to a party it was not
 * issued for. An operator token is one relay's master credential and names no
 * relay. The CLI read it in ten places (`--sync-token`, `MOTEBIT_API_TOKEN`,
 * `MOTEBIT_SYNC_TOKEN`) and sent it to whatever relay URL the invocation
 * resolved, so with relay A's token exported and the URL naming relay B, B
 * received A's master token. Every read now goes through
 * `operatorTokenFor(relayUrl, …)` in `apps/cli/src/relay-operator-token.ts`,
 * which returns the token only when the owner bound it to that URL
 * (`motebit relay bind-token`). A new direct read anywhere else re-opens the
 * door without failing a single test of the sites that exist today.
 *
 * Rules, over every non-test source file under `apps/cli/src`:
 *
 *   R1 Outside the two allowed files, no file mentions the token's sources —
 *      in code or in a string, never counting comments: the identifier
 *      `syncToken` (so `config.syncToken`, a destructured `{ syncToken }`, a
 *      parameter or a property of that name), and the text `syncToken`,
 *      `sync-token`, `MOTEBIT_API_TOKEN` or `MOTEBIT_SYNC_TOKEN` in any
 *      string, template or regex (so `config["syncToken"]` and
 *      `process.env["MOTEBIT_API_TOKEN"]`), or an identifier containing
 *      either variable name (`process.env.MOTEBIT_API_TOKEN`).
 *      Allowed, whole files: `relay-operator-token.ts` (the reader) and
 *      `args.ts` (the flag parser, the config type, the usage text). Nothing
 *      else — `subcommands/relay.ts` included.
 *   R2 `bindOperatorToken` (the one writer of the record) is named by exactly
 *      one file besides the module: `subcommands/relay-bind-token.ts`.
 *   R3 `resolveRelayApiToken` (the relay SERVER's own token resolver, which
 *      returns the value of `MOTEBIT_API_TOKEN`) is named only inside
 *      `subcommands/relay.ts`.
 *   R4 `@motebit/relay` is imported only by `subcommands/relay.ts`, so no
 *      other CLI file can reach the relay's own token resolver.
 *
 * What it cannot see: a file that passes the WHOLE `config` object or
 * `process.env` to a helper outside `apps/cli/src` that reads the token
 * there. `subcommands/relay.ts` does exactly that for the server role
 * (`resolveRelayApiToken` hands `env` to `resolveRelayAuthPosture`); no
 * sender does. That hole is covered by behaviour, not by this gate: the
 * subprocess tests (`apps/cli/src/__tests__/operator-token-daemons.test.ts`)
 * and the per-command tests go red, and
 * `scripts/tampers/cli-operator-token-per-relay.ts` keeps an entry that
 * records this gate staying green while they do.
 *
 * `--root <dir>` runs the same checks against another tree laid out like the
 * repo (the self-test plants broken shapes there).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const SCAN_DIR = "apps/cli/src";
const MODULE = "apps/cli/src/relay-operator-token.ts";
const ARGS = "apps/cli/src/args.ts";
const BIND_HANDLER = "apps/cli/src/subcommands/relay-bind-token.ts";
const RELAY_SERVER = "apps/cli/src/subcommands/relay.ts";

/** Whole files allowed to mention the token's sources (R1). */
const ALLOWED_READERS: readonly string[] = [MODULE, ARGS];

const FLAG_IDENTIFIER = "syncToken";
const VARIABLE_NAMES: readonly string[] = ["MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"];
/** Text that names a source when it appears inside a string, template or regex. */
const SOURCE_TEXT: readonly string[] = [FLAG_IDENTIFIER, "sync-token", ...VARIABLE_NAMES];

const BIND = "bindOperatorToken";
const SERVER_RESOLVER = "resolveRelayApiToken";
const RELAY_PACKAGE = "@motebit/relay";

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__fixtures__", "coverage"]);
const TEST_FILE = /\.(?:test|spec|probe)\.(?:ts|tsx|mts|cts)$/;
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;

const BLIND_SPOTS =
  "NOT CAUGHT: (1) a file that passes the whole `config` object or `process.env` to a helper outside apps/cli/src that reads the token there " +
  "(subcommands/relay.ts does this for the relay SERVER role; a sender doing it stays green here and is caught by the subprocess and per-command tests); " +
  "(2) a source name assembled at run time (string concatenation, a computed key built from parts); " +
  "(3) whether a caller of operatorTokenFor asks about the URL it then requests — that is the per-command tests' job; " +
  "(4) .js/.mjs sources and build output.";

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(abs, out);
    } else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) {
      out.push(abs);
    }
  }
}

export interface ScanResult {
  violations: string[];
  files: number;
  /** Allowed files that do mention a source. */
  allowedReaders: string[];
  /** Files besides the module that name `bindOperatorToken`. */
  bindImporters: string[];
}

function isTextNode(n: ts.Node): n is ts.Node & { text: string } {
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n) ||
    ts.isRegularExpressionLiteral(n) ||
    ts.isJsxText(n)
  );
}

export function scan(root: string): ScanResult {
  const violations: string[] = [];
  const files: string[] = [];
  walk(join(root, SCAN_DIR), files);
  const rel = (abs: string): string => relative(root, abs).split("\\").join("/");
  const allowedReaders = new Set<string>();
  const bindImporters = new Set<string>();

  if (!existsSync(join(root, MODULE))) {
    violations.push(`${MODULE} — the one reader of the operator token does not exist`);
  }

  for (const abs of files) {
    const file = rel(abs);
    const source = readFileSync(abs, "utf-8");
    const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true);
    const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const allowed = ALLOWED_READERS.includes(file);

    const visit = (n: ts.Node): void => {
      // ── R1: the token's sources ──
      let named: string | undefined;
      if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
        if (n.text === FLAG_IDENTIFIER) named = `the identifier \`${FLAG_IDENTIFIER}\``;
        else {
          const v = VARIABLE_NAMES.find((name) => n.text.includes(name));
          if (v !== undefined) named = `the identifier \`${n.text}\``;
        }
      } else if (isTextNode(n)) {
        // The raw source text of the literal: an escape cannot hide a name
        // the cooked text would spell, and the cooked text is checked too.
        const raw = n.getText(sf);
        const hit = SOURCE_TEXT.find((t) => n.text.includes(t) || raw.includes(t));
        if (hit !== undefined) named = `the text \`${hit}\` in a string`;
      }
      if (named !== undefined) {
        if (allowed) allowedReaders.add(file);
        else {
          violations.push(
            `${file}:${line(n)} — ${named}: only ${MODULE} reads the operator token's sources` +
              (file === RELAY_SERVER
                ? " (the relay server's own read passes `env` whole to resolveRelayAuthPosture and names no source)"
                : ""),
          );
        }
      }

      // ── R2: the one writer has one importer ──
      const spelled =
        ts.isIdentifier(n) || isTextNode(n) ? (n as ts.Node & { text: string }).text : undefined;
      if (spelled === BIND && file !== MODULE) {
        bindImporters.add(file);
        if (file !== BIND_HANDLER) {
          violations.push(
            `${file}:${line(n)} — names \`${BIND}\`: only ${BIND_HANDLER} may bind an operator token to a relay`,
          );
        }
      }

      // ── R3: the relay server's resolver stays in its file ──
      if (spelled === SERVER_RESOLVER && file !== RELAY_SERVER) {
        violations.push(
          `${file}:${line(n)} — names \`${SERVER_RESOLVER}\`: it returns the value of MOTEBIT_API_TOKEN and is for ${RELAY_SERVER} alone`,
        );
      }

      // ── R4: the relay package has one importer ──
      if (
        (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        (n.text === RELAY_PACKAGE || n.text.startsWith(`${RELAY_PACKAGE}/`)) &&
        file !== RELAY_SERVER
      ) {
        violations.push(
          `${file}:${line(n)} — names the module "${n.text}": only ${RELAY_SERVER} imports ${RELAY_PACKAGE} (it exports the relay's own token resolver)`,
        );
      }

      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  if (
    existsSync(join(root, MODULE)) &&
    !bindImporters.has(BIND_HANDLER) &&
    !violations.some((v) => v.includes(BIND))
  ) {
    violations.push(
      `${BIND_HANDLER} — does not name \`${BIND}\`: the record has exactly one writer and this file is its one caller`,
    );
  }

  return {
    violations,
    files: files.length,
    allowedReaders: [...allowedReaders].sort(),
    bindImporters: [...bindImporters].sort(),
  };
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root =
    i >= 0 && process.argv[i + 1] !== undefined ? resolve(process.argv[i + 1]!) : REPO_ROOT;
  const r = scan(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `${r.violations.length} finding(s): the CLI reads the relay operator token in one module only, and sends it only to the relay URL it is bound to`,
      canonical: `${MODULE} (operatorTokenFor, bearerHeaders, operatorTokenIsSet, ${BIND})`,
      fix: `replace the direct read with \`operatorTokenFor(<the relay URL you are about to request>, <the sources this site honours>, config)\` imported from ${MODULE}, send \`bearerHeaders(bound)\` (or \`bound.token\`) to \`bound.relayUrl\` only, and treat \`undefined\` as "no operator token set"; text that must name the flag or a variable is exported from ${MODULE} as a whole sentence`,
      sites: r.violations,
      doctrine:
        "docs/doctrine/security-boundaries.md (token binding: a credential is sent only to the party it was issued for)",
    });
  }
  process.stdout.write(
    `✓ check-cli-operator-token-reader: ${r.files} source file(s) scanned under ${SCAN_DIR}/ (tests excluded); ` +
      `${r.allowedReaders.length} allowed reader file(s) found (${r.allowedReaders.join(", ")}); ` +
      `${r.bindImporters.length} file(s) name ${BIND} besides the module (${r.bindImporters.join(", ")}); ` +
      `${SERVER_RESOLVER} and ${RELAY_PACKAGE} are named only in ${RELAY_SERVER}.\n  ${BLIND_SPOTS}\n`,
  );
}

main();
