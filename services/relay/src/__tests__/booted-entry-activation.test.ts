/**
 * BOOTED-ARTIFACT activation conformance for #359 — the first rung of the
 * booted-artifact tier (docs/doctrine/composition-preserves-enforcement.md
 * Inc 3b).
 *
 * #359 was a shadow at the deployed ENTRY: the discover-signature sunset was
 * law in `federation.ts`, green in every test — and inert in production
 * because `server.ts` shadowed the constant. The #360 response reduced the
 * seam (server.ts is now a thin entry whose composition IS
 * `createSyncRelay(buildRelayConfigFromEnv(process.env, …))`) and gated it
 * statically (`check-security-default-wiring`). What remained unproven is the
 * activation claim itself: that the PROCESS a deployment actually starts —
 * `server.ts`, through its real entry composition, real env resolution, real
 * HTTP listener — enforces the strict boundary observed from OUTSIDE.
 *
 * So this test spawns the real entry as a child process with a
 * production-shaped strict env (no security overrides), waits for the real
 * `relay.listening` line, and runs `probeSecurityBoundaries` — the same
 * deployed-behavior probe an operator runs against prod — over real HTTP
 * against it. Every applicable boundary must report strict.
 *
 * Discriminating power (the severing run, recorded in the PR): perturbing
 * server.ts to shadow the built config (`requireDiscoverSignature = false`
 * between builder and createSyncRelay — the #359 diff-shape at today's seam)
 * turns this test red: the unsigned-discover probe observes non-403. The
 * positive test is the permanent guard; the severing run is the one-time
 * proof it discriminates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSecurityBoundaries } from "../relay-config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(HERE, "..", "server.ts");
const BOOT_TIMEOUT_MS = 60_000;

let child: ChildProcess | null = null;
let baseUrl = "";
let bootLog = "";

/** Spawn the REAL deployed entry and resolve when it reports listening. */
function bootRealEntry(): Promise<string> {
  return new Promise((resolvePort, reject) => {
    // Production-shaped STRICT env: the minimal valid config with NO
    // security-boundary overrides — exactly the state #359's sunset was
    // supposed to be strict in. Federation enabled so the cross-org boundary
    // is reachable. Ambient overrides are DELETED (not empty-stringed) so a
    // dev shell exporting an opt-out cannot leak into the child's resolution.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000000",
      MOTEBIT_FEDERATION_ENDPOINT_URL: "https://relay-under-test.example/federation",
      PORT: "0", // ephemeral — the entry logs the real bound port
      NODE_ENV: "test",
    };
    delete env.MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE;
    delete env.MOTEBIT_ENABLE_DEVICE_AUTH;
    delete env.MOTEBIT_FEDERATION_AUTO_ACCEPT;
    delete env.MOTEBIT_DB_PATH; // ":memory:" default
    child = spawn("npx", ["--yes", "tsx", SERVER_ENTRY], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      reject(
        new Error(`relay entry did not report listening within ${BOOT_TIMEOUT_MS}ms:\n${bootLog}`),
      );
    }, BOOT_TIMEOUT_MS - 2_000);
    const onChunk = (chunk: Buffer): void => {
      bootLog += chunk.toString();
      // The entry's own boot logger emits {"msg":"relay.listening","port":N}.
      for (const line of bootLog.split("\n")) {
        if (!line.includes("relay.listening")) continue;
        try {
          const parsed = JSON.parse(line) as { port?: number };
          if (typeof parsed.port === "number") {
            clearTimeout(timer);
            resolvePort(`http://127.0.0.1:${parsed.port}`);
            return;
          }
        } catch {
          // partial line — keep buffering
        }
      }
    };
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", onChunk);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay entry exited before listening (code ${code}):\n${bootLog}`));
    });
  });
}

describe("booted entry — deployed-behavior security boundaries (#359 activation)", () => {
  beforeAll(async () => {
    baseUrl = await bootRealEntry();
  }, BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (child != null) {
      child.kill("SIGTERM");
      const c = child;
      setTimeout(() => c.kill("SIGKILL"), 5_000).unref();
    }
  });

  it("every applicable security boundary reports STRICT when probed over real HTTP", async () => {
    const results = await probeSecurityBoundaries(baseUrl, { federationEnabled: true });
    // At least the #359 boundary (unsigned federation discover) must be
    // probeable — an empty result set would be a vacuous pass.
    const probed = results.filter((r) => !r.skipped);
    expect(probed.length).toBeGreaterThan(0);
    for (const r of probed) {
      // Repair pointer on failure: the boundary name + envVar identify the
      // registry entry in relay-config.ts; a non-strict observation from the
      // BOOTED entry means the deployed composition lost the default — the
      // #359 class, live.
      expect(r, `${r.boundary} (${r.envVar}): ${r.detail}`).toMatchObject({ strict: true });
    }
  });

  it("the unsigned-discover probe specifically observed the #359 boundary (not a skip)", async () => {
    const results = await probeSecurityBoundaries(baseUrl, { federationEnabled: true });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(discover).toBeDefined();
    expect(discover!.skipped).toBe(false);
    expect(discover!.strict).toBe(true);
  });
});
