/**
 * The pins of governed repo changes as committed on `main`
 * (`.motebit/principals/`, docs/proposals/governed-repo-change-v1.md "Pins,
 * typed by role"): each is an intact identity file, read through the same
 * `pinFromIdentityFile` both judges use, and the principal is not an agent.
 * A reformat or a hand edit breaks the signature and turns this red.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AGENT_PIN_DIR, PRINCIPAL_PIN_FILE, pinFromIdentityFile } from "../git/index.js";

const ROOT = new URL("../../../../", import.meta.url);
const read = (p: string): string => fs.readFileSync(fileURLToPath(new URL(p, ROOT)), "utf8");

describe("the committed pins", () => {
  it("the principal pin is founder identity F", async () => {
    const pin = await pinFromIdentityFile(read(PRINCIPAL_PIN_FILE), PRINCIPAL_PIN_FILE);
    expect(pin).toEqual({
      motebit_id: "019df0f4-084e-7910-90a8-3492ced8fb8f",
      public_key: "854caa5de4068766ae58b0b424752ac8883b65949def7c99d9281c9c8350a972",
    });
  });

  it("the one agent pin is agent identity A, distinct from F", async () => {
    const dir = fileURLToPath(new URL(AGENT_PIN_DIR, ROOT));
    expect(fs.readdirSync(dir)).toEqual(["repo-a.md"]);
    const file = `${AGENT_PIN_DIR}repo-a.md`;
    const agent = await pinFromIdentityFile(read(file), file);
    expect(agent.motebit_id).toBe("ebabc222-1f74-8177-8537-30590a2808a3");
    const principal = await pinFromIdentityFile(read(PRINCIPAL_PIN_FILE), PRINCIPAL_PIN_FILE);
    expect(agent.public_key).not.toBe(principal.public_key);
  });

  it("refuses a pin with one byte changed", async () => {
    const t = read(PRINCIPAL_PIN_FILE).replace('trust_mode: "guarded"', 'trust_mode: "Guarded"');
    expect(t).not.toBe(read(PRINCIPAL_PIN_FILE));
    await expect(pinFromIdentityFile(t, PRINCIPAL_PIN_FILE)).rejects.toThrow(
      /not an intact identity file/,
    );
  });
});
