---
name: git-conventional-commits
description: "Compose Conventional Commits 1.0.0 messages — `type(scope):
  subject`, body explains the why, breaking changes flagged. Read the diff
  first, match the project's prior types and scopes, never bundle unrelated
  changes."
version: 1.0.0
platforms:
  - macos
  - linux
  - windows
metadata:
  author: agentskills.io carrier-demo
  category: software-development
  tags:
    - git
    - commit
    - conventional-commits
    - semver
motebit:
  spec_version: "1.0"
  sensitivity: none
  hardware_attestation:
    required: false
    minimum_score: 0
  signature:
    suite: motebit-jcs-ed25519-b64-v1
    public_key: 858996cc58abe51870bd48c5a46ea5c8d5341293648455c1712866006ede2c13
    value: V3u9sMKRafU9eMR_s2V2jgEq5BPMz-mPh-Dp8HcmzTiaytisWgJOFijfnrhcIOINrEQWMW1Wv83Ku1CflcS7CQ
---
# Conventional Commits

## When to Use

The user asks for a commit message, a release-notes summary, or a
changelog entry, and the project follows the Conventional Commits 1.0.0
specification. Telltale signs: a `CHANGELOG.md` with grouped sections,
prior commits in `type(scope): subject` form, a `commitlint` or
`@commitlint/config-conventional` dependency, or release tooling that
expects semver-friendly commit history (semantic-release, changesets,
release-please).

## Procedure

1. **Read the diff before composing the message.** `git status` for
   untracked, `git diff --staged` for staged, `git diff` for unstaged.
   The message describes what the diff actually does, not what the user
   intended; if those diverge, surface the divergence rather than
   papering over it.

2. **Pick the type.** Conventional Commits 1.0.0 normatively defines
   only `feat` (new feature, MINOR semver bump) and `fix` (bug fix,
   PATCH semver bump). Common additional types — `build`, `chore`,
   `ci`, `docs`, `perf`, `refactor`, `style`, `test` — are widely
   adopted but project-specific. Match the project's prior history
   before introducing a new type.

3. **Pick the scope.** Optional. A noun in parentheses describing the
   subsystem: `feat(api):`, `fix(auth):`. Read 5-10 prior commits to
   see what scopes the project uses; reuse them. Inventing a new
   scope is acceptable when no existing one fits, but never invent
   one that overlaps an existing one with a different name.

4. **Compose the subject line.** `type(scope): summary` or
   `type: summary` if no scope. Imperative mood ("add", not "added"
   or "adds"). No trailing period. Aim for ≤ 72 characters total. The
   summary should let a reader skim `git log --oneline` and
   understand what changed without reading the diff.

5. **Write the body.** Optional but recommended for non-trivial
   changes. Blank line separates subject from body. The body
   explains the **why** — what problem the diff solves, what
   constraint forced the approach, what alternatives were rejected.
   The diff already shows the **what**. Wrap at 72 columns by
   convention; readers paginate `git log` in a terminal.

6. **Flag breaking changes explicitly.** Two ways, either is valid:
   - `!` after the type/scope: `feat(api)!: drop legacy v1 endpoints`
   - `BREAKING CHANGE:` footer with description of what breaks
   Both forms map to a MAJOR semver bump. Use both together for
   maximum tooling compatibility.

7. **Add footers for related context.** Conventional Commits supports
   git trailers in the footer (Reference: `Closes #123`,
   `Reviewed-by:`, `Co-authored-by:`). One per line, after a blank
   line separating from the body. Tooling parses these.

## Pitfalls

- **`type` describes the change, not the file.** Editing a test file
  to fix a bug it reveals is `fix`, not `test`. Adding a new test
  for an unbugged feature is `test`. Read the diff and ask "what
  would a downstream consumer notice?"

- **`feat` is for users, `refactor` is for the codebase.** A
  refactor that changes no observable behavior is `refactor`, even
  if the diff is large. `feat` implies something a release-notes
  reader would want to know about.

- **Don't bundle unrelated changes.** Conventional Commits is a
  single-purpose-commit convention. Two changes worth different
  types (`fix` and `refactor`, say) belong in two commits. If the
  workflow forces them together, prefer `refactor` and call out
  the embedded fix in the body, but the better path is splitting.

- **Don't fabricate scopes to look authoritative.** A commit
  message that invents `feat(quantum-flux): …` for a project
  with no `quantum-flux` subsystem is noise. Prefer no scope to
  a wrong scope.

- **Don't paste the diff into the body.** `git log -p` already
  shows the diff. The body is for the reasoning the diff doesn't
  capture: trade-offs, alternatives considered, the constraint
  that forced this shape over a more obvious one.

- **Don't promise breaking changes you didn't make.** A `!` mark
  or `BREAKING CHANGE:` footer triggers a MAJOR bump in
  semver-driven release tooling. Adding one to a non-breaking
  commit ships unnecessary major versions.

## Verification

- `git log -1 --format=%B` shows the new commit message in the
  expected shape: `type(scope): subject` on the first line,
  blank line, body if present, blank line, footers if present.
- The Conventional Commits type matches the diff's actual impact:
  `feat` only when a user-facing capability is added; `fix` only
  when something previously broken now works; `refactor` when
  observable behavior is unchanged.
- A semver-driven release tool (semantic-release, changesets,
  release-please) parses the message and produces the expected
  version bump (MAJOR for breaking, MINOR for feat, PATCH for fix).
- The scope (if present) appears in at least one prior commit OR is
  a deliberate addition the user has approved.
- For breaking changes: both the `!` mark AND the `BREAKING CHANGE:`
  footer are present — every parser handles at least one, and using
  both removes ambiguity.

## Reference

Conventional Commits 1.0.0 specification — https://www.conventionalcommits.org/
