/**
 * Skills registry — relay-hosted index of submitted, signature-verified
 * skill envelopes (`spec/skills-registry-v1.md`).
 *
 * Permissive submit, curated discovery: any motebit-signed envelope is
 * accepted; the default discover query filters by a featured-submitters
 * allowlist. Curation is a discovery filter, not a submission gate.
 *
 * The relay stores the submitted envelope/body/files byte-identical for
 * consumer-side re-verification (services/relay/CLAUDE.md rule 11
 * shape). Consumers MUST re-verify against the embedded
 * `motebit.signature.public_key` before installing — the relay is a
 * convenience surface, not a trust root (CLAUDE.md rule 6).
 *
 * Routes:
 *   POST /api/v1/skills/submit
 *   GET  /api/v1/skills/discover
 *   GET  /api/v1/skills/:submitter/:name/:version
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  bytesToHex,
  decodeSkillSignaturePublicKey,
  hexToBytes,
  publicKeyToDidKey,
  sha256,
  verifySkillEnvelopeDetailed,
} from "@motebit/crypto";
import type {
  SkillRegistryBundle,
  SkillRegistryEntry,
  SkillRegistryListing,
  SkillRegistrySubmitRequest,
  SkillRegistrySubmitResponse,
} from "@motebit/protocol";
import type { DatabaseDriver } from "@motebit/persistence";
import { SkillRegistryBundleSchema, SkillRegistrySubmitRequestSchema } from "@motebit/wire-schemas";

import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "skill-registry" });

// === Limits ===

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Hard cap on the total submission payload (envelope + body + files), pre-base64. */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

// === Database ===

