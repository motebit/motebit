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
  canonicalJson,
  ed25519Sign,
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import type { SyncRelay } from "../index.js";
import {
  createTestRelay,
  JSON_AUTH,
  jsonAuthWithIdempotency,
  createAgent,
} from "./test-helpers.js";
import { signExecutionReceipt, hash as sha256 } from "@motebit/crypto";
import { createSignedToken } from "@motebit/encryption";

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
async function _regOperator(mid: string, extra: Record<string, unknown>) {
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
async function _guardianFields(mid: string, g: KeyPair) {
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
async function _presentRecovery(target: string, rec: unknown) {
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

let BACKFILL = "";
beforeAll(async () => {
  try {
    const m = (await import("../identity-keys.js")) as { IDENTITY_KEYS_BACKFILL_SQL?: string };
    BACKFILL = m.IDENTITY_KEYS_BACKFILL_SQL ?? "";
  } catch {
    BACKFILL = "";
  }
});
function backfillIfBranch() {
  const t = db()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='identity_keys'")
    .get();
  if (t) {
    db().prepare("DELETE FROM identity_keys").run();
    db().prepare(BACKFILL).run(1, 1);
    return "ran";
  }
  return "n/a";
}
const regKey = (mid: string) =>
  (
    db().prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?").get(mid) as
      { public_key: string } | undefined
  )?.public_key;

async function ownReceipt(mid: string, did: string, kp: KeyPair) {
  const taskRes = await relay.app.request(`/agent/${mid}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({
      prompt: "p",
      submitted_by: mid,
      target_agent: mid,
      required_capabilities: ["web_search"],
    }),
  });
  if (taskRes.status !== 201) return `task${taskRes.status}`;
  const { task_id } = (await taskRes.json()) as { task_id: string };
  const token = await createSignedToken(
    {
      mid,
      did,
      iat: Date.now(),
      exp: Date.now() + 300000,
      jti: crypto.randomUUID(),
      aud: "task:result",
    },
    kp.privateKey,
  );
  const enc = new TextEncoder();
  const receipt = await signExecutionReceipt(
    {
      task_id,
      relay_task_id: task_id,
      motebit_id: mid,
      public_key: hex(kp),
      device_id: did,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result: "ok",
      tools_used: [] as string[],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("p")),
      result_hash: await sha256(enc.encode("ok")),
    } as unknown as Parameters<typeof signExecutionReceipt>[0],
    kp.privateKey,
    kp.publicKey,
  );
  const res = await relay.app.request(`/agent/${mid}/task/${task_id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(receipt),
  });
  return res.status;
}

async function healScenario(fill: boolean) {
  const owner = await generateKeypair();
  const paired = await generateKeypair();
  const next = await generateKeypair();
  const a = await createAgent(relay, hex(owner));
  const mid = a.motebitId;
  plantDevice(mid, `${mid}-p`, hex(paired));
  const roles = { [hex(owner)]: "OWNER", [hex(paired)]: "PAIRED", [hex(next)]: "NEXT" };
  const pairedReg = await regDevice(mid, `${mid}-p`, paired, {
    public_key: hex(paired),
    capabilities: ["web_search"],
  });
  const reg1 = regKey(mid);
  if (fill) backfillIfBranch();
  const receipt = await ownReceipt(mid, a.deviceId, owner);
  const reg2 = regKey(mid);
  const ownerRotate = await rotateOwn(mid, a.deviceId, owner, next);
  return name(
    { pairedReg, reg1, receipt, regAfterReceipt: reg2, ownerRotate, ...(await served(mid)) },
    roles,
  ) as Record<string, unknown>;
}

it("HEAL-U: unfilled legacy id; paired device registered its own key; owner's receipt then owner rotates", async () => {
  obs["HEAL-U"] = await healScenario(false);
});
it("HEAL-F: same, identity filled by v42 E-main from main's registry", async () => {
  obs["HEAL-F"] = await healScenario(true);
});

it("CASE-G: legacy stored UPPER(K) device row; owner registers lowercase K as a new device", async () => {
  const kp = await generateKeypair();
  const mid = `case-${crypto.randomUUID()}`;
  plantDevice(mid, `${mid}-old`, hex(kp).toUpperCase());
  const boot = await bootstrap(mid, `${mid}-new`, hex(kp));
  const self = await registerSelf(mid, `${mid}-new2`, kp);
  obs["CASE-G"] = { boot, self };
});

it("CASE-ROT: unfilled legacy identity rotates to an UPPER new key", async () => {
  const kp = await generateKeypair();
  const n = await generateKeypair();
  const a = await createAgent(relay, hex(kp));
  const rec = await signKeySuccession(kp.privateKey, n.privateKey, n.publicKey, kp.publicKey);
  (rec as unknown as Record<string, string>).new_public_key = hex(n).toUpperCase();
  const { token } = await mintAudienceToken(
    { mid: a.motebitId, did: a.deviceId, aud: "rotate-key" },
    kp.privateKey,
  );
  const r = await relay.app.request(`/api/v1/agents/${a.motebitId}/rotate-key`, {
    method: "POST",
    headers: { ...J, Authorization: `Bearer ${token}` },
    body: JSON.stringify(rec),
  });
  obs["CASE-ROT"] = { status: r.status };
});

// Helpers kept for probes that grow new scenarios (recovery, operator paths).
void [_regOperator, _guardianFields, _presentRecovery];
