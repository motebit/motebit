// @motebit/desktop-skills-sidecar
//
// Phase 4.2 of skills-v1: a Node child that owns all skill verification +
// fs-write + trust grants. The Tauri webview never sees envelope bytes;
// it sees only display-grade SkillSummary / SkillDetail records.
//
// Why a sidecar — feedback_privilege_boundary_probe (2026-04-29):
// install-permissive (spec §7.1) means motebit accepts arbitrary third-
// party SKILL.md content; rendering it in a context that ALSO has fs-
// write + signature verification collapses three privilege concerns
// into one process. The desktop renderer is a Chromium webview
// (architecture_tauri_webview_not_node). Boundary: webview → Rust IPC →
// this sidecar. Node fs/crypto stays here.
//
// Wire format: newline-delimited JSON. One request per line on stdin,
// one response per line on stdout. Errors surface as { ok: false, error }
// with a typed `reason` so the Rust layer can translate to a structured
// IPC error without parsing free-text messages.
//
// Methods are a 1:1 facade over @motebit/skills' SkillRegistry +
// NodeFsSkillStorageAdapter. The summary projection is local to the
// sidecar so the wire payload stays display-shaped (no Uint8Array body
// in list responses).

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { SkillRegistry, SkillInstallError } from "@motebit/skills";
import { NodeFsSkillStorageAdapter, resolveDirectorySkillSource } from "@motebit/skills/node-fs";

const SKILLS_ROOT = join(homedir(), ".motebit", "skills");

const adapter = new NodeFsSkillStorageAdapter({ root: SKILLS_ROOT });
const registry = new SkillRegistry(adapter, {
  // Audit events flow back to the host as protocol-flavored notifications.
  // The Rust side currently logs them; phase 4.2.x wires them into the
  // event store for ledger receipts (skill_trust_grant / skill_remove).
  audit: (event) => {
    writeFrame({ id: null, ok: true, notification: "audit", payload: event });
  },
});

// ── Display-grade projections (match @motebit/panels SkillsPanelAdapter) ──

function summarize(record) {
  const summary = {
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
    summary.platforms = record.manifest.platforms;
  }
  return summary;
}

function detail(record) {
  const summary = summarize(record);
  // body is Uint8Array on the wire from @motebit/skills; surfaces render
  // markdown so we decode UTF-8 here. Frontmatter strings already pre-
  // decoded into manifest.metadata.
  const body = new TextDecoder("utf-8").decode(record.body);
  const out = { ...summary, body };
  const meta = record.manifest.metadata;
  if (meta?.author !== undefined) out.author = meta.author;
  if (meta?.category !== undefined) out.category = meta.category;
  if (meta?.tags !== undefined) out.tags = meta.tags;
  return out;
}

// ── Method dispatch ────────────────────────────────────────────────────

const handlers = {
  async list() {
    const records = await registry.list();
    return records.map(summarize);
  },

  async read_detail(params) {
    const record = await registry.get(params.name);
    if (record === null) return null;
    return detail(record);
  },

  async install_directory(params) {
    const source = resolveDirectorySkillSource(params.path);
    const force = params.force === true;
    return registry.install(source, { force, source_label: `directory:${params.path}` });
  },

  async enable(params) {
    await registry.enable(params.name);
    return null;
  },

  async disable(params) {
    await registry.disable(params.name);
    return null;
  },

  async trust(params) {
    await registry.trust(params.name);
    return null;
  },

  async untrust(params) {
    await registry.untrust(params.name);
    return null;
  },

  async remove(params) {
    await registry.remove(params.name);
    return null;
  },

  async verify(params) {
    return registry.verify(params.name);
  },
};

// ── Frame I/O ──────────────────────────────────────────────────────────

function writeFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function classifyError(err) {
  if (err instanceof SkillInstallError) {
    return { reason: err.reason, message: err.message };
  }
  if (err instanceof Error) {
    return { reason: "internal_error", message: err.message };
  }
  return { reason: "internal_error", message: String(err) };
}

async function dispatch(req) {
  const handler = handlers[req.method];
  if (handler === undefined) {
    return { id: req.id, ok: false, error: { reason: "unknown_method", message: req.method } };
  }
  try {
    const result = await handler(req.params ?? {});
    return { id: req.id, ok: true, result };
  } catch (err) {
    return { id: req.id, ok: false, error: classifyError(err) };
  }
}

// ── Main loop ──────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (line === "") return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    writeFrame({
      id: null,
      ok: false,
      error: { reason: "protocol_error", message: `malformed JSON: ${err.message}` },
    });
    return;
  }
  if (typeof req.id !== "number" || typeof req.method !== "string") {
    writeFrame({
      id: req.id ?? null,
      ok: false,
      error: { reason: "protocol_error", message: "missing id or method" },
    });
    return;
  }
  void dispatch(req).then(writeFrame);
});

rl.on("close", () => {
  process.exit(0);
});

// Announce ready so the Rust side can stop a startup race. The Rust
// host reads exactly one line from stdout before forwarding any
// requests; this guarantees the sidecar's @motebit/skills imports
// finished loading before the first IPC call.
writeFrame({ id: null, ok: true, notification: "ready", root: SKILLS_ROOT });
