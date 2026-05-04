/**
 * `SkillsPanelAdapter` implementation backed directly by a `SkillRegistry`.
 *
 * Web's analogue to desktop's `TauriIpcSkillsPanelAdapter` — but with no
 * sidecar process between the controller and the registry. The browser
 * sandbox is the only privilege boundary; install + envelope-bytes
 * verification run in the same renderer context as the panel UI. See
 * `packages/skills/CLAUDE.md` rule 5 for the cross-surface contract.
 *
 * The summarize/detail projections mirror the desktop sidecar
 * (`apps/desktop/src-tauri/sidecar/skills.js` — `summarize()` and
 * `detail()`), so installed-skill list rows render identically across
 * surfaces. Drift between the two would surface as a missing field in
 * the panel state shape and is caught by the controller's typecheck.
 */

import type {
  SkillDetail,
  SkillInstallResult,
  SkillProvenanceStatus,
  SkillSummary,
  SkillsInstallSource,
  SkillsPanelAdapter,
  SkillSensitivity,
  SkillPlatform,
} from "@motebit/panels";
import type { SkillRegistry } from "@motebit/skills";
import type { SkillRecord } from "@motebit/skills";
import type { SkillRegistryBundle } from "@motebit/sdk";

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
    sensitivity: (record.manifest.motebit?.sensitivity ?? "none") as SkillSensitivity,
    installed_at: record.index.installed_at,
    source: record.index.source,
  };
  if (record.manifest.platforms !== undefined) {
    summary.platforms = record.manifest.platforms as SkillPlatform[];
  }
  return summary;
}

function detail(record: SkillRecord): SkillDetail {
  const summary = summarize(record);
  const body = new TextDecoder("utf-8").decode(record.body);
  const out: SkillDetail = { ...summary, body };
  const meta = record.manifest.metadata as
    | { author?: string; category?: string; tags?: string[] }
    | undefined;
  if (meta?.author !== undefined) out.author = meta.author;
  if (meta?.category !== undefined) out.category = meta.category;
  if (meta?.tags !== undefined) out.tags = meta.tags;
  return out;
}

export interface RegistryBackedSkillsPanelAdapterOptions {
  /**
   * Fetch a `SkillRegistryBundle` from a `motebit:skills:` URL. The web
   * panel constructs this from the relay's `/api/v1/skills/...` HTTP
   * endpoint; tests can swap in a stub. The default builds the URL
   * straight from the source path and uses `fetch`.
   */
  fetchBundle: (url: string) => Promise<SkillRegistryBundle>;
}

export class RegistryBackedSkillsPanelAdapter implements SkillsPanelAdapter {
  constructor(
    private readonly registry: SkillRegistry,
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
        `Install source kind \`${source.kind}\` is not supported on web — directory installs require host filesystem access.`,
      );
    }
    const bundle = await this.options.fetchBundle(source.url);
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
