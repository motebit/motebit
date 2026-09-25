// Composition proof, TypeScript half (#760 review F4). The identity-manager
// tests use a TS fake that preserves by itself, so they cannot prove the
// REAL Rust key store keeps what a restore replaces. This test records the
// exact IPC sequence `restoreIdentity` issues and pins it to a committed
// fixture; the Rust test `ipc_replay_tests::restore_ipc_sequence_preserves_*`
// replays that same fixture through the real `KeyStore` + `config_file`
// and asserts the old key, the old identity's rotation write-ahead and the
// old binding all survive. Change the sequence here ⇒ this test fails until
// the fixture is regenerated (UPDATE_IPC_FIXTURES=1), and the Rust replay
// then proves the new sequence.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@motebit/core-identity", () => ({
  bootstrapIdentity: vi.fn(),
  writeRestoredIdentity: vi.fn(async () => undefined),
}));
vi.mock("@motebit/identity-file", () => ({
  generate: vi.fn(),
  importIdentityFile: vi.fn(),
  parse: vi.fn(),
  validateRestoreRequest: vi.fn(async () => null),
  verify: vi.fn(),
  rotate: vi.fn(),
}));
vi.mock("../index.js", () => ({
  createTauriStorage: vi.fn(() => ({ identityStorage: {}, eventStore: {} })),
}));

import { IdentityManager } from "../identity-manager";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "src-tauri",
  "fixtures",
  "identity-switch-restore.json",
);
const STATE_CMDS = new Set([
  "keyring_get",
  "keyring_set",
  "keyring_delete",
  "keyring_set_aside",
  "update_config",
  "write_config",
]);

describe("identity switch IPC sequence (replayed through the real Rust store)", () => {
  it("restore issues exactly the fixture's sequence", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-00000000000b");
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (STATE_CMDS.has(cmd)) calls.push({ cmd, args: args ?? {} });
      if (cmd === "read_config") return "{}";
      if (cmd === "keyring_get") return null;
      return undefined;
    });
    const r = await new IdentityManager().restoreIdentity(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      invoke as any,
      {
        privateKeyHex: "KEY-B",
        metadata: {
          motebitId: "m-B",
          publicKey: "bb",
          ownerId: "o",
          bornAt: "not-a-date",
          devices: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        originalContent: "B-FILE",
        preserveMemories: false,
      },
    );
    expect(r.ok).toBe(true);
    const recorded = JSON.stringify(calls, null, 2) + "\n";
    if (process.env.UPDATE_IPC_FIXTURES === "1") writeFileSync(FIXTURE, recorded);
    expect(recorded).toBe(readFileSync(FIXTURE, "utf8"));
  });
});
