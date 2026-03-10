import { HeroSection } from "../components/hero-section";
import { Reveal } from "../components/reveal";
import { ClosingCTA } from "../components/closing-cta";

export default function HomePage() {
  return (
    <div className="overflow-hidden">
      <HeroSection />

      <div className="bg-fd-background text-zinc-900 dark:text-zinc-100">
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
