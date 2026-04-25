import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Not found",
  description: "The page you were looking for could not be found.",
};

/**
 * Custom 404 page. Replaces Next.js' default empty-error template.
 * Surfaces the four most-trafficked entry points so a misstep
 * lands somewhere useful rather than at a dead end.
 */
export default function NotFound() {
  return (
    <main
      className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-start justify-center gap-6 px-6 py-16"
      style={{ color: "var(--color-fd-foreground)" }}
    >
      <p
        className="font-mono text-sm tracking-wide"
        style={{ color: "var(--color-fd-muted-foreground)" }}
      >
        404
      </p>
      <h1 className="text-3xl font-semibold leading-tight">This page isn&apos;t here.</h1>
      <p className="text-base" style={{ color: "var(--color-fd-muted-foreground)" }}>
        The link may be stale, or the page was moved during a docs restructure. The places people
        usually meant to land:
      </p>
      <ul className="flex flex-col gap-2 text-base">
        <li>
          <Link
            href="/docs/introduction"
            className="underline decoration-dotted underline-offset-4"
            style={{ color: "var(--color-fd-primary)" }}
          >
            Introduction
          </Link>{" "}
          <span style={{ color: "var(--color-fd-muted-foreground)" }}>
            — what motebit is and why it exists
          </span>
        </li>
        <li>
          <Link
            href="/docs/concepts/identity"
            className="underline decoration-dotted underline-offset-4"
            style={{ color: "var(--color-fd-primary)" }}
          >
            Concepts
          </Link>{" "}
          <span style={{ color: "var(--color-fd-muted-foreground)" }}>
            — identity, memory, governance, the droplet
          </span>
        </li>
        <li>
          <Link
            href="/docs/operator/architecture"
            className="underline decoration-dotted underline-offset-4"
            style={{ color: "var(--color-fd-primary)" }}
          >
            Operator guide
          </Link>{" "}
          <span style={{ color: "var(--color-fd-muted-foreground)" }}>
            — running a relay, governance, sync, troubleshooting
          </span>
        </li>
        <li>
          <Link
            href="/docs/developer/identity-standard"
            className="underline decoration-dotted underline-offset-4"
            style={{ color: "var(--color-fd-primary)" }}
          >
            Developer guide
          </Link>{" "}
          <span style={{ color: "var(--color-fd-muted-foreground)" }}>
            — identity files, federation, delegation, MCP server
          </span>
        </li>
      </ul>
      <p className="text-sm" style={{ color: "var(--color-fd-muted-foreground)" }}>
        Or jump to{" "}
        <Link
          href="/"
          className="underline decoration-dotted underline-offset-4"
          style={{ color: "var(--color-fd-primary)" }}
        >
          motebit.com
        </Link>{" "}
        and meet the creature.
      </p>
    </main>
  );
}
