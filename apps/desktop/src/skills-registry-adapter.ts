/**
 * `SkillsPanelAdapter` implementation backed directly by an
 * IDB-stored `SkillRegistry` — used in desktop's dev-mode fallback
 * (`vite dev` without the Tauri shell). The Tauri sidecar isn't
 * available, so install + envelope-bytes verification run in the
 * Chromium webview itself.
 *
 * Sibling of `apps/web/src/skills-adapter.ts` — same shape, different
 * surface. Drift between the two is bounded by `SkillsPanelAdapter`'s
 * structural typecheck.
 *
 * Privilege boundary: dev-mode collapses install + verification +
 * fs-write into one process (no sidecar isolation analogue without
 * Tauri). The status banner above the panel makes this explicit.
 * See `packages/skills/CLAUDE.md` rule 5 for the cross-surface
 * contract — desktop production preserves the sidecar boundary; only
 * dev-mode degrades to the in-process trade-off web carries.
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

export interface InRendererSkillsPanelAdapterOptions {
  /** Fetches a `SkillRegistryBundle` from a URL — defaults to plain `fetch`. */
  fetchBundle?: (url: string) => Promise<SkillRegistryBundle>;
}

export class InRendererSkillsPanelAdapter implements SkillsPanelAdapter {
  private readonly fetchBundle: (url: string) => Promise<SkillRegistryBundle>;

  constructor(
    private readonly registry: SkillRegistry,
    options: InRendererSkillsPanelAdapterOptions = {},
  ) {
    this.fetchBundle =
      options.fetchBundle ??
      (async (url: string) => {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
          throw new Error(`Relay returned ${resp.status}: ${resp.statusText}`);
        }
        return (await resp.json()) as SkillRegistryBundle;
      });
  }

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
        `Install source kind \`${source.kind}\` is not supported in dev-mode fallback — directory installs require the Tauri sidecar.`,
      );
    }
    const bundle = await this.fetchBundle(source.url);
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
