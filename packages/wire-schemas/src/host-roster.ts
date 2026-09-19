/**
 * Machine roster — wire schemas for the two sovereign-signed membership
 * artifacts.
 *
 * "Every machine" is a statement about a set. `HostEnrollment` adds a
 * machine to a motebit's roster and `HostRetirement` ends one; the
 * roster is every enrolment no retirement names. A relay stores and
 * serves these verbatim and never mints one — so a third party (or the
 * sovereign's own phone) validates what it was served against THIS
 * schema, then verifies the signatures with `@motebit/crypto`, and needs
 * nothing else from motebit to do it.
 *
 * Doctrine: docs/doctrine/machine-roster.md. Spec: spec/machine-roster-v1.md.
 */

import { z } from "zod";

import type { HostEnrollment, HostRetirement } from "@motebit/protocol";

import { assembleJsonSchemaFor, toDraft7 } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const HOST_ENROLLMENT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/host-enrollment-v1.json";

export const HOST_RETIREMENT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/host-retirement-v1.json";

// ---------------------------------------------------------------------------
// Shared fields
// ---------------------------------------------------------------------------

const publicKey = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "public_key MUST be 64 lowercase hex characters")
  .describe(
    "Hex-encoded 32-byte Ed25519 identity public key that signs this artifact. Named in the body so a verifier knows WHICH key after a rotation. A consumer accepts it only if it is a key that consumer already trusts for `motebit_id` — never because the artifact says so.",
  );

const suite = z
  .literal("motebit-jcs-ed25519-b64-v1")
  .describe(
    "Cryptosuite — always `motebit-jcs-ed25519-b64-v1` (JCS, Ed25519, base64url signature). Verifiers reject missing or unknown values fail-closed.",
  );

const signature = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "signature MUST be unpadded URL-safe base64")
  .describe(
    "Base64url Ed25519 signature over canonicalJson of every field except `signature`, by `public_key`.",
  );

// ---------------------------------------------------------------------------
// HostEnrollment
// ---------------------------------------------------------------------------

export const HostEnrollmentSchema = z
  .object({
    motebit_id: z.string().min(1).describe("MotebitId whose unattended work this machine hosts."),
    device_id: z
      .string()
      .min(1)
      .describe(
        "The machine. A label under the motebit's one identity key, not a principal of its own. MUST be minted fresh per machine — two hosts sharing one are a single roster line to every consumer.",
      ),
    public_key: publicKey,
    enrolled_at: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Epoch milliseconds (a non-negative integer), self-asserted by the enrolling machine. Informational: MUST NOT be used to order entries or break a tie.",
      ),
    suite,
    signature,
  })
  .strict();

type _InferredEnrollment = z.infer<typeof HostEnrollmentSchema>;

export const _HOST_ENROLLMENT_TYPE_PARITY: {
  forward: ParityForward<HostEnrollment, _InferredEnrollment>;
  reverse: ParityReverse<HostEnrollment, _InferredEnrollment>;
} = {
  forward: true,
  reverse: true,
};

export function buildHostEnrollmentJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(HostEnrollmentSchema);
  return assembleJsonSchemaFor(raw, {
    $id: HOST_ENROLLMENT_SCHEMA_ID,
    title: "HostEnrollment (v1)",
    description:
      "A motebit's sovereign-signed statement that a machine hosts its unattended work. One entry in a SET: identified by the lowercase hex SHA-256 of the canonical JSON of its signed body (every field except `signature`), unordered, merged by union. A relay stores and serves it verbatim and never mints one. See spec/machine-roster-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// HostRetirement
// ---------------------------------------------------------------------------

export const HostRetirementSchema = z
  .object({
    motebit_id: z.string().min(1).describe("MotebitId the retired enrolment belongs to."),
    enrollment_id: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "enrollment_id MUST be 64 lowercase hex characters")
      .describe(
        "Lowercase hex SHA-256 of the canonical JSON of the SIGNED BODY of the HostEnrollment being ended — every field except `signature`. Naming the entry by that hash makes removal terminal: a replayed copy has the same id and stays retired, and so does one whose signature was re-spelled.",
      ),
    public_key: publicKey,
    retired_at: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Epoch milliseconds (a non-negative integer), self-asserted. Informational: MUST NOT be used to order entries.",
      ),
    suite,
    signature,
  })
  .strict();

type _InferredRetirement = z.infer<typeof HostRetirementSchema>;

export const _HOST_RETIREMENT_TYPE_PARITY: {
  forward: ParityForward<HostRetirement, _InferredRetirement>;
  reverse: ParityReverse<HostRetirement, _InferredRetirement>;
} = {
  forward: true,
  reverse: true,
};

export function buildHostRetirementJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(HostRetirementSchema);
  return assembleJsonSchemaFor(raw, {
    $id: HOST_RETIREMENT_SCHEMA_ID,
    title: "HostRetirement (v1)",
    description:
      "A motebit's sovereign-signed end of one HostEnrollment, named by hash. Signed by ANY holder of the motebit's identity key — a lost machine cannot sign its own exit. Remove wins and is terminal for that entry. See spec/machine-roster-v1.md.",
  });
}
