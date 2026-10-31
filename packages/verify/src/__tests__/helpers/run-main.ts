/**
 * Drive the real `motebit-verify` entry point IN-PROCESS.
 *
 * `cli.ts` runs `main()` only when it is the process entry point
 * (`isMainModule(import.meta.url, process.argv[1])`). The subprocess suites
 * (`spawnSync("npx", ["tsx", cli.ts, ...])`) exercise that path end-to-end but
 * are invisible to v8 coverage in the test process. This helper reproduces the
 * entry-point condition inside the test process instead: it points
 * `process.argv[1]` at `cli.ts`, re-evaluates the module (`vi.resetModules()` +
 * dynamic import), and captures what the real `main()` writes and the code it
 * hands to `process.exit`. Nothing in `cli.ts` is mocked — the argv parser,
 * the command bodies, `@motebit/verifier`, `@motebit/crypto` and the hardware
 * adapters all run for real. Only the process boundary (stdout, stderr, exit)
 * is intercepted, because that boundary IS the CLI's observable contract.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_SRC = resolve(HERE, "..", "..", "cli.ts");

export interface MainRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

/** Run `motebit-verify <args...>` in-process; resolves when `main()` calls `process.exit`. */
export async function runMain(args: readonly string[]): Promise<MainRun> {
  vi.resetModules();
  const originalArgv = process.argv;
  let stdout = "";
  let stderr = "";
  let settle!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    settle = r;
  });
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += chunkToString(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += chunkToString(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    settle(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);
  process.argv = [originalArgv[0]!, CLI_SRC, ...args];
  try {
    await import("../../cli.js");
    const code = await exited;
    return { code, stdout, stderr };
  } finally {
    process.argv = originalArgv;
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
}
