#!/usr/bin/env bash
# check-secrets.sh — Scan staged files for accidentally committed secrets.
# Runs as part of the pre-commit hook. Zero external dependencies.
#
# Patterns match common credential formats. False positives in test fixtures
# are excluded via the ALLOW_PATHS filter.

set -euo pipefail

# Files where test fixture secrets are expected (not real credentials)
ALLOW_PATHS='__tests__/|\.test\.|\.spec\.|\.example$|\.md$|check-secrets'

# Get staged file content (not working tree — catches what will actually be committed)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Filter out allowed paths
FILES_TO_CHECK=$(echo "$STAGED_FILES" | grep -Ev "$ALLOW_PATHS" || true)
if [ -z "$FILES_TO_CHECK" ]; then
  exit 0
fi

FOUND=0

check_pattern() {
  local desc="$1"
  local pattern="$2"

  # Check staged content via git diff
  local matches
  matches=$(echo "$FILES_TO_CHECK" | xargs git diff --cached -U0 -- 2>/dev/null | grep -En "$pattern" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    echo "ERROR: Possible secret detected — $desc"
    echo "$matches" | head -5
    echo ""
    FOUND=1
  fi
}

check_pattern "Stripe live key"              'sk_live_[0-9a-zA-Z]{20,}'
check_pattern "Stripe test key (non-test)"   'sk_test_[0-9a-zA-Z]{20,}'
check_pattern "AWS access key"               'AKIA[0-9A-Z]{16}'
check_pattern "GitHub PAT"                   'ghp_[0-9a-zA-Z]{36}'
check_pattern "GitHub OAuth token"           'gho_[0-9a-zA-Z]{36}'
check_pattern "GitLab token"                 'glpat-[0-9a-zA-Z_-]{20,}'
check_pattern "Slack bot token"              'xoxb-[0-9]{10,}'
check_pattern "Slack user token"             'xoxp-[0-9]{10,}'
check_pattern "PEM private key"              '-----BEGIN.*PRIVATE KEY'
check_pattern "Hex private key (64 chars)"   'private.?key.*[0-9a-fA-F]{64}'

if [ "$FOUND" -eq 1 ]; then
  echo "========================================="
  echo "SECRET SCAN FAILED"
  echo "If these are false positives (test fixtures, docs),"
  echo "move them to a __tests__/ directory or .example file."
  echo "To bypass (dangerous): git commit --no-verify"
  echo "========================================="
  exit 1
fi
