/**
 * Minimal virtual-terminal interpreter for renderer tests.
 *
 * Interprets the ANSI subset the CLI renderer emits (cursor moves, line/
 * screen erase, CR/LF, SGR stripped, synchronized-output markers ignored)
 * into a character grid, so tests assert on the SCREEN a user would see —
 * "five resizes produce exactly one `you>`" — instead of on escape-code
 * strings. This is the honest substitute for a PTY harness: resize can't
 * be driven through `script(1)`, but reflow can be simulated here.
 *
 * Reflow model matches macOS Terminal/iTerm2 (where #455 was witnessed):
 * on resize, soft-wrapped rows re-join into logical lines and re-wrap at
 * the new width; the cursor follows its character position.
 */

interface Row {
  chars: string[];
  /** True when this row overflowed and visually continues on the next row. */
  softWrap: boolean;
}

export class VirtualTerminal {
  private rows: Row[] = [{ chars: [], softWrap: false }];
  private cursorRow = 0;
  private cursorCol = 0;
  cols: number;

  constructor(cols = 80) {
    this.cols = cols;
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        i = this.handleEscape(data, i);
        continue;
      }
      if (ch === "\r") {
        this.cursorCol = 0;
        i++;
        continue;
      }
      if (ch === "\n") {
        // stdout passes through the tty driver with ONLCR, so LF behaves
        // as CR+LF from the app's point of view.
        this.currentRow().softWrap = false;
        this.cursorRow++;
        this.cursorCol = 0;
        this.ensureRow();
        i++;
        continue;
      }
      if (ch === "\b") {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        i++;
        continue;
      }
      if (ch.charCodeAt(0) < 32) {
        i++; // other control chars: ignore
        continue;
      }
      // Printable
      if (this.cursorCol >= this.cols) {
        this.currentRow().softWrap = true;
        this.cursorRow++;
        this.cursorCol = 0;
        this.ensureRow();
      }
      this.currentRow().chars[this.cursorCol] = ch;
      this.cursorCol++;
      i++;
    }
  }

  /** Simulate a reflowing terminal resize (macOS Terminal/iTerm2 model). */
  resize(newCols: number): void {
    // Join soft-wrapped runs into logical lines, remembering where the
    // cursor sits as a (logical line, char offset) pair.
    interface Logical {
      text: string[];
      cursorOffset: number | null;
    }
    const logicals: Logical[] = [];
    let current: Logical | null = null;
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r]!;
      if (current === null) current = { text: [], cursorOffset: null };
      if (r === this.cursorRow) {
        current.cursorOffset = current.text.length + this.cursorCol;
      }
      // Pad implicit blanks so column positions survive the join
      const width = row.softWrap ? this.cols : row.chars.length;
      for (let c = 0; c < width; c++) current.text.push(row.chars[c] ?? " ");
      if (!row.softWrap) {
        logicals.push(current);
        current = null;
      }
    }
    if (current !== null) logicals.push(current);

    this.cols = newCols;
    this.rows = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    for (const logical of logicals) {
      const startRow = this.rows.length;
      const chunks = Math.max(1, Math.ceil(logical.text.length / newCols));
      for (let k = 0; k < chunks; k++) {
        this.rows.push({
          chars: logical.text.slice(k * newCols, (k + 1) * newCols),
          softWrap: k < chunks - 1,
        });
      }
      if (logical.cursorOffset !== null) {
        this.cursorRow = startRow + Math.floor(logical.cursorOffset / newCols);
        this.cursorCol = logical.cursorOffset % newCols;
        // Cursor exactly at end-of-line lands at col == len, not next row
        if (
          this.cursorCol === 0 &&
          logical.cursorOffset > 0 &&
          logical.cursorOffset === logical.text.length
        ) {
          this.cursorRow = startRow + chunks - 1;
          this.cursorCol = newCols;
        }
        this.ensureRow();
      }
    }
    if (this.rows.length === 0) this.rows.push({ chars: [], softWrap: false });
  }

  /** The visible screen: rows joined by \n, trailing blanks trimmed. */
  screen(): string {
    return this.rows
      .map((r) =>
        r.chars
          .map((c) => c ?? " ")
          .join("")
          .replace(/\s+$/, ""),
      )
      .join("\n")
      .replace(/\n+$/, "");
  }

  /** Count occurrences of a visible substring on screen. */
  count(needle: string): number {
    return this.screen().split(needle).length - 1;
  }

  cursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  // -------------------------------------------------------------------------

  private currentRow(): Row {
    this.ensureRow();
    return this.rows[this.cursorRow]!;
  }

  private ensureRow(): void {
    while (this.rows.length <= this.cursorRow) {
      this.rows.push({ chars: [], softWrap: false });
    }
  }

  /** Returns the index after the escape sequence. */
  private handleEscape(data: string, start: number): number {
    const next = data[start + 1];
    if (next !== "[") return start + 2; // ESC7/ESC8 etc — ignore
    let j = start + 2;
    while (j < data.length && !/[a-zA-Z~]/.test(data[j]!)) j++;
    if (j >= data.length) return data.length;
    const final = data[j]!;
    const params = data.slice(start + 2, j);
    const n =
      parseInt(params.replace(/[?]/g, ""), 10) || (final === "G" ? 1 : params === "0" ? 0 : NaN);
    const count = Number.isNaN(n) ? (final === "J" || final === "K" ? 0 : 1) : n;
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, count));
        break;
      case "B":
        this.cursorRow += Math.max(1, count);
        this.ensureRow();
        break;
      case "C":
        this.cursorCol = Math.min(this.cols, this.cursorCol + Math.max(1, count));
        break;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, count));
        break;
      case "G":
        this.cursorCol = Math.max(0, Math.max(1, count) - 1);
        break;
      case "K": {
        const row = this.currentRow();
        if (count === 0) {
          row.chars.length = Math.min(row.chars.length, this.cursorCol);
          row.softWrap = false;
        } else if (count === 2) {
          row.chars = [];
          row.softWrap = false;
        }
        break;
      }
      case "J": {
        if (count === 0) {
          // Erase from cursor to end of screen
          const row = this.currentRow();
          row.chars.length = Math.min(row.chars.length, this.cursorCol);
          row.softWrap = false;
          this.rows.length = this.cursorRow + 1;
        } else if (count === 2) {
          for (const row of this.rows) {
            row.chars = [];
            row.softWrap = false;
          }
        }
        break;
      }
      // m (SGR), h/l (modes incl. ?2026 sync, ?2004 paste), and anything
      // else: ignored — the VT tracks characters, not attributes.
      default:
        break;
    }
    return j + 1;
  }
}
