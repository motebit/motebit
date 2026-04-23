/**
 * @motebit/verifier — offline third-party verifier for every signed
 * Motebit artifact.
 *
 * The moat: anything a motebit signs (identity file, execution receipt,
 * credential, presentation) is third-party verifiable with only this
 * package and the signer's public key — no relay contact, no motebit
 * runtime, no network. This module is the smallest public surface of
 * that promise.
 *
 * Composition:
 *
 *   - `verifyFile(path, opts?)` — read an artifact off disk, detect its
 *     kind, return the typed `VerifyResult` from `@motebit/crypto`.
 *   - `verifyArtifact(content, opts?)` — same, but accept the artifact
 *     already-loaded (string for identity, object or JSON string for
 *     JSON artifacts).
 *   - `formatHuman(result)` — render a `VerifyResult` as the
 *     multi-line human-readable output the CLI prints.
 *
 * The CLI (`motebit-verify`) lives at `./cli.ts` and calls only these
 * three functions plus `@motebit/crypto`.
 */

export { verifyFile, verifyArtifact, formatHuman } from "./lib.js";
export type { VerifyFileOptions } from "./lib.js";
export type { VerifyResult, ArtifactType } from "@motebit/crypto";
