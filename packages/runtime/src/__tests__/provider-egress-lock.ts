/**
 * TYPE-AWARE provider egress lock — the static half of the egress canary
 * (`egress-canary.test.ts`).
 *
 * The canary drives every runtime entry point that reaches a provider; this
 * lock proves the list of entry points is complete by finding every place in
 * packages/ and apps/ source that can reach a provider's REQUEST methods
 * (`generate`, `generateStream`). It asks the TypeScript checker about the
 * VALUE's type, never the spelling, so each of these is a site:
 *
 *   p.generate(...)              property access (called or not)
 *   p["generate"](...), p[k]     element access — a literal egress key, or any
 *                                non-literal key (the key could be one)
 *   const { generate } = p       destructuring (also `...rest`, and a
 *   function f({ generate }: P)  destructured parameter)
 *   const q: any = p             erasure (no-any-provider rule): a provider
 *   p as unknown, q = p          value declared, cast or assigned to `any` /
 *                                `unknown` — after erasure the checker can no
 *                                longer see the provider, so the erasure
 *                                itself is the site
 *
 * A value is a provider when its type (or a union / intersection member, or
 * a base type) is named `IntelligenceProvider` / `StreamingProvider`, or
 * structurally carries a provider's request surface (`generate` +
 * `estimateConfidence` + `extractMemoryCandidates`, or `generateStream` +
 * `setModel`) — so a class that implements the interface, an object literal
 * shaped like one and a wrapper all count.
 *
 * APERTURE (what it cannot see, by construction): a provider passed as an
 * ARGUMENT to an `any` / `unknown` parameter (the contextual type of every
 * call argument in the monorepo is a full type-check — minutes, not seconds —
 * so that erasure is not scanned), a provider reached through a value the
 * checker types as something unrelated without an erasure above
 * (`Object.values(p)`, `Reflect.get`, a generic `T` parameter),
 * `eval`/`Function`, and code outside packages/<pkg>/src and apps/<app>/src
 * (tests, scripts, services/). Named here so a green lock is not read as
 * wider than it is.
 */
import ts from "typescript";

const EGRESS_METHODS = new Set(["generate", "generateStream"]);
const PROVIDER_TYPE_NAMES = new Set(["IntelligenceProvider", "StreamingProvider"]);

export type ProviderSiteKind = "access" | "element" | "destructure" | "erasure";

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

/** Every provider egress site in `files` (absolute paths), per the rules above. */
export function findProviderSites(files: readonly string[]): ProviderSite[] {
  const program = ts.createProgram({ rootNames: [...files], options: COMPILER_OPTIONS });
  const checker = program.getTypeChecker();
  const isProvider = makeIsProvider(checker);
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
        if (erasedTo(checker.getTypeFromTypeNode(node.type)) && typeIsProvider(node.expression))
          add(node, "erasure");
      } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
        if (
          node.type != null &&
          node.initializer != null &&
          erasedTo(checker.getTypeFromTypeNode(node.type)) &&
          typeIsProvider(node.initializer)
        )
          add(node, "erasure");
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        erasedTo(checker.getTypeAtLocation(node.left)) &&
        typeIsProvider(node.right)
      ) {
        add(node, "erasure");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}
