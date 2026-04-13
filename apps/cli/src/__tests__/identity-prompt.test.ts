/**
 * promptPassphrase REPL flow tests.
 *
 * Business-logic identity generation (keypair creation, config write,
 * idempotent re-run) is locked by `packages/core-identity/src/__tests__/
 * bootstrap.test.ts`. This file locks the *TTY boundary* — the readline
 * wrapper that prompts the user for a passphrase, masks output, handles
 * tab-to-toggle-visibility, backspace, Ctrl-C, paste, and the fail-safe
 * "always mask before newline" behavior.
 *
 * Why the separation: a bug in the REPL (empty-on-enter, plaintext
 * leaking into scroll history, passphrase echoing during raw mode
 * setup) is a security-shaped regression that `bootstrap.test.ts`
 * cannot catch — that suite tests the crypto + storage, not the
 * terminal UI. Both matter; each gets its own layer.
 *
 * Tests poke at `process.stdin` / `process.stdout` directly because
 * that is what the function under test reaches for. Every test saves
 * the originals, installs a stub, and restores in `afterEach` so the
 * vitest runner's own stdio is never polluted across cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Import _after_ the test runner has settled; the function reads
// `process.stdin` lazily on call, so the import order doesn't matter.
import { promptPassphrase } from "../identity.js";

// ---------------------------------------------------------------------------
// Stdio stubs
// ---------------------------------------------------------------------------

interface StdinStub extends EventEmitter {
  isTTY: boolean;
  setRawMode(mode: boolean): StdinStub;
  setEncoding(enc: string): StdinStub;
  resume(): StdinStub;
  pause(): StdinStub;
  readonly rawMode: boolean;
}

function makeTTYStdinStub(): StdinStub {
  const emitter = new EventEmitter() as StdinStub;
  let rawMode = false;
  emitter.isTTY = true;
  Object.defineProperty(emitter, "rawMode", { get: () => rawMode });
  emitter.setRawMode = (mode: boolean) => {
    rawMode = mode;
    return emitter;
  };
  emitter.setEncoding = () => emitter;
  emitter.resume = () => emitter;
  emitter.pause = () => emitter;
  return emitter;
}

interface StdoutStub {
  readonly writes: string[];
  write(chunk: string): boolean;
  /** Return the concatenation of every chunk written since setup. */
  readonly joined: string;
}

function makeStdoutStub(): StdoutStub {
  const writes: string[] = [];
  return {
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    get joined() {
      return writes.join("");
    },
  };
}

// ---------------------------------------------------------------------------
// Environment install/restore
// ---------------------------------------------------------------------------

interface Installed {
  stdin: StdinStub;
  stdout: StdoutStub;
  restore(): void;
}

function installTTYStdio(): Installed {
  const stdin = makeTTYStdinStub();
  const stdout = makeStdoutStub();
  const origStdin = process.stdin;
  const origWrite = process.stdout.write.bind(process.stdout);
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "write", {
    configurable: true,
    value: ((chunk: string | Buffer) => stdout.write(String(chunk))) as typeof process.stdout.write,
  });
  return {
    stdin,
    stdout,
    restore() {
      Object.defineProperty(process, "stdin", { configurable: true, value: origStdin });
      Object.defineProperty(process.stdout, "write", { configurable: true, value: origWrite });
    },
  };
}

/** Push a single character (or multi-char chunk for paste) to the stub. */
function send(stdin: StdinStub, char: string): void {
  stdin.emit("data", char);
}

// ---------------------------------------------------------------------------
// Tests — TTY path
// ---------------------------------------------------------------------------

