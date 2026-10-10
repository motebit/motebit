/**
 * TYPE-AWARE provider egress lock — the static half of the egress canary
 * (`egress-canary.test.ts`).
 *
 * The canary drives every runtime entry point that reaches a provider; this
 * lock proves the list of entry points is complete by finding every place in
 * packages/ and apps/ source that can reach a provider's REQUEST methods
 * (`generate`, `generateStream`). It asks the TypeScript checker about the
 * VALUE's type, never the spelling.
 *
 * WHAT A GREEN LOCK PROVES — every one of these, on a value whose declared
 * type is a provider type, is a counted site:
 *
 *   p.generate(...)              property access (called, bound or aliased:
 *   const g = p.generate           `p.generate.bind(p)`, `const g = p.generate`)
 *   p["generate"](...), p[k]     element access — a literal egress key, or any
 *                                non-literal key (the key could be one)
 *   const { generate } = p       destructuring (also `...rest`, and a
 *   function f({ generate }: P)  destructured parameter)
 *   const q: any = p             erasure: a provider value declared, cast or
 *   p as unknown, q = p          assigned to `any` / `unknown`
 *   use(p), Reflect.get(p, k)    narrowing: a provider NAME (`p`, `a.b`,
 *   const g: { generate } = p    `this.b`) flowing into a slot whose declared
 *   { gen: p }, return p         type is not a provider — a call argument
 *                                (the callee's DECLARED parameter type, so a
 *                                generic `T`, `object`, `unknown`, `any`,
 *                                `Pick<Provider, "generate">` or an interface
 *                                declaring only `generate` all count), a typed
 *                                declaration, an object-literal property, a
 *                                return, an assignment
 *   use(deps) with `d: any`,     container erasure: a CONTAINER whose data-
 *   (deps as any).provider,      property chain reaches a provider (≤ 3 hops:
 *   (d as Record<string, any>),  a deps object, a runtime, `this`) cast,
 *   const x: unknown = deps,     declared, assigned or passed (by name or
 *   (this as any).provider       `this`) into an ERASING slot — `any`,
 *                                `unknown`, or an any / unknown index
 *                                signature (`Record<string, any>`); past it
 *                                `d.provider.generate` type-checks unseen
 *
 * A value is a provider when its type (or a union / intersection member, or
 * a base type) is named `IntelligenceProvider` / `StreamingProvider`, or
 * structurally carries a provider's request surface (`generate` +
 * `estimateConfidence` + `extractMemoryCandidates`, or `generateStream` +
 * `setModel`) — so a class that implements the interface, an object literal
 * shaped like one and a wrapper all count. Narrowing closes the structural
 * hole the other rules leave: once a provider is held in a slot typed as
 * less than a provider, the checker can no longer see it, so the hand-off
 * itself is the site.
 *
 * APERTURE — what it cannot see, by construction (named so a green lock is
 * not read as wider than it is):
 *
 * - a provider that reaches a narrower slot through an EXPRESSION rather
 *   than a name (`use(cond ? p : q)`, `use(getProvider())`, `[p][0]`,
 *   spread `use(...[p])`, a rest parameter) — narrowing is checked on names;
 * - a container narrowed to a NON-erasing slot that drops the provider's
 *   property (`nameOf(d: { name: string })`) — reaching the provider again
 *   needs a cast, which is counted; a container more than 3 data-property
 *   hops from its provider, or reaching it only through a getter / method;
 * - an untyped (implicit-any) parameter in a JavaScript file, `eval` /
 *   `Function`, and anything the checker cannot type;
 * - a value built structurally from parts with no provider type at any point
 *   (`{ generate: (c) => fetch(...) }` written from scratch is not a
 *   provider; it is a new provider implementation, which the canary's
 *   provider-call-site table names by file);
 * - code outside packages/<pkg>/src and apps/<app>/src (tests, scripts,
 *   services/).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const EGRESS_METHODS = new Set(["generate", "generateStream"]);
const PROVIDER_TYPE_NAMES = new Set(["IntelligenceProvider", "StreamingProvider"]);

export type ProviderSiteKind =
  "access" | "element" | "destructure" | "erasure" | "narrowing" | "container";

export interface ProviderSite {
  file: string;
  line: number;
  kind: ProviderSiteKind;
  text: string;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: [],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  allowArbitraryExtensions: true,
};

function isAnyOrUnknown(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function makeIsProvider(checker: ts.TypeChecker): (type: ts.Type) => boolean {
  const memo = new Map<ts.Type, boolean>();
  const visit = (type: ts.Type, depth: number): boolean => {
    if (depth > 6 || isAnyOrUnknown(type)) return false;
    const cached = memo.get(type);
    if (cached != null) return cached;
    memo.set(type, false); // cycle guard
    let result = false;
    if (type.isUnionOrIntersection()) {
      result = type.types.some((t) => visit(t, depth + 1));
    } else {
      const named = [type.getSymbol(), type.aliasSymbol].some(
        (s) => s != null && PROVIDER_TYPE_NAMES.has(s.getName()),
      );
      const has = (n: string) => type.getProperty(n) != null;
      const structural =
        (has("generate") && has("estimateConfidence") && has("extractMemoryCandidates")) ||
        (has("generateStream") && has("setModel"));
      result = named || structural;
      if (!result && type.isClassOrInterface()) {
        result = (checker.getBaseTypes(type) ?? []).some((b) => visit(b, depth + 1));
      }
    }
    memo.set(type, result);
    return result;
  };
  return (type) => visit(type, 0);
}

/**
 * Does `type` reach a provider through its property chain (≤ 3 hops, data
 * properties only — a method's function type carries no provider)? The
 * container a provider rides in: deps objects, a runtime, `this`.
 */
