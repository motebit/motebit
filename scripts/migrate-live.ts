/**
 * migrate-live — a REAL cross-deployment sovereign migration over the wire.
 *
 *   SOURCE_URL=https://motebit-sync-stg-b.fly.dev \
 *   DEST_URL=https://motebit-sync-stg-d.fly.dev \
 *   MOTEBIT_API_TOKEN=… \
 *   pnpm tsx scripts/migrate-live.ts [--skip-cleanup]
 *
 * The production sibling of `scripts/demo-migration.ts`. Where the demo stands
 * up two relays in one Node process and routes fetch between them, this points
 * the SAME `performMigration` code path (the one a real agent uses) at two
 * independently-deployed relays over real HTTPS — real TLS, a real
 * `/.well-known/motebit.json` fetch, a real pinned-peer federation handshake,
 * real network failure modes. It is the proof→production step: the in-process
 * proof made real across the internet.
 *
 * The migrating agent is sovereign — its motebit_id is the sha256 commitment to
 * its key — so the destination binds key↔id offline (spec/migration-v1.md §8.2
 * step 6) and the relay-side accept-migration hardening (commit 077e40c1) is
 * exercised against deployed code, not a test harness.
 *
 * Prereq: the destination must trust the source. With the staging mesh, the
 * destination already has the source pinned as an active federation peer
 * (Tier 1); failing that, accept-migration falls back to fetching + verifying
 * the source's signed RelayMetadata (Tier 2). Both run against live relays here.
 */
import { performMigration } from "@motebit/runtime";
import { generateKeypair, bytesToHex, deriveSovereignMotebitId } from "@motebit/crypto";

const SOURCE_URL = (process.env.SOURCE_URL || "https://motebit-sync-stg-b.fly.dev").replace(
  /\/$/,
  "",
);
const DEST_URL = (process.env.DEST_URL || "https://motebit-sync-stg-d.fly.dev").replace(/\/$/, "");
const TOKEN = process.env.MOTEBIT_API_TOKEN || process.env.RELAY_TOKEN || "";
const SKIP_CLEANUP = process.argv.includes("--skip-cleanup");

function say(line = ""): void {
  process.stdout.write(line + "\n");
}
function step(n: number, title: string): void {
  say(`\n  [${n}] ${title}`);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    say("✗ MOTEBIT_API_TOKEN (or RELAY_TOKEN) is required — the staging relays share one bearer.");
    process.exitCode = 1;
    return;
  }

  say("════════════════════════════════════════════════════════════════");
  say("  motebit — LIVE cross-deployment sovereign migration");
  say(`  SOURCE: ${SOURCE_URL}`);
  say(`  DEST:   ${DEST_URL}`);
  say("════════════════════════════════════════════════════════════════");

  const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

  // Confirm both relays are reachable and capture their real identities.
  step(1, "Reach both live relays (real HTTPS)");
  const [srcWk, dstWk] = await Promise.all([
    fetch(`${SOURCE_URL}/.well-known/motebit.json`).then((r) => r.json()) as Promise<{
      relay_id: string;
    }>,
    fetch(`${DEST_URL}/.well-known/motebit.json`).then((r) => r.json()) as Promise<{
      relay_id: string;
    }>,
  ]);
  say(`      SOURCE relay_id ${srcWk.relay_id}`);
  say(`      DEST   relay_id ${dstWk.relay_id}`);

  // A sovereign agent: its own Ed25519 identity, id = sha256(public key).
  const agent = await generateKeypair();
  const agentPubHex = bytesToHex(agent.publicKey);
  const motebitId = await deriveSovereignMotebitId(agentPubHex);

  step(2, "Register a sovereign agent on SOURCE");
  const reg = await fetch(`${SOURCE_URL}/api/v1/agents/register`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "https://nomad.example/mcp",
      capabilities: ["web_search", "summarize"],
      public_key: agentPubHex,
    }),
  });
  if (!reg.ok) {
    say(`      ✗ register failed: HTTP ${reg.status} ${await reg.text()}`);
    process.exitCode = 1;
    return;
  }
  say(`      Registered ${motebitId} on SOURCE (id = sha256(public key)).`);

  step(3, "Migrate SOURCE → DEST over the wire (performMigration)");
  say("      → SOURCE issues a signed MigrationToken + DepartureAttestation");
  say("      → agent signs its credential bundle, presents token+attestation+bundle to DEST");
  say("      → DEST binds the agent key to its id, verifies the bundle, onboards");
  const result = await performMigration({
    sourceRelayUrl: SOURCE_URL,
    destRelayUrl: DEST_URL,
    motebitId,
    publicKeyHex: agentPubHex,
    signingPrivateKey: agent.privateKey,
    sourceAuth: TOKEN,
    destAuth: TOKEN,
    reason: "live cross-deployment migration proof",
    fetch: globalThis.fetch,
  });

  if (!result.ok) {
    say(`\n  ✗ Migration failed at '${result.step}': ${result.reason ?? `HTTP ${result.status}`}`);
    process.exitCode = 1;
    return;
  }

  step(4, "Confirm the agent is discoverable on DEST");
  const discover = await fetch(`${DEST_URL}/api/v1/discover/${motebitId}`).then((r) => r.json());
  const found = (discover as { found: boolean }).found;
  say(`      Discoverable on DEST: ${found ? "YES" : "NO"}`);

  if (!SKIP_CLEANUP) {
    // Best-effort: leave neither staging registry polluted.
    await fetch(`${SOURCE_URL}/api/v1/agents/${motebitId}`, {
      method: "DELETE",
      headers: auth,
    }).catch(() => undefined);
    await fetch(`${DEST_URL}/api/v1/agents/${motebitId}`, {
      method: "DELETE",
      headers: auth,
    }).catch(() => undefined);
    say("\n      (cleaned up the test agent on both relays — pass --skip-cleanup to leave it)");
  }

  if (!found) {
    process.exitCode = 1;
    return;
  }

  say("\n────────────────────────────────────────────────────────────────");
  say("  A sovereign agent carried its identity from one LIVE relay to another");
  say("  over the real internet. The destination trusted neither the agent's");
  say("  self-report nor a key fetched blind — only the source relay's pinned");
  say("  signature plus the math binding the agent's key to its id.");
  say("════════════════════════════════════════════════════════════════\n");
}

main().catch((e: unknown) => {
  process.stderr.write(`migrate-live failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
