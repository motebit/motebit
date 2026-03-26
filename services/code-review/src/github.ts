/**
 * GitHub API — fetch PR metadata and diff for public repos.
 * No auth required. Rate limit: 60 req/hour unauthenticated.
 */

const MAX_DIFF_BYTES = 100_000; // ~100KB — keeps Claude context manageable
const GITHUB_API = "https://api.github.com";

export interface PullRequestInfo {
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  changed_files: number;
  additions: number;
  deletions: number;
  diff: string;
}

/**
 * Parse a PR reference from a natural language prompt.
 * Supports:
 *   - "owner/repo#123"
 *   - "https://github.com/owner/repo/pull/123"
 *   - "github.com/owner/repo/pull/123"
 *   - "review owner/repo PR 123"
 */
export function parsePrReference(
  prompt: string,
): { owner: string; repo: string; number: number } | null {
  // Full URL: github.com/owner/repo/pull/123
  const urlMatch = prompt.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: parseInt(urlMatch[3]!, 10) };
  }

  // Short form: owner/repo#123
  const shortMatch = prompt.match(/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)#(\d+)/);
  if (shortMatch) {
    return { owner: shortMatch[1]!, repo: shortMatch[2]!, number: parseInt(shortMatch[3]!, 10) };
  }

  // Looser: owner/repo PR 123 or owner/repo pull 123
  const looseMatch = prompt.match(/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\s+(?:pr|pull)\s+(\d+)/i);
  if (looseMatch) {
    return { owner: looseMatch[1]!, repo: looseMatch[2]!, number: parseInt(looseMatch[3]!, 10) };
  }

  return null;
}

/** Fetch PR metadata (JSON) and diff (text) from GitHub API. */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestInfo> {
  // Fetch metadata
  const metaResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "motebit-code-review" },
  });
  if (!metaResp.ok) {
    const text = await metaResp.text().catch(() => "");
    throw new Error(`GitHub API ${metaResp.status}: ${text.slice(0, 200)}`);
  }
  const meta = (await metaResp.json()) as {
    title: string;
    body: string | null;
    user: { login: string };
    base: { ref: string };
    head: { ref: string };
    changed_files: number;
    additions: number;
    deletions: number;
  };

  // Fetch diff
  const diffResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Accept: "application/vnd.github.diff", "User-Agent": "motebit-code-review" },
  });
  if (!diffResp.ok) {
    throw new Error(`GitHub diff fetch failed: ${diffResp.status}`);
  }
  let diff = await diffResp.text();

  // Truncate if too large
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES) + "\n\n[... diff truncated at 100KB ...]";
  }

  return {
    title: meta.title,
    body: meta.body ?? "",
    author: meta.user.login,
    base: meta.base.ref,
    head: meta.head.ref,
    changed_files: meta.changed_files,
    additions: meta.additions,
    deletions: meta.deletions,
    diff,
  };
}
