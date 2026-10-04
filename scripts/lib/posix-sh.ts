/**
 * A small POSIX-sh lexer + parser, enough to read every command a script runs —
 * including the ones inside `$( … )`, `$(( … ))` and `${ … }` — with the
 * context each runs in (function body, pipeline, subshell, command
 * substitution, background). Written for `check-prepush-subset`, which must
 * reason about `.husky/pre-push` deny-by-default: anything this parser does
 * not understand is a parse ERROR, never "no commands found".
 *
 * Out of scope on purpose (each is a parse error): backtick substitution,
 * here-documents, `case` inside a command substitution, process substitution.
 */

export interface Word {
  /** The word's source text, quotes and expansions intact. */
  raw: string;
  /** Parsed `$( … )` bodies inside this word (including inside `$(( … ))`). */
  subs: Program[];
  /** Bodies of `${ … }` parameter expansions in this word. */
  params: string[];
  line: number;
}

type Tok =
  | { kind: "word"; word: Word }
  | { kind: "op"; op: string; line: number }
  | { kind: "redir"; text: string; target: Word | null; line: number };

export class ShParseError extends Error {}

const OP_CHARS = new Set([";", "&", "|", "(", ")", "<", ">", "\n"]);

/**
 * Lex `src` from `start`. With `closeParen`, stop at the `)` that closes a
 * `$(` (returning its index); otherwise lex to the end.
 */
function lex(src: string, start: number, line0: number, closeParen: boolean) {
  const toks: Tok[] = [];
  let i = start;
  let line = line0;
  let depth = 0;
  const isBlank = (c: string) => c === " " || c === "\t";

  const readWord = (): Word => {
    const w: Word = { raw: "", subs: [], params: [], line };
    const begin = i;
    for (;;) {
      if (i >= src.length) break;
      const c = src[i]!;
      if (isBlank(c) || OP_CHARS.has(c)) break;
      if (c === "\\") {
        if (src[i + 1] === "\n") {
          i += 2;
          line++;
          continue;
        }
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ShParseError(`line ${line}: unterminated single quote`);
        for (let k = i; k < end; k++) if (src[k] === "\n") line++;
        i = end + 1;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i]!;
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "`") throw new ShParseError(`line ${line}: backtick command substitution`);
          if (d === "$") {
            dollar(w);
            continue;
          }
          if (d === "\n") line++;
          i++;
        }
        if (i >= src.length) throw new ShParseError(`line ${line}: unterminated double quote`);
        i++;
        continue;
      }
      if (c === "`") throw new ShParseError(`line ${line}: backtick command substitution`);
      if (c === "$") {
        dollar(w);
        continue;
      }
      i++;
    }
    w.raw = src.slice(begin, i).replace(/\\\n/g, "");
    return w;
  };

  /** At a `$`: consume `$( … )`, `$(( … ))`, `${ … }` or a plain `$x`. */
  const dollar = (w: Word) => {
    if (src[i + 1] === "(" && src[i + 2] === "(") {
      // Arithmetic: balanced parens; may itself contain `$( … )`.
      i += 3;
      let d = 0;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
          dollar(w);
          continue;
        }
        if (c === "(") d++;
        if (c === ")") {
          if (d === 0 && src[i + 1] === ")") {
            i += 2;
            return;
          }
          d--;
        }
        if (c === "\n") line++;
        i++;
      }
      throw new ShParseError(`line ${line}: unterminated $((`);
    }
    if (src[i + 1] === "(") {
      const inner = lex(src, i + 2, line, true);
      w.subs.push(parseTokens(inner.toks));
      line = inner.line;
      i = inner.end + 1;
      return;
    }
    if (src[i + 1] === "{") {
      const open = i;
      i += 2;
      let d = 0;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "{") d++;
        if (c === "}") {
          if (d === 0) break;
          d--;
        }
        if (c === "$" && src[i + 1] === "(") {
          dollar(w);
          continue;
        }
        i++;
      }
      if (i >= src.length) throw new ShParseError(`line ${line}: unterminated \${`);
      w.params.push(src.slice(open + 2, i));
      i++;
      return;
    }
    i++;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (isBlank(c)) {
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      line++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      toks.push({ kind: "op", op: "\n", line });
      line++;
      i++;
      continue;
    }
    // Redirections, with an optional leading fd number.
    const redir = /^(\d*)(>>|>&|<&|<<|<>|>\||>|<)/.exec(src.slice(i, i + 8));
    if (redir) {
      if (redir[2] === "<<") throw new ShParseError(`line ${line}: here-document`);
      i += redir[0].length;
      while (isBlank(src[i] ?? "")) i++;
      const target = readWord();
      toks.push({ kind: "redir", text: redir[0] + target.raw, target, line });
      continue;
    }
    if (c === "(") {
      depth++;
      toks.push({ kind: "op", op: "(", line });
      i++;
      continue;
    }
    if (c === ")") {
      if (closeParen && depth === 0) return { toks, end: i, line };
      depth--;
      toks.push({ kind: "op", op: ")", line });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ";;") {
      toks.push({ kind: "op", op: two, line });
      i += 2;
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      toks.push({ kind: "op", op: c, line });
      i++;
      continue;
    }
    toks.push({ kind: "word", word: readWord() });
  }
  if (closeParen) throw new ShParseError(`line ${line}: unterminated $(`);
  return { toks, end: i, line };
}

