/**
 * Parsing helpers for GitHub PR references. The service no longer fetches
 * PRs directly — that's delegated to the `read-url` atom (see
 * review-via-motebit.ts). What remains here is shape + URL parsing.
 */

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

/** Reconstruct the canonical PR URL from parsed components. */
export function prUrl(ref: { owner: string; repo: string; number: number }): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
