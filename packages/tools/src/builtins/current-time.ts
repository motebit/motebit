/**
 * current_time — returns the current date/time in a specified IANA timezone.
 *
 * Pure tool. No external API, no filesystem, no side effects. Every surface
 * can safely register it; no capability check needed.
 *
 * Parameters:
 *   - timezone (optional) — IANA timezone id (e.g., "America/Los_Angeles").
 *                           Defaults to UTC.
 *
 * Output: ISO 8601 timestamp + human-readable local representation.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";

export const currentTimeDefinition: ToolDefinition = {
  name: "current_time",
  description:
    "Get the current date and time. Use when you need to know what time it is, today's date, or time in a specific timezone.",
  inputSchema: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          'IANA timezone id (e.g., "America/Los_Angeles", "Europe/London", "UTC"). Defaults to UTC.',
      },
    },
  },
};

export function createCurrentTimeHandler(): ToolHandler {
  return async (args) => {
    const timezone = (args.timezone as string | undefined) ?? "UTC";
    const now = new Date();
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
      const local = formatter.format(now);
      return {
        ok: true,
        data: `${local} (${timezone}) · ISO ${now.toISOString()}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Invalid timezone "${timezone}": ${msg}`,
      };
    }
  };
}
