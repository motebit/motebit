import Link from "next/link";

export function ClosingCTA() {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.04em]">Begin.</h2>
      <div className="mt-10">
        <Link
          href="/docs/get-your-agent"
          className="inline-block px-8 py-3 rounded-full bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200 transition-colors"
        >
          Read the Documentation
        </Link>
      </div>
    </div>
  );
}
