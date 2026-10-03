/**
 * An identity file is intact only when its signature AND its succession chain
 * verify. `motebit verify <motebit.md>` and `motebit rotate` used to read only
 * the signature, so a file re-signed by a key its chain never legitimately
 * reached passed as "valid" — and rotation would extend that broken chain.
 * Both now read the shared `identityVerifyOutcome` from @motebit/crypto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, generateKeypair } from "@motebit/encryption";
import { generate, rotate } from "@motebit/identity-file";

import { handleVerify } from "../subcommands/verify.js";
import { performRotation, type RotationDeps } from "../rotation.js";

async function forgedChainIdentityFile(): Promise<string> {
  const oldKp = await generateKeypair();
  const newKp = await generateKeypair();
  const original = await generate(
    {
      motebitId: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb",
      ownerId: "owner",
      publicKeyHex: bytesToHex(oldKp.publicKey),
    },
    oldKp.privateKey,
  );
  return rotate({
    existingContent: original,
    newPublicKey: newKp.publicKey,
    newPrivateKey: newKp.privateKey,
    successionRecord: {
      old_public_key: bytesToHex(oldKp.publicKey),
      new_public_key: bytesToHex(newKp.publicKey),
      timestamp: Date.now(),
      old_key_signature: "00".repeat(64),
      new_key_signature: "00".repeat(64),
    },
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-succession-intact-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("motebit verify <motebit.md>", () => {
  it("rejects (exit 1) a validly signed file whose succession chain is invalid", async () => {
    const p = join(tmp, "motebit.md");
    writeFileSync(p, await forgedChainIdentityFile(), "utf-8");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));

    await expect(handleVerify(p)).rejects.toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(out.join("\n")).toMatch(/succession/i);
  });
});

describe("motebit rotate", () => {
  it("refuses to rotate on top of an invalid succession chain", async () => {
    const p = join(tmp, "motebit.md");
    writeFileSync(p, await forgedChainIdentityFile(), "utf-8");
    const untouched = () => {
      throw new Error("rotation must stop before touching config");
    };
    const deps = {
      identityPath: p,
      loadConfig: untouched,
      saveConfig: untouched,
      pending: { read: untouched, write: untouched, clear: untouched },
      passphrase: "x",
      syncUrl: "http://127.0.0.1:1",
    } as unknown as RotationDeps;
    await expect(performRotation(deps)).rejects.toThrow(/succession/i);
  });
});
