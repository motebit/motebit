/**
 * @vitest-environment jsdom
 *
 * A closed dialog must be out of the accessibility tree and the tab order, not
 * only invisible. `opacity: 0` hides pixels: the dialog's role, label and
 * buttons stay readable to screen readers and agents, and Tab still reaches
 * them. The skills-consent modal shipped that way, so every page load carried
 * an "Install Sensitive Skill?" `aria-modal` dialog that was never open.
 *
 * Mounts the REAL index.html (its stylesheet and body) and checks every
 * `role="dialog"` in it, so a new dialog is covered without a list to update.
 */
import { beforeAll, describe, expect, it } from "vitest";

// The app tsconfig carries no Node types (browser / React Native target), so
// the Node built-in is loaded through a non-literal specifier (the pattern
// settings-anthropic-picker.test.ts uses).
const NODE_FS = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ NODE_FS)) as {
  readFileSync: (p: string, enc: "utf8") => string;
};
/** Read a file relative to this test file. */
const readRel = (rel: string): string =>
  readFileSync(decodeURIComponent(new URL(rel, import.meta.url).pathname), "utf8");

beforeAll(() => {
  const html = readRel("../../index.html");
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!);
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)![1]!;
  document.head.innerHTML = styles.map((css) => `<style>${css}</style>`).join("");
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
});

/** Whether `el` is out of the accessibility tree: an ancestor-or-self has `display: none`, or `visibility` (inherited) is hidden. */
function hidden(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (getComputedStyle(n).display === "none") return true;
  }
  return getComputedStyle(el).visibility === "hidden";
}

describe("closed dialogs leave the accessibility tree", () => {
  it("index.html has dialogs to check", () => {
    expect(document.querySelectorAll('[role="dialog"]').length).toBeGreaterThanOrEqual(5);
  });

  it("every dialog is hidden, not only transparent, while closed", () => {
    const shown = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter((d) => !hidden(d))
      .map((d) => (d.id !== "" ? d.id : d.outerHTML.slice(0, 60)));
    expect(shown).toEqual([]);
  });

  it("the skills-consent modal is reachable once opened", () => {
    const modal = document.getElementById("skills-consent-modal")!;
    const backdrop = document.getElementById("skills-consent-backdrop")!;
    modal.classList.add("open");
    backdrop.classList.add("open");
    try {
      expect(hidden(modal)).toBe(false);
      expect(getComputedStyle(backdrop).visibility).not.toBe("hidden");
    } finally {
      modal.classList.remove("open");
      backdrop.classList.remove("open");
    }
  });
});
