/**
 * The runtime-host election: first process to bind the canonical socket
 * coordinates; everyone else attaches (`docs/doctrine/
 * daemon-desktop-unification.md`).
 *
 * Order of operations is attach-first: a live coordinator answering the
 * socket is the common case and the cheapest probe. Only a socket that
 * refuses connections (no listener bound to that path — a live listener
 * would accept) is takeover territory, and the PID lockfile then
 * adjudicates "crashed coordinator, take over now" vs "coordinator
 * mid-boot, give it a beat". The bind itself is the truth: a lost race
 * surfaces as EADDRINUSE and the loser attaches.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { isPidAlive, readLockfile } from "./lockfile.js";
import { AttachRefusedError, CoordinatorUnreachableError, RuntimeHostClient } from "./client.js";
import {
  CoordinatorAlreadyBoundError,
  RuntimeHostServer,
  type RuntimeHostServerOptions,
} from "./server.js";

export type ElectionOutcome =
  | { role: "coordinator"; server: RuntimeHostServer }
  | { role: "frontend"; client: RuntimeHostClient };

export interface ElectRuntimeHostOptions extends RuntimeHostServerOptions {
  /**
   * Fresh attach token per attempt (`mintAttachToken`) — tokens are
   * short-TTL by design, so the election mints lazily rather than
   * accepting one that may expire across retries.
   */
  mintToken: () => Promise<string>;
  /** Bind/attach race + mid-boot grace iterations. Default 4. */
  maxAttempts?: number;
  /** Delay between iterations. Default 150ms. */
  retryDelayMs?: number;
  /** Test seam for the PID liveness probe. */
  probePid?: (pid: number) => boolean;
}

function isWindowsPipe(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Does anything accept connections on the socket right now? Exported as a test seam. */
export function probeSocketLive(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Serialize the takeover critical section (unlink stale socket + bind)
 * behind an atomic `mkdir`. Without this, two simultaneous starters can
 * both observe connect-refused, and the slower one's unlink removes the
 * winner's *just-bound live* socket — orphaning a coordinator and
 * binding a second one at the same path. The mkdir is atomic on POSIX
 * and Windows; a crashed holder is recovered by the PID probe.
 * Exported as a test seam.
 */
export function acquireTakeoverMutex(
  mutexDir: string,
  pid: number,
  probePid: (pid: number) => boolean,
): boolean {
  mkdirSync(dirname(mutexDir), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i += 1) {
    try {
      mkdirSync(mutexDir);
      writeFileSync(join(mutexDir, "pid"), String(pid), { mode: 0o600 });
      return true;
    } catch {
      let holderPid = Number.NaN;
      try {
        holderPid = Number(readFileSync(join(mutexDir, "pid"), "utf8").trim());
      } catch {
        // Holder mid-write or crashed pre-write; treat as live this round.
        return false;
      }
      if (Number.isInteger(holderPid) && holderPid > 0 && probePid(holderPid)) return false;
      try {
        rmSync(mutexDir, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseTakeoverMutex(mutexDir: string): void {
  try {
    rmSync(mutexDir, { recursive: true, force: true });
  } catch {
    // A stale mutex is recovered by the PID probe on the next election.
  }
}

/**
 * Run the election. Resolves to exactly one of coordinator (this
 * process bound the socket and must serve until `server.close()`) or
 * frontend (attached to a live coordinator).
 *
 * Throws `AttachRefusedError` untouched — a live coordinator refusing
 * the handshake (version skew, auth) is an answer, not an invitation
 * to bind over it. Throws a plain error if the election fails to
 * converge within `maxAttempts`.
 */
export async function electRuntimeHost(opts: ElectRuntimeHostOptions): Promise<ElectionOutcome> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const retryDelayMs = opts.retryDelayMs ?? 150;
  const probePid = opts.probePid ?? isPidAlive;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 1. Attach to a live coordinator if one answers.
    try {
      const client = await RuntimeHostClient.attach({
        socketPath: opts.socketPath,
        token: await opts.mintToken(),
        handshakeTimeoutMs: opts.handshakeTimeoutMs,
      });
      return { role: "frontend", client };
    } catch (err) {
      if (err instanceof AttachRefusedError) throw err;
      if (!(err instanceof CoordinatorUnreachableError)) {
        throw new Error(
          `runtime-host attach failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      lastError = err;
    }

    // 2. Nothing answered. A lockfile naming a live PID may be a
    //    coordinator mid-boot — give it a beat before takeover.
    const lock = readLockfile(opts.lockfilePath);
    if (lock !== null && probePid(lock.pid) && attempt < maxAttempts) {
      await sleep(retryDelayMs);
      continue;
    }

    // 3. Takeover. The unlink + bind pair is a critical section: it
    //    must be held by exactly one process, and the socket's deadness
    //    must be re-verified *inside* it — a connect-refused observed
    //    before the mutex may be stale by the time we hold it.
    const mutexDir = `${opts.lockfilePath}.takeover`;
    const pid = opts.pid ?? process.pid;
    if (!acquireTakeoverMutex(mutexDir, pid, probePid)) {
      // Another process is mid-takeover; it will be attachable shortly.
      await sleep(retryDelayMs);
      continue;
    }
    try {
      if (await probeSocketLive(opts.socketPath, retryDelayMs * 2)) {
        // A coordinator bound between our probe and the mutex — attach
        // on the next iteration, never unlink a live socket.
        continue;
      }
      if (!isWindowsPipe(opts.socketPath)) {
        try {
          rmSync(opts.socketPath, { force: true });
        } catch {
          // Bind will tell the truth either way.
        }
      }
      const server = await RuntimeHostServer.bind(opts);
      return { role: "coordinator", server };
    } catch (err) {
      if (err instanceof CoordinatorAlreadyBoundError) {
        // Lost a race the mutex doesn't cover (Windows pipes have no
        // unlink step); the winner is live — attach on the next
        // iteration.
        lastError = err;
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    } finally {
      releaseTakeoverMutex(mutexDir);
    }
  }

  throw new Error(
    `runtime-host election did not converge after ${maxAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError },
  );
}
