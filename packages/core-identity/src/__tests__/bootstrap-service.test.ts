import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapServiceIdentity,
  FileSystemBootstrapConfigStore,
  FileSystemBootstrapKeyStore,
} from "../index.js";

describe("FileSystemBootstrapConfigStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "motebit-config-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns null when the file is absent", async () => {
    const store = new FileSystemBootstrapConfigStore(join(dataDir, "motebit.json"));
    expect(await store.read()).toBeNull();
  });

  it("round-trips a config state through write + read", async () => {
    const store = new FileSystemBootstrapConfigStore(join(dataDir, "motebit.json"));
    const state = {
      motebit_id: "01936c1d-e7f8-7000-8000-000000000001",
      device_id: "01936c1d-e7f8-7001-8000-000000000001",
      device_public_key: "deadbeef".repeat(8),
    };
    await store.write(state);
    expect(await store.read()).toEqual(state);
  });

  it("returns null when the JSON is malformed", async () => {
    const path = join(dataDir, "motebit.json");
    writeFileSync(path, "{not valid json", "utf-8");
    const store = new FileSystemBootstrapConfigStore(path);
    expect(await store.read()).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const path = join(dataDir, "motebit.json");
    writeFileSync(path, JSON.stringify({ motebit_id: "only-partial" }), "utf-8");
    const store = new FileSystemBootstrapConfigStore(path);
    expect(await store.read()).toBeNull();
  });

  it("returns null when fields have the wrong type", async () => {
    const path = join(dataDir, "motebit.json");
    writeFileSync(
      path,
      JSON.stringify({ motebit_id: 42, device_id: "b", device_public_key: "c" }),
      "utf-8",
    );
    const store = new FileSystemBootstrapConfigStore(path);
    expect(await store.read()).toBeNull();
  });

  it("cleans up the .tmp file after atomic rename", async () => {
    const path = join(dataDir, "motebit.json");
    const store = new FileSystemBootstrapConfigStore(path);
    await store.write({
      motebit_id: "a",
      device_id: "b",
      device_public_key: "c",
    });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});

describe("FileSystemBootstrapKeyStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "motebit-key-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns null when the file is absent", () => {
    const store = new FileSystemBootstrapKeyStore(join(dataDir, "motebit.key"));
    expect(store.readPrivateKey()).toBeNull();
  });

  it("returns null when the file is empty", async () => {
    const path = join(dataDir, "motebit.key");
    const store = new FileSystemBootstrapKeyStore(path);
    await store.storePrivateKey("");
    expect(store.readPrivateKey()).toBeNull();
  });

  it("round-trips a private key hex through store + read", async () => {
    const path = join(dataDir, "motebit.key");
    const store = new FileSystemBootstrapKeyStore(path);
    const keyHex = "a".repeat(64);
    await store.storePrivateKey(keyHex);
    expect(store.readPrivateKey()).toBe(keyHex);
  });

  it("writes the key file with mode 0600 on first write", async () => {
    const path = join(dataDir, "motebit.key");
    const store = new FileSystemBootstrapKeyStore(path);
    await store.storePrivateKey("b".repeat(64));
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves mode 0600 on overwrite (key rotation)", async () => {
    const path = join(dataDir, "motebit.key");
    const store = new FileSystemBootstrapKeyStore(path);
    await store.storePrivateKey("c".repeat(64));
    await store.storePrivateKey("d".repeat(64));
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("bootstrapServiceIdentity", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "motebit-bootstrap-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("generates a fresh identity on first boot", async () => {
    const result = await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test-service",
    });

    expect(result.isFirstLaunch).toBe(true);
    expect(result.motebitId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists identity files to the data directory on first boot", async () => {
    await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test-service",
    });

    expect(existsSync(join(dataDir, "motebit.json"))).toBe(true);
    expect(existsSync(join(dataDir, "motebit.key"))).toBe(true);
  });

  it("reuses the same identity on subsequent boots", async () => {
    const first = await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test-service",
    });
    const second = await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test-service",
    });

    expect(second.isFirstLaunch).toBe(false);
    expect(second.motebitId).toBe(first.motebitId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
    expect(second.privateKeyHex).toBe(first.privateKeyHex);
  });

  it("writes motebit.json with the matching motebit_id", async () => {
    const result = await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test",
    });
    const configContent = readFileSync(join(dataDir, "motebit.json"), "utf-8");
    const config = JSON.parse(configContent) as {
      motebit_id: string;
      device_id: string;
      device_public_key: string;
    };
    expect(config.motebit_id).toBe(result.motebitId);
    expect(config.device_id).toBe(result.deviceId);
    expect(config.device_public_key).toBe(result.publicKeyHex);
  });

  it("creates the data directory if it doesn't exist", async () => {
    const nested = join(dataDir, "deep", "nested", "path");
    expect(existsSync(nested)).toBe(false);

    const result = await bootstrapServiceIdentity({
      dataDir: nested,
      serviceName: "motebit-test",
    });

    expect(existsSync(nested)).toBe(true);
    expect(result.isFirstLaunch).toBe(true);
  });

  it("returns absolute paths for all artifact locations", async () => {
    const result = await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test",
    });
    expect(result.configPath).toBe(join(dataDir, "motebit.json"));
    expect(result.keyPath).toBe(join(dataDir, "motebit.key"));
    expect(result.suggestedIdentityPath).toBe(join(dataDir, "motebit.md"));
  });

  it("private key file is mode 0600", async () => {
    await bootstrapServiceIdentity({
      dataDir,
      serviceName: "motebit-test",
    });
    const mode = statSync(join(dataDir, "motebit.key")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
