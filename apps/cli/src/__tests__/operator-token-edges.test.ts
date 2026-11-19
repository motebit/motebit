/**
 * Operator token per relay — the cases the per-site rows do not cover:
 *
 *   4c  `federation peer <B>` with A's token bound to A: B gets no operator token
 *   6   `federation mesh` with one relay bound; and `MOTEBIT_MESH_TOKENS` unchanged
 *   7   `/connect` refuses on a token being SET, bound or not
 *   10  redirects: a bound relay cannot hand the token to another origin
 *   11  no relay URL: `credentials` and `export` resolve no auth at all
 *
 * The CLI runs from source as a subprocess against fake relays on 127.0.0.1
 * (`operator-token.probe.ts`).
 *
 * Tamper: scripts/tampers/cli-operator-token-per-relay.ts
 */
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: nothing here reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "mb-ot-edges-"));
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN", "PROBE_OUT"])
    delete process.env[k];
});

import {
  authKind,
  createEphemeralIdentity,
  removeEphemeralIdentities,
  replLine,
  spawnCli,
  startFakeRelay,
  TOKEN_A,
  TOKEN_B,
  waitForPrompt,
  writeTokenRecord,
  type EphemeralIdentity,
  type FakeRelay,
} from "./operator-token.probe.js";

vi.setConfig({ testTimeout: 180_000 });

afterAll(() => removeEphemeralIdentities());

const CONFIRM = "POST /api/v1/admin/federation/peer-confirm-signature";

/** Run the CLI to completion; returns its exit code and output. */
async function run(
  args: string[],
  identity: EphemeralIdentity,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; output: string }> {
  const cli = spawnCli(args, { identity, env });
  const code = await Promise.race([
    cli.exited,
    new Promise<null>((r) => setTimeout(() => r(null), 120_000)),
  ]);
  await cli.stop();
  return { code, output: cli.output() };
}

async function relays(n: number): Promise<FakeRelay[]> {
  return Promise.all(Array.from({ length: n }, () => startFakeRelay()));
}

async function closeAll(rs: FakeRelay[]): Promise<void> {
  await Promise.all(rs.map((r) => r.close()));
}

describe.concurrent("federation peer: the peer never gets our operator token (4c)", () => {
  it("A's token bound to A, no peer variable: B receives no operator token; A mints its confirm on it", async () => {
    const [a, b] = (await relays(2)) as [FakeRelay, FakeRelay];
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [a.url]: TOKEN_A });
    try {
      const r = await run(["federation", "peer", b.url, "--sync-url", a.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(b.sightings(TOKEN_A), r.output).toEqual([]);
      expect(
        b.requests.map((q) => authKind(q)),
        r.output,
      ).not.toContain("operator");
      expect(b.requests.length, r.output).toBeGreaterThan(0);
      expect(a.sightings(TOKEN_A), r.output).toEqual([CONFIRM]);
    } finally {
      await closeAll([a, b]);
    }
  });

  it("with MOTEBIT_PEER_API_TOKEN: the peer receives THAT token, as before, and never ours", async () => {
    const [a, b] = (await relays(2)) as [FakeRelay, FakeRelay];
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [a.url]: TOKEN_A });
    try {
      const r = await run(["federation", "peer", b.url, "--sync-url", a.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
        // The peer's token is named for the peer typed in this command: unbound by design.
        MOTEBIT_PEER_API_TOKEN: TOKEN_B,
      });
      expect(b.sightings(TOKEN_B), r.output).toEqual([CONFIRM]);
      expect(b.sightings(TOKEN_A), r.output).toEqual([]);
      expect(a.sightings(TOKEN_A), r.output).toEqual([CONFIRM]);
      expect(a.sightings(TOKEN_B), r.output).toEqual([]);
    } finally {
      await closeAll([a, b]);
    }
  });
});

