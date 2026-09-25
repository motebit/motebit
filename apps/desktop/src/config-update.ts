/**
 * The one way the desktop writes `~/.motebit/config.json`.
 *
 * That file is SHARED with the motebit CLI, which keeps its identity key in
 * it (`cli_encrypted_key` — for a CLI identity the only copy). A
 * `read_config` → mutate → `write_config` pair in JS writes back whatever it
 * read, so a CLI rotation that commits in between is silently reverted and
 * its new key destroyed (inventory X2 / B-r2). `update_config` instead sends
 * only the fields this caller changes; Rust merges them into the file as it
 * is at commit time, renames only if the file did not change underneath
 * (compare-and-swap, retried), refuses any `cli_*` field, refuses to merge
 * into a damaged file, and keeps the previous file whenever identity-binding
 * material (`motebit_id`, `device_id`, `device_public_key`, `_identity_file`)
 * changes.
 */

export type ConfigInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** A value of `null` removes the key. */
export type ConfigPatch = Record<string, unknown>;

/**
 * Merge `patch` into the shared config. `expect` is a compare-and-swap
 * guard: each key must still hold that value on disk (`null` ⇒ absent), or
 * nothing is written and this rejects.
 */
export async function updateConfig(
  invoke: ConfigInvoke,
  patch: ConfigPatch,
  expect?: ConfigPatch,
): Promise<void> {
  await invoke<void>("update_config", {
    patch: JSON.stringify(patch),
    ...(expect !== undefined ? { expect: JSON.stringify(expect) } : {}),
  });
}

/** Mirror of the Rust merge, for tests and pure callers. */
export function applyConfigPatch(
  existing: Record<string, unknown>,
  patch: ConfigPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}
