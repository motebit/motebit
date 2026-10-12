# Agent identity boundary: the 2026-10-12 workstation incident and the open gap

Implementation agents act on GitHub as `motebit-agent`, a machine user with write (push) access to `motebit/motebit` and no admin, maintain or ruleset-bypass role. The founder account is the code owner whose review the `main` ruleset requires on constitutional, money, identity and federation paths. This document records how that split was first implemented wrong on the founder's workstation, what was repaired, and what is still not separated.

**Exit criterion:** identity separation enforced outside the agent — by credentials the agent's environment does not hold — not by configuration the agent could undo or by instructions it is asked to follow.

## Incident (2026-10-12)

**Root cause.** The cutover treated a project-scoped identity as machine-scoped. On the founder's workstation the agent token was logged into the global GitHub CLI configuration and made its active account, and the founder account was then logged out of it — on the orchestrating agent's recommendation, intended to stop agents switching back to the founder account. No inventory was taken of what else depended on the global configuration.

**Blast radius.** Every repository on the workstation fetched over HTTPS through the global `gh auth git-credential` helper. With only the agent account (and an unrelated platform account) left, git operations on the founder's other private repositories failed with "Repository not found". No repository was modified or deleted; no agent identity gained permissions. The `admin:org` scope seen in shell history belonged to the founder's own pre-existing token; the agent token's scopes were and are `repo`, `read:org`.

**Logout is not deletion, and neither is revocation.** `gh auth logout` removed the founder account from the CLI's account list; it did not delete the founder's OS keychain item. Keychain metadata shows that item was created in January 2026 and next modified only when the founder logged in again — so the old founder token stayed retrievable from the keychain by any process running as the founder's OS user throughout, until it was overwritten. Nothing was revoked on GitHub's side at any point. Removing a CLI account, deleting a stored credential and revoking a token at the issuer are three different acts, and only the last ends a token's validity.

**Remediation (applied with founder approval at each step).**

1. The founder restored their account in the global CLI by interactive browser login. Default scopes only (`gist`, `read:org`, `repo`, `workflow`); no `admin:org`, no `delete_repo`.
2. The founder loaded the agent token into a separate CLI configuration directory holding only `motebit-agent`.
3. This repository's local git configuration (shared by all its worktrees) resets the inherited credential helper and points it at that directory; local author and committer are `motebit-agent`. The agent's project settings export the same configuration directory. Nothing global was changed by these steps.
4. The agent account was removed from the global CLI's account list by editing its hosts file, **not** with `gh auth logout`: the CLI keeps one OS keychain item per account, shared by every configuration directory, and a logout may delete the item the scoped directory still uses. Either way the agent token remains in the founder user's keychain — this step tidies the global account list; it isolates nothing.

**Verification.** A read-only check (no pushes; `git push --dry-run` only, hooks skipped because it tests authentication, not code) passes 19/19 from both the agent's environment and a clean one: no token overrides in the environment; global CLI = founder; scoped directory = agent only, non-privileged scopes; the agent's repository permission read from GitHub = push without admin or maintain; the founder's other repositories reachable through the global helper; this repository's credential resolves to `motebit-agent` in every worktree.

## What is NOT separated

1. **Same-user workstation.** The agent runs as the founder's OS user. Any process it starts can unset the configuration directory and use the founder's stored credential — the verification check does exactly this to test the founder's access. The scoped configuration is an operational safeguard against accidents, not an isolation boundary.
2. **Cloud lanes.** Remote agent runs authenticate to GitHub through the founder's claude.ai GitHub connection, which is account-wide, not per project. Commits from those runs carry agent metadata but the GitHub operations are the founder's. Swapping that connection to the agent token would move every cloud session on the account — including unrelated projects — so it is not the fix. **New cloud-lane GitHub writes are suspended** until a separated path is verified; local lanes push as `motebit-agent`.

## Target architecture (decision pending)

Agent work runs in an execution environment that **never holds a founder credential**: its only GitHub credential is `motebit-agent`'s, its permission on the repository is write without bypass, and founder approval stays a GitHub-enforced code-owner review the agent cannot satisfy. Verification is deterministic and two-sided: the agent identity can push a branch; it cannot approve, bypass the ruleset, change repository settings, or reach any repository outside its grant.

Candidate environments are an isolated cloud runner holding only the agent token, or a separate OS user on the workstation. The trade-offs and the recommendation are tracked with the founder; this document is updated when one is chosen and verified.