describe.concurrent("federation mesh (6)", () => {
  it("three relays, the token bound to one: only that relay receives it; the others get the device token", async () => {
    const [r1, r2, r3] = (await relays(3)) as [FakeRelay, FakeRelay, FakeRelay];
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [r2.url]: TOKEN_A });
    try {
      const r = await run(["federation", "mesh", r1.url, r2.url, r3.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(r2.sightings(TOKEN_A).length, r.output).toBeGreaterThan(0);
      expect(r1.sightings(TOKEN_A), r.output).toEqual([]);
      expect(r3.sightings(TOKEN_A), r.output).toEqual([]);
      for (const other of [r1, r3]) {
        const confirms = other.requests.filter((q) => q.path.endsWith("/peer-confirm-signature"));
        expect(confirms.length, r.output).toBeGreaterThan(0);
        expect(new Set(confirms.map((q) => authKind(q))), r.output).toEqual(new Set(["device"]));
      }
      expect(r.output).toContain("3/3 pair(s) active");
    } finally {
      await closeAll([r1, r2, r3]);
    }
  });

  it("every relay bound: no passphrase is asked for (the device token is never minted)", async () => {
    const [r1, r2] = (await relays(2)) as [FakeRelay, FakeRelay];
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [r1.url]: TOKEN_A, [r2.url]: TOKEN_A });
    try {
      const r = await run(["federation", "mesh", r1.url, r2.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
        // No passphrase available: a mint would have to prompt, on a closed stdin.
        MOTEBIT_PASSPHRASE: undefined,
      });
      expect(r.code, r.output).toBe(0);
      expect(r.output).not.toContain("Passphrase");
      expect(r.output).not.toContain("could not mint");
      expect(r1.sightings(TOKEN_A).length, r.output).toBeGreaterThan(0);
      expect(r2.sightings(TOKEN_A).length, r.output).toBeGreaterThan(0);
    } finally {
      await closeAll([r1, r2]);
    }
  });

  it("MOTEBIT_MESH_TOKENS: each relay receives its own positional token, as before, and never the configured one", async () => {
    const [r1, r2, r3] = (await relays(3)) as [FakeRelay, FakeRelay, FakeRelay];
    const identity = await createEphemeralIdentity();
    // The configured token is even bound to r2: a positional token still wins.
    writeTokenRecord(identity.configDir, { [r2.url]: TOKEN_A });
    const positional = ["mesh-token-one", "mesh-token-two", "mesh-token-three"];
    try {
      const r = await run(["federation", "mesh", r1.url, r2.url, r3.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
        MOTEBIT_MESH_TOKENS: positional.join(","),
        MOTEBIT_PASSPHRASE: undefined,
      });
      for (const [i, relay] of [r1, r2, r3].entries()) {
        expect(relay.sightings(positional[i]!).length, r.output).toBeGreaterThan(0);
        expect(relay.sightings(TOKEN_A), r.output).toEqual([]);
        for (const [j, tok] of positional.entries()) {
          if (j !== i) expect(relay.sightings(tok), r.output).toEqual([]);
        }
      }
      expect(r.code, r.output).toBe(0);
    } finally {
      await closeAll([r1, r2, r3]);
    }
  });
});

describe.concurrent("/connect refuses on an operator token being set, bound or not (7)", () => {
  for (const boundToTarget of [false, true]) {
    it(`a session with no relay, a token ${boundToTarget ? "BOUND to the relay named" : "bound to nothing"}: /connect sends nothing and says why`, async () => {
      const [x] = (await relays(1)) as [FakeRelay];
      const identity = await createEphemeralIdentity();
      writeTokenRecord(identity.configDir, boundToTarget ? { [x.url]: TOKEN_A } : {});
      const cli = spawnCli(["--provider", "local-server"], {
        identity,
        env: { MOTEBIT_API_TOKEN: TOKEN_A },
        stdin: "open",
      });
      try {
        expect(await waitForPrompt(cli), cli.output()).toBe(true);
        await replLine(cli, `/connect ${x.url}`, () => false);
        const out = cli.output();
        expect(out).toContain("An operator token is set for this session (MOTEBIT_API_TOKEN)");
        expect(out).toContain("/connect does not send an operator token");
        expect(x.requests, out).toEqual([]);
        expect(x.firstFrames, out).toEqual([]);
        expect(out).not.toContain(TOKEN_A);
      } finally {
        await cli.stop();
        await x.close();
      }
    });
  }
});

