/**
 * The one reader every surface uses for an answer composed from several
 * machines. It reads an ERROR body, which is where a surface is least
 * careful — so what it refuses matters as much as what it accepts.
 */
import { describe, it, expect } from "vitest";
import { readComposedCommandResult } from "../commands/composed.js";

const composed = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    summary: "Asked 2 machines; 1 reported.",
    detail: "dev-1: Running\ndev-2: not reached",
    data: {
      composed: true,
      partial: true,
      machines: [
        { device_id: "dev-1", outcome: "answered", result: { summary: "Running" } },
        { device_id: "dev-2", outcome: "unreached" },
      ],
      ...data,
    },
    ...over,
  });

describe("readComposedCommandResult", () => {
  it("reads a composed body, machine by machine", () => {
    const read = readComposedCommandResult(composed());
    expect(read?.summary).toBe("Asked 2 machines; 1 reported.");
    expect(read?.detail).toMatch(/dev-2: not reached/);
    expect(read?.partial).toBe(true);
    expect(read?.machines).toEqual([
      { device_id: "dev-1", outcome: "answered", result: { summary: "Running" } },
      { device_id: "dev-2", outcome: "unreached" },
    ]);
  });

  it("reads `partial` fail-closed — only an outright `false` is a whole picture", () => {
    expect(readComposedCommandResult(composed({}, { partial: false }))?.partial).toBe(false);
    // A relay that forgot the field must not make half a picture whole.
    expect(readComposedCommandResult(composed({}, { partial: undefined }))?.partial).toBe(true);
    expect(readComposedCommandResult(composed({}, { partial: "false" }))?.partial).toBe(true);
  });

  it("is not fooled by a plain runtime reply, a timeout, or a refusal", () => {
    // Each of these keeps the status-keyed sentence it already had.
    expect(readComposedCommandResult('{"summary":"Agent did not respond in time."}')).toBeNull();
    expect(readComposedCommandResult('{"error":"No unattended runtime is connected"}')).toBeNull();
    expect(
      readComposedCommandResult('{"summary":"Running","data":{"halted":false,"active":[]}}'),
    ).toBeNull();
    // `composed` must be the boolean, not something truthy.
    expect(readComposedCommandResult(composed({}, { composed: "true" }))).toBeNull();
  });

  it("never throws on what a proxy or a dead relay sends instead", () => {
    expect(readComposedCommandResult(undefined)).toBeNull();
    expect(readComposedCommandResult("")).toBeNull();
    expect(readComposedCommandResult("<html>502 Bad Gateway</html>")).toBeNull();
    expect(readComposedCommandResult("null")).toBeNull();
    expect(readComposedCommandResult('"a string"')).toBeNull();
  });

  it("an outcome it has never heard of is SHOWN, and costs the picture its completeness", () => {
    // The relay deploys on merge; an installed phone updates whenever it
    // does. Returning null here sent the surface back to "Delivered, no
    // answer yet" about a machine that was never reached.
    const read = readComposedCommandResult(
      composed(
        {},
        {
          partial: false,
          machines: [
            { device_id: "dev-1", outcome: "answered", result: { summary: "Running" } },
            { device_id: "dev-2", outcome: "refused" },
          ],
        },
      ),
    );
    expect(read).not.toBeNull();
    expect(read?.summary).toBe("Asked 2 machines; 1 reported.");
    expect(read?.machines[1]).toEqual({ device_id: "dev-2", outcome: "unknown" });
    // Even though the body said `partial: false`.
    expect(read?.partial).toBe(true);
  });

  it("a line it cannot place is dropped from the list, never from the report", () => {
    for (const bad of [null, "dev-1", { device_id: 1, outcome: "answered" }]) {
      const read = readComposedCommandResult(
        composed(
          {},
          { partial: false, machines: [bad, { device_id: "dev-2", outcome: "answered" }] },
        ),
      );
      expect(read?.detail).toMatch(/dev-2: not reached/);
      expect(read?.machines.map((m) => m.device_id)).toEqual(["dev-2"]);
      expect(read?.partial).toBe(true);
    }
  });

  it("refuses only what is not a composed body at all", () => {
    expect(readComposedCommandResult(composed({}, { machines: "dev-1" }))).toBeNull();
    expect(readComposedCommandResult(composed({ summary: 7 }))).toBeNull();
  });

  it("drops a `result` that is not an object instead of passing it on as one", () => {
    const read = readComposedCommandResult(
      composed({}, { machines: [{ device_id: "dev-1", outcome: "no_record", result: "???" }] }),
    );
    expect(read?.machines).toEqual([{ device_id: "dev-1", outcome: "no_record" }]);
  });

  it("tolerates a body with no detail", () => {
    const read = readComposedCommandResult(composed({ detail: undefined }));
    expect(read).not.toBeNull();
    expect(read?.detail).toBeUndefined();
  });
});
