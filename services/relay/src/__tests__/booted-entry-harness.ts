/**
 * Shared boot harness for BOOTED-ARTIFACT activation suites
 * (docs/doctrine/composition-preserves-enforcement.md).
 *
 * Spawns a real deployed entry — the tsx source rung or the compiled
 * `dist/server.js` rung (the exact command `run.sh`, `package.json#start`,
 * and the DEPLOY.md systemd unit all exec) — as a child process with a
 * production-shaped STRICT env, and resolves when the entry's own boot
 * logger reports `relay.listening`. Consumers probe it over real HTTP.
 *
 * The strict base env carries NO security-boundary overrides, and ambient
 * overrides are DELETED (not empty-stringed) so a dev shell exporting an
 * opt-out cannot leak into the child's resolution. Suites layer their own
 * additions (e.g. an operator master token for provisioning) via
 * `envOverrides` — additions only; the deletions always win.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(HERE, "..", "server.ts");
const DIST_ENTRY = resolve(HERE, "..", "..", "dist", "server.js");
export const BOOT_TIMEOUT_MS = 60_000;

export interface EntryTier {
  /** Which rung of the booted-artifact ladder this is. */
  name: string;
  command: string;
  args: string[];
  /** Throws with a repair instruction when the rung's input is absent. */
  precondition?: () => void;
}

export const SOURCE_TIER: EntryTier = {
  name: "source entry (tsx src/server.ts)",
  command: "npx",
  args: ["--yes", "tsx", SERVER_ENTRY],
};

export const DIST_TIER: EntryTier = {
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
};

export interface BootedEntry {
  child: ChildProcess;
  baseUrl: string;
}

/** Spawn a real deployed entry and resolve when it reports listening. */
export function bootRealEntry(
  tier: EntryTier,
  envOverrides: Record<string, string> = {},
): Promise<BootedEntry> {
  tier.precondition?.();
  return new Promise((resolveBooted, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000000",
      MOTEBIT_FEDERATION_ENDPOINT_URL: "https://relay-under-test.example/federation",
      PORT: "0", // ephemeral — the entry logs the real bound port
      NODE_ENV: "test",
      ...envOverrides,
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

/** SIGTERM with a SIGKILL backstop — standard afterAll teardown. */
export function killBootedEntry(booted: BootedEntry | null): void {
  if (booted != null) {
    const c = booted.child;
    c.kill("SIGTERM");
    setTimeout(() => c.kill("SIGKILL"), 5_000).unref();
  }
}
