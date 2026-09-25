/**
 * The tri-state keystore probe (`probePrivateKey`) — key-file durability
 * item 1 (`docs/proposals/key-file-durability-v1.md`). `bootstrapIdentity`
 * is the one shared absence decision every surface goes through; with the
 * probe it never mints over a key it could not read, never mints over a key
 * held without an identity, and never proceeds on a key that does not
 * derive to the identity's public key.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import {
  bootstrapIdentity,
  IdentityBootstrapRefusedError,
  InMemoryIdentityStorage,
  type BootstrapConfigStore,
  type BootstrapKeyStore,
} from "../index.js";

type Probe = Awaited<ReturnType<NonNullable<BootstrapKeyStore["probePrivateKey"]>>>;

function stores(
  config: { motebit_id: string; device_id: string; device_public_key: string } | null,
  probe: Probe,
) {
  const state = { config, storeCalls: 0, configWrites: 0 };
  const configStore: BootstrapConfigStore = {
    read: () => Promise.resolve(state.config),
    write: (s) => {
      state.configWrites++;
      state.config = s;
      return Promise.resolve();
    },
  };
  const keyStore: BootstrapKeyStore = {
    storePrivateKey: () => {
      state.storeCalls++;
      return Promise.resolve();
    },
    probePrivateKey: () => Promise.resolve(probe),
    // The legacy boolean would say "no key" for every one of these; the probe
    // must win.
    hasPrivateKey: () => Promise.resolve(false),
  };
  return { state, configStore, keyStore };
}

describe("bootstrapIdentity with probePrivateKey", () => {
  let identityStorage: InMemoryIdentityStorage;
  let eventStoreAdapter: InMemoryEventStore;
  beforeEach(() => {
    identityStorage = new InMemoryIdentityStorage();
    eventStoreAdapter = new InMemoryEventStore();
  });
  const run = (s: ReturnType<typeof stores>) =>
    bootstrapIdentity({
      surfaceName: "test",
      identityStorage,
      eventStoreAdapter,
      configStore: s.configStore,
      keyStore: s.keyStore,
    });

  it("unreadable keystore ⇒ REFUSES: nothing minted, nothing stored, config untouched", async () => {
    const s = stores(
      { motebit_id: "m-1", device_id: "d-1", device_public_key: "aa" },
      { state: "unreadable", reason: "EACCES" },
    );
    await expect(run(s)).rejects.toBeInstanceOf(IdentityBootstrapRefusedError);
    expect(s.state.storeCalls).toBe(0);
    expect(s.state.configWrites).toBe(0);
  });

  it("a key held with NO identity bound ⇒ REFUSES rather than minting over it", async () => {
    // The CLI's config with `cli_encrypted_key` but no `motebit_id` (a crash
    // between two writes, a hand edit): the first-launch path used to
    // overwrite the key.
    const s = stores(null, { state: "present" });
    await expect(run(s)).rejects.toMatchObject({ state: "key-without-identity" });
    expect(s.state.storeCalls).toBe(0);
    expect(s.state.configWrites).toBe(0);
  });

  it("a key that derives to a DIFFERENT public key than the identity names ⇒ REFUSES", async () => {
    const s = stores(
      { motebit_id: "m-1", device_id: "d-1", device_public_key: "aa".repeat(32) },
      { state: "present", publicKeyHex: "bb".repeat(32) },
    );
    await expect(run(s)).rejects.toMatchObject({ state: "key-mismatch" });
    expect(s.state.storeCalls).toBe(0);
  });

  it("a matching key ⇒ the existing identity loads, nothing is written", async () => {
    const s = stores(
      { motebit_id: "m-1", device_id: "d-1", device_public_key: "AA".repeat(32) },
      { state: "present", publicKeyHex: "aa".repeat(32) },
    );
    const r = await run(s);
    expect(r).toMatchObject({ motebitId: "m-1", isFirstLaunch: false });
    expect(s.state.storeCalls).toBe(0);
  });

  it("provably absent + no identity ⇒ a genuine first launch mints", async () => {
    const s = stores(null, { state: "absent" });
    const r = await run(s);
    expect(r.isFirstLaunch).toBe(true);
    expect(s.state.storeCalls).toBe(1);
    expect(s.state.configWrites).toBe(1);
  });

  it("provably absent + an identity ⇒ the divergent-state recovery (nothing held to destroy)", async () => {
    const s = stores(
      { motebit_id: "m-1", device_id: "d-1", device_public_key: "aa" },
      {
        state: "absent",
      },
    );
    const r = await run(s);
    expect(r).toMatchObject({ isFirstLaunch: true, divergedFromMotebitId: "m-1" });
  });
});