// ---------------------------------------------------------------------------
// AST

export interface Simple {
  type: "simple";
  assigns: Word[];
  words: Word[];
  redirs: string[];
  /** Redirection targets — words, so `> "$(cmd)"` is walked too. */
  redirTargets: Word[];
  line: number;
}
export interface Compound {
  type: "if" | "while" | "until" | "for" | "case" | "group" | "subshell";
  /** Each nested body (conditions and branches). */
  bodies: Program[];
  /** `for` variable / `case` subject+patterns — words evaluated, not run. */
  words: Word[];
  forVar?: string;
  line: number;
}
export interface FuncDef {
  type: "func";
  name: string;
  body: Program;
  /** Canonical token text of the body (comments + layout removed). */
  canon: string;
  line: number;
}
export type Command = Simple | Compound | FuncDef;
export interface Pipeline {
  bang: boolean;
  cmds: Command[];
}
export interface AndOr {
  pipelines: Pipeline[];
  ops: string[];
  background: boolean;
  /** Canonical token text of the whole and-or list. */
  canon: string;
}
export interface Program {
  items: AndOr[];
}

const RESERVED_END = new Set(["then", "else", "elif", "fi", "do", "done", "esac", "}"]);

const tokText = (t: Tok) =>
  t.kind === "word" ? t.word.raw : t.kind === "op" ? (t.op === "\n" ? ";" : t.op) : t.text;

/**
 * Canonical token text: comments and layout gone; a newline counts as `;`
 * only where it separates commands (not after `{`, `then`, `do`, `else`, an
 * operator, or another separator), so `a\n}` and `a; }` canonicalise alike.
 */
function canonText(toks: Tok[]): string {
  const out: string[] = [];
  const soft = new Set(["{", "then", "do", "else", "|", "&&", "||", ";", "(", "in"]);
  for (const t of toks) {
    const text = tokText(t);
    if (t.kind === "op" && (t.op === "\n" || t.op === ";")) {
      if (out.length === 0 || soft.has(out[out.length - 1]!)) continue;
      out.push(";");
      continue;
    }
    out.push(t.kind === "word" ? t.word.raw.replace(/\s+/g, " ") : text);
  }
  return out.join(" ");
}

