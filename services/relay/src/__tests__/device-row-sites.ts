/**
 * The site scanner behind `device-row-reads-875.test.ts` (#875 review round
 * 3): every read of a device row — or of a helper that returns device-row
 * keys — in relay source, identified by file, enclosing function and a
 * normalized snippet of the line, so a sanctioned read swapped for an unsafe
 * one in the same file is a DIFFERENT site.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * What counts as a device-row read, case-insensitive: the core-identity
 * device loaders, raw SQL over `devices` (and the legacy `relay_devices`),
 * and the identity-keys helpers that return device-row keys.
 */
export const DEVICE_ROW_READ =
  /\b(?:listDevices|loadDeviceById|loadDeviceByToken|loadDevice|getDevice|readDeviceKeys|keysHeldBy)\s*\(|\b(?:from|join)\s+devices\b|\brelay_devices\b/i;

/**
 * The nearest enclosing named scope: a function declaration, a route
 * registration (its path), an arrow/function bound to a const, or a method.
 * Control-flow keywords are never a scope name.
 */
const ENCLOSING =
  /(?:^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+))|(?:^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=)|(?:app\.(?:get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+))|(?:^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|\w+\s*=>))|(?:^\s+(?:async\s+)?(?!(?:if|for|while|switch|catch|return|else)\b)(\w+)\s*\([^()]*\)\s*(?::[^{]*)?\{\s*$)/;

export interface DeviceRowSite {
  file: string;
  fn: string;
  snippet: string;
}

const normalize = (s: string): string => s.trim().replace(/\s+/g, " ");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

export function scanDeviceRowSites(srcDir: string): { files: number; sites: DeviceRowSite[] } {
  const files = sourceFiles(srcDir);
  const sites: DeviceRowSite[] = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!DEVICE_ROW_READ.test(line)) continue;
      // Skip comment-only lines: prose naming a helper is not a read.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      let fn = "<module>";
      for (let j = i; j >= 0; j--) {
        const m = ENCLOSING.exec(lines[j]!);
        if (m) {
          fn = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "<module>";
          break;
        }
      }
      sites.push({ file: relative(srcDir, f), fn, snippet: normalize(line) });
    }
  }
  return { files: files.length, sites };
}
