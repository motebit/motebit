/**
 * A small harness for the C-2 roster tests: an in-memory relay with the
 * part-B semantics the kit relies on (idempotent union, 422 per-entry
 * refusal, 429 with Retry-After, liveness rows), and an in-memory replica
 * cache that merges on save. The key chain and the law are the real
 * primitives.
 */
import {
  bytesToHex,
  generateKeypair,
  hostEnrollmentId,
  hostRetirementId,
  signHostEnrollment,
  signHostRetirement,
  signKeySuccession,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";
import {
  MachineRoster,
  createRosterSigner,
  type HeldKeyRefusal,
  type LiveUnenrolled,
  type LivenessRow,
  type MachineRosterOptions,
  type MachineRosterPorts,
  type RosterAcquired,
  type RosterPresentResponse,
  type RosterSigner,
} from "../machine-roster.js";
import { mergeReplicas, type MachineRosterReplica } from "../machine-roster-replica.js";

export const LEGACY_MID = "0190f1a2-0000-7000-8000-000000000001";
export const NOW = 1_800_000_000_000;
export const hex = (kp: KeyPair): string => bytesToHex(kp.publicKey);
export { generateKeypair };

export class FakeRelay {
  constructor(public motebitId: string = LEGACY_MID) {}
  enr = new Map<string, HostEnrollment>();
  ret = new Map<string, HostRetirement>();
  rows: LivenessRow[] = [];
  live: LiveUnenrolled[] = [];
  chain: KeySuccessionRecord[] = [];
  current: string | null = null;
  omit = new Set<string>();
  /** Answer every POST 429 with this Retry-After (ms); `undefined` = no header. */
  rateLimited: { retryAfterMs?: number } | null = null;
  posts: Array<{ enrollments: HostEnrollment[]; retirements: HostRetirement[] }> = [];

  async roster(_s: RosterSigner) {
    return {
      ok: true as const,
      body: {
        motebit_id: this.motebitId,
        enrollments: [...this.enr].filter(([id]) => !this.omit.has(id)).map(([, v]) => v),
        retirements: [...this.ret].filter(([id]) => !this.omit.has(id)).map(([, v]) => v),
        liveness: {
          observed_by: "relay-mid",
          retention_days: 90,
          observing_since: NOW - 90 * 86_400_000,
          rows: this.rows,
          live_unenrolled: this.live,
        },
      },
    };
  }

  async present(
    _s: RosterSigner,
    body: { enrollments: HostEnrollment[]; retirements: HostRetirement[] },
  ): Promise<RosterPresentResponse> {
    this.posts.push(body);
    if (this.rateLimited) {
      return {
        status: 429,
        body: { error: "rate limited" },
        ...(this.rateLimited.retryAfterMs !== undefined
          ? { retryAfterMs: this.rateLimited.retryAfterMs }
          : {}),
      };
    }
    for (const e of body.enrollments) this.enr.set(await hostEnrollmentId(e), e);
    for (const r of body.retirements) this.ret.set(await hostRetirementId(r), r);
    return { status: 200, body: { accepted: [] } };
  }

  async hold(...items: Array<HostEnrollment | HostRetirement>): Promise<void> {
    for (const i of items) {
      if ("device_id" in i) this.enr.set(await hostEnrollmentId(i), i);
      else this.ret.set(await hostRetirementId(i), i);
    }
  }
}

export class FakeCache {
  value: MachineRosterReplica | null = null;
  async load() {
    return this.value
      ? { kind: "value" as const, replica: this.value }
      : { kind: "absent" as const };
  }
  async save(r: MachineRosterReplica) {
    this.value = this.value ? mergeReplicas(this.value, r) : r;
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export interface C2Machine {
  roster: MachineRoster<HeldKeyRefusal>;
  ports: MachineRosterPorts;
  cache: FakeCache;
  relay: FakeRelay;
}

export function c2Machine(
  relay: FakeRelay,
  key: KeyPair | null,
  opts: {
    deviceId?: string;
    gated?: boolean;
    knownDeviceKeys?: string[];
    options?: MachineRosterOptions;
  } = {},
): C2Machine {
  const cache = new FakeCache();
  const ports: MachineRosterPorts = {
    motebitId: relay.motebitId,
    deviceId: opts.deviceId ?? "dev-self",
    signer: async () =>
      key == null
        ? null
        : createRosterSigner({
            privateKey: key.privateKey,
            authorization: async () => ({ Authorization: "Bearer device-token" }),
          }),
    fetchSuccession: async () => ({
      ok: true,
      body: {
        motebit_id: relay.motebitId,
        chain: relay.chain,
        current_public_key: relay.current,
        held_public_key: relay.current,
      },
    }),
    fetchRoster: (s) => relay.roster(s),
    presentRoster: (s, b) => relay.present(s, b),
    localSuccession: async () => [],
    pinnedGuardian: async () => null,
    cache,
    now: () => NOW,
    ...(opts.knownDeviceKeys ? { knownDeviceKeys: async () => opts.knownDeviceKeys! } : {}),
  };
  const roster =
    opts.gated === false
      ? (new MachineRoster(ports, opts.options) as MachineRoster<HeldKeyRefusal>)
      : MachineRoster.gated(ports, opts.options);
  return { roster, ports, cache, relay };
}

export const enrol = (kp: KeyPair, deviceId: string, motebitId = LEGACY_MID, at = NOW) =>
  signHostEnrollment(
    { motebit_id: motebitId, device_id: deviceId, public_key: hex(kp), enrolled_at: at },
    kp.privateKey,
  );

export const retireEntry = async (kp: KeyPair, e: HostEnrollment, motebitId = LEGACY_MID) =>
  signHostRetirement(
    {
      motebit_id: motebitId,
      enrollment_id: await hostEnrollmentId(e),
      public_key: hex(kp),
      retired_at: NOW,
    },
    kp.privateKey,
  );

export const rotate = (from: KeyPair, to: KeyPair) =>
  signKeySuccession(from.privateKey, to.privateKey, to.publicKey, from.publicKey);

export async function acquiredOf(m: C2Machine): Promise<RosterAcquired> {
  const a = await m.roster.acquire();
  if (a.kind !== "acquired") throw new Error(`expected acquired, got ${a.kind}`);
  return a;
}
