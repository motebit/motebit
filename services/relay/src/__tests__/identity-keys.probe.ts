/**
 * E4 differential probe (#703 §5f proof contract) — HTTP + raw-SQL planting
 * only, so the SAME file runs against the branch and against origin/main.
 * Each scenario records observations; the comparison lives outside.
 */
import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import {
  generateKeypair,
  bytesToHex,
  signDeviceRegistration,
  mintAudienceToken,
  signKeySuccession,
  signGuardianRecoverySuccession,
  canonicalJson,
  ed25519Sign,
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import { createTestRelay, JSON_AUTH } from "./test-helpers.js";

const J = { "Content-Type": "application/json" };
const hex = (k: KeyPair) => bytesToHex(k.publicKey);
let relay: SyncRelay;
const obs: Record<string, Record<string, unknown>> = {};

beforeAll(async () => {
  relay = await createTestRelay();
});
afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
});

const db = () => relay.moteDb.db;
const plantDevice = (mid: string, id: string, key: string) =>
  db()
    .prepare(
      "INSERT INTO devices (device_id, motebit_id, device_token, public_key, registered_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, mid, `tok-${id}`, key, 3_000);
async function sovereign() {
  const kp = await generateKeypair();
  return { mid: await deriveSovereignMotebitId(hex(kp)), kp };
}
async function bootstrap(mid: string, did: string, key: string) {
  return (
    await relay.app.request("/api/v1/agents/bootstrap", {
      method: "POST",
      headers: J,
      body: JSON.stringify({ motebit_id: mid, device_id: did, public_key: key }),
    })
  ).status;
}
async function registerSelf(mid: string, did: string, kp: KeyPair) {
  const body = await signDeviceRegistration(
    {
      motebit_id: mid,
      device_id: did,
      public_key: hex(kp),
      device_name: "t",
      timestamp: Date.now(),
    },
    kp.privateKey,
  );
  return (
    await relay.app.request("/api/v1/devices/register-self", {
      method: "POST",
      headers: J,
      body: JSON.stringify(body),
    })
  ).status;
}
async function regOperator(mid: string, extra: Record<string, unknown>) {
  return (
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9/mcp",
        capabilities: [],
        ...extra,
      }),
    })
  ).status;
}
async function regDevice(mid: string, did: string, kp: KeyPair, extra: Record<string, unknown>) {
  const { token } = await mintAudienceToken({ mid, did, aud: "admin:query" }, kp.privateKey);
  return (
    await relay.app.request("/api/v1/agents/register", {
      method: "POST",
      headers: { ...J, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint_url: "http://localhost:9/mcp", capabilities: [], ...extra }),
    })
  ).status;
}
async function guardianFields(mid: string, g: KeyPair) {
  return {
    guardian_public_key: hex(g),
    guardian_attestation: bytesToHex(
      await ed25519Sign(
        new TextEncoder().encode(
          canonicalJson({
            action: "guardian_attestation",
            guardian_public_key: hex(g),
            motebit_id: mid,
          }),
        ),
        g.privateKey,
      ),
    ),
  };
}
async function rotateOwn(mid: string, did: string, from: KeyPair, to: KeyPair) {
  const rec = await signKeySuccession(from.privateKey, to.privateKey, to.publicKey, from.publicKey);
  const { token } = await mintAudienceToken({ mid, did, aud: "rotate-key" }, from.privateKey);
  return (
    await relay.app.request(`/api/v1/agents/${mid}/rotate-key`, {
      method: "POST",
      headers: { ...J, Authorization: `Bearer ${token}` },
      body: JSON.stringify(rec),
    })
  ).status;
}
async function presentRecovery(target: string, rec: unknown) {
  const s = await sovereign();
  await registerSelf(s.mid, `${s.mid}-l`, s.kp);
  const { token } = await mintAudienceToken(
    { mid: s.mid, did: `${s.mid}-l`, aud: "rotate-key" },
    s.kp.privateKey,
  );
  return (
    await relay.app.request(`/api/v1/agents/${target}/rotate-key`, {
      method: "POST",
      headers: { ...J, Authorization: `Bearer ${token}` },
      body: JSON.stringify(rec),
    })
  ).status;
}
async function served(mid: string) {
  const b = await relay.app.request(`/api/v1/identity/${mid}`);
  const bundle =
    b.status === 200
      ? ((await b.json()) as { current_public_key: string }).current_public_key
      : `HTTP${b.status}`;
  const s = await relay.app.request(`/api/v1/agents/${mid}/succession`);
  const succ =
    s.status === 200
      ? ((await s.json()) as { current_public_key: string | null }).current_public_key
      : `HTTP${s.status}`;
  return { bundle, succ };
}
/** Replace concrete keys with role names so branch and main observations compare. */
function name(v: unknown, roles: Record<string, string>): unknown {
  if (typeof v === "string") return roles[v] ?? roles[v.toLowerCase()] ?? v;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, name(x, roles)]));
  return v;
}

