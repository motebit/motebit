/**
 * check-turbo-remote-cache — THE LAW (#997 round 2). Deny-by-default over a
 * copy of this repository: every row of the mutation table (the shapes the
 * round-2 cold review reproduced passing the gate, and their siblings) must
 * turn the gate RED, and the unmutated copy must stay green.
 */
import { rmSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runTurboRemoteCacheGate } from "../check-turbo-remote-cache.js";
import { copyRepo, MUTATIONS } from "./turbo-remote-cache-mutations.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = (): string => {
  const d = copyRepo();
  dirs.push(d);
  return d;
};

describe("the law, on a copy of this repository", () => {
  it("control: the unmutated copy is green", () => {
    expect(runTurboRemoteCacheGate(fresh()).violations).toEqual([]);
  });

  it.each(MUTATIONS.map((m) => [m.id, m] as const))("%s turns the gate RED", (_id, m) => {
    const d = fresh();
    m.apply(d);
    expect(runTurboRemoteCacheGate(d).violations, m.shape).not.toEqual([]);
  });
});
