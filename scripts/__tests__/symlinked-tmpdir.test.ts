/**
 * The gate self-tests run under a symlinked TMPDIR (scripts/lib/
 * vitest-symlinked-tmpdir.ts), so a fixture root that is not realpath'd fails
 * on Linux CI the way it fails on macOS, where os.tmpdir() sits under the
 * /var -> /private/var link. Red here means that setup file stopped applying,
 * and with it the only CI coverage of the macOS shape.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("gate self-tests run under a symlinked TMPDIR", () => {
  it("os.tmpdir() is not its own realpath", () => {
    expect(process.env.TMPDIR).toBe(tmpdir());
    expect(realpathSync(tmpdir())).not.toBe(tmpdir());
  });
});
