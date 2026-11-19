/**
 * A temporary config directory with a seeded per-relay key record.
 *
 * `CONFIG_DIR` is read when `config.ts` loads, so this must run inside
 * `vi.hoisted` — before any import that reaches `config.ts`. It imports only
 * `node:` modules for that reason. Without it a test that drives a money-path
 * reader would read (and, through lazy binding, could write) the developer's
 * own `~/.motebit/relay-pins.json`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Point `MOTEBIT_CONFIG_DIR` at a fresh temporary directory and record
 * `pins` (pin key → 64-hex relay key) in its `relay-pins.json`. Returns the
 * directory.
 */
export function seedConfigDirWithPins(pins: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-seeded-cfg-"));
  process.env["MOTEBIT_CONFIG_DIR"] = dir;
  const record = {
    version: 1,
    pins: Object.fromEntries(
      Object.entries(pins).map(([pinKey, publicKey]) => [
        pinKey,
        { public_key: publicKey, relay_id: "test-relay", pinned_at: 1 },
      ]),
    ),
  };
  fs.writeFileSync(path.join(dir, "relay-pins.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return dir;
}
