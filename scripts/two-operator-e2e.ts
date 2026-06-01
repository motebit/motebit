/**
 * Day-1 two-operator federation E2E — the "second relay operator" sprint, fast filter.
 *
 * Boots TWO independent relays in one box (separate identity keys → separate
 * treasuries, separate DBs, separate admin tokens, separate ports), peers them
 * over real localhost HTTP via the signed handshake, and asserts:
 *   1. They federate with NO shared admin token (the load-bearing day-1 unknown).
 *   2. Each ends in mutually-active peering.
 *
 * This is the loopback fast-filter. Day 2 swaps the in-script boot for two
 * `motebit relay up` processes on a separate cloud account + the signed
 * container (`cosign verify ghcr.io/motebit/relay`), and settles on testnet.
 *
 * PHASE 2 (TODO, next layer): register a worker on B, delegate a paid task from
 * A across the federation, settle over the virtual-account path, assert the 5%
 * fee leg, reconcile BOTH treasuries. Grounded by this running foundation.
 *
 * Run: npx tsx scripts/two-operator-e2e.ts
 */
import { serve } from "@hono/node-server";
import { createSyncRelay, type SyncRelay } from "@motebit/relay";
import { rmSync } from "node:fs";

const A = {
  port: 8801,
  db: "/tmp/motebit-op-a.sqlite",
  token: "ADMIN-TOKEN-OPERATOR-A",
  name: "Operator A",
};
const B = {
  port: 8802,
  db: "/tmp/motebit-op-b.sqlite",
  token: "ADMIN-TOKEN-OPERATOR-B",
  name: "Operator B",
};
const url = (p: number) => `http://127.0.0.1:${p}`;

function cleanDbs() {
  for (const f of [A.db, B.db])
    for (const ext of ["", "-wal", "-shm"]) rmSync(f + ext, { force: true });
}

async function boot(op: typeof A): Promise<{ relay: SyncRelay; close: () => void }> {
  const relay = await createSyncRelay({
    dbPath: op.db,
    apiToken: op.token, // distinct per operator — the whole point
    // Testnet x402 config (no real funds / CDP creds needed); virtual-account
    // settlement is what day 1 exercises, not x402.
    x402: {
      payToAddress: "0x000000000000000000000000000000000000dEaD",
      network: "eip155:84532",
      testnet: true,
    },
    platformFeeRate: 0.05,
    federation: {
      displayName: op.name,
      endpointUrl: url(op.port),
      enabled: true,
      allowedPeers: [],
    },
  });
  const server = serve({ fetch: relay.app.fetch, port: op.port });
  return { relay, close: () => server.close() };
}

async function waitReady(port: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url(port)}/health/ready`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`relay on :${port} never became ready`);
}

const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
async function j(method: string, base: number, path: string, body?: unknown) {
  const r = await fetch(`${url(base)}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

/** Bilateral signed handshake over real HTTP — NO admin token anywhere. */
async function handshake() {
  const idA = (await j("GET", A.port, "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };
  const idB = (await j("GET", B.port, "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };

  // A proposes to B → B returns its nonce N_B (that A must sign).
  const nB = (
    await j("POST", B.port, "/federation/v1/peer/propose", {
      relay_id: idA.relay_motebit_id,
      public_key: idA.public_key,
      endpoint_url: url(A.port),
      display_name: A.name,
      nonce: rand(),
    })
  ).body as { nonce: string };
  // B proposes to A → A returns N_A.
  const nA = (
    await j("POST", A.port, "/federation/v1/peer/propose", {
      relay_id: idB.relay_motebit_id,
      public_key: idB.public_key,
      endpoint_url: url(B.port),
      display_name: B.name,
      nonce: rand(),
    })
  ).body as { nonce: string };
  // A signs "A.id:N_B" (self-propose to A with B's nonce).
  const sigA = (
    await j("POST", A.port, "/federation/v1/peer/propose", {
      relay_id: idA.relay_motebit_id,
      public_key: idA.public_key,
      endpoint_url: url(A.port),
      nonce: nB.nonce,
    })
  ).body as { challenge: string };
  // B signs "B.id:N_A".
  const sigB = (
    await j("POST", B.port, "/federation/v1/peer/propose", {
      relay_id: idB.relay_motebit_id,
      public_key: idB.public_key,
      endpoint_url: url(B.port),
      nonce: nA.nonce,
    })
  ).body as { challenge: string };
  // Confirm each side.
  const cB = await j("POST", B.port, "/federation/v1/peer/confirm", {
    relay_id: idA.relay_motebit_id,
    challenge_response: sigA.challenge,
  });
  const cA = await j("POST", A.port, "/federation/v1/peer/confirm", {
    relay_id: idB.relay_motebit_id,
    challenge_response: sigB.challenge,
  });
  return { idA, idB, confirmA: cA.status, confirmB: cB.status };
}

async function main() {
  cleanDbs();
  console.log("→ booting two independent relays (distinct identities, DBs, admin tokens, ports)…");
  const a = await boot(A);
  const b = await boot(B);
  try {
    await Promise.all([waitReady(A.port), waitReady(B.port)]);
    console.log("  ✓ both relays ready");

    console.log("→ bilateral signed handshake over real HTTP (no shared admin token)…");
    const hs = await handshake();
    console.log(
      `  A=${hs.idA.relay_motebit_id.slice(0, 12)}…  B=${hs.idB.relay_motebit_id.slice(0, 12)}…  confirmA=${hs.confirmA} confirmB=${hs.confirmB}`,
    );

    const peersA = (await j("GET", A.port, "/federation/v1/peers")).body as {
      peers: Array<{ peer_relay_id: string; state?: string }>;
    };
    const peersB = (await j("GET", B.port, "/federation/v1/peers")).body as {
      peers: Array<{ peer_relay_id: string; state?: string }>;
    };
    const aSeesB = peersA.peers.some((p) => p.peer_relay_id === hs.idB.relay_motebit_id);
    const bSeesA = peersB.peers.some((p) => p.peer_relay_id === hs.idA.relay_motebit_id);

    if (hs.confirmA === 200 && hs.confirmB === 200 && aSeesB && bSeesA) {
      console.log(
        "\n  ✓✓ TWO INDEPENDENT OPERATORS PEERED — no shared secret in the federation path.",
      );
      console.log("     A sees B:", aSeesB, "| B sees A:", bSeesA);
      console.log("\n  Load-bearing day-1 unknown ANSWERED: peering needs no shared admin token.");
      console.log(
        "  Next layer (PHASE 2): cross-operator paid task → settlement → fee → reconcile both treasuries.",
      );
    } else {
      console.error(
        "\n  ✗ peering did not close cleanly — this is day-1 finding its first real bug:",
      );
      console.error(
        "    confirmA",
        hs.confirmA,
        "confirmB",
        hs.confirmB,
        "aSeesB",
        aSeesB,
        "bSeesA",
        bSeesA,
      );
      console.error("    peersA:", JSON.stringify(peersA), "\n    peersB:", JSON.stringify(peersB));
      process.exitCode = 1;
    }
  } finally {
    a.close();
    b.close();
    cleanDbs();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
