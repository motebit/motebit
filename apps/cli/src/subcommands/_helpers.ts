/**
 * Shared internal helpers for CLI subcommand topic files.
 *
 * The leading underscore marks this as a module-internal file — not
 * re-exported from the `subcommands.ts` barrel, not intended for
 * consumers outside `apps/cli/src/subcommands/`.
 *
 * Extracted alongside Target 2 (export) because `fetchRelayJson` is
 * reused by handleExport, handleFederation*, and handleBalance. Rather
 * than duplicating the helper or routing it through the legacy
 * subcommands.ts module (which would create a circular import as
 * topics are extracted), we give shared helpers their own home here.
 */

/**
 * Fetch JSON from the relay, returning a discriminated-union result
 * instead of throwing. All CLI relay probes use this shape so the
 * caller can branch on `ok` cleanly.
 */
export async function fetchRelayJson(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `relay returned ${String(res.status)}: ${body.slice(0, 100)}` };
    }
    const data: unknown = await res.json();
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