function makeContainsProvider(
  checker: ts.TypeChecker,
  isProvider: (type: ts.Type) => boolean,
): (type: ts.Type) => boolean {
  const memo = new Map<ts.Type, boolean>();
  const visit = (raw: ts.Type, depth: number): boolean => {
    // `this` and generic `T` are type parameters: read their constraint.
    const type = raw.isTypeParameter() ? checker.getApparentType(raw) : raw;
    if (isProvider(type)) return true;
    if (depth >= 3 || isAnyOrUnknown(type)) return false;
    const cached = memo.get(type);
    if (cached != null) return cached;
    memo.set(type, false); // cycle guard
    let result = false;
    if (type.isUnionOrIntersection()) {
      result = type.types.some((t) => visit(t, depth));
    } else if ((type.flags & ts.TypeFlags.Object) !== 0 && type.getCallSignatures().length === 0) {
      for (const prop of checker.getPropertiesOfType(type)) {
        if ((prop.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Accessor)) !== 0) continue;
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        if (decl == null) continue;
        if (visit(checker.getTypeOfSymbolAtLocation(prop, decl), depth + 1)) {
          result = true;
          break;
        }
      }
    }
    memo.set(type, result);
    return result;
  };
  return (type) => visit(type, 0);
}

/**
 * A slot that erases what flows into it: `any`, `unknown`, or a record whose
 * index signature is `any` / `unknown` (`Record<string, any>`) — past it,
 * any property chain type-checks.
 */
function erases(checker: ts.TypeChecker, type: ts.Type | undefined): boolean {
  if (type == null) return false;
  if (isAnyOrUnknown(type)) return true;
  for (const kind of [ts.IndexKind.String, ts.IndexKind.Number]) {
    const index = checker.getIndexTypeOfType(type, kind);
    if (index != null && isAnyOrUnknown(index)) return true;
  }
  return false;
}

/** A value reached by name: `p`, `a.b`, `this.b` (not a call, literal or operator result). */
function isNameExpression(node: ts.Node): node is ts.Expression {
  return (
    ts.isIdentifier(node) ||
    (ts.isPropertyAccessExpression(node) && !ts.isCallExpression(node.parent))
  );
}

/** Is `node` the whole value of a slot the checker types from context? */
function flowsIntoSlot(node: ts.Expression): boolean {
  const parent = node.parent;
  if (parent == null) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments != null)
    return parent.arguments.includes(node);
  if (ts.isVariableDeclaration(parent)) return parent.initializer === node && parent.type != null;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  if (ts.isReturnStatement(parent)) return parent.expression === node;
  if (ts.isArrowFunction(parent)) return parent.body === node;
  if (ts.isBinaryExpression(parent))
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node;
  return false;
}

/**
 * The declared type of the slot `node` flows into. A call argument reads the
 * callee's DECLARED parameter type — a generic `T` stays `T` (the contextual
 * type would be the inferred instantiation, i.e. the provider itself, which
 * would hide `Reflect.get(p, k)` and `use<T>(p)`); every other slot reads
 * the contextual type.
 */
function slotType(checker: ts.TypeChecker, node: ts.Expression): ts.Type | undefined {
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments != null) {
    const decl = checker.getResolvedSignature(parent)?.getDeclaration();
    const i = parent.arguments.indexOf(node);
    const params = decl != null && "parameters" in decl ? decl.parameters : undefined;
    const param = params?.[Math.min(i, params.length - 1)];
    if (param != null && param.dotDotDotToken == null && i < params!.length)
      return checker.getTypeAtLocation(param);
  }
  return checker.getContextualType(node);
}

