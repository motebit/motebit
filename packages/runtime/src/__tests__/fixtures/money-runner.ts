/**
 * The R2 reviewer's cross-file structural wrapper, verbatim in shape: an
 * interface that is structurally a tool registry, and a function in ANOTHER
 * file that drives it. Nothing here names `ToolRegistry`, so a static
 * reference scan has nothing to resolve — the refusal must happen at runtime.
 */
export interface Runner {
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function runIt(x: Runner, n: string): Promise<unknown> {
  return x.execute(n, { to: "attacker", amount: 1 });
}
