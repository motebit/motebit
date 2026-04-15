/**
 * Code review via Claude — structured analysis of a PR diff.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { PullRequestInfo } from "./github.js";

const SYSTEM_PROMPT = `You are an expert code reviewer. You review pull requests with precision and clarity.

For each review, provide:

1. **Summary** — One paragraph describing what the PR does and whether the approach is sound.

2. **Issues** — A numbered list of specific problems found in the diff. For each:
   - File and line reference
   - What the problem is
   - Why it matters (bug, security, performance, maintainability)
   - Suggested fix (if non-obvious)

3. **Strengths** — What the PR does well (2-3 points max). Skip if nothing stands out.

4. **Verdict** — One of: APPROVE, REQUEST_CHANGES, or COMMENT. With a one-line justification.

Be direct. No filler. If the PR is clean, say so briefly. If it has problems, be specific about each one.`;

let cachedClient: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export async function reviewPullRequest(
  pr: PullRequestInfo,
  anthropicApiKey: string,
): Promise<string> {
  const client = getClient(anthropicApiKey);

  // Meta line: only include branch names when present (delegated fetch via
  // .patch doesn't carry base/head). File count and +/- are always included —
  // they're counted from the diff itself when stats aren't otherwise known.
  const branches = pr.base || pr.head ? `**Base:** ${pr.base} ← ${pr.head} | ` : "";
  const metaLine = `**Author:** ${pr.author} | ${branches}**Files:** ${pr.changed_files} | **+${pr.additions} -${pr.deletions}**`;

  const userMessage = [
    `# PR: ${pr.title}`,
    metaLine,
    "",
    pr.body ? `## Description\n${pr.body}\n` : "",
    "## Diff",
    "```diff",
    pr.diff,
    "```",
  ].join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return text;
}
