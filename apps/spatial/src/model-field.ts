/**
 * The model-field sanitizer spatial runs on every mode/vendor flip and at
 * boot (#654 cold review). One field serves every mode, so an id the new
 * lane refuses must not ride a flip — but an id the lane SERVES must never
 * be cleared: on Motebit Cloud the verdict is `motebitCloudAdmission`, the
 * exact function the proxy route runs (alias step included), so a stored
 * class alias or legacy dated id the proxy serves survives boot and the next Save
 * (cold review R2: the old pre-flight skipped the alias step and cleared
 * them, and Save persisted the downgrade).
 */
import { motebitCloudAdmission, providerAcceptsModel } from "@motebit/sdk";

export type ModelFieldLane = "motebit-cloud" | "byok";

/** The field's value after a flip: `typed` if the lane serves it, else `""`
 *  (empty = "the provider's default"). `typed` is the trimmed field value —
 *  exactly what Save sends. */
export function modelFieldValueForLane(
  lane: ModelFieldLane,
  vendor: string,
  typed: string,
): string {
  if (typed === "") return "";
  const admitted =
    lane === "motebit-cloud"
      ? motebitCloudAdmission(typed).admitted
      : providerAcceptsModel(vendor, typed);
  return admitted ? typed : "";
}
