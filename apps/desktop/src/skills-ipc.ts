// Tauri IPC adapter for the skills panel.
//
// Implements `SkillsPanelAdapter` from `@motebit/panels`. Each method
// dispatches to the matching `skills_*` command in `src-tauri/src/skills.rs`,
// which forwards to the Node sidecar.
//
// The webview never sees envelope bytes, body bytes pre-decode, or
// signature material — by the time data reaches this layer, the sidecar
// has already verified provenance and projected to display-grade
// summaries. That's the whole privilege-boundary point of phase 4.2.
//
// The error reasons surfaced by the Rust dispatch match the sidecar's
// classification taxonomy (`verification_failed`, `duplicate_name`,
// `size_limit_exceeded`, `manifest_envelope_mismatch`,
// `malformed_source`, `internal_error`) plus the host-only reasons
// `sidecar_unavailable` (Node missing, spawn failed, child crashed)
// and `protocol_error` (malformed frame). Surfaces translate these into
// next-step messaging via `feedback_intelligence_commodity`-shaped UI
// — short error toast, link to remediation.

import type {
  SkillDetail,
  SkillInstallResult,
  SkillProvenanceStatus,
  SkillSummary,
  SkillsInstallSource,
  SkillsPanelAdapter,
} from "@motebit/panels";

import type { InvokeFn } from "./tauri-storage";

interface IpcError {
  reason: string;
  message: string;
}

function isIpcError(err: unknown): err is IpcError {
  return (
    typeof err === "object" &&
    err !== null &&
    "reason" in err &&
    "message" in err &&
    typeof (err as { reason: unknown }).reason === "string"
  );
}

/**
 * Wrap a sidecar call so the controller's `state.error` carries the
 * structured reason in the message — surfaces parse it back via the
 * `Skills unavailable: <reason>` convention to flip the panel into
 * its `[unavailable]` empty state without re-throwing.
 */
async function callIpc<T>(
  invoke: InvokeFn,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err: unknown) {
    if (isIpcError(err)) {
      throw new Error(`${err.reason}: ${err.message}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export class TauriIpcSkillsPanelAdapter implements SkillsPanelAdapter {
  constructor(private readonly invoke: InvokeFn) {}

  listSkills(): Promise<SkillSummary[]> {
    return callIpc<SkillSummary[]>(this.invoke, "skills_list");
  }

  readSkillDetail(name: string): Promise<SkillDetail | null> {
    return callIpc<SkillDetail | null>(this.invoke, "skills_read_detail", { name });
  }

  async installFromSource(source: SkillsInstallSource): Promise<SkillInstallResult> {
    if (source.kind !== "directory") {
      // URL installs are phase 4.5 (curated registry). The desktop
      // panel only exposes the directory picker, so this branch is
      // unreachable from the UI — guard anyway so a future ad-hoc
      // call site fails fast instead of silently no-op'ing.
      throw new Error(
        `Install source kind \`${source.kind}\` is not supported on desktop yet (phase 4.5).`,
      );
    }
    return callIpc<SkillInstallResult>(this.invoke, "skills_install_directory", {
      path: source.path,
    });
  }

  async enableSkill(name: string): Promise<void> {
    await callIpc(this.invoke, "skills_enable", { name });
  }

  async disableSkill(name: string): Promise<void> {
    await callIpc(this.invoke, "skills_disable", { name });
  }

  async trustSkill(name: string): Promise<void> {
    await callIpc(this.invoke, "skills_trust", { name });
  }

  async untrustSkill(name: string): Promise<void> {
    await callIpc(this.invoke, "skills_untrust", { name });
  }

  async removeSkill(name: string): Promise<void> {
    await callIpc(this.invoke, "skills_remove", { name });
  }

  verifySkill(name: string): Promise<SkillProvenanceStatus | "not_installed"> {
    return callIpc<SkillProvenanceStatus | "not_installed">(this.invoke, "skills_verify", {
      name,
    });
  }
}
