---
"motebit": patch
---

Add `motebit skills publish <directory>` — sign a skill with the user's CLI identity key, write back the signed `SKILL.md` + `skill-envelope.json` byte-stable, and POST the bundle to the relay-hosted registry's `/api/v1/skills/submit` endpoint. Closes the author-side loop opened by phase 4.5a (`spec/skills-registry-v1.md`).

The publish flow is fail-closed in two places before going to the network:

1. **Local re-verify after sign.** A tampered private key or a dependency drift in the signing chain surfaces as `Local re-verify failed after signing` rather than at the relay's 400.
2. **Idempotent re-publish.** Re-running `publish` on the same directory with the same identity key produces byte-identical envelope + body, so the relay returns 200 (idempotent) instead of 409 `version_immutable`. Authors can re-run the command without bumping SemVer.

Usage:

```text
motebit skills publish skills/git-commit-motebit-style
```

Output names the resolved address so the author can immediately install elsewhere:

```text
  published
  git-commit-motebit-style v1.0.0
  address:    did:key:z6Mk…/git-commit-motebit-style@1.0.0
  submitter:  did:key:z6Mk…
  content:    7f313f44…

  Install elsewhere with: motebit skills install did:key:z6Mk…/git-commit-motebit-style@1.0.0
```

Also seeds a second motebit-canonical skill, `motebit-spec-writer`, at `skills/motebit-spec-writer/`. Procedural knowledge for drafting `motebit/<name>@<version>` specifications: header conventions, foundation-law markers, wire-format triple-sync (protocol type → zod schema → JSON Schema), drift-gate discipline. Build via `pnpm --filter @motebit/skills build-spec-writer-skill`.

The reference corpus now ships two signed skills (`git-commit-motebit-style`, `motebit-spec-writer`) — operators can `motebit skills publish skills/<name>` against any deployed relay to seed the curated index.

Drift gate `check-skill-cli-coverage` learns about network-side verbs: `publish` is intentionally not backed by a `SkillRegistry` method (it's a relay-client operation, not a local-disk one). Future network-side verbs add a one-line waiver in the gate's `INTENTIONAL_NON_REGISTRY_VERBS` set.
