#!/usr/bin/env tsx
/**
 * Surface-controller adoption gate.
 *
 * Surface controllers that have been extracted to `@motebit/surface-kit`
 * (state + actions shared across flat surfaces) MUST be consumed from the
 * package by every adopting surface — never re-forked locally. Before the
 * extraction these controllers existed as per-surface copies that drifted
 * (`MobileMcpManager` / `SpatialMcpManager`: identical lifecycle, different
 * storage + naming). This gate is the synchronization-invariant defense that
 * keeps them from re-forking: each adopting surface's controller file must
 * import the canonical class from `@motebit/surface-kit` and stay a THIN
 * adapter (inject platform ports, no re-declared logic).
 *
 * Adding a controller to the package, or a surface to its adopters, is one
 * entry in ADOPTIONS below — the registry update is the discipline trigger.
 *
 * Out of scope (documented forks, not silent ones): the desktop MCP manager
 * is the stdio superset and is reconciled in a follow-up; CLI has no MCP
 * manager. They are absent from ADOPTIONS by intent, not omission.
 *
 * When to add a controller here vs. leave it per-surface: the four-question
 * extraction test in `docs/doctrine/surface-controller-extraction.md`.
 *
 * "Consumes" is read from the syntax tree, never from the text (#800
 * follow-up): the file must carry a VALUE import of the named symbol from
 * `@motebit/surface-kit` (`import type` does not count), and must reference
 * that binding outside import/export declarations. A controller name that
 * only appears in a comment, a string, an import from anywhere else, or an
 * unused import beside a local fork is not an adoption. The earlier textual
 * check passed a CLI adapter swapped to a local fork of `MachineRoster`
 * because the word stayed in three comments.
 *
 * And a reference is read through the type checker, never by its text
 * (#805): it must be a VALUE-position identifier that resolves to the import
 * binding's own symbol. `typeof X` in a type, a property named `X`, and a
 * parameter or local that shadows `X` all carry the text and none is a use —
 * the textual visitor passed a local fork beside `type _Keep = typeof X` on
 * every adapter. The residue is honest: a deliberate dead reference
 * (`void X;`) beside a fork is still a value use and still passes; the
 * line ceiling below is the other half of this gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { formatRepair } from "./lib/gate-report.js";

const ROOT = join(import.meta.dirname, "..");

interface Adoption {
  /** The canonical export in @motebit/surface-kit. */
  controller: string;
  /** Surface controller files that must consume it (relative to repo root). */
  files: string[];
  /** Thin-adapter line ceiling — a re-forked implementation blows past this. */
  maxLines: number;
}

const ADOPTIONS: readonly Adoption[] = [
  {
    controller: "McpManager",
    files: ["apps/mobile/src/mcp-manager.ts", "apps/spatial/src/mcp-manager.ts"],
    maxLines: 60,
  },
  {
    // Key rotation (#709): four surfaces each re-forked the same state machine
    // and three got the ordering wrong the same way. The CLI keeps its own
    // richer adapter (identity file + config reconciliation, apps/cli/src/
    // rotation.ts); these three are thin: ports over the platform's keystore.
    controller: "rotateOrThrow",
    files: [
      "apps/web/src/key-rotation.ts",
      "apps/mobile/src/key-rotation.ts",
      "apps/desktop/src/key-rotation.ts",
    ],
    maxLines: 130,
  },
  {
    // The CLI is the fourth adapter of the same controller: its ports carry a
    // passphrase-encrypted config key, motebit.md as the published witness,
    // and an encrypted write-ahead file. Ceiling is higher because the CLI
    // keeps its own outcome vocabulary for the terminal, mapped from the kit's.
    controller: "performKeyRotation",
    files: ["apps/cli/src/rotation.ts"],
    maxLines: 260,
  },
  {
    // Machine roster, part C (docs/proposals/machine-roster-clients-v1.md
    // C2): the chain acquisition, the C3 status table, retire/enroll,
    // presentation and set-pinning live in the kit. The CLI adapter carries
    // the ports (device-token fetches, identity-file record sources), the
    // terminal wording of outcomes, and the two doors (mint-on-announce,
    // the rotation hook); its replica file is `machine-roster-file.ts`.
    // Mobile / desktop / web adopt in C-2.
    controller: "MachineRoster",
    files: ["apps/cli/src/machine-roster.ts"],
    maxLines: 360,
  },
  {
    // Machine roster C-2 (docs/proposals/machine-roster-surfaces-v1.md S6):
    // the held-key gate, the non-host rules and the Settings section state
    // holder live in the kit (`createMachineRosterSection` over
    // `MachineRoster.gated`). The web adapter carries the ports (device-token
    // fetches, Retry-After), the Web Locks (mint lock + presentation leader),
    // the cadence store wiring and the two custody doors; its IndexedDB
    // replica is `machine-roster-store.ts`, its render `ui/machines-section.ts`.
    // Mobile (C-2b) carries the same ports over SecureStore + the stored
    // motebit.md, in-process save/exclusive chains, and no leader lock (one
    // JS process); its AsyncStorage replica is `machine-roster-store.ts`, its
    // render model `machines-render-model.ts`. Desktop (C-2c) carries them
    // over its own key store (dev-keyring.json) and the config's motebit.md,
    // with a Rust-backed compare-and-swap replica file and a lease for
    // `exclusive` (`machine-roster-store.ts`, `src-tauri/src/roster_replica.rs`);
    // its render model is `machines-render-model.ts`.
    controller: "createMachineRosterSection",
    files: [
      "apps/web/src/machine-roster.ts",
      "apps/mobile/src/machine-roster.ts",
      "apps/desktop/src/machine-roster.ts",
    ],
    maxLines: 360,
  },
];