describe("promptPassphrase (TTY)", () => {
  let env: Installed;

  beforeEach(() => {
    env = installTTYStdio();
  });

  afterEach(() => {
    env.restore();
  });

  it("resolves with the typed characters and masks them in the output", async () => {
    const p = promptPassphrase("  Set a passphrase: ");
    // Let the initial prompt write hit stdout before typing.
    await Promise.resolve();
    send(env.stdin, "s");
    send(env.stdin, "e");
    send(env.stdin, "c");
    send(env.stdin, "r");
    send(env.stdin, "e");
    send(env.stdin, "t");
    send(env.stdin, "\n");

    const value = await p;
    expect(value).toBe("secret");

    // Prompt text landed.
    expect(env.stdout.joined).toContain("Set a passphrase:");
    // Every typed character became a '*' in output. The raw chars 'secret'
    // must never appear concatenated.
    expect(env.stdout.joined).not.toContain("secret");
    // Count of star echoes equals the length of the password.
    const stars = env.stdout.writes.filter((w) => w === "*").length;
    expect(stars).toBe(6);
    // Raw mode was toggled on and then off.
    expect(env.stdin.rawMode).toBe(false);
  });

  it("backspace removes the last character from the buffer", async () => {
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "a");
    send(env.stdin, "b");
    send(env.stdin, "\u007F"); // DEL
    send(env.stdin, "c");
    send(env.stdin, "\n");

    expect(await p).toBe("ac");
  });

  it("tab toggles visibility; final newline always re-masks", async () => {
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "x");
    send(env.stdin, "\t"); // reveal
    send(env.stdin, "y");
    send(env.stdin, "\n");

    const value = await p;
    expect(value).toBe("xy");
    // After the newline, the last output chunk visible before '\n' must be
    // the masked re-write, not the plaintext 'xy'. The implementation
    // writes '**' as the final masking step.
    const beforeNewline = env.stdout.writes.slice(0, env.stdout.writes.indexOf("\n"));
    // Implementation re-masks on enter: writes '**' after the CSI moves and
    // clear. Assert that at least one all-star chunk of length 2 is present.
    expect(beforeNewline.some((w) => w === "**")).toBe(true);
  });

  it("ignores escape sequences (e.g. arrow keys, bracketed paste markers)", async () => {
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "a");
    send(env.stdin, "\x1b[A"); // up arrow — must be swallowed, not appended
    send(env.stdin, "\x1b[200~"); // bracketed paste start — same
    send(env.stdin, "b");
    send(env.stdin, "\n");

    expect(await p).toBe("ab");
  });

  it("pastes multi-character chunks (each printable char appended)", async () => {
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "pa55word"); // simulated paste: one chunk, many chars
    send(env.stdin, "\n");

    expect(await p).toBe("pa55word");
  });

  it("Ctrl-C exits the process with signal 130 (SIGINT semantic)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__exit__");
    }) as typeof process.exit);

    promptPassphrase("pw: ").catch(() => {
      /* never resolves — process.exit fires first */
    });
    await Promise.resolve();
    expect(() => send(env.stdin, "\u0003")).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(130);

    exitSpy.mockRestore();
  });

  it("accepts \\r (carriage return) as well as \\n", async () => {
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "x");
    send(env.stdin, "\r");

    expect(await p).toBe("x");
  });

  it("empty passphrase resolves as empty string (validation is caller's job)", async () => {
    // The REPL wrapper's sole job is to read a passphrase; empty-check is
    // owned by the caller so different flows (create vs unlock) can handle
    // it differently. This test locks that contract.
    const p = promptPassphrase("pw: ");
    await Promise.resolve();
    send(env.stdin, "\n");

    expect(await p).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests — non-TTY path (piped stdin)
// ---------------------------------------------------------------------------

describe("promptPassphrase (non-TTY / piped)", () => {
  let origStdin: NodeJS.ReadStream;
  let origWrite: typeof process.stdout.write;
  let stdoutStub: StdoutStub;

  beforeEach(() => {
    origStdin = process.stdin;
    origWrite = process.stdout.write.bind(process.stdout);
    stdoutStub = makeStdoutStub();
    Object.defineProperty(process.stdout, "write", {
      configurable: true,
      value: ((chunk: string | Buffer) =>
        stdoutStub.write(String(chunk))) as typeof process.stdout.write,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { configurable: true, value: origStdin });
    Object.defineProperty(process.stdout, "write", { configurable: true, value: origWrite });
  });

  it("reads one line from piped stdin (no masking, no raw mode)", async () => {
    const pipe = Readable.from(["piped-secret\n"]);
    (pipe as unknown as { isTTY: boolean }).isTTY = false;
    Object.defineProperty(process, "stdin", { configurable: true, value: pipe });

    const value = await promptPassphrase("Passphrase: ");
    expect(value).toBe("piped-secret");
    // Prompt text still prints to stdout (useful when the command is run
    // in a shell with piped stdin but interactive stdout).
    expect(stdoutStub.joined).toContain("Passphrase: ");
    // No mask characters on the non-TTY path.
    expect(stdoutStub.writes.filter((w) => w === "*").length).toBe(0);
  });

  it("returns an empty string when piped stdin is just a blank line", async () => {
    const pipe = Readable.from(["\n"]);
    (pipe as unknown as { isTTY: boolean }).isTTY = false;
    Object.defineProperty(process, "stdin", { configurable: true, value: pipe });

    expect(await promptPassphrase("Passphrase: ")).toBe("");
  });
});
