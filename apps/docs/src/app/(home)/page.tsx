import { HeroSection } from "../components/hero-section";
import { Reveal } from "../components/reveal";
import { ClosingCTA } from "../components/closing-cta";

export default function HomePage() {
  return (
    <div className="overflow-hidden">
      <HeroSection />

      <div className="bg-fd-background text-zinc-900 dark:text-zinc-100">
        {/* ── Quick Start ── */}
        <section className="py-20 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl">
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6 font-mono text-sm shadow-sm overflow-x-auto">
                <div className="flex items-center gap-2 mb-4 text-zinc-400 dark:text-zinc-500 border-b border-zinc-200 dark:border-zinc-800 pb-4">
                  <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50" />
                  <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
                  <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50" />
                  <span className="ml-2 text-xs">terminal</span>
                </div>
                <div className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  <span className="text-zinc-400 dark:text-zinc-500">$</span>{" "}
                  <span className="text-zinc-900 dark:text-zinc-100">
                    npm create motebit@latest my-agent
                  </span>
                  <br />
                  <span className="text-zinc-400 dark:text-zinc-500">
                    Generating Ed25519 keypair...
                  </span>
                  <br />
                  <span className="text-zinc-400 dark:text-zinc-500">Signing identity file...</span>
                  <br />
                  <span className="text-green-600 dark:text-green-500">+ Created ./my-agent</span>
                  <br />
                  <br />
                  <span className="text-zinc-400 dark:text-zinc-500">$</span>{" "}
                  <span className="text-zinc-900 dark:text-zinc-100">
                    cd my-agent && npx motebit run --identity ./motebit.md
                  </span>
                  <br />
                  <span className="text-zinc-400 dark:text-zinc-500">
                    Daemon running. motebit_id: 0195a8... Goals: 0. Policy: max_risk_auto=R1_DRAFT,
                    deny_above=R4_MONEY
                  </span>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ── The Inversion ── */}
        <section className="py-36 md:py-52 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-lg md:text-xl text-zinc-400 dark:text-zinc-500 leading-relaxed">
                Every AI today owns the intelligence
                <br className="hidden md:block" />
                and rents you a session.
              </p>
              <p className="mt-8 text-3xl md:text-5xl font-bold tracking-[-0.04em]">
                Motebit inverts that.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Identity ── */}
        <section className="py-28 md:py-40 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.04em]">
                It knows who it is.
              </h2>
              <p className="mt-6 text-lg md:text-xl text-zinc-400 dark:text-zinc-500 leading-relaxed max-w-lg mx-auto">
                Cryptographic identity that persists across time and devices. Not a session token.
                An entity.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Memory ── */}
        <section className="py-28 md:py-40 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.04em]">It remembers.</h2>
              <p className="mt-6 text-lg md:text-xl text-zinc-400 dark:text-zinc-500 leading-relaxed max-w-lg mx-auto">
                Memory that compounds. Strengthens with use, fades naturally with time. The longer
                it runs, the more capable it becomes.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Governance ── */}
        <section className="py-28 md:py-40 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.04em]">
                It asks before it acts.
              </h2>
              <p className="mt-6 text-lg md:text-xl text-zinc-400 dark:text-zinc-500 leading-relaxed max-w-lg mx-auto">
                You set the boundaries. Policy gates control what crosses the surface.
                Sensitivity-aware. Fail-closed by default.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Tools ── */}
        <section className="py-28 md:py-40 px-6">
          <Reveal>
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.04em]">
                It connects to everything.
              </h2>
              <p className="mt-6 text-lg md:text-xl text-zinc-400 dark:text-zinc-500 leading-relaxed max-w-lg mx-auto">
                Any intelligence provider. Any tool ecosystem. Any device. The intelligence is a
                commodity. The identity is the asset.
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Canon ── */}
        <section className="py-36 md:py-48 px-6">
          <Reveal>
            <div className="mx-auto max-w-xl text-center">
              <p className="text-lg md:text-2xl text-zinc-400 dark:text-zinc-500 leading-relaxed italic">
                &ldquo;The body is passive. The interior is active.
                <br />
                Glass transmits &mdash; the interior is visible
                <br className="hidden md:block" />
                without being added to the surface.&rdquo;
              </p>
              <p className="mt-8 text-zinc-300 dark:text-zinc-600 text-xs tracking-[0.2em] uppercase">
                Maximum interiority, minimum display
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── CTA ── */}
        <section className="py-36 md:py-52 px-6">
          <Reveal hold>
            <ClosingCTA />
          </Reveal>
        </section>
      </div>
    </div>
  );
}
