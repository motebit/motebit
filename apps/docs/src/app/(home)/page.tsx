import { HeroSection } from "../components/hero-section";
import { Reveal } from "../components/reveal";
import { ClosingCTA } from "../components/closing-cta";

export default function HomePage() {
  return (
    <div className="text-zinc-900 overflow-hidden">
      <HeroSection />

      {/* ── The Inversion ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xl md:text-2xl text-zinc-500 leading-relaxed">
              Every AI today owns the intelligence
              <br className="hidden md:block" />
              and rents you a session.
            </p>
            <p className="mt-8 text-3xl md:text-5xl font-bold tracking-[-0.03em] text-[#0284c7]">
              Motebit inverts that.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Identity ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.03em]">
              It knows who it is.
            </h2>
            <p className="mt-6 text-lg md:text-xl text-zinc-500 leading-relaxed max-w-lg mx-auto">
              Cryptographic identity that persists across time and devices.
              Not a session token. An entity.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Memory ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.03em]">
              It remembers.
            </h2>
            <p className="mt-6 text-lg md:text-xl text-zinc-500 leading-relaxed max-w-lg mx-auto">
              Memory that compounds. Strengthens with use, fades naturally
              with time. The longer it runs, the more capable it becomes.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Governance ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.03em]">
              It asks before it acts.
            </h2>
            <p className="mt-6 text-lg md:text-xl text-zinc-500 leading-relaxed max-w-lg mx-auto">
              You set the boundaries. Policy gates control what crosses
              the surface. Sensitivity-aware. Fail-closed by default.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Tools ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl md:text-5xl font-bold tracking-[-0.03em]">
              It connects to everything.
            </h2>
            <p className="mt-6 text-lg md:text-xl text-zinc-500 leading-relaxed max-w-lg mx-auto">
              Any intelligence provider. Any tool ecosystem.
              Any device. The intelligence is a commodity.
              The identity is the asset.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── Canon ── */}
      <section className="py-32 md:py-48 px-6">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xl md:text-2xl text-zinc-600 leading-relaxed italic">
              &ldquo;The body is passive. The interior is active.
              <br />
              Glass transmits &mdash; the interior is visible
              <br className="hidden md:block" />
              without being added to the surface.&rdquo;
            </p>
            <p className="mt-8 text-zinc-600 text-sm tracking-[0.15em] uppercase">
              Maximum interiority, minimum display.
            </p>
          </div>
        </Reveal>
      </section>

      {/* ── CTA ── */}
      <section className="py-32 md:py-48 px-6">
        <ClosingCTA />
      </section>
    </div>
  );
}