it("W1: stranger bootstraps an unseen sovereign id with its (public) genesis key", async () => {
  const { mid, kp } = await sovereign();
  const r = { roles: { [hex(kp)]: "GENESIS" } };
  const boot = await bootstrap(mid, `${mid}-planted`, hex(kp));
  obs["W1"] = name({ boot, ...(await served(mid)) }, r.roles) as Record<string, unknown>;
});

it("W2: stranger bootstraps UPPER(K) first; the owner then registers and rotates", async () => {
  const { mid, kp } = await sovereign();
  const k2 = await generateKeypair();
  const roles = { [hex(kp)]: "K", [hex(kp).toUpperCase()]: "UPPER_K", [hex(k2)]: "K2" };
  const plant = await bootstrap(mid, `${mid}-stranger`, hex(kp).toUpperCase());
  const own = await registerSelf(mid, `${mid}-owner`, kp);
  const rotate = await rotateOwn(mid, `${mid}-owner`, kp, k2);
  obs["W2"] = name({ plant, own, rotate, ...(await served(mid)) }, roles) as Record<
    string,
    unknown
  >;
});

it("G1a: paired device names X after a keyless register; the owner rotates", async () => {
  const owner = await generateKeypair();
  const paired = await generateKeypair();
  const x = await generateKeypair();
  const next = await generateKeypair();
  const mid = `g1a-${crypto.randomUUID()}`;
  plantDevice(mid, `${mid}-o`, hex(owner));
  plantDevice(mid, `${mid}-p`, hex(paired));
  const roles = {
    [hex(owner)]: "OWNER",
    [hex(paired)]: "PAIRED",
    [hex(x)]: "X",
    [hex(next)]: "NEXT",
  };
  const keyless = await regOperator(mid, {});
  const named = await regDevice(mid, `${mid}-p`, paired, { public_key: hex(x) });
  const after = await served(mid);
  const rotate = await rotateOwn(mid, `${mid}-o`, owner, next);
  obs["G1a"] = name({ keyless, named, servedAfterX: after, ownerRotate: rotate }, roles) as Record<
    string,
    unknown
  >;
});

it("G1b: paired device rotates its own key; the owner rotates", async () => {
  const owner = await generateKeypair();
  const paired = await generateKeypair();
  const k3 = await generateKeypair();
  const next = await generateKeypair();
  const mid = `g1b-${crypto.randomUUID()}`;
  plantDevice(mid, `${mid}-o`, hex(owner));
  plantDevice(mid, `${mid}-p`, hex(paired));
  const roles = {
    [hex(owner)]: "OWNER",
    [hex(paired)]: "PAIRED",
    [hex(k3)]: "K3",
    [hex(next)]: "NEXT",
  };
  const pairedRotate = await rotateOwn(mid, `${mid}-p`, paired, k3);
  const after = await served(mid);
  const ownerRotate = await rotateOwn(mid, `${mid}-o`, owner, next);
  obs["G1b"] = name({ pairedRotate, servedAfter: after, ownerRotate }, roles) as Record<
    string,
    unknown
  >;
});

it("L3: guardian on a blank-key registry row, device rows disagree; guardian recovers from a device key", async () => {
  const k = await generateKeypair();
  const e = await generateKeypair();
  const g = await generateKeypair();
  const next = await generateKeypair();
  const mid = `l3-${crypto.randomUUID()}`;
  const roles = { [hex(k)]: "K", [hex(e)]: "E", [hex(next)]: "NEXT" };
  const reg = await regOperator(mid, await guardianFields(mid, g));
  plantDevice(mid, `${mid}-1`, hex(k));
  plantDevice(mid, `${mid}-2`, hex(e));
  const rec = await signGuardianRecoverySuccession(
    g.privateKey,
    next.privateKey,
    k.publicKey,
    next.publicKey,
  );
  const recover = await presentRecovery(mid, rec);
  obs["L3"] = name({ reg, recover, ...(await served(mid)) }, roles) as Record<string, unknown>;
});