/** Every provider egress site in `files` (absolute paths), per the rules above. */
export function findProviderSites(files: readonly string[]): ProviderSite[] {
  const program = ts.createProgram({ rootNames: [...files], options: COMPILER_OPTIONS });
  const checker = program.getTypeChecker();
  const isProvider = makeIsProvider(checker);
  const containsProvider = makeContainsProvider(checker, isProvider);
  const roots = new Set(files);
  const sites: ProviderSite[] = [];

  for (const sf of program.getSourceFiles()) {
    if (!roots.has(sf.fileName)) continue;
    const add = (node: ts.Node, kind: ProviderSiteKind) => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      sites.push({ file: sf.fileName, line: line + 1, kind, text: node.getText(sf).slice(0, 80) });
    };
    const typeIsProvider = (expr: ts.Node) => isProvider(checker.getTypeAtLocation(expr));
    const erasedTo = (target: ts.Type | undefined) => target != null && isAnyOrUnknown(target);
    /** A CONTAINER (not itself a provider) whose property chain reaches one. */
    const typeIsContainer = (expr: ts.Node) => {
      const t = checker.getTypeAtLocation(expr);
      return !isProvider(t) && containsProvider(t);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        if (EGRESS_METHODS.has(node.name.text) && typeIsProvider(node.expression))
          add(node, "access");
      } else if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression;
        const literal = ts.isStringLiteralLike(arg) ? arg.text : null;
        if ((literal == null || EGRESS_METHODS.has(literal)) && typeIsProvider(node.expression))
          add(node, "element");
      } else if (ts.isObjectBindingPattern(node)) {
        const takesEgress = node.elements.some((el) => {
          if (el.dotDotDotToken != null) return true;
          const key = el.propertyName ?? el.name;
          return (
            (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && EGRESS_METHODS.has(key.text)
          );
        });
        if (takesEgress && typeIsProvider(node)) add(node, "destructure");
      } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const target = checker.getTypeFromTypeNode(node.type);
        if (erasedTo(target) && typeIsProvider(node.expression)) add(node, "erasure");
        else if (erases(checker, target) && typeIsContainer(node.expression))
          add(node, "container");
      } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        if (node.type != null && node.initializer != null) {
          const target = checker.getTypeFromTypeNode(node.type);
          if (erasedTo(target) && typeIsProvider(node.initializer)) add(node, "erasure");
          else if (erases(checker, target) && typeIsContainer(node.initializer))
            add(node, "container");
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = checker.getTypeAtLocation(node.left);
        if (erasedTo(target) && typeIsProvider(node.right)) add(node, "erasure");
        else if (erases(checker, target) && typeIsContainer(node.right)) add(node, "container");
      }
      // Narrowing: a provider-typed NAME (identifier, `a.b`, `this.b`)
      // flowing into a slot whose declared type is not a provider — a call
      // argument, a typed declaration, an object-literal property, a return,
      // an assignment. Past that point the checker sees only the slot's
      // type (`{ generate }`, `Pick<…>`, `unknown`, a generic `T`), so the
      // flow itself is the site.
      if (isNameExpression(node) && flowsIntoSlot(node) && typeIsProvider(node)) {
        const slot = slotType(checker, node);
        if (slot != null && !isProvider(slot)) add(node, "narrowing");
      } else if (
        (isNameExpression(node) || node.kind === ts.SyntaxKind.ThisKeyword) &&
        flowsIntoSlot(node as ts.Expression) &&
        typeIsContainer(node)
      ) {
        // Container erasure: a container that carries a provider handed to
        // an erasing slot (`use(deps)` with `d: any`) — past it the chain
        // `d.provider.generate` type-checks unseen.
        if (erases(checker, slotType(checker, node as ts.Expression))) add(node, "container");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Provider egress sites per file over every packages/<pkg>/src and
 * apps/<app>/src non-test source file under `root`, keyed by `root`-relative
 * path, plus the aperture: how many files were examined.
 */
export function scanProviderSites(root: string): {
  counts: Record<string, number>;
  scanned: number;
} {
  const files: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, top))) {
      const src = join(root, top, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      sourceFiles(src, files);
    }
  }
  const counts: Record<string, number> = {};
  for (const site of findProviderSites(files)) {
    const rel = relative(root, site.file);
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
  return { counts, scanned: files.length };
}
