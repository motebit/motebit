# shellcheck shell=sh
# Shell twin of `cleanEnv` (scripts/lib/differential-tree.ts) — source it,
# then call `fixture_git_env_scrub` before a script runs git (clone, init,
# -C <dir>) against a repository it created in a temp dir.
#
# A git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to every process
# it spawns; inherited, they make `git -C "$WORK/x" …` act on the hook's
# repository instead of "$WORK/x". This unsets every GIT_* variable — the same
# rule, and the same `env | sed` idiom, as the scrub line in .husky/pre-push
# (#1028). Use it only in scripts that never target the real repository;
# check-fixture-git-env requires it before such a git line.

fixture_git_env_scrub() {
  for _fge_var in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$_fge_var"
  done
  unset _fge_var
}
