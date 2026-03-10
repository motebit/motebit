import type { MotebitIdentity } from "@motebit/sdk";
import type { IdentityStorage, DeviceRegistration } from "@motebit/core-identity";
import { idbRequest } from "./idb.js";

export class IdbIdentityStorage implements IdentityStorage {
  constructor(private db: IDBDatabase) {}

  async save(identity: MotebitIdentity): Promise<void> {
    const tx = this.db.transaction("identities", "readwrite");
    await idbRequest(tx.objectStore("identities").put(identity));
  }

  async load(motebitId: string): Promise<MotebitIdentity | null> {
    const tx = this.db.transaction("identities", "readonly");
    const result = (await idbRequest(tx.objectStore("identities").get(motebitId))) as
      | MotebitIdentity
      | undefined;
    return result ?? null;
  }

  async loadByOwner(ownerId: string): Promise<MotebitIdentity | null> {
    const tx = this.db.transaction("identities", "readonly");
    const store = tx.objectStore("identities");
    const index = store.index("owner_id");
    const result = (await idbRequest(index.get(ownerId))) as MotebitIdentity | undefined;
    return result ?? null;
  }

  async saveDevice(device: DeviceRegistration): Promise<void> {
    const tx = this.db.transaction("devices", "readwrite");
    await idbRequest(tx.objectStore("devices").put(device));
  }

  async loadDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const tx = this.db.transaction("devices", "readonly");
    const result = (await idbRequest(tx.objectStore("devices").get(deviceId))) as
      | DeviceRegistration
      | undefined;
    return result ?? null;
  }

  async loadDeviceByToken(token: string): Promise<DeviceRegistration | null> {
    const tx = this.db.transaction("devices", "readonly");
    const store = tx.objectStore("devices");
    const index = store.index("device_token");
    const result = (await idbRequest(index.get(token))) as DeviceRegistration | undefined;
    return result ?? null;
  }

  async listDevices(motebitId: string): Promise<DeviceRegistration[]> {
    const tx = this.db.transaction("devices", "readonly");
    const store = tx.objectStore("devices");
    const index = store.index("motebit_id");
    return (await idbRequest(index.getAll(IDBKeyRange.only(motebitId)))) as DeviceRegistration[];
  }
}
