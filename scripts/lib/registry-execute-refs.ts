/**
 * Type-aware scan for REFERENCES to a tool registry's execute method or its
 * private handler storage — the analysis behind `check-money-authority`
 * assertion 5.
 *
 * A raw registry execute skips the policy gate, so an R4_MONEY tool runs with
 * no verified grant. A text scan for `registry.execute(` saw only the literal
 * call; every aliasing form slipped past it. This scan asks the TypeScript
 * checker what each reference RESOLVES to, so the spelling does not matter:
 *
 *   - `r.execute` / `r?.execute` / `r["execute"]` whose symbol is the
 *     `execute` member of a ToolRegistry (the protocol interface, any class or
 *     interface named `*ToolRegistry`, or anything implementing/extending one)
 *     — covers a direct call, `const e = r.execute`, `.call/.apply/.bind`, and
 *     passing the method as a callback (all start with this access);
 *   - an `execute` access whose receiver passes THROUGH a registry type on the
 *     way (`(r as SimpleToolRegistry as unknown as { execute… }).execute`) —
 *     the cast form, where the final symbol is the type literal's;
 *   - `execute` on an `any`-typed receiver (the type is gone, so the access
 *     cannot be proven not to be a registry's);
 *   - a computed element access (`r[k]`) on a registry-typed receiver;
 *   - destructuring `execute` out of a registry-typed value
 *     (`const { execute } = r`, parameter patterns);
 *   - any reference to a registry class's PRIVATE / protected member (the
 *     handler map, a scoped registry's inner registry) from outside that
 *     class — TypeScript lets bracket access reach private members.
 *
 * References inside a registry implementation's own class body (a scoped
 * registry delegating to its inner registry) are reported as `internal`.
 */
import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type RefKind =
  | "execute-member"
  | "execute-through-cast"
  | "execute-on-any"
  | "computed-access"
  | "destructure"
  | "private-member";

export interface RegistryRef {
  /** Repo-relative path. */
  file: string;
  line: number;
  kind: RefKind;
  lineText: string;
  /** Inside the declaring registry class's own body (composition). */
  internal: boolean;
  /**
   * The named scopes enclosing the reference, outermost first, joined by
   * ` > ` — e.g. `MotebitRuntime.executeToolGated` or `runServe > executeTool`.
   * What a sanctioned site is keyed on: a spelling-independent location.
   */
  container: string;
  /** Source text of the innermost NAMED function-like scope, from its start up to the reference. */
  containerPrefix: string;
}

const REGISTRY_NAME = /ToolRegistry$/;

/** Every workspace package's name → its `src/index.ts`, for checker resolution without dist. */
function workspacePaths(root: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const dir of ["packages", "apps", "services"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(resolve(root, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgJson = resolve(root, dir, entry, "package.json");
      const index = resolve(root, dir, entry, "src", "index.ts");
      if (!existsSync(pkgJson) || !existsSync(index)) continue;
      try {
        const name = (JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string }).name;
        if (typeof name === "string") paths[name] = [index];
      } catch {
        continue;
      }
    }
  }
  return paths;
}

export function compilerOptionsFor(root: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    resolveJsonModule: true,
    types: [],
    baseUrl: root,
    paths: workspacePaths(root),
  };
}

/**
 * A program over `roots` plus in-memory `virtual` files (absolute path →
 * source). Virtual files resolve imports exactly like real ones.
 */
export function createScanProgram(
  root: string,
  roots: readonly string[],
  virtual: ReadonlyMap<string, string> = new Map(),
): ts.Program {
  const options = compilerOptionsFor(root);
  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => virtual.has(f) || baseFileExists(f);
  host.readFile = (f) => virtual.get(f) ?? baseReadFile(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const v = virtual.get(f);
    if (v !== undefined) return ts.createSourceFile(f, v, lang, true);
    return baseGetSourceFile(f, lang, onError, create);
  };
  return ts.createProgram({ rootNames: [...roots, ...virtual.keys()], options, host });
}

