/**
 * What am I inside of, right now?
 *
 * Breadcrumbs are a VS Code *workbench* feature, not a Monaco one — the
 * embedded editor ships no outline and no breadcrumb bar, so a file long enough
 * to scroll gives you a filename at the top and nothing else. This module is the
 * missing half: a symbol trail for the two file shapes this editor actually
 * opens, computed from the buffer with no language service and no round trip.
 *
 * It is deliberately a scanner rather than a parse. The alternative is asking
 * Monaco's TypeScript worker for navigation items, which is async, version-
 * shaped, and answers nothing at all for a JSON spec — and a breadcrumb that
 * arrives after you have finished reading the line is not a breadcrumb. What is
 * lost is precision on code this editor does not hold: the trail is exact for
 * `describe` / `test` / `test.step` nesting and for JSON property paths, and
 * empty for anything else, which is the honest answer rather than a guess.
 */

export interface OutlineSymbol {
  /** The literal the block was named with — a test title, or a JSON key. */
  name: string;
  startLine: number;
  endLine: number;
}

/**
 * The same cap impact.ts puts on scanning test source. A generated spec is a few
 * hundred lines; something past this is a paste of a minified bundle, and
 * walking it on every cursor move would cost more than the trail is worth.
 */
const MAX_CHARS = 400_000;

/**
 * Is the character immediately before this offset one that rules a header out?
 *
 * Two rejections, and both matter. An identifier character means this is the
 * TAIL of a longer name — `mytest(` contains `test(`. A dot means it is a member
 * call on something else — `/re/.test(url)` and `expect(x).describe` are not
 * blocks, and reading them as one would name a block after a regex match.
 *
 * It reads the raw previous character rather than the last significant one,
 * because `await test.step(` is preceded by a space and the last significant
 * character is the `t` of `await`.
 */
const blocksHeader = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_$.]/.test(ch);

/**
 * `test('…')`, `describe('…')`, `it('…')`, and the modifier chains they carry.
 *
 * Sticky, so it can be tried at one exact offset instead of scanning ahead into
 * a string or a comment. The leading name is guarded by the caller checking the
 * PREVIOUS character, which is what stops `/re/.test('x')` and `myTest(` from
 * being read as a block — a member call and a longer identifier respectively.
 */
const HEADER =
  /(?:test|it|describe|suite)(?:\.(?:describe|step|only|skip|fixme|serial|parallel|concurrent|each|failing|fail|todo))*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/y;

/** `\'` inside a title is an apostrophe, not two characters. */
const unescape = (raw: string): string => raw.replace(/\\(.)/g, '$1');

/**
 * Blocks in a Playwright/Jest-shaped spec, innermost last.
 *
 * The state machine tracks three things: brace depth (which block am I in),
 * paren depth (has the call that opened this block closed without a body), and
 * the previous non-whitespace character (which brace is the body).
 *
 * That last one is the whole trick. `test('x', async ({ page }) => {` contains
 * TWO opening braces, and the first is a destructuring pattern. Claiming "the
 * next brace after the title" would name `{ page }` — a block that closes on
 * the same line — and leave the real body anonymous. A body brace always
 * follows `=>` or `)`; a pattern or an options object never does.
 */
function specOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const stack: Array<{ name: string | null; startLine: number }> = [];
  let pending: { name: string; line: number; parenLevel: number } | null = null;
  let parenDepth = 0;
  let prevCode = '';
  let line = 1;
  let i = 0;

  /** Advance past `count` characters, keeping the line number honest. */
  const skip = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (text[k] === '\n') line += 1;
  };

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    // A line comment, unless that first slash was escaped — `/https:\/\//` ends
    // in two slashes that are a regex, not a comment, and swallowing the rest of
    // the line over it would drop every block below.
    if (ch === '/' && next === '/' && prevCode !== '\\') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      skip(i, stop);
      i = stop;
      continue;
    }

    /*
     * A string, skipped whole — including a template literal's `${…}`. Its
     * braces are balanced inside it, so stepping over the lot keeps the depth
     * right and costs nothing a breadcrumb would have used.
     */
    if (ch === '"' || ch === "'" || ch === '`') {
      let k = i + 1;
      while (k < text.length) {
        if (text[k] === '\\') {
          k += 2;
          continue;
        }
        if (text[k] === ch) break;
        k += 1;
      }
      const stop = Math.min(k + 1, text.length);
      skip(i, stop);
      i = stop;
      prevCode = ch;
      continue;
    }

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // A block header, but only where a fresh identifier can start.
    if ((ch === 't' || ch === 'i' || ch === 'd' || ch === 's') && !blocksHeader(text[i - 1])) {
      HEADER.lastIndex = i;
      const match = HEADER.exec(text);
      if (match) {
        const headerLine = line;
        skip(i, HEADER.lastIndex);
        // The pattern consumed the call's own `(`, so the depth has to be told.
        parenDepth += 1;
        pending = { name: unescape(match[2] ?? ''), line: headerLine, parenLevel: parenDepth };
        i = HEADER.lastIndex;
        prevCode = text[i - 1] ?? prevCode;
        continue;
      }
    }

    if (ch === '(') parenDepth += 1;
    else if (ch === ')') {
      parenDepth -= 1;
      // The call closed without ever opening a body — `test.skip('name')`. The
      // title belongs to nothing, so it must not be handed to the next block.
      if (pending && parenDepth < pending.parenLevel) pending = null;
    } else if (ch === '{') {
      if (pending && (prevCode === '>' || prevCode === ')')) {
        stack.push({ name: pending.name, startLine: pending.line });
        pending = null;
      } else {
        stack.push({ name: null, startLine: line });
      }
    } else if (ch === '}') {
      const top = stack.pop();
      if (top?.name) out.push({ name: top.name, startLine: top.startLine, endLine: line });
    }

    prevCode = ch;
    i += 1;
  }

  /*
   * Whatever is still open at the end is still open around the cursor. A file
   * mid-edit is unbalanced most of the time — you are inside the block you just
   * typed the opening brace of — and dropping those is exactly when the trail
   * would go blank on you.
   */
  for (const frame of stack) {
    if (frame.name) out.push({ name: frame.name, startLine: frame.startLine, endLine: line });
  }

  return out;
}

/** The property path through a JSON spec — the same trail, for the other buffer. */
function jsonOutline(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const stack: Array<{ name: string; startLine: number; array: boolean; index: number }> = [];
  let pendingKey: string | null = null;
  let line = 1;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }

    if (ch === '"') {
      let k = i + 1;
      let raw = '';
      while (k < text.length) {
        if (text[k] === '\\') {
          raw += text[k + 1] ?? '';
          k += 2;
          continue;
        }
        if (text[k] === '"') break;
        raw += text[k];
        k += 1;
      }
      i = Math.min(k + 1, text.length);

      // A string is a KEY only where a colon follows it. In an array, or as a
      // value, it is data and carries no path.
      let after = i;
      while (after < text.length && /\s/.test(text[after]!)) after += 1;
      const frame = stack[stack.length - 1];
      if (text[after] === ':' && frame && !frame.array) pendingKey = raw;
      continue;
    }

    if (ch === '{' || ch === '[') {
      const parent = stack[stack.length - 1];
      const name = pendingKey ?? (parent?.array ? `[${parent.index}]` : '');
      stack.push({ name, startLine: line, array: ch === '[', index: 0 });
      pendingKey = null;
    } else if (ch === '}' || ch === ']') {
      const top = stack.pop();
      if (top?.name) out.push({ name: top.name, startLine: top.startLine, endLine: line });
    } else if (ch === ',') {
      pendingKey = null;
      const frame = stack[stack.length - 1];
      if (frame?.array) frame.index += 1;
    }

    i += 1;
  }

  for (const frame of stack) {
    if (frame.name) out.push({ name: frame.name, startLine: frame.startLine, endLine: line });
  }

  return out;
}

/** Every named block in the buffer. Unordered — `symbolTrailAt` sorts what it needs. */
export function fileOutline(text: string, language: string): OutlineSymbol[] {
  if (!text || text.length > MAX_CHARS) return [];
  if (language === 'json') return jsonOutline(text);
  if (language === 'typescript' || language === 'javascript') return specOutline(text);
  return [];
}

/**
 * The blocks containing `line`, outermost first — the breadcrumb, in order.
 *
 * Ties break on the wider span, so `describe` precedes the `test` that opens on
 * the same line as it.
 */
export function symbolTrailAt(symbols: OutlineSymbol[], line: number): OutlineSymbol[] {
  return symbols
    .filter((s) => s.startLine <= line && line <= s.endLine)
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}
