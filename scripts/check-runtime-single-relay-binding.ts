#!/usr/bin/env tsx
/**
 * check-runtime-single-relay-binding — the runtime holds ONE delegation
 * relay binding, and nothing else in its delegation paths holds a relay URL,
 * token source or relay key of its own.
 *
 * The defect this locks behind (design runtime-relay-binding rev 6, part
 * 4a): the relay a runtime delegated to lived in five places that rebound
 * differently — the delegation tools' closures (captured from
 * `enableInteractiveDelegation(config)`) and the credential submitter, the
 * task-query coordinates, the granted-spend coordinates, the tap manager's
 * config, and a capabilities fetcher built over a surface's bootstrap URL —
 * so after a relay switch or a Disconnect some calls still reached the old
 * relay. Now `MotebitRuntime._relayBinding` is the one holder; the managers
 * hold an accessor; every call reads one snapshot. A new holder anywhere in
 * the shape main used re-opens the class without failing any existing test.
 *
 * Rules. "Relay members" are members named syncUrl, relayUrl, baseUrl,
 * discoveryUrl, relayPublicKey, relayPublicKeyHex or authToken, read from a
 * type through the TypeScript checker (so through aliases, Pick<>,
 * intersections and mapped types); a union is read member by member and
 * null / undefined are dropped. Arrays, tuples, records and maps are NOT
 * entered (their element types are not this rule's business), and a type
 * the checker cannot resolve (an import from another package — the program
 * is confined to packages/runtime/src) reads as having no members.
 *
 *   T1 Types: `InteractiveDelegationConfig`, `InvokeCapabilityConfig` (when
 *      declared), `RelayCapabilitiesFetcherConfig`, every constructor
 *      parameter of `InteractiveDelegationManager` / `InvokeCapabilityManager`,
 *      and every parameter of every method of those two classes, carry no
 *      relay member. Method parameters are checked too so that a config type
 *      deleted or renamed cannot make the rule vacuous: main's shape —
 *      `enable(config)` whose closures capture `config.syncUrl` — is caught
 *      under any type name.
 *   T2 Stored values: no class property (including constructor parameter
 *      properties) and no module-level variable in
 *      packages/runtime/src/{motebit-runtime,interactive-delegation,
 *      invoke-capability}.ts has a type with a relay member — except the
 *      binding field `MotebitRuntime._relayBinding` itself.
 *   T3 Removed names: no `.ts`/`.tsx`/`.mts`/`.cts` file in the repository
 *      (tests included; node_modules, build output and dot-directories are
 *      not source) calls `enableInteractiveDelegation`,
 *      `disableInteractiveDelegation` or `enableInvokeCapability` — as
 *      `x.name(…)`, `x["name"](…)` or `name(…)`. Strings and comments that
 *      only mention them do not count.
 *   T4 Presence: both manager classes and their constructors exist, the
 *      binding field exists, and `RelayCapabilitiesFetcherConfig` exists — a
 *      deleted or renamed holder cannot pass by being absent.
 *
 * `--root <dir>` runs the same checks against another tree laid out like the
 * repo (the self-test plants broken shapes there).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const RUNTIME_SRC = "packages/runtime/src";
const RELAY_MEMBERS: ReadonlySet<string> = new Set([
  "syncUrl",
  "relayUrl",
  "baseUrl",
  "discoveryUrl",
  "relayPublicKey",
  "relayPublicKeyHex",
  "authToken",
]);
const STORED_FILES = ["motebit-runtime.ts", "interactive-delegation.ts", "invoke-capability.ts"];
const CONFIG_TYPES: ReadonlyArray<{ file: string; name: string; required: boolean }> = [
  { file: "interactive-delegation.ts", name: "InteractiveDelegationConfig", required: false },
  { file: "invoke-capability.ts", name: "InvokeCapabilityConfig", required: false },
  {
    file: "hardware-attestation-fetcher.ts",
    name: "RelayCapabilitiesFetcherConfig",
    required: true,
  },
];
const MANAGERS: ReadonlyArray<{ file: string; cls: string }> = [
  { file: "interactive-delegation.ts", cls: "InteractiveDelegationManager" },
  { file: "invoke-capability.ts", cls: "InvokeCapabilityManager" },
];
const BINDING_FIELD = { file: "motebit-runtime.ts", cls: "MotebitRuntime", name: "_relayBinding" };
const REMOVED_NAMES: ReadonlySet<string> = new Set([
  "enableInteractiveDelegation",
  "disableInteractiveDelegation",
  "enableInvokeCapability",
]);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const NOT_SOURCE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "src-tauri",
  "playwright-report",
  "test-results",
]);

const BLIND_SPOTS =
  "NOT CAUGHT: (1) a value typed `any` / `unknown`, or typed by another package's type (the type program is confined to packages/runtime/src, so such types read as having no members); " +
  "(2) a holder in any OTHER runtime file, or a relay member under another name; " +
  "(3) a closure that captures a relay from somewhere other than a manager-method parameter (the managers are checked by type, not by data flow); " +
  "(4) a surface that forgets to call unbindRelay on Disconnect — held by the surface tests (apps/{web,desktop}/src/__tests__/relay-binding-switch.test.ts, apps/mobile/src/__tests__/relay-binding-attempt.test.ts); " +
  "(5) a removed-API call assembled at run time (a computed member from parts), and .js sources.";

export interface ScanResult {
  violations: string[];
  /** Typed declarations T2 read (properties + module variables). */
  storedChecked: number;
  /** Types and parameters T1 read. */
  typesChecked: number;
  /** Files T3 parsed for removed-name calls. */
  removedNameFiles: number;
}