function isRegistryDecl(d: ts.Declaration | undefined): boolean {
  if (d == null) return false;
  if (!ts.isClassDeclaration(d) && !ts.isClassExpression(d) && !ts.isInterfaceDeclaration(d)) {
    return false;
  }
  if (d.name != null && REGISTRY_NAME.test(d.name.text)) return true;
  for (const clause of d.heritageClauses ?? []) {
    for (const t of clause.types) {
      const text = t.expression.getText();
      if (REGISTRY_NAME.test(text.split(".").pop() ?? "")) return true;
    }
  }
  return false;
}

function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

function isRegistryExecuteSymbol(checker: ts.TypeChecker, sym: ts.Symbol | undefined): boolean {
  if (sym == null) return false;
  const s = resolveAlias(checker, sym);
  if (s.getName() !== "execute") return false;
  return (s.declarations ?? []).some((d) => isRegistryDecl(d.parent as ts.Declaration));
}

function isRegistryType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some((t) => isRegistryType(checker, t));
  const sym = type.getSymbol() ?? type.aliasSymbol;
  if (sym != null && (sym.declarations ?? []).some((d) => isRegistryDecl(d))) return true;
  const exec = type.getProperty("execute");
  return isRegistryExecuteSymbol(checker, exec);
}

/** The private/protected member of a registry class this symbol is, else null. */
function registryPrivateMember(sym: ts.Symbol | undefined): ts.Declaration | null {
  if (sym == null) return null;
  for (const d of sym.declarations ?? []) {
    if (!isRegistryDecl(d.parent as ts.Declaration)) continue;
    const isHash =
      (ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d)) &&
      d.name != null &&
      ts.isPrivateIdentifier(d.name);
    const flags = ts.getCombinedModifierFlags(d);
    if (isHash || flags & ts.ModifierFlags.Private || flags & ts.ModifierFlags.Protected) {
      return d.parent as ts.Declaration;
    }
  }
  // A constructor parameter property (`private readonly inner: ToolRegistry`).
  for (const d of sym.declarations ?? []) {
    if (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent)) {
      const cls = d.parent.parent as ts.Declaration;
      const flags = ts.getCombinedModifierFlags(d);
      if (isRegistryDecl(cls) && flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) {
        return cls;
      }
    }
  }
  return null;
}

function enclosingRegistryClass(node: ts.Node): ts.Node | null {
  for (let n: ts.Node | undefined = node.parent; n != null; n = n.parent) {
    if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && isRegistryDecl(n)) return n;
  }
  return null;
}

function scopeName(n: ts.Node): string | null {
  const nameOf = (name: ts.Node | undefined): string | null =>
    name != null &&
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name))
      ? name.text
      : null;
  if (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) {
    const member = nameOf(n.name);
    const cls = n.parent;
    const clsName =
      (ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) && cls.name != null
        ? cls.name.text
        : null;
    return member == null ? null : clsName != null ? `${clsName}.${member}` : member;
  }
  if (ts.isConstructorDeclaration(n)) {
    const cls = n.parent;
    return `${cls.name?.text ?? "<class>"}.constructor`;
  }
  if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) return nameOf(n.name);
  if (ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) {
    const init = n.initializer;
    return init != null && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ? nameOf(n.name)
      : null;
  }
  if (ts.isVariableDeclaration(n)) {
    const init = n.initializer;
    return init != null && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ? nameOf(n.name)
      : null;
  }
  return null;
}

function containerOf(node: ts.Node, sf: ts.SourceFile): { container: string; prefix: string } {
  const names: string[] = [];
  let innermost: ts.Node | null = null;
  for (let n: ts.Node | undefined = node.parent; n != null; n = n.parent) {
    const name = scopeName(n);
    if (name != null) {
      names.unshift(name);
      innermost ??= n;
    }
  }
  const prefix = innermost == null ? "" : sf.text.slice(innermost.getStart(sf), node.getStart(sf));
  return { container: names.length > 0 ? names.join(" > ") : "<module>", prefix };
}

