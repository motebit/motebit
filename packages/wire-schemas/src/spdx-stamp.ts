/**
 * SPDX license stamp applied to every committed JSON Schema artifact
 * at build time. Called by both `scripts/build-schemas.ts` (producing
 * committed files) and `src/__tests__/drift.test.ts` (matching the
 * committed shape against live zod output).
 *
 * JSON Schema's `$comment` keyword is specifically for machine-
 * parseable metadata validators ignore — the right place for a SPDX
 * identifier. Prepending it makes it the first field every reader
 * sees when opening a schema file.
 *
 * See the package `LICENSE` + `CLAUDE.md` for the mixed-licensing
 * rationale — this module exists to keep the stamp a single source of
 * truth across the writer and the drift-test comparator.
 */

/** SPDX identifier carried by every `schema/*.json` artifact. */
export const SCHEMA_SPDX_IDENTIFIER = "SPDX-License-Identifier: MIT";

/**
 * Stamp a raw zod-derived JSON Schema with the SPDX `$comment` as the
 * first field. Deterministic — same input always produces the same
 * stamped output — so it's usable as the single source of truth for
 * both the build step and the drift comparison.
 */
export function stampSchema<T extends Record<string, unknown>>(raw: T): { $comment: string } & T {
  return { $comment: SCHEMA_SPDX_IDENTIFIER, ...raw };
}