const PACKAGE = "@motebit/surface-kit";

interface Consumption {
  /** The local binding of a value import of `controller` from the package, or null. */
  localName: string | null;
  /**
   * Value-position references that RESOLVE to that import binding, outside
   * import/export declarations.
   */
  references: number;
}

/**
 * One Program over exactly the given sources, served from memory by a minimal
 * compiler host. `noResolve` + `noLib` keep it to those texts alone (no import
 * graph, no lib.d.ts, no disk reads): name resolution inside a file is all
 * this gate needs, and it stays pre-push fast.
 */
function adapterProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    noResolve: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = sources.get(fileName);
      if (text === undefined) return undefined;
      const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      return ts.createSourceFile(fileName, text, languageVersion, true, kind);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => sources.has(f),
    readFile: (f) => sources.get(f),
  };
  return ts.createProgram({ rootNames: [...sources.keys()], options, host });
}

/**
 * True when `node` sits in a position the compiler erases: inside any type
 * node (`typeof X`, `X<T>` as a type, `implements X`, a type annotation), an
 * interface or type alias, or an ambient (`declare`) declaration. The one
 * TypeNode kind that is NOT erased is `ExpressionWithTypeArguments` in a
 * class's `extends` clause (a runtime superclass) or as an instantiation
 * expression; `ts.isPartOfTypeNode` alone is not enough, because it reports
 * the operand of `typeof X` as a value reference.
 */
function isErasedPosition(node: ts.Node): boolean {
  for (let cur: ts.Node = node.parent; cur != null; cur = cur.parent) {
    if (ts.isSourceFile(cur)) return false;
    if (ts.isExpressionWithTypeArguments(cur)) {
      const clause = cur.parent;
      if (ts.isHeritageClause(clause)) {
        const runtimeSuper =
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent));
        if (!runtimeSuper) return true;
      }
      continue;
    }
    if (ts.isTypeNode(cur)) return true;
    if (ts.isInterfaceDeclaration(cur) || ts.isTypeAliasDeclaration(cur)) return true;
    if (
      ts.canHaveModifiers(cur) &&
      (ts.getCombinedModifierFlags(cur as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0
    )
      return true;
  }
  return false;
}

/**
 * Read, through the type checker, whether `sf` imports `controller` (as a
 * value) from `@motebit/surface-kit` and references THAT binding in a value
 * position. A reference counts only when `getSymbolAtLocation` resolves it to
 * the import specifier's own symbol: an identifier that merely has the same
 * text — a property name (`{ X: 1 }`, `o.X`), a shadowing parameter or local,
 * a type-position `typeof X` — resolves elsewhere or is erased, and never
 * counts. Comments and strings are not syntax, so they can never count.
 */
