/**
 * An ANSI-aware scrollback buffer.
 *
 * This is the pure half of the terminal panel: bytes in, styled lines out, no
 * DOM and no network. It exists as its own module because everything hard about
 * rendering a shell is in here and none of it is hard to test — while the React
 * component around it is trivial and (this app has no jsdom) untestable.
 *
 * Three problems it actually solves, none of which a naive `text += chunk`
 * does:
 *
 * 1. **Carriage returns.** `npm install`, `playwright test`, `docker pull` and
 *    every progress bar ever written repaint one line by emitting `\r` and
 *    overwriting. Splitting the stream on `\n` turns a thirty-second install
 *    into ten thousand scrollback lines and pushes the error that matters off
 *    the top. Here `\r` moves a cursor to column 0 and subsequent characters
 *    overwrite in place, which is what a terminal does and why the install
 *    stays one line.
 *
 * 2. **Chunk reassembly.** Output arrives in whatever pieces the transport
 *    hands us, and an escape sequence has no reason to respect those
 *    boundaries: `\x1b[3` in one chunk and `1mFAILED` in the next is entirely
 *    normal. A parser that gives up at the end of a chunk prints a literal
 *    `[31m` in the middle of the failure message. So an incomplete sequence is
 *    held back and re-parsed when more arrives.
 *
 * 3. **Bounds.** A `cat` of a minified bundle is one 2MB line; a runaway loop
 *    is a million lines. Both are bounded here, and the bound is reported
 *    rather than applied silently — a scrollback that quietly ate the first
 *    four thousand lines is a debugging tool that lies.
 *
 * ── What it deliberately is NOT ──────────────────────────────────────────────
 * It is not a terminal emulator. There is no cursor grid, no alternate screen,
 * no scroll region, so a full-screen TUI (`htop`, `vim`) would render as
 * nonsense. That is the right trade: the transport this feeds is a
 * one-command-at-a-time allowlisted channel (see apps/api/src/lib/pty.ts), not
 * an interactive tty, so nothing on the other end can launch a TUI. Cursor
 * movement sequences are *consumed* rather than printed — the honest failure
 * for output we cannot place is to drop it, never to spray `\x1b[2A` into the
 * user's log.
 *
 * Colours resolve to design tokens, not hex. The 16 ANSI colours are a palette
 * this product does not own; mapping them onto the seven tokens the cockpit
 * does own is what keeps a red failure the same red as every other failure on
 * the screen, in both themes.
 */

/** The only colours this buffer can produce. Every one is a cockpit token. */
export type TerminalColour =
  | 'ink'
  | 'ink-dim'
  | 'ink-faint'
  | 'accent'
  | 'pass'
  | 'flake'
  | 'fail';

export interface SpanStyle {
  fg?: TerminalColour;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  /** SGR 7. Rendered as a swapped foreground/background by the component. */
  inverse?: boolean;
}

export interface Span {
  text: string;
  style: SpanStyle;
}

export interface Line {
  spans: Span[];
  /** The line hit `maxColumns` and the rest was dropped. Shown, never hidden. */
  truncated: boolean;
}

const DEFAULT_STYLE: SpanStyle = {};

/**
 * ANSI colour index → token.
 *
 * Bright black is the interesting one: programs use it for de-emphasised text
 * (timestamps, hints), so it maps to `ink-dim` rather than to something dark
 * enough to vanish. Blue, magenta and cyan all collapse onto `accent` — the
 * cockpit has one accent and inventing two more to be faithful to a 1979
 * palette would put colours on screen that belong to no theme.
 */
const ANSI_FG: Readonly<Record<number, TerminalColour>> = {
  30: 'ink-faint',
  31: 'fail',
  32: 'pass',
  33: 'flake',
  34: 'accent',
  35: 'accent',
  36: 'accent',
  37: 'ink',
  90: 'ink-dim',
  91: 'fail',
  92: 'pass',
  93: 'flake',
  94: 'accent',
  95: 'accent',
  96: 'accent',
  97: 'ink',
};