function relayMembersOf(type: ts.Type, checker: ts.TypeChecker): string[] {
  const flags = type.flags;
  if (
    flags &
    (ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.Never)
  ) {
    return [];
  }
  if (type.isUnion()) {
    return [...new Set(type.types.flatMap((t) => relayMembersOf(t, checker)))];
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) return [];
  return checker
    .getPropertiesOfType(type)
    .map((p) => p.getName())
    .filter((n) => RELAY_MEMBERS.has(n));
}

/** A program over the runtime's files only; other packages read as unresolved. */
function runtimeProgram(root: string): ts.Program {
  const srcDir = join(root, RUNTIME_SRC);
  const libDir = dirname(ts.getDefaultLibFilePath({}));
  const inScope = (f: string): boolean => {
    const abs = resolve(f);
    return abs.startsWith(resolve(srcDir) + "/") || abs.startsWith(libDir + "/");
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options, true);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => inScope(f) && fileExists(f);
  host.readFile = (f) => (inScope(f) ? readFile(f) : undefined);
  host.getSourceFile = (f, lang, onError, create) =>
    inScope(f) ? getSourceFile(f, lang, onError, create) : undefined;
  host.directoryExists = (d) => existsSync(d);
  const roots = [...STORED_FILES, "hardware-attestation-fetcher.ts"]
    .map((f) => join(srcDir, f))
    .filter((f) => existsSync(f));
  return ts.createProgram(roots, options, host);
}

function findClass(sf: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name?.text === name) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function findTypeDecl(
  sf: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  for (const s of sf.statements) {
    if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === name) {
      return s;
    }
  }
  return undefined;
}

function checkTypesAndStored(
  root: string,
  violations: string[],
): { types: number; stored: number } {
  const program = runtimeProgram(root);
  const checker = program.getTypeChecker();
  const at = (sf: ts.SourceFile, n: ts.Node): string =>
    `${relative(root, sf.fileName).split("\\").join("/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const srcFile = (f: string): ts.SourceFile | undefined =>
    program.getSourceFile(join(root, RUNTIME_SRC, f));
  let types = 0;
  let stored = 0;

  // ── T1 named config types, T4 presence of the fetcher config ──
  for (const c of CONFIG_TYPES) {
    const sf = srcFile(c.file);
    const decl = sf ? findTypeDecl(sf, c.name) : undefined;
    if (sf == null || decl == null) {
      if (c.required) {
        violations.push(`${RUNTIME_SRC}/${c.file} — \`${c.name}\` is missing (T4 presence)`);
      }
      continue;
    }
    types++;
    const found = relayMembersOf(checker.getTypeAtLocation(decl.name), checker);
    if (found.length > 0) {
      violations.push(
        `${at(sf, decl)} — T1: \`${c.name}\` has relay member(s) ${found.join(", ")}`,
      );
    }
  }

  // ── T1 manager constructors + method parameters, T4 presence ──
  for (const m of MANAGERS) {
    const sf = srcFile(m.file);
    const cls = sf ? findClass(sf, m.cls) : undefined;
    if (sf == null || cls == null) {
      violations.push(`${RUNTIME_SRC}/${m.file} — class \`${m.cls}\` is missing (T4 presence)`);
      continue;
    }
    if (!cls.members.some(ts.isConstructorDeclaration)) {
      violations.push(`${at(sf, cls)} — \`${m.cls}\` has no constructor (T4 presence)`);
    }
    for (const member of cls.members) {
      if (
        !ts.isConstructorDeclaration(member) &&
        !ts.isMethodDeclaration(member) &&
        !ts.isSetAccessorDeclaration(member)
      ) {
        continue;
      }
      const what = ts.isConstructorDeclaration(member)
        ? "constructor"
        : `method ${member.name.getText(sf)}`;
      for (const p of member.parameters) {
        types++;
        const found = relayMembersOf(checker.getTypeAtLocation(p), checker);
        if (found.length > 0) {
          violations.push(
            `${at(sf, p)} — T1: ${m.cls} ${what} parameter \`${p.name.getText(sf)}\` has relay member(s) ${found.join(", ")}`,
          );
        }
      }
    }
  }

  // ── T2 stored values, T4 presence of the binding field ──
  let bindingFieldSeen = false;
  for (const f of STORED_FILES) {
    const sf = srcFile(f);
    if (sf == null) {
      violations.push(`${RUNTIME_SRC}/${f} — missing (T2 cannot read it)`);
      continue;
    }
    const checkDecl = (owner: string, name: string, node: ts.Node, typeNode: ts.Node): void => {
      stored++;
      if (f === BINDING_FIELD.file && owner === BINDING_FIELD.cls && name === BINDING_FIELD.name) {
        bindingFieldSeen = true;
        return;
      }
      const found = relayMembersOf(checker.getTypeAtLocation(typeNode), checker);
      if (found.length > 0) {
        violations.push(
          `${at(sf, node)} — T2: ${owner === "" ? "module variable" : `${owner} property`} \`${name}\` holds relay member(s) ${found.join(", ")}`,
        );
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        const owner = n.name?.text ?? "<anonymous class>";
        for (const member of n.members) {
          if (ts.isPropertyDeclaration(member)) {
            checkDecl(owner, member.name.getText(sf), member, member.name);
          } else if (ts.isConstructorDeclaration(member)) {
            for (const p of member.parameters) {
              const isProperty =
                (ts.getCombinedModifierFlags(p) & ts.ModifierFlags.ParameterPropertyModifier) !== 0;
              if (isProperty) checkDecl(owner, p.name.getText(sf), p, p);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const s of sf.statements) {
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        checkDecl("", d.name.getText(sf), d, d.name);
      }
    }
  }
  if (!bindingFieldSeen) {
    violations.push(
      `${RUNTIME_SRC}/${BINDING_FIELD.file} — \`${BINDING_FIELD.cls}.${BINDING_FIELD.name}\`, the one binding field, is missing (T4 presence)`,
    );
  }
  return { types, stored };
}

function walkSources(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") || NOT_SOURCE_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkSources(abs, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts")) out.push(abs);
  }
}

