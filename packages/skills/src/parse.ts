/**
 * SKILL.md parser — splits frontmatter from body, validates against the
 * `SkillManifestSchema` zod schema, normalizes body bytes to LF endings.
 *
 * Outputs the parsed manifest object plus the LF-normalized body bytes.
 * Both are inputs to the canonicalize/verify recipe in @motebit/crypto.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SkillManifestSchema } from "@motebit/wire-schemas";
import type { SkillManifest } from "@motebit/protocol";

const FRONTMATTER_DELIM = "---";

export class SkillParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(message);
    this.name = "SkillParseError";
  }
}

/**
 * Strip a leading UTF-8 BOM if present. Per spec §5.1, body bytes are
 * BOM-free; the parser strips at parse time so callers don't need to.
 */
function stripBom(text: string): string {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Convert CRLF and bare CR to LF. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Parse a SKILL.md file. Splits frontmatter (between `---` delimiters at the
 * top of the file) from the body, validates the YAML frontmatter against
 * the SkillManifest wire schema, and returns the manifest + LF-normalized
 * body bytes ready for canonicalization.
 *
 * Fail-closed on malformed structure: missing frontmatter, malformed YAML,
 * frontmatter that fails schema validation. Errors carry line/column where
 * available.
 */
export function parseSkillFile(rawText: string): {
  manifest: SkillManifest;
  body: Uint8Array;
} {
  const text = normalizeLineEndings(stripBom(rawText));

  if (!text.startsWith(`${FRONTMATTER_DELIM}\n`) && !text.startsWith(`${FRONTMATTER_DELIM}\r`)) {
    throw new SkillParseError(
      "SKILL.md must begin with a `---` frontmatter delimiter on the first line.",
      1,
      1,
    );
  }

  const afterOpen = text.slice(FRONTMATTER_DELIM.length + 1); // skip "---\n"
  const closeIdx = afterOpen.indexOf(`\n${FRONTMATTER_DELIM}\n`);
  const closeIdxAtEof = afterOpen.endsWith(`\n${FRONTMATTER_DELIM}`);

  let frontmatterRaw: string;
  let bodyText: string;

  if (closeIdx >= 0) {
    frontmatterRaw = afterOpen.slice(0, closeIdx);
    bodyText = afterOpen.slice(closeIdx + 1 + FRONTMATTER_DELIM.length + 1); // skip "\n---\n"
  } else if (closeIdxAtEof) {
    frontmatterRaw = afterOpen.slice(0, afterOpen.length - FRONTMATTER_DELIM.length - 1);
    bodyText = "";
  } else {
    throw new SkillParseError("SKILL.md frontmatter has no closing `---` delimiter.");
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterRaw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SkillParseError(`Frontmatter is not valid YAML: ${message}`);
  }

  const validation = SkillManifestSchema.safeParse(frontmatter);
  if (!validation.success) {
    const first = validation.error.errors[0];
    const path = first?.path.join(".") ?? "(root)";
    throw new SkillParseError(
      `Frontmatter failed schema validation at \`${path}\`: ${first?.message ?? "unknown"}`,
    );
  }

  return {
    manifest: validation.data as SkillManifest,
    body: new TextEncoder().encode(bodyText),
  };
}

/**
 * Inverse of `parseSkillFile` — serializes a manifest + body back to a
 * SKILL.md string. Used when materializing skills from `in_memory` install
 * sources to disk.
 *
 * IMPORTANT: this output is NOT what the signature is computed over. The
 * signature is computed over the JCS-canonical form of the manifest object
 * concatenated with the LF-normalized body, per spec §5.1. Use
 * `canonicalizeSkillManifestBytes` from @motebit/crypto for that.
 *
 * Round-trip property: `parseSkillFile(serializeSkillFile(m, b))` yields a
 * structurally-equivalent `{ manifest, body }`. Insertion order is preserved
 * by the YAML library; canonicalization for signing always reroutes through
 * JCS so reader/writer YAML formatting differences don't break signatures.
 */
export function serializeSkillFile(manifest: SkillManifest, body: Uint8Array): string {
  const yamlBlock = stringifyYaml(manifest);
  const bodyText = new TextDecoder().decode(body);
  const trailing = bodyText.endsWith("\n") || bodyText.length === 0 ? "" : "\n";
  return `---\n${yamlBlock}---\n${bodyText}${trailing}`;
}
