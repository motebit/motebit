/**
 * `SkillsPanelAdapter` implementation that binds directly to a
 * `SkillRegistry` instance. Used by surfaces with no sidecar isolation
 * between the panel UI and the registry — web today, desktop's
 * dev-mode fallback, and (eventually) mobile. The Tauri-sidecar path on
 * desktop production uses `TauriIpcSkillsPanelAdapter` (in apps/desktop)
 * because the bridge there is IPC, not direct.
 *
 * Type-imports `SkillRegistry` + `SkillRegistryBundle` directly from
 * `@motebit/skills` and `@motebit/protocol`. This is a deliberate
 * exception to panels' "inline wire types" convention (CLAUDE.md
 * rule 2): the registry's class shape has too many TS-variance gotchas
 * to inline cleanly without forcing every host to cast at the boundary.
 * Type-only imports are erased at runtime — panels gets no bundle-weight
 * cost and no runtime dependency on `@motebit/skills`. The package.json
 * `dependencies` entry is required for tsc resolution; it does NOT add a
 * runtime edge in the dep graph (which is what `check-deps` and the
 * "zero internal deps" rule actually defend against).
 *
 * Privilege boundary: this adapter runs install + envelope-bytes
 * verification in the same renderer context as the panel UI. Hosts that
 * want a consent gate for sensitive-tier skills (medical/financial/secret
 * per `packages/skills/CLAUDE.md` rule 5) wire `requestInstallConsent`
 * in the options; the adapter calls it after fetching the bundle but
 * before the registry's install path. Hosts that don't (e.g. strong-
 * isolation surfaces, or tests that bypass consent) omit the callback —
 * the install proceeds unconditionally.
 */

import type {
  SkillDetail,
  SkillInstallResult,
  SkillProvenanceStatus,
  SkillSummary,
  SkillsInstallSource,
  SkillsPanelAdapter,
  SkillSensitivity,
} from "./controller.js";
import type { SkillRecord, SkillRegistry } from "@motebit/skills";
import type { SkillRegistryBundle } from "@motebit/protocol";

/** Re-exported for hosts that want to type their `fetchBundle` callback. */
export type SkillBundleShape = SkillRegistryBundle;

/**
 * Duck-typed `SkillRegistry` interface — exposes only the methods the
 * adapter actually calls. Hosts pass their concrete `SkillRegistry`
 * instance from `@motebit/skills`; type-only imports above keep panels'
 * runtime dep-graph clean while letting the structural typecheck use
 * the canonical types.
 */
export type SkillRegistryShape = Pick<
  SkillRegistry,
  "list" | "get" | "install" | "enable" | "disable" | "trust" | "untrust" | "remove" | "verify"
>;

// ── Consent gate ───────────────────────────────────────────────────────

/**
 * Sensitivity tiers that require an explicit user consent gate before
 * install on weak-isolation surfaces. Per `packages/skills/CLAUDE.md`
 * rule 5: `medical`/`financial`/`secret` skills SHOULD route through an
 * additional consent prompt on surfaces where install + verification
 * run in the same renderer context as the panel UI. Strong-isolation
 * surfaces (Tauri sidecar, future MPC isolation) are exempt.
 */
const CONSENT_REQUIRED_TIERS: ReadonlySet<SkillSensitivity> = new Set([
  "medical",
  "financial",
  "secret",
]);

/**
 * Pure predicate — no I/O, no host concerns, just the rule. Surfaces
 * that need a consent gate import this and use it to decide whether to
 * surface a confirmation dialog before calling `installFromSource`.
 * Adapter-internal install also checks via the same predicate so a host
 * that wires `requestInstallConsent` is asked exactly when needed and
 * never asked when not needed.
 */
export function requiresInstallConsent(sensitivity: SkillSensitivity): boolean {
  return CONSENT_REQUIRED_TIERS.has(sensitivity);
}

/**
 * Payload passed to a host-supplied consent prompt. Carries enough
 * context for the host to render a meaningful dialog without further
 * lookup — name + version for identification, sensitivity for the
 * trade-off framing, description for the user-facing "what does this
 * do" line.
 */
export interface SkillInstallConsentRequest {
  skillName: string;
  skillVersion: string;
  sensitivity: SkillSensitivity;
  description: string;
}

/**
 * Host-supplied consent prompt. Returns `true` to proceed with install,
 * `false` to abort. The adapter throws `SkillConsentDeclined` on `false`
 * so the controller's existing error path renders a "user declined"
 * message and leaves state unchanged.
 */
export type RequestInstallConsentFn = (request: SkillInstallConsentRequest) => Promise<boolean>;