function checkRemovedNames(root: string, violations: string[]): number {
  const files: string[] = [];
  walkSources(root, files);
  for (const abs of files) {
    const text = readFileSync(abs, "utf-8");
    // Cheap pre-filter: a file that never spells a removed name cannot call it.
    if (![...REMOVED_NAMES].some((n) => text.includes(n))) continue;
    const kind = abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        // `x.name!()`, `(x.name)()`, `(x.name as F)()` call the same member.
        let e: ts.Expression = n.expression;
        while (
          ts.isNonNullExpression(e) ||
          ts.isParenthesizedExpression(e) ||
          ts.isAsExpression(e) ||
          ts.isSatisfiesExpression(e)
        ) {
          e = e.expression;
        }
        let called: string | undefined;
        if (ts.isIdentifier(e)) called = e.text;
        else if (ts.isPropertyAccessExpression(e)) called = e.name.text;
        else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
          called = e.argumentExpression.text;
        }
        if (called !== undefined && REMOVED_NAMES.has(called)) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          violations.push(
            `${relative(root, abs).split("\\").join("/")}:${line} — T3: calls the removed \`${called}\``,
          );
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return files.length;
}

export function scan(root: string): ScanResult {
  const violations: string[] = [];
  const { types, stored } = checkTypesAndStored(root, violations);
  const removedNameFiles = checkRemovedNames(root, violations);
  return { violations, storedChecked: stored, typesChecked: types, removedNameFiles };
}

function main(): void {
  const i = process.argv.indexOf("--root");
  const root =
    i >= 0 && process.argv[i + 1] !== undefined ? resolve(process.argv[i + 1]!) : REPO_ROOT;
  const r = scan(root);
  if (r.violations.length > 0) {
    failWithRepair({
      invariant: `${r.violations.length} finding(s): the runtime holds ONE delegation relay binding; no manager, config, property or module variable holds a relay URL, token source or relay key of its own`,
      canonical:
        "packages/runtime/src/relay-binding.ts (RelayBinding, RelayBindingSnapshot) + MotebitRuntime.bindRelay / unbindRelay / _relayBinding",
      fix: "read the relay per call from the binding snapshot (`getBinding()` in a manager, `this._relayBinding` in the runtime) at the call's start and pass it down to relay-delegation.ts functions; never store a relay URL, token source or key in a config, property or module variable; replace a removed enable/disable call with `runtime.bindRelay({ syncUrl, authToken, relayPublicKey?, tools, invokeCapability })` / `runtime.unbindRelay()`",
      sites: r.violations,
      doctrine:
        "design runtime-relay-binding rev 6 §3.5; docs/doctrine/composition-preserves-enforcement.md (one holder, so a switch cannot leave a call on the old relay)",
    });
  }
  process.stdout.write(
    `✓ check-runtime-single-relay-binding: T1 read ${r.typesChecked} type(s)/parameter(s) (the named configs + every constructor and method parameter of InteractiveDelegationManager and InvokeCapabilityManager); ` +
      `T2 read ${r.storedChecked} typed declaration(s) in ${RUNTIME_SRC}/{${STORED_FILES.join(",")}} (one exempt: ${BINDING_FIELD.cls}.${BINDING_FIELD.name}); ` +
      `T3 scanned ${r.removedNameFiles} .ts/.tsx/.mts/.cts file(s) repo-wide (tests included; node_modules, build output and dot-directories excluded) for calls to ${[...REMOVED_NAMES].join(", ")}; T4 presence held.\n  ${BLIND_SPOTS}\n`,
  );
}

main();
