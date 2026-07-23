/**
 * BOOTED-ARTIFACT activation conformance for #359 — the booted-artifact tier
 * of docs/doctrine/composition-preserves-enforcement.md (Inc 3b + Inc 4).
 *
 * #359 was a shadow at the deployed ENTRY: the discover-signature sunset was
 * law in `federation.ts`, green in every test — and inert in production
 * because `server.ts` shadowed the constant. The #360 response reduced the
 * seam (server.ts is now a thin entry whose composition IS
 * `createSyncRelay(buildRelayConfigFromEnv(process.env, …))`) and gated it
 * statically (`check-security-default-wiring`). What remained unproven is the
 * activation claim itself: that the PROCESS a deployment actually starts —
 * through its real entry composition, real env resolution, real HTTP
 * listener — enforces the strict boundary observed from OUTSIDE.
 *
 * The tier is a two-rung ladder over the SAME probe:
 *
 *  - Rung 1 (Inc 3b) — SOURCE entry: `src/server.ts` via tsx. Proves the
 *    entry's composition enforces the boundary.
 *  - Rung 2 (Inc 4) — COMPILED artifact: `node dist/server.js`, the exact
 *    command `run.sh`, `package.json#start`, and the DEPLOY.md systemd unit
 *    all exec. Proves the ARTIFACT a deployment boots enforces it — a defect
 *    present only in the built output (stale/corrupted emit, build-pipeline
 *    drift) is invisible to rung 1 and red here.
 *
 * Keeping both rungs is deliberate: a rung-1-green / rung-2-red differential
 * localizes the fault to the build step. Freshness of `dist/` is guaranteed
 * by turbo's `test` → `build` dependency in the canonical pipeline; the
 * beforeAll existence check carries the repair instruction for anyone
 * running vitest directly.
 *
 * Each rung spawns its entry as a child process with a production-shaped
 * strict env (no security overrides), waits for the real `relay.listening`
 * line, and runs `probeSecurityBoundaries` — the same deployed-behavior
 * probe an operator runs against prod — over real HTTP against it. Every
 * applicable boundary must report strict.
 *
 * Discriminating power (severing runs, recorded in the PRs):
 *  - Inc 3b: perturbing server.ts to shadow the built config
 *    (`requireDiscoverSignature = false` between builder and createSyncRelay
 *    — the #359 diff-shape at today's seam) turns both rungs red: the
 *    unsigned-discover probe observes non-403.
 *  - Inc 4: applying the SAME shadow to `dist/server.js` only (an
 *    artifact-not-source defect) leaves rung 1 green and turns rung 2 red —
 *    the detection surface this rung uniquely adds.
 * The positive tests are the permanent guard; the severing runs are the
 * one-time proof they discriminate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSecurityBoundaries } from "../relay-config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(HERE, "..", "server.ts");
const DIST_ENTRY = resolve(HERE, "..", "..", "dist", "server.js");
const BOOT_TIMEOUT_MS = 60_000;

interface EntryTier {
  /** Which rung of the booted-artifact ladder this is. */
  name: string;
  command: string;
  args: string[];
  /** Throws with a repair instruction when the rung's input is absent. */
  precondition?: () => void;
}

const TIERS: EntryTier[] = [
  {
    name: "source entry (tsx src/server.ts)",
    command: "npx",
    args: ["--yes", "tsx", SERVER_ENTRY],
  },
  {
    name: "compiled artifact (node dist/server.js — the run.sh exec line)",
    command: process.execPath,
    args: [DIST_ENTRY],
    precondition: () => {
      if (!existsSync(DIST_ENTRY)) {
        throw new Error(
          `${DIST_ENTRY} is missing — this rung boots the COMPILED artifact. ` +
            `Run \`pnpm --filter @motebit/relay build\` first; the canonical ` +
            `pipeline (turbo test → build dependency) does this for you.`,
        );
      }
    },
  },
];

interface BootedEntry {
  child: ChildProcess;
  baseUrl: string;
}

/** Spawn a real deployed entry and resolve when it reports listening. */
function bootRealEntry(tier: EntryTier): Promise<BootedEntry> {
  return new Promise((resolveBooted, reject) => {
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
    let bootLog = "";
    const child = spawn(tier.command, tier.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      reject(
        new Error(`${tier.name} did not report listening within ${BOOT_TIMEOUT_MS}ms:\n${bootLog}`),
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
            resolveBooted({ child, baseUrl: `http://127.0.0.1:${parsed.port}` });
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
      reject(new Error(`${tier.name} exited before listening (code ${code}):\n${bootLog}`));
    });
  });
}

for (const tier of TIERS) {
  describe(`booted entry — deployed-behavior security boundaries (#359 activation) — ${tier.name}`, () => {
    let booted: BootedEntry | null = null;

    beforeAll(async () => {
      tier.precondition?.();
      booted = await bootRealEntry(tier);
    }, BOOT_TIMEOUT_MS);

    afterAll(() => {
      if (booted != null) {
        const c = booted.child;
        c.kill("SIGTERM");
        setTimeout(() => c.kill("SIGKILL"), 5_000).unref();
      }
    });

    it("every applicable security boundary reports STRICT when probed over real HTTP", async () => {
      const results = await probeSecurityBoundaries(booted!.baseUrl, { federationEnabled: true });
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
      const results = await probeSecurityBoundaries(booted!.baseUrl, { federationEnabled: true });
      const discover = results.find(
        (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
      );
      expect(discover).toBeDefined();
      expect(discover!.skipped).toBe(false);
      expect(discover!.strict).toBe(true);
    });
  });
}
