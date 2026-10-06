/**
 * Boot × route acceptance harness for the relay's auth posture.
 *
 * The bar: NO protected relay endpoint is reachable unauthenticated, through
 * ANY entry point, under ANY environment. Every cell of
 *   entry point × NODE_ENV × MOTEBIT_API_TOKEN × MOTEBIT_RELAY_INSECURE_NO_AUTH
 * has one expected outcome from the boot table:
 *   - refuse              — the entry throws before a relay exists;
 *   - boot-authenticated  — every protected route answers 401 unauthenticated;
 *   - boot-insecure-dev   — the explicit dev opt-in, honoured ONLY when
 *                           NODE_ENV (trimmed, lowercased) is `development` or
 *                           `test`; every other value, unset included, is
 *                           production for this decision.
 *
 * "Protected" is read from the app's own route table (never a hand list): a
 * reference relay booted with a token is probed route by route, and every
 * route that answers 401 unauthenticated there is a protected route every
 * booted cell is held to.
 *
 * The CLI `relay up` slice lives in apps/cli (it cannot be imported from
 * here); it calls the same `resolveRelayAuthPosture`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSyncRelay, type SyncRelay, type SyncRelayConfig } from "../index.js";
import { resolveRelayAuthPosture } from "../auth-posture.js";
import { buildRelayConfigFromEnv, MINIMAL_VALID_RELAY_ENV } from "../relay-config.js";
import { TEST_RELAY_NETWORK, X402_TEST_CONFIG, createTestRelay } from "./test-helpers.js";

const DEPS = { getShuttingDown: () => false } as const;
const TOKEN = "matrix-master-token";

const NODE_ENVS: Array<string | undefined> = [
  "production",
  "Production",
  "production ",
  "staging",
  undefined,
  "development",
  "test",
];
const TOKENS: Array<{ name: string; value: string | undefined }> = [
  { name: "absent", value: undefined },
  { name: "empty", value: "" },
  { name: "whitespace", value: "   " },
  { name: "set", value: TOKEN },
];
const FLAGS: Array<{ name: string; value: string | undefined }> = [
  { name: "absent", value: undefined },
  { name: "'1'", value: "1" },
  { name: "typo", value: "ture" },
];

type Outcome = "refuse" | "boot-authenticated" | "boot-insecure-dev";

function isDevEnv(nodeEnv: string | undefined): boolean {
  const v = nodeEnv?.trim().toLowerCase();
  return v === "development" || v === "test";
}

/** The boot table. */
function expected(
  nodeEnv: string | undefined,
  token: string | undefined,
  flag: string | undefined,
  hasFallbackToken: boolean,
): Outcome {
  if (flag === "ture") return "refuse"; // an unrecognised opt-in value is a misconfiguration
  const optIn = flag === "1";
  if (optIn && !isDevEnv(nodeEnv)) return "refuse";
  if (token != null && token.trim() !== "") return "boot-authenticated";
  if (optIn) return "boot-insecure-dev";
  // `relay up` keeps a generated owner-only token beside its database: with
  // no env token and no opt-in requested, it boots AUTHENTICATED under it.
  return hasFallbackToken ? "boot-authenticated" : "refuse";
}

function envFor(
  nodeEnv: string | undefined,
  token: string | undefined,
  flag: string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...MINIMAL_VALID_RELAY_ENV };
  delete env.MOTEBIT_API_TOKEN;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  if (token !== undefined) env.MOTEBIT_API_TOKEN = token;
  if (flag !== undefined) env.MOTEBIT_RELAY_INSECURE_NO_AUTH = flag;
  return env;
}

const TEST_SHAPE = {
  dbPath: ":memory:",
  x402: X402_TEST_CONFIG,
  x402ChainReader: null,
  drainGraceMs: 10,
  ...TEST_RELAY_NETWORK,
} satisfies Partial<SyncRelayConfig>;

/** Each entry point turns an env into a running relay, or throws (a refusal). */
const ENTRY_POINTS: Array<{
  name: string;
  hasFallbackToken?: boolean;
  boot: (env: Record<string, string | undefined>) => Promise<SyncRelay>;
}> = [
  {
    // server.ts: `createSyncRelay(buildRelayConfigFromEnv(process.env, …))`.
    name: "server-config path",
    boot: async (env) => createSyncRelay({ ...buildRelayConfigFromEnv(env, DEPS), ...TEST_SHAPE }),
  },
  {
    // A library embedder: the relay's own decision function, then createSyncRelay.
    name: "createSyncRelay path",
    boot: async (env) =>
      createSyncRelay({ authPosture: resolveRelayAuthPosture(env), ...TEST_SHAPE }),
  },
  {
    // `motebit relay up` (apps/cli `resolveRelayApiToken` → `buildRelayConfig`
    // → createSyncRelay): the same decision with the CLI's token-file
    // fallback. apps/cli's relay test pins that the CLI composes exactly this.
    name: "CLI relay-up resolution",
    hasFallbackToken: true,
    boot: async (env) => {
      const authPosture = resolveRelayAuthPosture(env, { fallbackToken: () => "cli-file-token" });
      return createSyncRelay({
        apiToken: authPosture.kind === "token" ? authPosture.token : undefined,
        authPosture,
        ...TEST_SHAPE,
      });
    },
  },
];

