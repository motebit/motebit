/**
 * The platform seam: everything OS-shaped the runtime-host protocol
 * needs, behind one injected interface. The protocol, handshake
 * verification, election logic, and bridging all stay in this package
 * as the single implementation; platforms only move bytes and touch
 * the filesystem.
 *
 * Two implementations today: node (`@motebit/runtime-host/node` —
 * node:net unix sockets / Windows named pipes + node:fs) and the
 * desktop's Tauri bridge (webview-side adapter over dumb Rust pipe
 * commands — the webview has no Node APIs, so the Rust side owns the
 * socket as transport while ALL protocol logic runs in TS;
 * `docs/doctrine/daemon-desktop-unification.md`).
 */

/** One bidirectional framed byte stream (a socket, a piped channel). */
export interface FrameConnection {
  /** Write raw protocol bytes (already `\n`-framed by the caller). */
  send(data: string): void;
  /**
   * Receive raw inbound bytes. `Uint8Array` chunks may split UTF-8
   * sequences mid-character — `JsonLineDecoder` handles streaming
   * decode. String chunks must be whole UTF-8 (the Tauri pipe delivers
   * complete lines).
   */
  onData(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
  /** Flush pending writes, then close gracefully (refusals must land). */
  end(): void;
  destroy(): void;
  readonly destroyed: boolean;
}

/** A bound coordinator endpoint accepting frame connections. */
export interface FrameListener {
  onConnection(cb: (conn: FrameConnection) => void): void;
  close(): Promise<void>;
}

export interface RuntimeHostPlatform {
  /** This process's pid — lockfile + takeover-mutex identity. */
  readonly pid: number;
  /**
   * Connect to the endpoint. Resolves null when nothing accepts
   * (absent path, connect-refused, or timeout) — the election's
   * "unreachable" signal. Throws only on unexpected platform failure.
   */
  connect(socketPath: string, timeoutMs: number): Promise<FrameConnection | null>;
  /**
   * Bind the endpoint (unix sockets: mode 0600). Resolves "in_use"
   * when another listener holds it. NEVER unlinks — stale-socket
   * clearing is the election's critical section, not the binder's.
   */
  bind(socketPath: string): Promise<FrameListener | "in_use">;
  /** Remove a verified-stale socket file (no-op for named pipes). */
  removeSocketFile(socketPath: string): Promise<void>;
  /** Read a small file; null on absence or unreadability. */
  readFile(path: string): Promise<string | null>;
  /** Write mode 0600, creating the parent directory (0700) if needed. */
  writeFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /**
   * Atomic exclusive directory create (parent created first) — the
   * takeover-mutex primitive. "exists" when already held.
   */
  mkdirExclusive(path: string): Promise<"created" | "exists">;
  removeDir(path: string): Promise<void>;
  /** PID liveness probe; permission-denied counts as alive. */
  isPidAlive(pid: number): Promise<boolean>;
}
