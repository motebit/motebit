/**
 * Static gate: no mobile code path may execute a delegated task
 * (`handleAgentTask`) or advertise this device as a worker (`startServing`)
 * outside the single serving gate (serving-gate.ts).
 *
 * Rule: every reference to `handleAgentTask` must be preceded, inside one of
 * its enclosing functions, by a call to `canExecuteDelegatedTask(...)`; every
 * reference to `startServing` (other than its own declaration) by a call to
 * `mobileServingAllowed()` or `canExecuteDelegatedTask(...)`. The
 * `startServing` method declarations must themselves open with the gate.
 * Aliasing (`const run = runtime.handleAgentTask`) counts as a reference.
 *
 * Aperture: every non-test .ts/.tsx/.js file under apps/mobile/src, plus
 * apps/mobile/index.ts and apps/mobile/modules/** (node_modules excluded).
 * The scan is lexical-precedence within enclosing functions — it proves a gate
 * check is on the path, not that every branch honours it; the behavioural
 * tests (serving-gate-push-wake, slash-commands /serve, sync-controller)
 * cover the branches.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, "../..");

const EXEC = "handleAgentTask";
const SERVE = "startServing";
const EXEC_GATES = new Set(["canExecuteDelegatedTask"]);
const SERVE_GATES = new Set(["mobileServingAllowed", "canExecuteDelegatedTask"]);

interface Site {
  file: string;
  line: number;
  name: string;
  gated: boolean;
}

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(tsx?|js)$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts"))
      out.push(p);
  }
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n)
  );
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Gate calls (by name) inside `scope`, at or before `pos`. */
function hasGateBefore(scope: ts.Node, pos: number, gates: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || n.getStart() >= pos) return;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && gates.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

export function scanSource(fileName: string, text: string): Site[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && (n.text === EXEC || n.text === SERVE)) {
      const parent = n.parent;
      const isDeclaration =
        (ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.name === n;
      const gates = n.text === EXEC ? EXEC_GATES : SERVE_GATES;
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      if (isDeclaration) {
        // The serving entry point itself must open with the gate.
        if (n.text === SERVE && ts.isMethodDeclaration(parent) && parent.body) {
          const firstStmt = parent.body.statements[0];
          const gated =
            firstStmt !== undefined && hasGateBefore(firstStmt, firstStmt.getEnd() + 1, gates);
          sites.push({ file: fileName, line, name: `${SERVE} (declaration)`, gated });
        }
      } else {
        let gated = false;
        for (let a: ts.Node | undefined = n.parent; a !== undefined; a = a.parent) {
          if (isFunctionLike(a) && hasGateBefore(a, n.getStart(), gates)) {
            gated = true;
            break;
          }
        }
        sites.push({ file: fileName, line, name: n.text, gated });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

function scanMobile(): Site[] {
  const files: string[] = [];
  walkFiles(join(mobileRoot, "src"), files);
  walkFiles(join(mobileRoot, "modules"), files);
  files.push(join(mobileRoot, "index.ts"));
  return files.flatMap((f) => scanSource(relative(mobileRoot, f), readFileSync(f, "utf8")));
}

describe("mobile serving gate — static", () => {
  it("the gate is OFF: MOBILE_SERVING_ENABLED is the literal false", () => {
    const src = readFileSync(join(mobileRoot, "src/serving-gate.ts"), "utf8");
    expect(src).toMatch(/export const MOBILE_SERVING_ENABLED: boolean = false;/);
  });

  it("every handleAgentTask / startServing reference in apps/mobile is behind the gate", () => {
    const sites = scanMobile();
    // Aperture floor: the known execution + serving sites must be seen, so the
    // scan can never go green by looking at nothing.
    expect(sites.filter((s) => s.name === EXEC).length).toBeGreaterThanOrEqual(2);
    expect(sites.filter((s) => s.name.startsWith(SERVE)).length).toBeGreaterThanOrEqual(3);
    const ungated = sites.filter((s) => !s.gated);
    expect(
      ungated.map((s) => `${s.file}:${s.line} ${s.name}`),
      "Ungated delegated-execution site. Route it through serving-gate.ts: " +
        "check canExecuteDelegatedTask(...) before handleAgentTask, " +
        "mobileServingAllowed() before startServing.",
    ).toEqual([]);
  });

  it("bites: an ungated handleAgentTask call is reported", () => {
    const bad = `async function wake(rt) { for await (const c of rt.handleAgentTask(t)) {} }`;
    expect(scanSource("bad.ts", bad).filter((s) => !s.gated)).toHaveLength(1);
    const alias = `function f(rt) { const run = rt.handleAgentTask; return run; }`;
    expect(scanSource("alias.ts", alias).filter((s) => !s.gated)).toHaveLength(1);
    const badServe = `class C { async startServing() { return register(); } }`;
    expect(scanSource("serve.ts", badServe).filter((s) => !s.gated)).toHaveLength(1);
  });

  it("stays silent: a gated call passes", () => {
    const good = `async function wake(app, rt) {
      if (!canExecuteDelegatedTask(app.isServing())) return;
      for await (const c of rt.handleAgentTask(t)) {}
    }`;
    expect(scanSource("good.ts", good).filter((s) => !s.gated)).toHaveLength(0);
  });
});