/**
 * Public by design AND network-reaching, so never probed: the signed release
 * witness observes the npm registry on request. Its handler is not gated in
 * any posture; listing it here is the aperture's only exclusion.
 */
const UNPROBED = new Set(["GET /.well-known/motebit-releases.json"]);

const protectedRoutes: Array<{ method: string; path: string }> = [];
let probeSeq = 0;

function concrete(path: string): string {
  return path.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "probe-id").replace(/\*/g, "probe");
}

async function probe(relay: SyncRelay, method: string, path: string): Promise<number> {
  // A distinct client per probe: the per-IP limiter runs before auth on some
  // routes, and a 429 would hide what auth decides.
  probeSeq += 1;
  const res = await relay.app.request(concrete(path), {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-real-ip": `10.${(probeSeq >> 16) & 255}.${(probeSeq >> 8) & 255}.${probeSeq & 255}`,
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
  return res.status;
}

beforeAll(async () => {
  const reference = await createTestRelay({ apiToken: TOKEN });
  try {
    const seen = new Set<string>();
    for (const r of reference.app.routes) {
      // `app.use` registers middleware under ALL; handlers under their method.
      if (r.method === "ALL") continue;
      const key = `${r.method} ${r.path}`;
      if (seen.has(key) || UNPROBED.has(key)) continue;
      seen.add(key);
      if ((await probe(reference, r.method, r.path)) === 401) {
        protectedRoutes.push({ method: r.method, path: r.path });
      }
    }
  } finally {
    await reference.close();
  }
});

describe("relay auth posture: entry × NODE_ENV × token × opt-in", () => {
  it("reads the protected surface from the router", () => {
    // A floor, not a count: the aperture must see the known gated families.
    const keys = protectedRoutes.map((r) => `${r.method} ${r.path}`);
    expect(protectedRoutes.length).toBeGreaterThanOrEqual(40);
    expect(keys).toContain("POST /api/v1/admin/freeze");
    expect(keys.some((k) => k.includes("/api/v1/memory/"))).toBe(true);
    expect(keys.some((k) => k.includes("/api/v1/state/"))).toBe(true);
  });

  const wrong: string[] = [];
  afterAll(() => {
    if (wrong.length > 0) console.error(`auth posture matrix — wrong cells:\n${wrong.join("\n")}`);
  });

  for (const entry of ENTRY_POINTS) {
    it(`${entry.name}: every cell matches the boot table`, async () => {
      const failures: string[] = [];
      for (const nodeEnv of NODE_ENVS) {
        for (const token of TOKENS) {
          for (const flag of FLAGS) {
            const cell = `${entry.name} | NODE_ENV=${JSON.stringify(nodeEnv)} | token=${token.name} | flag=${flag.name}`;
            const want = expected(
              nodeEnv,
              token.value,
              flag.value,
              entry.hasFallbackToken === true,
            );
            let relay: SyncRelay | undefined;
            try {
              relay = await entry.boot(envFor(nodeEnv, token.value, flag.value));
            } catch (err) {
              if (want !== "refuse") {
                failures.push(
                  `${cell}: expected ${want}, refused (${err instanceof Error ? err.message : String(err)})`,
                );
              }
              continue;
            }
            try {
              if (want === "refuse") {
                const open: string[] = [];
                for (const r of protectedRoutes) {
                  const s = await probe(relay, r.method, r.path);
                  if (s !== 401) open.push(`${r.method} ${r.path}→${s}`);
                }
                failures.push(
                  `${cell}: expected refuse, BOOTED (${open.length} protected routes open, e.g. ${open.slice(0, 4).join(", ")})`,
                );
                continue;
              }
              if (want === "boot-insecure-dev") continue; // the explicit dev opt-in: open by request
              const open: string[] = [];
              for (const r of protectedRoutes) {
                const s = await probe(relay, r.method, r.path);
                if (s !== 401) open.push(`${r.method} ${r.path}→${s}`);
              }
              if (open.length > 0)
                failures.push(
                  `${cell}: ${open.length} protected routes open: ${open.slice(0, 4).join(", ")}`,
                );
            } finally {
              await relay.close();
            }
          }
        }
      }
      wrong.push(...failures);
      expect(failures).toEqual([]);
    }, 600_000);
  }
});
