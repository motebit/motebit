/**
 * Build the reference dogfood skill at `skills/git-commit-motebit-style/`.
 *
 * Generates a fresh ephemeral keypair on each run, signs the manifest +
 * envelope per spec/skills-v1.md, and writes the signed artifacts to disk.
 * The signing key is NOT persisted — signatures verify offline against the
 * embedded public_key regardless of where the original keypair lives.
 *
 * Re-run after editing the SKILL.md body or any frontmatter field:
 *
 *   pnpm --filter @motebit/skills build-reference-skill
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  hash as sha256Hex,
  signSkillEnvelope,
  signSkillManifest,
} from "@motebit/crypto";
import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";

import { serializeSkillFile } from "../src/parse.js";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SKILL_DIR = join(REPO_ROOT, "skills", "git-commit-motebit-style");

const BODY = `# Git Commit Motebit-Style

## When to Use

The user asks for a commit message, a PR description, or a changeset entry,
and the work being captured lives in the motebit monorepo. Also fires on
"clean up the diff before commit" turns.

## Procedure

1. **Read the diff first.** \`git status\` for untracked, \`git diff --staged\`
   for staged, \`git diff\` for unstaged. Check \`git log\` for the project's
   recent commit style — every motebit commit uses Conventional Commits.
2. **Compose the subject line in Conventional Commits form** —
   \`type(scope): summary\`. Types observed in motebit history:
   \`feat\`, \`fix\`, \`refactor\`, \`docs\`, \`chore\`, \`test\`, plus motebit-
   specific scopes like \`operator(scope):\`, \`gate(check-X):\`, \`ci:\`.
   Subject is imperative mood, ≤ 70 chars.
3. **Body explains the why, not the what.** The diff already shows what
   changed. Lead with the architectural reason (e.g., "permissive-floor
   purity required types-only at this layer"). Reference doctrine docs and
   spec sections by path when they justify the change.
4. **Co-author trailer.** End commit messages authored in collaboration
   with Claude with:

       Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

   Adjust the model name to match the model that did the work. The trailer
   is required for any AI-collaborated commit.
5. **Use a HEREDOC for commit messages with multiple lines.** This avoids
   shell escaping landmines:

       git commit -m "$(cat <<'EOF'
       feat(skills): add agentskills.io-compatible runtime

       Why: ride the open standard, add sovereign primitives on top.
       Carrier thesis (memory: strategy_openclaw_hermes_carrier_thesis)
       converges on motebit becoming the only agentskills.io runtime where
       every skill carries cryptographic provenance.

       Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
       EOF
       )"

## Pitfalls

- **Never \`--no-verify\`.** Pre-commit hooks are load-bearing. If a hook
  fails, fix the underlying issue, re-stage, create a NEW commit. Do NOT
  amend across hook failures (pre-commit failure means the commit didn't
  happen — amend would modify the prior commit and lose work).
- **Never \`git add -A\` or \`git add .\`** unless every untracked file
  belongs in the commit. Add specific files. Particularly never include
  \`.env\`, credentials, or large binaries.
- **Don't ship register slips.** Commit messages and PR descriptions must
  pass the protocol-first sniff test (memory:
  feedback_register_discipline). Chat shorthand ("competitor", "MVP",
  "moat-lite") doesn't survive on the public protocol's own terms. Use
  motebit-native vocabulary in committed artifacts.
- **Don't say "I" in commit messages.** Neutral imperative voice is the
  motebit convention.

## Verification

- \`git log -1\` shows the new commit with the expected subject form
- The Conventional Commits type (\`feat\`/\`fix\`/etc.) matches the actual
  diff (don't say \`feat\` for a bug fix)
- The body explains the why, not the what
- The Co-Authored-By trailer is present iff Claude was involved
- Pre-commit hooks all passed (no \`--no-verify\`)
- The commit was created NEW (not \`--amend\` after a hook failure)
`;

async function main(): Promise<void> {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  const unsignedManifest = {
    name: "git-commit-motebit-style",
    description:
      "Craft commit messages that match motebit's Conventional Commits + co-author + HEREDOC conventions. Read the diff, lead with the architectural why, never skip hooks.",
    version: "1.0.0",
    platforms: ["macos", "linux", "windows"] as const,
    metadata: {
      author: "motebit dogfood",
      category: "software-development",
      tags: ["git", "commit", "conventional-commits"],
    },
    motebit: {
      spec_version: "1.0" as const,
      sensitivity: "none" as const,
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  };

  const bodyBytes = new TextEncoder().encode(BODY);

  const signedManifest = (await signSkillManifest(
    unsignedManifest,
    privateKey,
    publicKey,
    bodyBytes,
  )) as SkillManifest;

  // Compute content_hash and body_hash
  const contentBytes = new TextEncoder().encode(canonicalJson(signedManifest));
  const fullContent = new Uint8Array(contentBytes.length + 1 + bodyBytes.length);
  fullContent.set(contentBytes, 0);
  fullContent[contentBytes.length] = 0x0a;
  fullContent.set(bodyBytes, contentBytes.length + 1);
  const contentHash = await sha256Hex(fullContent);
  const bodyHash = await sha256Hex(bodyBytes);

  const signedEnvelope: SkillEnvelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: {
        name: signedManifest.name,
        version: signedManifest.version,
        content_hash: contentHash,
      },
      manifest: signedManifest,
      body_hash: bodyHash,
      files: [],
    },
    privateKey,
    publicKey,
  );

  const skillMdContent = serializeSkillFile(signedManifest, bodyBytes);
  writeFileSync(join(SKILL_DIR, "SKILL.md"), skillMdContent);
  writeFileSync(
    join(SKILL_DIR, "skill-envelope.json"),
    JSON.stringify(signedEnvelope, null, 2) + "\n",
  );

  console.log(`Wrote signed reference skill to ${SKILL_DIR}`);
  console.log(`  public_key: ${signedManifest.motebit.signature?.public_key}`);
  console.log(`  content_hash: ${contentHash}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
