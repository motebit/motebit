// create-motebit's identity-file writers stamp `created_at` at WRITE time.
//
// The seed-backup date proof (`legacyAckCoversCurrentKey` in
// packages/surface-kit/src/seed-backup.ts) reads a motebit.md's signed
// `created_at` as the time the file was signed. spec/identity-v1.md §3.1
// defines it as the identity's creation time; the proof is sound only while
// every writer stamps it at write time. A change that made `generateIdentity`
// or `regenerateIdentityFile` preserve a genesis date would let a fresh file
// for a later key read as "signed before" an old acknowledgment: this goes
// red first. (The identity-file `generate` callers are pinned by
// packages/surface-kit/src/__tests__/seed-backup-writers.test.ts.)

import { describe, it, expect } from "vitest";
import { generateIdentity, regenerateIdentityFile, decryptPrivateKey } from "../generate.js";

/** The `created_at` a motebit.md's frontmatter declares. */
function createdAt(content: string): string {
  const m = /^created_at:\s*"?([^"\n]+)"?\s*$/m.exec(content);
  if (m == null) throw new Error("no created_at in the identity file");
  return m[1]!;
}

describe("create-motebit writers stamp created_at at write time", () => {
  it("generateIdentity and regenerateIdentityFile both date the file now, with a zone", async () => {
    const before = Date.now();
    const result = await generateIdentity({
      name: "t",
      trustMode: "guarded",
      passphrase: "correct horse",
    });
    const minted = createdAt(result.identityFileContent);
    expect(minted).toMatch(/Z$/);
    expect(Date.parse(minted)).toBeGreaterThanOrEqual(before);

    // Regenerating for the same key later must date the NEW file, never
    // carry the mint's date forward.
    await new Promise((r) => setTimeout(r, 5));
    const beforeRegen = Date.now();
    const regenerated = await regenerateIdentityFile({
      motebitId: result.motebitId,
      deviceId: result.deviceId,
      name: "t",
      publicKeyHex: result.publicKeyHex,
      privateKeyHex: await decryptPrivateKey(result.encryptedKey, "correct horse"),
      trustMode: "guarded",
    });
    const regen = createdAt(regenerated);
    expect(regen).toMatch(/Z$/);
    expect(Date.parse(regen)).toBeGreaterThanOrEqual(beforeRegen);
    expect(Date.parse(regen)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(regen)).toBeGreaterThan(Date.parse(minted));
  });
});