it("SVC: operator registers a bare service identity with a guardian; the guardian recovers", async () => {
  const k = await generateKeypair();
  const g = await generateKeypair();
  const next = await generateKeypair();
  const mid = `svc-${crypto.randomUUID()}`;
  const roles = { [hex(k)]: "K", [hex(next)]: "NEXT" };
  const reg = await regOperator(mid, { public_key: hex(k), ...(await guardianFields(mid, g)) });
  const before = await served(mid);
  const rec = await signGuardianRecoverySuccession(
    g.privateKey,
    next.privateKey,
    k.publicKey,
    next.publicKey,
  );
  const recover = await presentRecovery(mid, rec);
  obs["SVC"] = name({ reg, before, recover, after: await served(mid) }, roles) as Record<
    string,
    unknown
  >;
});

it("CLI: sovereign daemon — bootstrap, keyless register under its own token, rotate", async () => {
  const { mid, kp } = await sovereign();
  const next = await generateKeypair();
  const roles = { [hex(kp)]: "K", [hex(next)]: "NEXT" };
  const boot = await bootstrap(mid, `${mid}-daemon`, hex(kp));
  const reg = await regDevice(mid, `${mid}-daemon`, kp, {});
  const before = await served(mid);
  const rotate = await rotateOwn(mid, `${mid}-daemon`, kp, next);
  obs["CLI"] = name({ boot, reg, before, rotate, after: await served(mid) }, roles) as Record<
    string,
    unknown
  >;
});

it("LEGACY: legacy-id daemon — bootstrap, keyless register (the stated cost)", async () => {
  const kp = await generateKeypair();
  const mid = `legacy-${crypto.randomUUID()}`;
  const roles = { [hex(kp)]: "K" };
  const boot = await bootstrap(mid, `${mid}-daemon`, hex(kp));
  const reg = await regDevice(mid, `${mid}-daemon`, kp, {});
  obs["LEGACY"] = name({ boot, reg, ...(await served(mid)) }, roles) as Record<string, unknown>;
});

it("STRANGER: a stranger's key registers onto an existing sovereign identity", async () => {
  const { mid, kp } = await sovereign();
  const s = await generateKeypair();
  await registerSelf(mid, `${mid}-owner`, kp);
  const bootS = await bootstrap(mid, `${mid}-s1`, hex(s));
  const selfS = await registerSelf(mid, `${mid}-s2`, s);
  obs["STRANGER"] = { bootS, selfS };
});

it("C1: chain-only identity (registry '' + guardian, chain K→K1): guardian recovers from K1", async () => {
  const k = await generateKeypair();
  const k1 = await generateKeypair();
  const g = await generateKeypair();
  const n = await generateKeypair();
  const mid = `c1-${crypto.randomUUID()}`;
  const roles = { [hex(k1)]: "K1", [hex(n)]: "N" };
  await regOperator(mid, await guardianFields(mid, g));
  db()
    .prepare(
      "INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, new_key_signature) VALUES (?, ?, ?, ?, 'sig')",
    )
    .run(mid, hex(k), hex(k1), 2000);
  const rec = await signGuardianRecoverySuccession(
    g.privateKey,
    n.privateKey,
    k1.publicKey,
    n.publicKey,
  );
  const recover = await presentRecovery(mid, rec);
  obs["C1"] = name({ recover, ...(await served(mid)) }, roles) as Record<string, unknown>;
});

it("C2: operator identity WITH a keyless device row: guardian recovers from the registry key", async () => {
  const k = await generateKeypair();
  const g = await generateKeypair();
  const n = await generateKeypair();
  const mid = `c2-${crypto.randomUUID()}`;
  const roles = { [hex(k)]: "K", [hex(n)]: "N" };
  plantDevice(mid, `${mid}-dev`, "");
  const reg = await regOperator(mid, { public_key: hex(k), ...(await guardianFields(mid, g)) });
  const rec = await signGuardianRecoverySuccession(
    g.privateKey,
    n.privateKey,
    k.publicKey,
    n.publicKey,
  );
  const recover = await presentRecovery(mid, rec);
  obs["C2"] = name({ reg, recover, ...(await served(mid)) }, roles) as Record<string, unknown>;
});

it("C3: owner registered its key; a paired device tries to rotate its own key", async () => {
  const { mid, kp } = await sovereign();
  const paired = await generateKeypair();
  const k3 = await generateKeypair();
  const roles = { [hex(kp)]: "K0", [hex(k3)]: "K3" };
  plantDevice(mid, `${mid}-o`, hex(kp));
  plantDevice(mid, `${mid}-p`, hex(paired));
  const reg = await regDevice(mid, `${mid}-o`, kp, { public_key: hex(kp) });
  const pairedRotate = await rotateOwn(mid, `${mid}-p`, paired, k3);
  obs["C3"] = name({ reg, pairedRotate, ...(await served(mid)) }, roles) as Record<string, unknown>;
});
