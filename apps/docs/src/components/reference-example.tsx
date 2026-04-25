/**
 * <ReferenceExample> — wraps a code block whose imports name a
 * workspace-private package (e.g. `@motebit/market`,
 * `@motebit/semiring`, `@motebit/mcp-server`). Names the block as
 * a reference-implementation snippet rather than a consumer
 * recipe, so a reader doesn't think they can `npm install` what
 * the import statement implies.
 *
 * The boundary the wrapper enforces is the same one the sentinel
 * commit (fa5fdfeb) made explicit in the version-doctrine: only
 * the eleven published packages make stability promises; private
 * packages exist for source organization and have no version or
 * API surface to claim. See `/docs/concepts/public-surface`.
 *
 * Usage:
 *
 *   <ReferenceExample
 *     pkg="@motebit/market"
 *     source="packages/market/src/budget.ts"
 *     note="The runtime calls this internally; consumers integrate via the spec or the public packages."
 *   >
 *     ```typescript
 *     import { allocateBudget } from "@motebit/market";
 *     ```
 *   </ReferenceExample>
 *
 * Drift gate `check-doc-private-imports` enforces that any
 * `import ... from "@motebit/<X>"` where X is "private": true
 * appears inside this wrapper.
 */
import type { ReactNode } from "react";

interface ReferenceExampleProps {
  /** The workspace-private package the example imports from (e.g. "@motebit/market"). */
  readonly pkg: string;
  /** Repo-relative path to the source file the example reflects. Rendered as a GitHub link. */
  readonly source?: string;
  /** Optional one-sentence framing prepended to the default callout. */
  readonly note?: string;
  /** The fenced code block (or any MDX content) being framed as reference-internal. */
  readonly children: ReactNode;
}

const GITHUB_BLOB_BASE = "https://github.com/motebit/motebit/blob/main";

export function ReferenceExample({ pkg, source, note, children }: ReferenceExampleProps) {
  const sourceUrl = source ? `${GITHUB_BLOB_BASE}/${source}` : null;

  return (
    <aside
      // Left-edge accent stripe (same pattern as the license-tiers
      // Private row) makes the boundary visually unmistakable without
      // adopting a warning-shaped chrome that would fight motebit's
      // calm aesthetic. The stripe says: this block is in a different
      // category than the surrounding prose. The header text says
      // exactly which category.
      className="my-6 overflow-hidden rounded-lg border border-l-4 p-4"
      style={{
        borderColor: "var(--color-fd-border)",
        borderLeftColor: "var(--color-fd-primary)",
        background: "var(--color-fd-card)",
      }}
      aria-label={`Reference-implementation example from ${pkg}`}
    >
      <header
        className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
        style={{ color: "var(--color-fd-muted-foreground)" }}
      >
        <span
          className="font-semibold uppercase tracking-wide"
          style={{ color: "var(--color-fd-primary)" }}
        >
          Reference implementation — not for direct import
        </span>
        <code
          className="rounded px-1.5 py-0.5 font-mono"
          style={{
            background: "var(--color-fd-muted)",
            color: "var(--color-fd-foreground)",
          }}
        >
          {pkg}
        </code>
        <span aria-hidden="true">·</span>
        <span>workspace-private (`0.0.0-private`)</span>
        {sourceUrl && (
          <>
            <span aria-hidden="true">·</span>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-2"
              style={{ color: "var(--color-fd-primary)" }}
            >
              source on GitHub
            </a>
          </>
        )}
      </header>
      <p
        className="mb-3 text-sm leading-relaxed"
        style={{ color: "var(--color-fd-muted-foreground)" }}
      >
        {note ? note + " " : null}
        This snippet shows what motebit&apos;s reference runtime does internally. The package is
        workspace-internal —{" "}
        <strong style={{ color: "var(--color-fd-foreground)" }}>
          not on npm, not under semver, not a supported import target.
        </strong>{" "}
        For external integrations, use{" "}
        <a
          href="/docs/concepts/public-surface"
          className="underline decoration-dotted underline-offset-2"
          style={{ color: "var(--color-fd-primary)" }}
        >
          the spec or the published packages
        </a>
        .
      </p>
      <div>{children}</div>
    </aside>
  );
}
