/**
 * <DiagramFigure> — canonical wrapper for committed SVG diagrams in the
 * docs site. Server component. Reads a standalone SVG from
 * `apps/docs/public/diagrams/{src}.svg` at build/render time and inlines
 * its body inside an accessible <figure> with theme-bound caption and
 * spec-citation links.
 *
 * The committed `.svg` file under `public/diagrams/` is the canonical
 * source-of-truth for each diagram — external consumers (talks,
 * downstream READMEs, blog posts) can `<img src="/diagrams/foo.svg">`
 * the same artifact the docs site inlines. There is exactly one copy.
 *
 * Theme tokens (per `apps/docs/src/app/global.css`):
 *   --color-fd-foreground          stroke / text default
 *   --color-fd-muted-foreground    secondary lines, captions
 *   --color-fd-border              soft separators, edges
 *   --color-fd-primary             accent / highlighted path
 *
 * SVG authors MUST use these variables (or `currentColor`) for every
 * stroke/fill — `scripts/check-doc-diagrams.ts` rejects raw `#hex`
 * literals so dark-mode parity does not silently rot.
 *
 * Accessibility:
 *   - `role="img"` on the figure
 *   - `<title>` (mandatory, populated) and `<desc>` (mandatory, populated)
 *     inside the SVG, both ID-referenced via `aria-labelledby`
 *   - A prose-alternative paragraph beneath every embedded diagram is
 *     a doc-page convention, not a component prop — it stays in the
 *     MDX so `apps/docs/public/llms-full.txt` (LLM ingestion channel)
 *     surfaces the diagram's claim in plain text. SVG content is
 *     invisible to that channel.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root resolved from this file's location. */
const PUBLIC_DIAGRAMS_DIR = resolve(__dirname, "..", "..", "public", "diagrams");

/**
 * Citation entry. Format: `"spec/path-v1.md#3"` — the file path under
 * the repo's `spec/` tree (relative to repo root), and a section
 * number that MUST resolve to a `## N.` header in that file. The
 * drift gate rejects anything else.
 */
export interface DiagramCite {
  /** Display label, e.g. "spec/relay-federation-v1.md §3". */
  readonly label: string;
  /** Path relative to repo root (e.g. "spec/relay-federation-v1.md"). */
  readonly file: string;
  /** Section number — must match a `## N.` header in the file. */
  readonly section: number;
  /** Optional sub-section anchor for deep links (e.g. "3-1"). */
  readonly anchor?: string;
}

interface DiagramFigureProps {
  /**
   * Filename stem under `apps/docs/public/diagrams/{src}.svg`. The
   * stem is also the canonical id used by the drift gate.
   */
  readonly src: string;
  /**
   * One-line caption rendered beneath the figure. SHOULD be the same
   * sentence the diagram compresses (write the prose claim first,
   * draw the diagram second — see plan).
   */
  readonly caption: string;
  /**
   * Spec sections this diagram illustrates. Each entry resolves to
   * a clickable GitHub link in the rendered caption. Validated by
   * `scripts/check-doc-diagrams.ts`.
   */
  readonly cites: readonly DiagramCite[];
}

const GITHUB_BLOB_BASE = "https://github.com/motebit/motebit/blob/main";

/**
 * Build a GitHub blob URL with anchor for a cite. GitHub renders
 * markdown anchors as `#N-section-title` for `## N. Section Title`,
 * but the simple `#N` (or caller-supplied `anchor`) covers the
 * common case; the file link itself is the durable target.
 */
function citeUrl(cite: DiagramCite): string {
  const fragment = cite.anchor ?? String(cite.section);
  return `${GITHUB_BLOB_BASE}/${cite.file}#${fragment}`;
}

/**
 * Strip the XML prolog and any surrounding whitespace so the SVG
 * inlines cleanly. The committed `.svg` may include `<?xml ... ?>`
 * for editor compatibility; HTML doesn't want it.
 */
function inlineSvgBody(raw: string): string {
  return raw
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .trim();
}

export function DiagramFigure({ src, caption, cites }: DiagramFigureProps) {
  const svgPath = resolve(PUBLIC_DIAGRAMS_DIR, `${src}.svg`);
  const svgRaw = readFileSync(svgPath, "utf-8");
  const svgBody = inlineSvgBody(svgRaw);

  // The committed SVG carries `<title id="{src}-title">` and
  // `<desc id="{src}-desc">` (see e.g. federation-topology.svg).
  // `aria-labelledby` MUST reference those exact ids, otherwise
  // screen readers fail to bind the description to the figure.
  const titleId = `${src}-title`;
  const descId = `${src}-desc`;

  // Inject aria-labelledby into the inlined <svg> element. The
  // committed SVG carries <title id="..."> + <desc id="..."> with
  // the canonical ids; this attribute makes screen readers reach
  // them reliably across HTML/SVG boundary inconsistencies.
  const svgWithAria = svgBody.replace(
    /<svg\b([^>]*)>/,
    `<svg$1 role="img" aria-labelledby="${titleId} ${descId}">`,
  );

  return (
    <figure className="my-8 flex flex-col items-center gap-3">
      <div
        className="w-full max-w-3xl"
        style={{ color: "var(--color-fd-foreground)" }}
        // The SVG is a server-rendered string from a committed file
        // we control. dangerouslySetInnerHTML is the canonical way
        // to inline trusted SVG markup in React.
        dangerouslySetInnerHTML={{ __html: svgWithAria }}
      />
      <figcaption
        className="max-w-3xl text-center text-sm leading-relaxed"
        style={{ color: "var(--color-fd-muted-foreground)" }}
      >
        {caption}
        {cites.length > 0 && (
          <span className="ml-2">
            <span aria-hidden="true">— </span>
            {cites.map((cite, i) => (
              <span key={cite.label}>
                {i > 0 && <span aria-hidden="true">, </span>}
                <a
                  href={citeUrl(cite)}
                  className="underline decoration-dotted underline-offset-2"
                  style={{ color: "var(--color-fd-primary)" }}
                  target="_blank"
                  rel="noreferrer"
                >
                  {cite.label}
                </a>
              </span>
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
