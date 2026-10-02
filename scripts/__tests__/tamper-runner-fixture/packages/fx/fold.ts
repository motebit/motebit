// A typed module the tamper-runner type-checks (tsconfig.json here): an edit
// tsc rejects (c.add -> c.addd, TS2551) still loads, and throws a TypeError.
export interface Combiner {
  add(a: number, b: number): number;
}

export const plus: Combiner = { add: (a, b) => a + b };

export function fold(c: Combiner, xs: number[]): number {
  let acc = 0;
  for (const x of xs) acc = c.add(acc, x);
  return acc;
}