function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n != null; n = n.parent) if (n === ancestor) return true;
  return false;
}

/** Does `expr`, or any cast/paren layer inside it, carry a registry type? */
function passesThroughRegistry(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  let e: ts.Expression = expr;
  for (;;) {
    if (isRegistryType(checker, checker.getTypeAtLocation(e))) return true;
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
      continue;
    }
    return false;
  }
}

function isAnyType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

/** Scan one source file of `program` for registry execute / private-member references. */
export function scanFile(program: ts.Program, sf: ts.SourceFile, rel: string): RegistryRef[] {
  const checker = program.getTypeChecker();
  const lines = sf.text.split("\n");
  const out: RegistryRef[] = [];
  const push = (node: ts.Node, kind: RefKind, owner: ts.Node | null) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const cls = enclosingRegistryClass(node);
    const { container, prefix } = containerOf(node, sf);
    out.push({
      file: rel,
      line,
      kind,
      lineText: lines[line - 1] ?? "",
      internal: owner != null ? isWithin(node, owner) : cls != null,
      container,
      containerPrefix: prefix,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const sym = checker.getSymbolAtLocation(node.name);
      const owner = registryPrivateMember(sym);
      if (owner != null) {
        if (!isWithin(node, owner)) push(node, "private-member", owner);
      } else if (node.name.text === "execute") {
        if (isRegistryExecuteSymbol(checker, sym)) push(node, "execute-member", null);
        else if (passesThroughRegistry(checker, node.expression))
          push(node, "execute-through-cast", null);
        else if (isAnyType(checker.getTypeAtLocation(node.expression)))
          push(node, "execute-on-any", null);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) {
        const recvType = checker.getTypeAtLocation(node.expression);
        const sym = checker.getSymbolAtLocation(arg) ?? recvType.getProperty(arg.text);
        const owner = registryPrivateMember(sym);
        if (owner != null) {
          if (!isWithin(node, owner)) push(node, "private-member", owner);
        } else if (arg.text === "execute") {
          if (isRegistryExecuteSymbol(checker, sym)) push(node, "execute-member", null);
          else if (passesThroughRegistry(checker, node.expression))
            push(node, "execute-through-cast", null);
          else if (isAnyType(recvType)) push(node, "execute-on-any", null);
        }
      } else if (passesThroughRegistry(checker, node.expression)) {
        push(node, "computed-access", null);
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const nameNode = node.propertyName ?? node.name;
      const prop =
        ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode) ? nameNode.text : null;
      if (prop != null) {
        const sourceType = checker.getTypeAtLocation(node.parent);
        const sym = sourceType.getProperty(prop);
        const owner = registryPrivateMember(sym);
        if (owner != null) {
          if (!isWithin(node, owner)) push(node, "private-member", owner);
        } else if (prop === "execute" && isRegistryExecuteSymbol(checker, sym)) {
          push(node, "destructure", null);
        }
      } else if (
        ts.isComputedPropertyName(nameNode) &&
        isRegistryType(checker, checker.getTypeAtLocation(node.parent))
      ) {
        push(node, "computed-access", null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Workspace source files the gate scans: every `<root>/<pkg>/src` `.ts`/`.tsx`, tests excluded. */
export function workspaceSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(resolve(root, rel));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
      if (entry === "__tests__") continue;
      const child = join(rel, entry);
      let st;
      try {
        st = statSync(resolve(root, child));
      } catch {
        continue; // broken symlink
      }
      if (st.isDirectory()) walk(child);
      else if (
        /\.tsx?$/.test(entry) &&
        !entry.endsWith(".d.ts") &&
        !/\.(test|spec|probe)\.tsx?$/.test(entry)
      ) {
        out.push(child);
      }
    }
  };
  for (const top of ["packages", "apps", "services"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(resolve(root, top));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const src = join(top, entry, "src");
      try {
        if (statSync(resolve(root, src)).isDirectory()) walk(src);
      } catch {
        continue;
      }
    }
  }
  return out.sort();
}
