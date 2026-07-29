import { describe, it, expect } from "vitest";
import { VirtualTerminal } from "./helpers/vt.js";

describe("VirtualTerminal", () => {
  it("renders plain text and newlines", () => {
    const vt = new VirtualTerminal(20);
    vt.write("hello\nworld\n");
    expect(vt.screen()).toBe("hello\nworld");
  });

  it("carriage return + erase-to-EOL overwrites in place", () => {
    const vt = new VirtualTerminal(20);
    vt.write("progress 1");
    vt.write("\r\x1b[K");
    vt.write("progress 2");
    expect(vt.screen()).toBe("progress 2");
  });

  it("strips SGR and ignores sync-output / paste-mode markers", () => {
    const vt = new VirtualTerminal(40);
    vt.write("\x1b[?2026h\x1b[2myou>\x1b[22m hi\x1b[?2026l\x1b[?2004h");
    expect(vt.screen()).toBe("you> hi");
  });

  it("soft-wraps long lines at the column width", () => {
    const vt = new VirtualTerminal(5);
    vt.write("abcdefgh");
    expect(vt.screen()).toBe("abcde\nfgh");
    expect(vt.cursor()).toEqual({ row: 1, col: 3 });
  });

  it("cursor-up + erase-down clears a multi-row region", () => {
    const vt = new VirtualTerminal(20);
    vt.write("scrollback\nrow one\nrow two");
    vt.write("\x1b[1A\r\x1b[J");
    expect(vt.screen()).toBe("scrollback");
    vt.write("repainted");
    expect(vt.screen()).toBe("scrollback\nrepainted");
  });

  it("reflows soft-wrapped rows on narrowing resize, cursor follows", () => {
    const vt = new VirtualTerminal(10);
    vt.write("you> hello");
    expect(vt.cursor()).toEqual({ row: 0, col: 10 });
    vt.resize(6);
    // "you> hello" (10 chars) rewraps to two rows at width 6
    expect(vt.screen()).toBe("you> h\nello");
    expect(vt.cursor()).toEqual({ row: 1, col: 4 });
  });

  it("does not rewrap rows that still fit after widening", () => {
    const vt = new VirtualTerminal(20);
    vt.write("line a\nyou> ");
    vt.resize(40);
    expect(vt.screen()).toBe("line a\nyou>");
    expect(vt.cursor()).toEqual({ row: 1, col: 5 });
  });
});
