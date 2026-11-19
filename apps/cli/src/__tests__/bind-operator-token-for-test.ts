/**
 * Test helper: record that an operator token belongs to a relay URL, the way
 * `motebit relay bind-token` does, by writing `relay-operator-tokens.json`
 * directly. A test that expects the CLI to SEND an operator token must bind
 * it first; an unbound token is withheld (`../relay-operator-token.ts`).
 *
 * Plain URLs only (`http(s)://host[:port][/path]`): the key is the URL as the
 * URL parser spells it, minus trailing slashes — what `relayPinKey` returns
 * for such a URL.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function bindOperatorTokenForTest(configDir: string, relayUrl: string, token: string): void {
  const file = path.join(configDir, "relay-operator-tokens.json");
  let tokens: Record<string, string> = {};
  try {
    tokens = (JSON.parse(fs.readFileSync(file, "utf-8")) as { tokens: Record<string, string> })
      .tokens;
  } catch {
    // No record yet.
  }
  const key = new URL(relayUrl).href.replace(/\/+$/, "");
  tokens[key] = createHash("sha256").update(token, "utf-8").digest("hex");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
}