describe.concurrent("redirects (10)", () => {
  it("a bound relay answering 307 to ANOTHER origin: the token is not forwarded", async () => {
    const elsewhere = await startFakeRelay();
    const relay = await startFakeRelay({
      respond: (req) =>
        req.path.endsWith("/balance")
          ? { status: 307, headers: { Location: `${elsewhere.url}${req.path}` } }
          : undefined,
    });
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [relay.url]: TOKEN_A });
    try {
      const r = await run(["balance", "--sync-url", relay.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(relay.sightings(TOKEN_A).length, r.output).toBeGreaterThan(0);
      expect(elsewhere.requests.length, r.output).toBeGreaterThan(0);
      expect(elsewhere.sightings(TOKEN_A), r.output).toEqual([]);
      expect(
        elsewhere.requests.map((q) => q.authorization),
        r.output,
      ).toEqual(elsewhere.requests.map(() => undefined));
    } finally {
      await closeAll([relay, elsewhere]);
    }
  });

  it("a bound relay answering 307 to another PATH on its own origin: the token goes with it", async () => {
    const relay: FakeRelay = await startFakeRelay({
      respond: (req) =>
        req.path.endsWith("/balance")
          ? { status: 307, headers: { Location: "/moved" } }
          : undefined,
    });
    const identity = await createEphemeralIdentity();
    writeTokenRecord(identity.configDir, { [relay.url]: TOKEN_A });
    try {
      const r = await run(["balance", "--sync-url", relay.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(relay.sightings(TOKEN_A), r.output).toContain("GET /moved");
    } finally {
      await relay.close();
    }
  });
});

describe.concurrent("no relay URL: no auth is resolved at all (11)", () => {
  it("credentials, local only: no request, no prompt, and the token is not consulted", async () => {
    const [a] = (await relays(1)) as [FakeRelay];
    const identity = await createEphemeralIdentity();
    // The saved config names a relay; `credentials` reads the flag and the variable only.
    identity.patchConfig({ sync_url: a.url });
    try {
      const r = await run(["credentials"], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
        // No passphrase available: unlocking the key would have to prompt.
        MOTEBIT_PASSPHRASE: undefined,
      });
      expect(r.code, r.output).toBe(0);
      expect(a.requests, r.output).toEqual([]);
      expect(r.output).not.toContain("Passphrase");
      // An unbound token that had been resolved for any URL would be announced.
      expect(r.output).not.toContain("was not sent");
      expect(r.output).toContain("No credentials found");
    } finally {
      await a.close();
    }
  });

  it("export: no request and the token is not consulted (it unlocks its own key, as in every build)", async () => {
    const [a] = (await relays(1)) as [FakeRelay];
    const identity = await createEphemeralIdentity();
    identity.patchConfig({ sync_url: a.url });
    try {
      const r = await run(["export", "--output", path.join(identity.workDir, "out")], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(r.code, r.output).toBe(0);
      expect(a.requests, r.output).toEqual([]);
      expect(r.output).not.toContain("was not sent");
      expect(r.output).toContain("credentials (no relay URL)");
    } finally {
      await a.close();
    }
  });

  it("with a relay named, the same commands DO resolve it (the control for the two above)", async () => {
    const [a] = (await relays(1)) as [FakeRelay];
    const identity = await createEphemeralIdentity();
    try {
      const r = await run(["credentials", "--sync-url", a.url], identity, {
        MOTEBIT_API_TOKEN: TOKEN_A,
      });
      expect(r.output).toContain("was not sent");
      expect(a.requests.length, r.output).toBeGreaterThan(0);
    } finally {
      await a.close();
    }
  });
});
