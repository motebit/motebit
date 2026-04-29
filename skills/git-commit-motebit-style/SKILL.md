---
name: git-commit-motebit-style
description: Craft commit messages that match motebit's Conventional Commits +
  co-author + HEREDOC conventions. Read the diff, lead with the architectural
  why, never skip hooks.
version: 1.0.0
platforms:
  - macos
  - linux
  - windows
metadata:
  author: motebit dogfood
  category: software-development
  tags:
    - git
    - commit
    - conventional-commits
motebit:
  spec_version: "1.0"
  sensitivity: none
  hardware_attestation:
    required: false
    minimum_score: 0
  signature:
    suite: motebit-jcs-ed25519-b64-v1
    public_key: ed5337823240b4bdd52e5e83dfdd4cc0f175222be4ab34b7707414cfa714adc2
    value: ZmEx7_5yQqCpGjuxR3X1TFL8ea92O3u7Rr60wqNW0ZrwCTc655SkIqKcZl6c9dqIuTOH4qIwaDxdcPsH92mCBg
---
# Git Commit Motebit-Style

## When to Use

The user asks for a commit message, a PR description, or a changeset entry,
and the work being captured lives in the motebit monorepo. Also fires on
"clean up the diff before commit" turns.

## Procedure

1. **Read the diff first.** `git status` for untracked, `git diff --staged`
   for staged, `git diff` for unstaged. Check `git log` for the project's
   recent commit style — every motebit commit uses Conventional Commits.
2. **Compose the subject line in Conventional Commits form** —
   `type(scope): summary`. Types observed in motebit history:
   `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, plus motebit-
   specific scopes like `operator(scope):`, `gate(check-X):`, `ci:`.
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

- **Never `--no-verify`.** Pre-commit hooks are load-bearing. If a hook
  fails, fix the underlying issue, re-stage, create a NEW commit. Do NOT
  amend across hook failures (pre-commit failure means the commit didn't
  happen — amend would modify the prior commit and lose work).
- **Never `git add -A` or `git add .`** unless every untracked file
  belongs in the commit. Add specific files. Particularly never include
  `.env`, credentials, or large binaries.
- **Don't ship register slips.** Commit messages and PR descriptions must
  pass the protocol-first sniff test (memory:
  feedback_register_discipline). Chat shorthand ("competitor", "MVP",
  "moat-lite") doesn't survive on the public protocol's own terms. Use
  motebit-native vocabulary in committed artifacts.
- **Don't say "I" in commit messages.** Neutral imperative voice is the
  motebit convention.

## Verification

- `git log -1` shows the new commit with the expected subject form
- The Conventional Commits type (`feat`/`fix`/etc.) matches the actual
  diff (don't say `feat` for a bug fix)
- The body explains the why, not the what
- The Co-Authored-By trailer is present iff Claude was involved
- Pre-commit hooks all passed (no `--no-verify`)
- The commit was created NEW (not `--amend` after a hook failure)
