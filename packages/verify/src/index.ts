/**
 * @motebit/verify — hardware-attestation-aware companion to
 * `@motebit/verifier`.
 *
 * Bundles the four BSL platform verifier leaves into a single
 * `HardwareAttestationVerifiers` record + a CLI `motebit-verify`
 * that hands them to `@motebit/verifier::verifyFile`. A credential
 * with `hardware_attestation: { platform: "device_check" | "tpm" |
 * "play_integrity" | "webauthn", ... }` verifies end-to-end through
 * this package instead of returning the MIT verifier's `adapter not
 * yet shipped` sentinel.
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