export function createSkillRegistryTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_skill_registry (
      submitter_motebit_id  TEXT NOT NULL,
      name                  TEXT NOT NULL,
      version               TEXT NOT NULL,
      content_hash          TEXT NOT NULL,
      description           TEXT NOT NULL,
      sensitivity           TEXT NOT NULL,
      platforms_json        TEXT,
      category              TEXT,
      tags_json             TEXT,
      author                TEXT,
      signature_public_key  TEXT NOT NULL,
      featured              INTEGER NOT NULL DEFAULT 0,
      submitted_at          INTEGER NOT NULL,
      bundle_json           TEXT NOT NULL,
      PRIMARY KEY (submitter_motebit_id, name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_registry_name ON relay_skill_registry(name);
    CREATE INDEX IF NOT EXISTS idx_skill_registry_submitter ON relay_skill_registry(submitter_motebit_id);
    CREATE INDEX IF NOT EXISTS idx_skill_registry_featured ON relay_skill_registry(featured, name);
  `);
}

// === Deps ===

export interface SkillRegistryDeps {
  db: DatabaseDriver;
  app: Hono;
  /**
   * Submitter `motebit_id` (did:key) values that are featured in the
   * default discover view. Reference relay reads from
   * `FEATURED_SKILL_SUBMITTERS` env var (comma-separated).
   */
  featuredSubmitters?: ReadonlySet<string>;
}

// === Internal row shape ===

interface RegistryRow {
  submitter_motebit_id: string;
  name: string;
  version: string;
  content_hash: string;
  description: string;
  sensitivity: string;
  platforms_json: string | null;
  category: string | null;
  tags_json: string | null;
  author: string | null;
  signature_public_key: string;
  featured: number;
  submitted_at: number;
  bundle_json: string;
}

function rowToEntry(row: RegistryRow): SkillRegistryEntry {
  const entry: SkillRegistryEntry = {
    submitter_motebit_id: row.submitter_motebit_id,
    name: row.name,
    version: row.version,
    content_hash: row.content_hash,
    description: row.description,
    sensitivity: row.sensitivity as SkillRegistryEntry["sensitivity"],
    signature_public_key: row.signature_public_key,
    featured: row.featured === 1,
    submitted_at: row.submitted_at,
  };
  if (row.platforms_json !== null) {
    entry.platforms = JSON.parse(row.platforms_json) as SkillRegistryEntry["platforms"];
  }
  if (row.category !== null) entry.category = row.category;
  if (row.tags_json !== null) entry.tags = JSON.parse(row.tags_json) as string[];
  if (row.author !== null) entry.author = row.author;
  return entry;
}

// === Base64 decode (web-platform `atob` so the function works in any
//     runtime — Node ≥ 16, Bun, Deno) ===

function base64Decode(s: string): Uint8Array {
  // Normalize url-safe → standard before atob; tolerate missing padding.
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// === Routes ===

export function registerSkillRegistryRoutes(deps: SkillRegistryDeps): void {
  const { db, app, featuredSubmitters } = deps;

  // ── POST /api/v1/skills/submit ──
  /** @spec motebit/skills-registry@1.0 */
  app.post("/api/v1/skills/submit", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "bad_request: malformed JSON body" });
    }

    // Approximate payload size before any heavy work.
    const approxSize = JSON.stringify(raw).length;
    if (approxSize > MAX_PAYLOAD_BYTES) {
      throw new HTTPException(413, {
        message: `payload_too_large: ${approxSize} bytes exceeds ${MAX_PAYLOAD_BYTES}`,
      });
    }

    const parsed = SkillRegistrySubmitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `bad_request: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      });
    }
    const submission: SkillRegistrySubmitRequest = parsed.data;
    const { envelope } = submission;

    // 1. Verify envelope signature (skills-v1.md §5).
    const publicKey = decodeSkillSignaturePublicKey(envelope.signature);
    const verifyDetail = await verifySkillEnvelopeDetailed(envelope, publicKey);
    if (!verifyDetail.valid) {
      throw new HTTPException(400, {
        message: `verification_failed: ${verifyDetail.reason}`,
      });
    }

    // 2. Re-derive body hash from the submitted bytes.
    const bodyBytes = base64Decode(submission.body);
    const bodyDigest = bytesToHex(await sha256(bodyBytes));
    if (bodyDigest !== envelope.body_hash) {
      throw new HTTPException(400, {
        message: `body_hash_mismatch: submitted body hashes to ${bodyDigest}, envelope pins ${envelope.body_hash}`,
      });
    }

    // 3. Re-derive each file hash. Envelope.files names every aux file;
    //    the submission MUST carry every byte the envelope pins.
    const fileBytes = submission.files ?? {};
    for (const fileSpec of envelope.files) {
      const b64 = fileBytes[fileSpec.path];
      if (b64 === undefined) {
        throw new HTTPException(400, {
          message: `file_hash_mismatch: envelope pins ${fileSpec.path} but submission omits it`,
        });
      }
      const decoded = base64Decode(b64);
      const digest = bytesToHex(await sha256(decoded));
      if (digest !== fileSpec.hash) {
        throw new HTTPException(400, {
          message: `file_hash_mismatch: ${fileSpec.path} hashes to ${digest}, envelope pins ${fileSpec.hash}`,
        });
      }
    }

    // 4. Derive canonical submitter from envelope signature key. The
    //    submitter is NEVER user-named — this is the spoof-prevention
    //    primitive (spec §3).
    const submitterMotebitId = publicKeyToDidKey(hexToBytes(envelope.signature.public_key));

    // 5. Idempotency / immutability check.
    const existing = db
      .prepare(
        "SELECT content_hash, submitted_at FROM relay_skill_registry WHERE submitter_motebit_id = ? AND name = ? AND version = ?",
      )
      .get(submitterMotebitId, envelope.skill.name, envelope.skill.version) as
      | { content_hash: string; submitted_at: number }
      | undefined;
    if (existing && existing.content_hash !== envelope.skill.content_hash) {
      throw new HTTPException(409, {
        message: `version_immutable: ${submitterMotebitId}/${envelope.skill.name}@${envelope.skill.version} already exists with content_hash ${existing.content_hash}`,
      });
    }

    const featured = featuredSubmitters?.has(submitterMotebitId) === true;
    const submittedAt = existing?.submitted_at ?? Date.now();

    // 6. Persist byte-identical bundle + indexed projection.
    const bundle: SkillRegistryBundle = {
      submitter_motebit_id: submitterMotebitId,
      envelope,
      body: submission.body,
      ...(submission.files !== undefined ? { files: submission.files } : {}),
      submitted_at: submittedAt,
      featured,
    };
    db.prepare(
      `INSERT OR REPLACE INTO relay_skill_registry
       (submitter_motebit_id, name, version, content_hash, description, sensitivity,
        platforms_json, category, tags_json, author, signature_public_key, featured,
        submitted_at, bundle_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      submitterMotebitId,
      envelope.skill.name,
      envelope.skill.version,
      envelope.skill.content_hash,
      envelope.manifest.description,
      envelope.manifest.motebit.sensitivity ?? "none",
      envelope.manifest.platforms ? JSON.stringify(envelope.manifest.platforms) : null,
      envelope.manifest.metadata?.category ?? null,
      envelope.manifest.metadata?.tags ? JSON.stringify(envelope.manifest.metadata.tags) : null,
      envelope.manifest.metadata?.author ?? null,
      envelope.signature.public_key,
      featured ? 1 : 0,
      submittedAt,
      JSON.stringify(bundle),
    );

    if (!existing) {
      logger.info("skill_registry.submitted", {
        submitter: submitterMotebitId,
        name: envelope.skill.name,
        version: envelope.skill.version,
        content_hash: envelope.skill.content_hash,
        featured,
      });
    }

    const response: SkillRegistrySubmitResponse = {
      skill_id: `${submitterMotebitId}/${envelope.skill.name}@${envelope.skill.version}`,
      submitter_motebit_id: submitterMotebitId,
      name: envelope.skill.name,
      version: envelope.skill.version,
      content_hash: envelope.skill.content_hash,
      submitted_at: submittedAt,
    };
    return c.json(response, existing ? 200 : 201);
  });

  // ── GET /api/v1/skills/discover ──
  /** @spec motebit/skills-registry@1.0 */
  app.get("/api/v1/skills/discover", (c) => {
    const q = c.req.query("q")?.toLowerCase().trim();
    const submitter = c.req.query("submitter");
    const sensitivity = c.req.query("sensitivity");
    const platform = c.req.query("platform");
    const includeUnfeatured = c.req.query("include_unfeatured") === "true";
    const limit = Math.max(
      1,
      Math.min(
        MAX_LIMIT,
        parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      ),
    );
    const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (!includeUnfeatured) {
      where.push("featured = 1");
    }
    if (submitter !== undefined && submitter !== "") {
      where.push("submitter_motebit_id = ?");
      params.push(submitter);
    }
    if (sensitivity !== undefined && sensitivity !== "") {
      where.push("sensitivity = ?");
      params.push(sensitivity);
    }
    if (q !== undefined && q !== "") {
      // Case-insensitive substring across name/description/tags.
      where.push(
        "(LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(IFNULL(tags_json, '')) LIKE ?)",
      );
      const wildcard = `%${q}%`;
      params.push(wildcard, wildcard, wildcard);
    }

    const baseSql =
      "FROM relay_skill_registry" + (where.length ? ` WHERE ${where.join(" AND ")}` : "");

    const totalRow = db.prepare(`SELECT COUNT(*) as cnt ${baseSql}`).get(...params) as
      | { cnt: number }
      | undefined;
    let total = totalRow?.cnt ?? 0;

    const rows = db
      .prepare(`SELECT * ${baseSql} ORDER BY name ASC, version DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RegistryRow[];

    let entries = rows.map(rowToEntry);

    if (platform !== undefined && platform !== "") {
      // Filter at the application layer because the SQL `platforms_json`
      // is a JSON array; SQLite JSON ops aren't portable enough for v1.
      const before = entries.length;
      entries = entries.filter(
        (e) => e.platforms === undefined || e.platforms.includes(platform as never),
      );
      total -= before - entries.length;
    }

    const response: SkillRegistryListing = { entries, total, limit, offset };
    return c.json(response);
  });

  // ── GET /api/v1/skills/:submitter/:name/:version ──
  /** @spec motebit/skills-registry@1.0 */
  app.get("/api/v1/skills/:submitter/:name/:version", (c) => {
    const submitter = c.req.param("submitter");
    const name = c.req.param("name");
    const version = c.req.param("version");

    const row = db
      .prepare(
        "SELECT bundle_json FROM relay_skill_registry WHERE submitter_motebit_id = ? AND name = ? AND version = ?",
      )
      .get(submitter, name, version) as { bundle_json: string } | undefined;
    if (!row) {
      throw new HTTPException(404, {
        message: `not_found: ${submitter}/${name}@${version}`,
      });
    }

    // Parse the stored bundle and validate against the wire schema before
    // returning. This is defense-in-depth — the bundle was already
    // validated at submit time, but pinning the read path through the
    // schema means a future migration that mutated `bundle_json` would
    // surface here, not silently to consumers.
    const parsed = SkillRegistryBundleSchema.safeParse(JSON.parse(row.bundle_json));
    if (!parsed.success) {
      logger.error("skill_registry.bundle_corrupt", {
        submitter,
        name,
        version,
        issues: parsed.error.issues,
      });
      throw new HTTPException(500, { message: "internal_error: stored bundle invalid" });
    }
    return c.json(parsed.data);
  });
}

// === Helpers (exported for tests) ===

/** Parse the FEATURED_SKILL_SUBMITTERS env var into a Set. */
export function parseFeaturedSubmitters(raw: string | undefined): Set<string> {
  if (raw === undefined || raw === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}
