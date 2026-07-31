import { describe, it, expect } from "vitest";
import { VirtualTerminal } from "./helpers/vt.js";
import { createTerminalRenderer, type TerminalRenderer } from "../terminal.js";

function setup(cols = 40): { vt: VirtualTerminal; r: TerminalRenderer } {
  const vt = new VirtualTerminal(cols);
  const r = createTerminalRenderer({
    write: (s) => vt.write(s),
    columns: () => vt.cols,
    isTTY: true,
  });
  return { vt, r };
}

function type(r: TerminalRenderer, text: string): void {
  for (const ch of text) r.handleEvent({ type: "key", key: ch, ctrl: false });
}

describe("terminal renderer — owned bottom region", () => {
  it("typing keystrokes repaints one prompt, never stacks", () => {
    const { vt, r } = setup();
    void r.readInput("you> ");
    type(r, "hello world");
    expect(vt.count("you>")).toBe(1);
    expect(vt.screen()).toBe("you> hello world");
  });

  it("five resizes produce exactly one prompt (#455)", () => {
    const { vt, r } = setup(40);
    void r.readInput("you> ");
    type(r, "hi");
    for (const cols of [35, 30, 25, 30, 40]) {
      vt.resize(cols);
      r.repaint();
    }
    expect(vt.count("you>")).toBe(1);
    expect(vt.screen()).toBe("you> hi");
  });

  it("narrowing below the painted width still repaints a single prompt", () => {
    const { vt, r } = setup(30);
    void r.readInput("you> ");
    type(r, "a somewhat longer input");
    vt.resize(12);
    r.repaint();
    expect(vt.count("you>")).toBe(1);
    // Repainted for the new width: the input wraps, nothing is lost
    expect(vt.screen().replace(/\n/g, "")).toBe("you> a somewhat longer input");
  });

  it("writeOutput during active input lands above the prompt", () => {
    const { vt, r } = setup(60);
    void r.readInput("you> ");
    type(r, "typing");
    r.writeOutput("  · relay hiccup — still waiting (attempt 2)\n");
    expect(vt.screen()).toBe("  · relay hiccup — still waiting (attempt 2)\nyou> typing");
    expect(vt.count("you>")).toBe(1);
    // Input survives: keep typing after the interruption
    type(r, " more");
    expect(vt.screen().endsWith("you> typing more")).toBe(true);
  });

  it("long input wraps across rows with the full text visible (#480)", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    // 5 (prompt) + 26 = 31 visible chars → two visual rows at 20 cols
    expect(vt.screen()).toBe("you> abcdefghijklmno\npqrstuvwxyz");
    expect(vt.count("…")).toBe(0);
    // Cursor sits at the end of the second visual row
    expect(vt.cursor()).toEqual({ row: 1, col: 11 });
  });

  it("wrapped input: typing repaints cleanly, never stacks rows", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    type(r, "0123456789");
    expect(vt.count("you>")).toBe(1);
    expect(vt.screen()).toBe("you> abcdefghijklmno\npqrstuvwxyz012345678\n9");
  });

  it("wrapped input: editing mid-line parks the cursor on the right visual row", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    r.handleEvent({ type: "key", key: "home", ctrl: false });
    expect(vt.cursor()).toEqual({ row: 0, col: 5 });
    type(r, "X");
    expect(vt.screen()).toBe("you> Xabcdefghijklmn\nopqrstuvwxyz");
    expect(vt.cursor()).toEqual({ row: 0, col: 6 });
  });

  it("wrapped input: backspace across the wrap boundary shrinks back to one row", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopq"); // 5 + 17 = 22 → wraps
    expect(vt.screen().split("\n").length).toBe(2);
    for (let i = 0; i < 10; i++) r.handleEvent({ type: "key", key: "backspace", ctrl: false });
    expect(vt.screen()).toBe("you> abcdefg");
    expect(vt.count("you>")).toBe(1);
  });

  it("writeOutput during wrapped input lands above and leaves the input intact", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    r.writeOutput("  · a step happened\n");
    expect(vt.screen()).toBe("  · a step happened\nyou> abcdefghijklmno\npqrstuvwxyz");
    expect(vt.count("you>")).toBe(1);
    type(r, "!");
    expect(vt.screen().endsWith("pqrstuvwxyz!")).toBe(true);
  });

  it("status row stays single above a wrapped input", () => {
    const { vt, r } = setup(20);
    r.setStatusRow("  · thinking · 2s");
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    expect(vt.screen()).toBe("  · thinking · 2s\nyou> abcdefghijklmno\npqrstuvwxyz");
    r.setStatusRow(null);
    expect(vt.screen()).toBe("you> abcdefghijklmno\npqrstuvwxyz");
  });

  it("resize while the input is wrapped repaints one prompt with all text (#455)", () => {
    const { vt, r } = setup(20);
    void r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    for (const cols of [16, 12, 24, 40]) {
      vt.resize(cols);
      r.repaint();
    }
    expect(vt.count("you>")).toBe(1);
    expect(vt.screen()).toBe("you> abcdefghijklmnopqrstuvwxyz");
  });

  it("submitting a wrapped input echoes the full line to scrollback", async () => {
    const { vt, r } = setup(20);
    const p = r.readInput("you> ");
    type(r, "abcdefghijklmnopqrstuvwxyz");
    r.handleEvent({ type: "key", key: "return", ctrl: false });
    await expect(p).resolves.toBe("abcdefghijklmnopqrstuvwxyz");
    r.writeOutput("mote> ok\n");
    expect(vt.screen()).toBe("you> abcdefghijklmno\npqrstuvwxyz\nmote> ok");
    expect(vt.count("you>")).toBe(1);
  });

  it("input filling the width exactly still clears without residue", () => {
    const { vt, r } = setup(10);
    void r.readInput("you> ");
    type(r, "abcde"); // 5 + 5 = exactly 10
    expect(vt.screen()).toBe("you> abcde");
    type(r, "f"); // 11 → wraps
    expect(vt.screen()).toBe("you> abcde\nf");
    r.handleEvent({ type: "key", key: "backspace", ctrl: false });
    expect(vt.screen()).toBe("you> abcde");
    expect(vt.count("you>")).toBe(1);
  });

  it("status row sits above the input row and updates in place", () => {
    const { vt, r } = setup(70);
    r.setStatusRow("  · delegating read_url · 3s");
    void r.readInput("you> ");
    type(r, "hi");
    expect(vt.screen()).toBe("  · delegating read_url · 3s\nyou> hi");
    r.setStatusRow("  · delegating read_url — relay hiccup (attempt 2) · 9s");
    expect(vt.screen()).toBe("  · delegating read_url — relay hiccup (attempt 2) · 9s\nyou> hi");
    expect(vt.count("delegating")).toBe(1);
    r.setStatusRow(null);
    expect(vt.screen()).toBe("you> hi");
  });

  it("status row truncates to the terminal width, never wraps", () => {
    const { vt, r } = setup(20);
    r.setStatusRow("  · delegating a-very-long-tool-name — a long narration step");
    expect(vt.screen().split("\n").length).toBe(1);
  });

  it("streamed partial text stays pinned above the status row", () => {
    const { vt, r } = setup();
    r.writeOutput("mote> thinking about");
    r.setStatusRow("  · running web_search · 1s");
    r.writeOutput(" it");
    expect(vt.screen()).toBe("mote> thinking about it\n  · running web_search · 1s");
    r.writeOutput(" — done.\n");
    r.setStatusRow(null);
    expect(vt.screen()).toBe("mote> thinking about it — done.");
  });

  it("a partial line longer than the width flushes wrapped rows to scrollback", () => {
    const { vt, r } = setup(10);
    r.setStatusRow("· busy");
    r.writeOutput("abcdefghijklmno");
    expect(vt.screen()).toBe("abcdefghij\nklmno\n· busy");
  });

  it("submit echoes the full line and resolves", async () => {
    const { vt, r } = setup();
    const p = r.readInput("you> ");
    type(r, "hello");
    r.handleEvent({ type: "key", key: "return", ctrl: false });
    await expect(p).resolves.toBe("hello");
    expect(vt.screen()).toBe("you> hello");
    // Next output lands below the echoed line
    r.writeOutput("mote> hi\n");
    expect(vt.screen()).toBe("you> hello\nmote> hi");
  });

  it("resize during status + input keeps both single", () => {
    const { vt, r } = setup(40);
    r.setStatusRow("  · delegating read_url · 12s");
    void r.readInput("you> ");
    type(r, "hello");
    for (const cols of [30, 22, 34]) {
      vt.resize(cols);
      r.repaint();
    }
    expect(vt.count("you>")).toBe(1);
    expect(vt.count("delegating")).toBe(1);
  });

  it("editing keys (backspace, arrows, ctrl+u) repaint correctly", () => {
    const { vt, r } = setup();
    void r.readInput("you> ");
    type(r, "helloo");
    r.handleEvent({ type: "key", key: "backspace", ctrl: false });
    expect(vt.screen()).toBe("you> hello");
    r.handleEvent({ type: "key", key: "home", ctrl: false });
    type(r, ">");
    expect(vt.screen()).toBe("you> >hello");
    r.handleEvent({ type: "key", key: "u", ctrl: true });
    expect(vt.screen()).toBe("you>");
    expect(vt.count("you>")).toBe(1);
  });

  it("paste inserts at the cursor without corrupting the region", () => {
    const { vt, r } = setup();
    void r.readInput("you> ");
    type(r, "ab");
    r.handleEvent({ type: "key", key: "left", ctrl: false });
    r.handleEvent({ type: "paste", text: "XY" });
    expect(vt.screen()).toBe("you> aXYb");
  });
});