/**
 * 256-colour index → token, for the first sixteen entries only.
 *
 * The index space and the SGR code space are NOT the same numbers, which is an
 * easy and silent bug: `38;5;32` is a blue from the colour cube, while the SGR
 * code 32 is green. Indices 0–7 are the basic colours and 8–15 the bright ones,
 * so they translate to codes 30–37 and 90–97. Everything above 15 is a point in
 * a 6×6×6 cube or a greyscale ramp with no honest home in a seven-token
 * palette, so it keeps the default colour rather than being rounded to whatever
 * token happens to be nearest.
 */
function paletteColour(index: number): TerminalColour | undefined {
  if (index >= 0 && index <= 7) return ANSI_FG[30 + index];
  if (index >= 8 && index <= 15) return ANSI_FG[90 + (index - 8)];
  return undefined;
}

/** Scrollback depth. Ten thousand lines is more than anyone reads and still bounded. */
export const DEFAULT_MAX_LINES = 5_000;

/**
 * Where a line stops.
 *
 * Truncation rather than wrapping, and that is a deliberate disagreement with
 * how a real terminal behaves. Wrapping a 2MB minified bundle at 80 columns
 * produces twenty-five thousand lines, which then evicts the entire rest of the
 * session through the line cap — one `cat` of the wrong file and the failure
 * you were reading is gone. Truncating costs the tail of one line and says so.
 */
export const DEFAULT_MAX_COLUMNS = 2_000;

/**
 * How much unterminated escape sequence to hold before giving up on it.
 *
 * An incomplete sequence is normal (problem 2 above) and is held for the next
 * chunk. But a stream that emits `\x1b[` and then a megabyte of digits — a
 * corrupted pipe, or someone probing — must not be buffered forever waiting for
 * a final byte that is not coming. Past this the ESC is dropped and parsing
 * resumes at the next character, which turns a hostile stream into slightly
 * ugly output instead of unbounded memory.
 */
const MAX_PENDING = 256;

/** Tab stops, at the width every shell and every log formatter assumes. */
const TAB_WIDTH = 8;

interface Cell {
  ch: string;
  style: SpanStyle;
}

/**
 * How a scan of one escape sequence ended.
 *
 * `incomplete` is a first-class outcome rather than an error, because it is the
 * expected result at the tail of most chunks.
 */
type ScanResult =
  | { kind: 'incomplete' }
  | { kind: 'csi'; length: number; params: number[]; final: string }
  | { kind: 'ignored'; length: number };

/**
 * Parse the CSI parameter/intermediate/final structure at `s[start]`.
 *
 * Written as an explicit character walk rather than a regex on purpose: this
 * function's input is remote output, and a regex over untrusted text is the one
 * thing this codebase refuses outright. It is also the only way to distinguish
 * "no final byte yet" from "no final byte ever", which is the whole point.
 */
function scanCsi(s: string, start: number): ScanResult {
  // start points at ESC; start+1 is '['.
  let i = start + 2;
  const paramStart = i;
  while (i < s.length && s[i]! >= '0' && s[i]! <= '?') i += 1; // params: 0-9 ; : < = > ?
  const paramText = s.slice(paramStart, i);
  while (i < s.length && s[i]! >= ' ' && s[i]! <= '/') i += 1; // intermediates
  if (i >= s.length) return { kind: 'incomplete' };

  const final = s[i]!;
  const length = i + 1 - start;
  if (final < '@' || final > '~') {
    // Not a valid final byte: the sequence is malformed, so stop pretending to
    // understand it and drop what we scanned rather than resyncing forever.
    return { kind: 'ignored', length };
  }

  const params = paramText
    .split(';')
    .map((part) => (part === '' ? 0 : Number.parseInt(part, 10)))
    .map((n) => (Number.isFinite(n) ? n : 0));

  return { kind: 'csi', length, params, final };
}

/** Scan a string-terminated sequence (OSC, DCS, APC, PM) ending in BEL or ST. */
function scanStringSequence(s: string, start: number): ScanResult {
  for (let i = start + 2; i < s.length; i += 1) {
    if (s[i] === '\x07') return { kind: 'ignored', length: i + 1 - start };
    if (s[i] === '\x1b' && s[i + 1] === '\\') return { kind: 'ignored', length: i + 2 - start };
    // A lone ESC that is not the start of ST means the terminator was lost;
    // treat the sequence as ended so one dropped byte does not eat the rest of
    // the stream.
    if (s[i] === '\x1b' && i + 1 < s.length) return { kind: 'ignored', length: i - start };
  }
  return { kind: 'incomplete' };
}