/**
 * Thrown by the adapter when `requestInstallConsent` returns `false`.
 *
 * The `<reason>: <message>` prefix matches the convention used by
 * `SkillInstallError` from `@motebit/skills` (`duplicate_name: ...`,
 * `verification_failed: ...`, etc.) — surfaces dispatch on the prefix
 * to format errors uniformly. Decline is intentionally a calm,
 * silent path: the consent modal closes, no toast fires, the install
 * does not happen. The user saw the modal close; that's the feedback.
 */
export class SkillConsentDeclined extends Error {
  readonly reason = "consent_declined" as const;
  constructor(public readonly skillName: string) {
    super(`consent_declined: User declined to install ${skillName}.`);
    this.name = "SkillConsentDeclined";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function summarize(record: SkillRecord): SkillSummary {
  const summary: SkillSummary = {
    name: record.index.name,
    version: record.index.version,
    description: record.manifest.description,
    enabled: record.index.enabled,
    trusted: record.index.trusted,
    provenance_status: record.provenance_status,
    sensitivity: record.manifest.motebit?.sensitivity ?? "none",
    installed_at: record.index.installed_at,
    source: record.index.source,
  };
  if (record.manifest.platforms !== undefined) {
    summary.platforms = [...record.manifest.platforms];
  }
  return summary;
}

function detail(record: SkillRecord): SkillDetail {
  const summary = summarize(record);
  const body = new TextDecoder("utf-8").decode(record.body);
  const out: SkillDetail = { ...summary, body };
  const meta = record.manifest.metadata;
  if (meta?.author !== undefined) out.author = meta.author;
  if (meta?.category !== undefined) out.category = meta.category;
  if (meta?.tags !== undefined) out.tags = [...meta.tags];
  return out;
}

// ── Adapter ────────────────────────────────────────────────────────────

export interface RegistryBackedSkillsPanelAdapterOptions {
  /**
   * Fetches a `SkillRegistryBundle`-shaped object from a URL. Web wires
   * `fetch`-based JSON; tests can stub with an in-memory builder. The
   * canonical relay endpoint is
   * `/api/v1/skills/:submitter/:name/:version`.
   */
  fetchBundle: (url: string) => Promise<SkillBundleShape>;
  /**
   * Optional consent gate for sensitive-tier skills on weak-isolation
   * surfaces (`medical`/`financial`/`secret`). Called after the bundle
   * fetch but before the registry's install path. If the host doesn't
   * provide a callback, install proceeds unconditionally — appropriate
   * for strong-isolation surfaces where the platform is the boundary.
   */
  requestInstallConsent?: RequestInstallConsentFn;
}

export class RegistryBackedSkillsPanelAdapter implements SkillsPanelAdapter {
  constructor(
    private readonly registry: SkillRegistryShape,
    private readonly options: RegistryBackedSkillsPanelAdapterOptions,
  ) {}

  async listSkills(): Promise<SkillSummary[]> {
    const records = await this.registry.list();
    return records.map(summarize);
  }

  async readSkillDetail(name: string): Promise<SkillDetail | null> {
    const record = await this.registry.get(name);
    if (record === null) return null;
    return detail(record);
  }

  async installFromSource(source: SkillsInstallSource): Promise<SkillInstallResult> {
    if (source.kind !== "url") {
      throw new Error(
        `Install source kind \`${source.kind}\` is not supported by the registry-backed adapter — directory installs require host filesystem access (use the Tauri sidecar adapter on desktop).`,
      );
    }
    const bundle = await this.options.fetchBundle(source.url);
    const sensitivity = bundle.envelope.manifest.motebit?.sensitivity ?? "none";
    if (this.options.requestInstallConsent !== undefined && requiresInstallConsent(sensitivity)) {
      const approved = await this.options.requestInstallConsent({
        skillName: bundle.envelope.skill.name,
        skillVersion: bundle.envelope.skill.version,
        sensitivity,
        description: bundle.envelope.manifest.description,
      });
      if (!approved) {
        throw new SkillConsentDeclined(bundle.envelope.skill.name);
      }
    }
    const body = base64ToBytes(bundle.body);
    const files: Record<string, Uint8Array> = {};
    for (const [path, b64] of Object.entries(bundle.files ?? {})) {
      files[path] = base64ToBytes(b64);
    }
    return this.registry.install(
      {
        kind: "in_memory",
        manifest: bundle.envelope.manifest,
        envelope: bundle.envelope,
        body,
        files,
      },
      { source_label: source.url },
    );
  }

  async enableSkill(name: string): Promise<void> {
    await this.registry.enable(name);
  }

  async disableSkill(name: string): Promise<void> {
    await this.registry.disable(name);
  }

  async trustSkill(name: string): Promise<void> {
    await this.registry.trust(name);
  }

  async untrustSkill(name: string): Promise<void> {
    await this.registry.untrust(name);
  }

  async removeSkill(name: string): Promise<void> {
    await this.registry.remove(name);
  }

  async verifySkill(name: string): Promise<SkillProvenanceStatus | "not_installed"> {
    return this.registry.verify(name);
  }
}