function parseTokens(toks: Tok[]): Program {
  let p = 0;
  const peekWord = (): string | null => {
    const t = toks[p];
    return t && t.kind === "word" ? t.word.raw : null;
  };
  const peekOp = (): string | null => {
    const t = toks[p];
    return t && t.kind === "op" ? t.op : null;
  };
  const lineOf = () => {
    const t = toks[Math.min(p, toks.length - 1)];
    return !t ? 0 : t.kind === "word" ? t.word.line : t.line;
  };
  const skipNewlines = () => {
    while (peekOp() === "\n") p++;
  };
  const expectWord = (w: string) => {
    skipNewlines();
    if (peekWord() !== w)
      throw new ShParseError(`line ${lineOf()}: expected '${w}', got '${peekWord() ?? peekOp()}'`);
    p++;
  };

  /** A list up to one of `stops` (a reserved word) or `)` when `paren`. */
  const list = (stops: Set<string>, paren = false): Program => {
    const items: AndOr[] = [];
    for (;;) {
      while (peekOp() === "\n" || peekOp() === ";") p++;
      if (p >= toks.length) break;
      const w = peekWord();
      if (w != null && stops.has(w)) break;
      if (paren && peekOp() === ")") break;
      if (peekOp() === ";;") break;
      items.push(andOr());
    }
    return { items };
  };

  const andOr = (): AndOr => {
    const from = p;
    const pipelines = [pipeline()];
    const ops: string[] = [];
    while (peekOp() === "&&" || peekOp() === "||") {
      ops.push(peekOp()!);
      p++;
      skipNewlines();
      pipelines.push(pipeline());
    }
    let background = false;
    const canon = canonText(toks.slice(from, p));
    if (peekOp() === "&") {
      background = true;
      p++;
    }
    return { pipelines, ops, background, canon };
  };

  const pipeline = (): Pipeline => {
    let bang = false;
    if (peekWord() === "!") {
      bang = true;
      p++;
    }
    const cmds = [command()];
    while (peekOp() === "|") {
      p++;
      skipNewlines();
      cmds.push(command());
    }
    return { bang, cmds };
  };

  /** Redirections after a compound command (`{ …; } 2>/dev/null`). */
  const trailingRedirs = () => {
    while (toks[p]?.kind === "redir") {
      const t = toks[p] as { target: Word | null };
      if (t.target?.subs.length)
        throw new ShParseError(
          `line ${lineOf()}: command substitution in a compound command's redirection`,
        );
      p++;
    }
  };

  const command = (): Command => {
    const line = lineOf();
    const w = peekWord();
    if (peekOp() === "(") {
      p++;
      const body = list(new Set(), true);
      if (peekOp() !== ")") throw new ShParseError(`line ${line}: unclosed (`);
      p++;
      trailingRedirs();
      return { type: "subshell", bodies: [body], words: [], line };
    }
    if (w === "{") {
      p++;
      const body = list(new Set(["}"]));
      expectWord("}");
      trailingRedirs();
      return { type: "group", bodies: [body], words: [], line };
    }
    if (w === "if") {
      p++;
      const bodies: Program[] = [];
      bodies.push(list(new Set(["then"])));
      expectWord("then");
      bodies.push(list(new Set(["elif", "else", "fi"])));
      for (;;) {
        skipNewlines();
        const k = peekWord();
        if (k === "elif") {
          p++;
          bodies.push(list(new Set(["then"])));
          expectWord("then");
          bodies.push(list(new Set(["elif", "else", "fi"])));
          continue;
        }
        if (k === "else") {
          p++;
          bodies.push(list(new Set(["fi"])));
        }
        break;
      }
      expectWord("fi");
      trailingRedirs();
      return { type: "if", bodies, words: [], line };
    }
    if (w === "while" || w === "until") {
      p++;
      const cond = list(new Set(["do"]));
      expectWord("do");
      const body = list(new Set(["done"]));
      expectWord("done");
      trailingRedirs();
      return { type: w, bodies: [cond, body], words: [], line };
    }
    if (w === "for") {
      p++;
      const v = peekWord();
      if (v == null) throw new ShParseError(`line ${line}: for without a variable`);
      p++;
      const words: Word[] = [];
      skipNewlines();
      if (peekWord() === "in") {
        p++;
        while (toks[p]?.kind === "word") words.push((toks[p++] as { word: Word }).word);
      }
      while (peekOp() === ";" || peekOp() === "\n") p++;
      expectWord("do");
      const body = list(new Set(["done"]));
      expectWord("done");
      trailingRedirs();
      return { type: "for", bodies: [body], words, forVar: v, line };
    }
    if (w === "case") {
      p++;
      const words: Word[] = [];
      const subj = toks[p];
      if (subj?.kind !== "word") throw new ShParseError(`line ${line}: case without a subject`);
      words.push(subj.word);
      p++;
      expectWord("in");
      const bodies: Program[] = [];
      for (;;) {
        skipNewlines();
        if (peekWord() === "esac") break;
        if (peekOp() === "(") p++;
        // Patterns: words separated by `|`, closed by `)`.
        for (;;) {
          const t = toks[p];
          if (t?.kind !== "word") throw new ShParseError(`line ${lineOf()}: bad case pattern`);
          words.push(t.word);
          p++;
          if (peekOp() === "|") {
            p++;
            continue;
          }
          break;
        }
        if (peekOp() !== ")") throw new ShParseError(`line ${lineOf()}: case pattern without ')'`);
        p++;
        bodies.push(list(new Set(["esac"])));
        if (peekOp() === ";;") p++;
      }
      expectWord("esac");
      trailingRedirs();
      return { type: "case", bodies, words, line };
    }
    // Function definition: NAME ( ) compound
    const t1 = toks[p + 1];
    const t2 = toks[p + 2];
    if (w != null && t1?.kind === "op" && t1.op === "(" && t2?.kind === "op" && t2.op === ")") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(w))
        throw new ShParseError(`line ${line}: bad function name ${w}`);
      p += 3;
      skipNewlines();
      const from = p;
      const bodyCmd = command();
      const canon = canonText(toks.slice(from, p));
      if (bodyCmd.type !== "group" && bodyCmd.type !== "subshell") {
        throw new ShParseError(`line ${line}: function ${w} body is not a { } or ( ) group`);
      }
      return { type: "func", name: w, body: bodyCmd.bodies[0]!, canon, line };
    }
    // Simple command.
    const s: Simple = {
      type: "simple",
      assigns: [],
      words: [],
      redirs: [],
      redirTargets: [],
      line,
    };
    for (;;) {
      const t = toks[p];
      if (!t) break;
      if (t.kind === "op") break;
      if (t.kind === "redir") {
        s.redirs.push(t.text);
        if (t.target) s.redirTargets.push(t.target);
        p++;
        continue;
      }
      if (s.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.word.raw))
        s.assigns.push(t.word);
      else {
        if (s.words.length === 0 && RESERVED_END.has(t.word.raw)) break;
        s.words.push(t.word);
      }
      p++;
    }
    if (s.words.length === 0 && s.assigns.length === 0 && s.redirs.length === 0) {
      throw new ShParseError(`line ${line}: unexpected '${toks[p] ? tokText(toks[p]!) : "EOF"}'`);
    }
    return s;
  };

  const prog = list(new Set());
  if (p < toks.length)
    throw new ShParseError(`line ${lineOf()}: unexpected '${tokText(toks[p]!)}'`);
  return prog;
}

