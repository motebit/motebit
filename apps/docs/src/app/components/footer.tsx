import Link from "next/link";

export function Footer() {
  return (
    <footer className="border-t border-black/[0.04] bg-white py-10">
      <div className="mx-auto max-w-5xl px-6 flex items-center justify-between">
        <p className="text-[13px] text-zinc-600">Motebit</p>
        <div className="flex items-center gap-5">
          <Link
            href="/docs/introduction"
            className="text-[13px] text-zinc-600 hover:text-zinc-800 transition-colors"
          >
            Docs
          </Link>
          <a
            href="https://github.com/motebit"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-zinc-600 hover:text-zinc-800 transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
