---
"@motebit/skills": patch
---

Add `git-conventional-commits` carrier-demo skill — runtime-agnostic procedural knowledge for composing Conventional Commits 1.0.0 messages. Body has zero motebit-specific references; the only motebit-flavored surface is the `motebit.*` frontmatter namespace (signature, sensitivity, hardware attestation), which non-motebit runtimes ignore per `spec/skills-v1.md` §11.

The corpus now demonstrates the carrier thesis with three artifacts:

- `git-conventional-commits` — generic, runtime-agnostic. Loads unmodified on Claude Code, Codex, Cursor, OpenClaw, Hermes, or any agentskills.io-compatible runtime. The motebit-specific value is the cryptographic provenance — the body is something any agent benefits from.
- `git-commit-motebit-style` — motebit-specific layering on top of Conventional Commits (Co-Authored-By trailers, HEREDOC for multi-line, never-`--no-verify` constraint). Motebit's flavor of the same shape.
- `motebit-spec-writer` — fully motebit-specific. Drafts `motebit/<name>@<version>` specs with foundation-law markers and triple-sync discipline.

Three signed skills covering the full layering spectrum: generic carrier → flavored carrier → motebit-internal. When 4.4 web ships and an external visitor lands on motebit.com/skills, the first skill they see is one they can install in their existing Claude Code setup as a working reference, not a motebit-internal artifact.

Build via `pnpm --filter @motebit/skills build-conventional-commits-skill`.