function consumption(sf: ts.SourceFile, checker: ts.TypeChecker, controller: string): Consumption {
  let binding: ts.Identifier | null = null;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== PACKAGE)
      continue;
    const clause = stmt.importClause;
    if (clause == null || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named == null || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      if ((el.propertyName ?? el.name).text === controller) binding = el.name;
    }
  }
  if (binding == null) return { localName: null, references: 0 };
  const localName = binding.text;
  const importSymbol = checker.getSymbolAtLocation(binding);
  if (importSymbol == null) return { localName, references: 0 };

  let references = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node))
      return;
    if (ts.isIdentifier(node) && node.text === localName && !isErasedPosition(node)) {
      const sym =
        ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
      if (sym === importSymbol) references++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { localName, references };
}

export interface AdapterSource {
  /** Repo-relative path (a key; never read from disk here). */
  path: string;
  text: string;
  /** The canonical export this file must consume. */
  controller: string;
}

/**
 * Analyze every adapter in ONE Program (one checker, one pass), from memory.
 * Exported so the tamper tests can drive it without touching the tree.
 */
export function analyzeConsumption(inputs: readonly AdapterSource[]): Consumption[] {
  const program = adapterProgram(new Map(inputs.map((i) => [i.path, i.text])));
  const checker = program.getTypeChecker();
  return inputs.map((i) => {
    const sf = program.getSourceFile(i.path);
    if (sf == null) throw new Error(`adapter program lost ${i.path}`);
    return consumption(sf, checker, i.controller);
  });
}

function main(): void {
  const sites: string[] = [];
  const inputs: (AdapterSource & { maxLines: number })[] = [];
  for (const adoption of ADOPTIONS) {
    for (const rel of adoption.files) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) {
        sites.push(`${rel}: missing — expected a thin ${adoption.controller} adapter here.`);
        continue;
      }
      inputs.push({
        path: rel,
        text: readFileSync(abs, "utf8"),
        controller: adoption.controller,
        maxLines: adoption.maxLines,
      });
    }
  }
  const filesParsed = inputs.length;
  const results = analyzeConsumption(inputs);

  inputs.forEach((input, idx) => {
    const { path: rel, text: src, controller, maxLines } = input;
    const c = results[idx]!;

    // 1. Must import the canonical controller from the package, as a value,
    //    and reference that binding in a value position — resolved by the
    //    type checker, never matched by text.
    if (c.localName == null) {
      sites.push(
        `${rel}: no value import of { ${controller} } from "${PACKAGE}" ` +
          `(a comment, a string, a type-only import, or an import from elsewhere does not count).`,
      );
    } else if (c.references === 0) {
      sites.push(
        `${rel}: imports { ${controller} } from "${PACKAGE}" but never uses it as a value ` +
          `(an unused import, or one referenced only in a type, a property name, or under a ` +
          `shadowing binding, beside a local fork is a re-fork).`,
      );
    }

    // 2. Must stay a thin adapter — a re-implemented controller grows past the
    //    ceiling (the extracted core is ~250 lines; an adapter is ~40).
    const lineCount = src.split("\n").length;
    if (lineCount > maxLines) {
      sites.push(
        `${rel}: ${lineCount} lines exceeds the thin-adapter ceiling (${maxLines}). ` +
          `If logic is creeping back into the surface, push it into ${PACKAGE} instead.`,
      );
    }
  });

  const fileCount = ADOPTIONS.reduce((n, a) => n + a.files.length, 0);

  if (sites.length > 0) {
    process.stderr.write(
      formatRepair({
        invariant:
          "Surface-controller adoption check failed — a surface re-forks an extracted controller.",
        sites,
        canonical:
          "packages/surface-kit/src/index.ts (the controllers) and the ADOPTIONS registry in scripts/check-surface-controller-adoption.ts",
        fix:
          `import the named controller as a value from "${PACKAGE}" and call it from the adapter; ` +
          "delete any local copy, and move logic that grew the adapter past its ceiling into @motebit/surface-kit.",
        doctrine: "docs/doctrine/surface-controller-extraction.md",
      }),
    );
    console.error(
      `${ADOPTIONS.length} controller(s) checked across ${fileCount} surface file(s) (${filesParsed} parsed).`,
    );
    process.exit(1);
  }

  console.log(
    `Surface-controller adoption check passed — ${ADOPTIONS.length} controller(s) imported from ${PACKAGE} and referenced as a value, across ${filesParsed} of ${fileCount} surface file(s) parsed.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
