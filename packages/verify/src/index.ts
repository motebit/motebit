/**
 * @motebit/verify — hardware-attestation-aware companion to
 * `@motebit/verifier`.
 *
 * Bundles every Apache-2.0 permissive-floor platform verifier leaf
 * into a single `HardwareAttestationVerifiers` record + a CLI
 * `motebit-verify` that hands them to `@motebit/verifier::verifyFile`.
 * A credential with `hardware_attestation: { platform: "device_check" |
 * "tpm" | "android_keystore" | "webauthn", ... }` verifies end-to-end
 * through this package instead of returning the permissive-floor
 * verifier's `adapter not yet shipped` sentinel. The deprecated
 * `play_integrity` adapter was removed 2026-05-03 — credentials
 * carrying that platform hit the canonical dispatcher's fail-closed
 * "verifier not wired" branch.
 *
 * Programmatic use:
 *
 * ```ts
 * import { verifyFile } from "@motebit/verifier";
 * import { buildHardwareVerifiers } from "@motebit/verify";
 *
 * const result = await verifyFile("cred.json", {
 *   hardwareAttestation: buildHardwareVerifiers(),
 * });
 * ```
 *
 * CLI use: `motebit-verify <file>` — same args as `motebit-verify`,
 * plus hardware-attestation verification. See `cli.ts`.
 */

export { buildHardwareVerifiers } from "./adapters.js";
export type { HardwareVerifierBundleConfig } from "./adapters.js";
