# shellcheck shell=sh
# Shell twin of scripts/lib/fixture-git-env.ts — source it, then call
# `fixture_git_env_scrub` before a script runs git (clone, init, -C <dir>)
# against a repository it created in a temp dir.
#
# A git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every process
# it spawns; inherited, they make `git -C "$WORK/x" …` act on the hook's
# repository instead of "$WORK/x". This unsets every GIT_* variable (GIT_CONFIG_*
# and GIT_ASKPASS included) and the same credential variables the TS helper
# drops. Use it only in scripts that never target the real repository.

fixture_git_env_scrub() {
  for _fge_var in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$_fge_var"
  done
  unset _fge_var
  unset SSH_ASKPASS SSH_AUTH_SOCK GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
}
