/**
 * Deny-by-default scan: no relay adapter is built off the session.
 *
 * The degree of freedom removed (cold review 3): an adapter that holds the
 * global fetch or a static credential can reach the relay after OFF, because
 * its own awaits (an encrypting push encrypts per message) resume past any
 * check at its door. So every relay adapter the sync controller builds takes
 * `fetch: session.fetch` and session-minted credentials, and every other raw
 * transport in the app is either here by name, with its reason, or red.
 *
 * APERTURE — what this scan examines, honestly:
 *   - lexical, over every non-test `.ts` / `.tsx` file under apps/mobile/src;
 *   - direct `fetch(` calls (not `x.fetch(`, not a method named fetch),
 *     `new WebSocket(`, and
 *     constructions of the relay adapters (`new Http*Adapter(`,
 *     `new WebSocketEventStoreAdapter(`, `new RelayDelegationAdapter(`,
 *     `new PairingClient(`);
 *   - for each relay-adapter construction, its option object must name
 *     `fetch: session.fetch` (HTTP adapters, delegation) or
 *     `credentialSource:` (the socket), and never `authToken:` as a string.
 * It does NOT see: requests made inside library packages the app calls
 * (core-identity registration, runtime's relay delegation, the sync-engine's
 * own internals — those take the session's fetch / signal at the call site,
 * which the interleaving harness checks behaviourally), an aliased `fetch`
 * (`const f = fetch; f(...)`), or a URL that is not the relay. Raw calls on
 * the ALLOWED list are pre-existing, user-initiated or OFF's own cleanup;
 * they are counted per file, so a new one anywhere goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** file → how many raw transports it may hold, and why. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "relay-session.ts": { count: 1, why: "the session's own fetch — the one door" },
  "push-token-manager.ts": {
    count: 2,
    why: "UNSCOPED channel for callers with no session; OFF's own bounded push-token DELETE",
  },
  "machine-roster.ts": { count: 1, why: "default for an injected fetchImpl (user-opened roster)" },
  "mobile-app.ts": {
    count: 4,
    why: "user slash commands / remote command and the serving-gated background push-wake handler; read the saved relay URL at call time (OFF clears it)",
  },
  "components/BillingPanel.tsx": { count: 6, why: "user-initiated billing actions" },
  "components/ActivityPanel.tsx": { count: 2, why: "public transparency/retention reads" },
  "components/CapabilitiesPanel.tsx": { count: 2, why: "public manifest / skills discovery" },
  "components/SovereignPanel.tsx": { count: 2, why: "user-opened Sovereign panel reads" },
  "pairing-manager.ts": { count: 8, why: "explicit user pairing flow (PairingClient)" },
  "adapters/elevenlabs-tts.ts": { count: 1, why: "not the relay (TTS provider)" },
  "adapters/openai-tts.ts": { count: 1, why: "not the relay (TTS provider)" },
};

const RAW = /(?<![.\w])(?<!async )fetch\(|new WebSocket\(|new PairingClient\(/g;
const ADAPTER = /new (Http\w*Adapter|WebSocketEventStoreAdapter|RelayDelegationAdapter)\(\s*\{/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Code with comments blanked, so prose never counts as a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The `{ ... }` option object starting at `open` (brace-balanced). */
function optionObject(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

interface Scan {
  files: number;
  raw: Map<string, number>;
  adapters: Array<{ file: string; kind: string; options: string }>;
}

function scan(): Scan {
  const files = sourceFiles(SRC);
  const raw = new Map<string, number>();
  const adapters: Scan["adapters"] = [];
  for (const path of files) {
    const file = relative(SRC, path).split("\\").join("/");
    const text = code(readFileSync(path, "utf8"));
    const n = text.match(RAW)?.length ?? 0;
    if (n > 0) raw.set(file, n);
    for (const m of text.matchAll(ADAPTER)) {
      const open = m.index + m[0].length - 1;
      adapters.push({ file, kind: m[1]!, options: optionObject(text, open) });
    }
  }
  return { files: files.length, raw, adapters };
}

describe("relay transport scan (deny-by-default)", () => {
  const result = scan();

  it("states its aperture", () => {
    process.stdout.write(
      `[relay-transport-scan] ${result.files} source files; ` +
        `${[...result.raw.values()].reduce((a, b) => a + b, 0)} raw transports in ` +
        `${result.raw.size} files (all allow-listed); ${result.adapters.length} relay adapters, ` +
        `each on the session\n`,
    );
    expect(result.files).toBeGreaterThan(20);
    expect(result.adapters.length).toBeGreaterThanOrEqual(6);
  });

  it("every relay adapter is built on the session's fetch and per-request credentials", () => {
    const bad: string[] = [];
    for (const a of result.adapters) {
      const where = `${a.file}: new ${a.kind}`;
      // A minting function (`authToken: (aud) => …`) is per request; a value is not.
      if (/\bauthToken:\s*[^\s(]/.test(a.options)) {
        bad.push(`${where} holds a static authToken — mint per request (credentialSource)`);
      }
      if (a.kind === "WebSocketEventStoreAdapter") {
        if (!/\bcredentialSource\b/.test(a.options))
          bad.push(`${where} has no session credentialSource`);
      } else if (!/\bfetch:\s*session\.fetch\b/.test(a.options)) {
        bad.push(`${where} is not handed \`fetch: session.fetch\` (it would use the global fetch)`);
      }
      if (a.kind.startsWith("Http") && !/\bcredentialSource\b/.test(a.options)) {
        bad.push(`${where} has no per-request credentialSource`);
      }
    }
    expect(bad, "build the adapter on the RelaySession (see relay-session.ts)").toEqual([]);
  });

  it("every raw fetch / WebSocket / PairingClient outside the session is allow-listed by count", () => {
    const bad: string[] = [];
    for (const [file, n] of result.raw) {
      const allowed = ALLOWED[file];
      if (!allowed) bad.push(`${file}: ${n} raw transport(s), none allowed — use session.fetch`);
      else if (n > allowed.count)
        bad.push(`${file}: ${n} raw transports, ${allowed.count} allowed (${allowed.why})`);
    }
    for (const [file, a] of Object.entries(ALLOWED)) {
      const n = result.raw.get(file) ?? 0;
      if (n < a.count) bad.push(`${file}: allow-list says ${a.count}, found ${n} — tighten it`);
    }
    expect(bad, "route relay calls through RelaySession.fetch, or name the exception").toEqual([]);
  });
});