export function parseSh(src: string): Program {
  return parseTokens(lex(src, 0, 1, false).toks);
}

// ---------------------------------------------------------------------------
// Walk

export interface Ctx {
  /** Innermost enclosing function name, or null at top level. */
  func: string | null;
  /** Runs in a child process / subshell (pipeline member, `( )`, `$( )`). */
  forked: boolean;
  background: boolean;
  /** Inside a `$( … )` (its output is consumed, its status mostly is not). */
  cmdsub: boolean;
  /** The canonical text of the enclosing and-or list. */
  andOr: string;
}

export interface Visitor {
  simple?(cmd: Simple, ctx: Ctx): void;
  func?(def: FuncDef, ctx: Ctx): void;
  compound?(cmd: Compound, ctx: Ctx): void;
  /** Return false to NOT descend into a word's `$( … )` bodies. */
  word?(w: Word, ctx: Ctx, role: "assign" | "arg" | "for" | "case"): boolean | void;
}

export function walk(
  prog: Program,
  v: Visitor,
  ctx: Ctx = { func: null, forked: false, background: false, cmdsub: false, andOr: "" },
): void {
  for (const item of prog.items) {
    for (const pl of item.pipelines) {
      const c: Ctx = {
        ...ctx,
        forked: ctx.forked || pl.cmds.length > 1,
        background: ctx.background || item.background,
        andOr: item.canon,
      };
      for (const cmd of pl.cmds) walkCommand(cmd, v, c);
    }
  }
}

function walkWord(w: Word, v: Visitor, ctx: Ctx, role: "assign" | "arg" | "for" | "case") {
  if (v.word?.(w, ctx, role) === false) return;
  for (const sub of w.subs) walk(sub, v, { ...ctx, forked: true, cmdsub: true });
}

function walkCommand(cmd: Command, v: Visitor, ctx: Ctx) {
  if (cmd.type === "simple") {
    v.simple?.(cmd, ctx);
    for (const a of cmd.assigns) walkWord(a, v, ctx, "assign");
    for (const w of cmd.words) walkWord(w, v, ctx, "arg");
    for (const w of cmd.redirTargets) walkWord(w, v, ctx, "arg");
    return;
  }
  if (cmd.type === "func") {
    v.func?.(cmd, ctx);
    walk(cmd.body, v, { ...ctx, func: cmd.name });
    return;
  }
  v.compound?.(cmd, ctx);
  for (const w of cmd.words) walkWord(w, v, ctx, cmd.type === "for" ? "for" : "case");
  const forked = ctx.forked || cmd.type === "subshell";
  for (const b of cmd.bodies) walk(b, v, { ...ctx, forked });
}