export interface TerminalBufferOptions {
  maxLines?: number;
  maxColumns?: number;
}

export class TerminalBuffer {
  private readonly maxLines: number;
  private readonly maxColumns: number;

  private committed: Line[] = [];
  private cells: Cell[] = [];
  private col = 0;
  private style: SpanStyle = DEFAULT_STYLE;
  private truncated = false;
  private pending = '';

  /** Lines evicted by the scrollback cap. Surfaced so the UI can say so. */
  droppedLines = 0;

  constructor(options: TerminalBufferOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
    this.maxColumns = Math.max(1, options.maxColumns ?? DEFAULT_MAX_COLUMNS);
  }

  /**
   * Feed a chunk. Safe to call with any split of the stream, including one that
   * lands in the middle of an escape sequence or between `\r` and `\n`.
   */
  write(chunk: string): void {
    if (!chunk) return;
    const s = this.pending + chunk;
    this.pending = '';

    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;

      if (ch === '\x1b') {
        const scan = this.scanEscape(s, i);
        if (scan.kind === 'incomplete') {
          const held = s.length - i;
          if (held < MAX_PENDING) {
            this.pending = s.slice(i);
            return;
          }
          // Held too long to be a real sequence. Drop the ESC and re-parse the
          // rest as text, which is at worst cosmetic and at best resyncs.
          i += 1;
          continue;
        }
        if (scan.kind === 'csi') this.applyCsi(scan.params, scan.final);
        i += scan.length;
        continue;
      }

      if (ch === '\n') {
        this.commitLine();
        i += 1;
        continue;
      }
      if (ch === '\r') {
        // Column 0, content intact. `\r\n` therefore ends one line rather than
        // producing a blank one, and a progress bar repaints in place.
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === '\b') {
        if (this.col > 0) this.col -= 1;
        i += 1;
        continue;
      }
      if (ch === '\t') {
        const next = Math.floor(this.col / TAB_WIDTH) * TAB_WIDTH + TAB_WIDTH;
        // Move the cursor, padding only the cells that do not exist yet — a tab
        // over already-printed text must not erase it.
        while (this.col < next) {
          if (this.col >= this.cells.length) this.putChar(' ', DEFAULT_STYLE);
          else this.col += 1;
          if (this.col >= this.maxColumns) break;
        }
        i += 1;
        continue;
      }
      if (ch < ' ' || ch === '\x7f') {
        // Remaining C0 controls (BEL, SO, SI, …) have no place in scrollback.
        i += 1;
        continue;
      }

      this.putChar(ch, this.style);
      i += 1;
    }
  }

  /** Committed scrollback plus the line currently being written. */
  lines(): Line[] {
    return [...this.committed, this.coalesce()];
  }

  /** Total lines the caller would render, for keying and scroll logic. */
  get lineCount(): number {
    return this.committed.length + 1;
  }

  clear(): void {
    this.committed = [];
    this.cells = [];
    this.col = 0;
    this.truncated = false;
    // Style and pending deliberately survive: `clear` is a screen operation,
    // not a reset of the stream being parsed.
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private scanEscape(s: string, start: number): ScanResult {
    const next = s[start + 1];
    if (next === undefined) return { kind: 'incomplete' };
    if (next === '[') return scanCsi(s, start);
    if (next === ']' || next === 'P' || next === '_' || next === '^') {
      return scanStringSequence(s, start);
    }
    if (next === '(' || next === ')' || next === '*' || next === '+') {
      // Charset designation: ESC, selector, one more byte.
      if (start + 2 >= s.length) return { kind: 'incomplete' };
      return { kind: 'ignored', length: 3 };
    }
    return { kind: 'ignored', length: 2 };
  }

  private applyCsi(params: number[], final: string): void {
    if (final === 'm') {
      this.applySgr(params);
      return;
    }
    if (final === 'K') {
      this.eraseInLine(params[0] ?? 0);
      return;
    }
    if (final === 'J' && (params[0] === 2 || params[0] === 3)) {
      // `clear`. Everything else in the J family addresses a cursor grid this
      // buffer does not model, so it is dropped rather than approximated.
      this.clear();
      return;
    }
    if (final === 'G') {
      // Cursor to absolute column — the one cursor move that is meaningful
      // without a grid, and the one `\r`-style progress code uses.
      this.col = Math.max(0, Math.min(this.maxColumns - 1, (params[0] ?? 1) - 1));
      return;
    }
    // Cursor up/down/save/restore, scroll regions, mode sets: consumed, not
    // printed. See the header — placing them wrongly is worse than dropping.
  }

  /**
   * `\x1b[m` and `\x1b[0m` both arrive here as `[0]` — scanCsi turns an empty
   * parameter list into a single zero, exactly as a terminal does — so reset
   * needs no separate case.
   */
  private applySgr(params: number[]): void {
    let next: SpanStyle = { ...this.style };
    for (let i = 0; i < params.length; i += 1) {
      const p = params[i]!;
      const colour = ANSI_FG[p];
      if (p === 0) next = {};
      else if (p === 1) next.bold = true;
      else if (p === 2) next.dim = true;
      else if (p === 4) next.underline = true;
      else if (p === 7) next.inverse = true;
      else if (p === 22) {
        delete next.bold;
        delete next.dim;
      } else if (p === 24) delete next.underline;
      else if (p === 27) delete next.inverse;
      else if (p === 39) delete next.fg;
      else if (colour) next.fg = colour;
      else if (p === 38 || p === 48) {
        /*
         * Extended colour. The parameters are consumed even though 24-bit
         * colour cannot survive a seven-token palette, and consuming them is
         * the entire point: `38;2;255;0;0;1m` left unconsumed would read `255`,
         * `0`, `0` as further SGR codes and then apply the trailing `1` as
         * bold on whatever it guessed. Getting the colour approximately wrong
         * is fine; desynchronising the parameter list is not.
         */
        const mode = params[i + 1];
        if (mode === 5) {
          const index = params[i + 2];
          const mapped = index === undefined ? undefined : paletteColour(index);
          if (p === 38 && mapped) next.fg = mapped;
          i += 2;
        } else if (mode === 2) {
          i += 4;
        }
      }
    }
    this.style = next;
  }

  private eraseInLine(mode: number): void {
    if (mode === 0) this.cells.length = Math.min(this.cells.length, this.col);
    else if (mode === 1) {
      for (let i = 0; i < Math.min(this.col, this.cells.length); i += 1) {
        this.cells[i] = { ch: ' ', style: DEFAULT_STYLE };
      }
    } else if (mode === 2) this.cells.length = 0;
    // A cleared line is no longer a truncated one.
    if (this.cells.length === 0) this.truncated = false;
  }

  private putChar(ch: string, style: SpanStyle): void {
    if (this.col >= this.maxColumns) {
      this.truncated = true;
      return;
    }
    // A cursor moved past the end (a tab, or CSI G) leaves a gap. Pad it with
    // DEFAULT_STYLE, never the active style — padding with an inverse or
    // coloured style paints a block across whitespace nobody wrote.
    while (this.cells.length < this.col) this.cells.push({ ch: ' ', style: DEFAULT_STYLE });
    this.cells[this.col] = { ch, style };
    this.col += 1;
  }

  private commitLine(): void {
    this.committed.push(this.coalesce());
    this.cells = [];
    this.col = 0;
    this.truncated = false;
    while (this.committed.length > this.maxLines) {
      this.committed.shift();
      this.droppedLines += 1;
    }
  }

  /** Cells → the fewest spans that describe them. */
  private coalesce(): Line {
    const spans: Span[] = [];
    for (const cell of this.cells) {
      const last = spans[spans.length - 1];
      if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
      else spans.push({ text: cell.ch, style: cell.style });
    }
    return { spans, truncated: this.truncated };
  }
}

function sameStyle(a: SpanStyle, b: SpanStyle): boolean {
  return (
    a.fg === b.fg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse
  );
}

/** The plain text of a line — what a "copy output" affordance yields. */
export function lineText(line: Line): string {
  return line.spans.map((span) => span.text).join('');
}

/** The whole buffer as plain text. */
export function bufferText(lines: readonly Line[]): string {
  return lines.map(lineText).join('\n');
}
