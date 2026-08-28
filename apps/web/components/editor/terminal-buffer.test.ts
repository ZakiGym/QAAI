/**
 * Tests for the scrollback buffer.
 *
 * Every case here is written against a behaviour that has a real, observable
 * failure in the product if it regresses, and the assertions come from the
 * ANSI spec and from what programs actually emit — never from the buffer's own
 * output. That distinction matters: a test that fed the buffer and asserted
 * `lines()` equals `lines()` would pass on every possible implementation,
 * including one that dropped the stream on the floor.
 *
 * The four that would cost the most:
 *
 *   · A progress bar producing one line, not ten thousand. This is the reason
 *     the buffer exists; without it a `npm ci` evicts the entire session
 *     through the scrollback cap and the error you opened the terminal to read
 *     is gone.
 *   · An escape sequence split across chunks rendering as colour, not as a
 *     literal `[31m` in the middle of the failure message. Transports split
 *     wherever they like and this is the only defence.
 *   · Extended-colour parameters being consumed. Getting `38;2;R;G;B` wrong by
 *     one parameter desynchronises the rest of the list and applies random SGR
 *     codes for the rest of the line.
 *   · The scrollback cap reporting what it dropped. A buffer that silently ate
 *     the first four thousand lines is a debugging tool that lies.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_COLUMNS,
  DEFAULT_MAX_LINES,
  TerminalBuffer,
  bufferText,
  lineText,
} from './terminal-buffer';

const ESC = '\x1b';

/** Every line as plain text, including the uncommitted one. */
function text(buffer: TerminalBuffer): string[] {
  return buffer.lines().map(lineText);
}

describe('plain text', () => {
  it('splits on newlines and keeps a trailing partial line', () => {
    const buffer = new TerminalBuffer();
    buffer.write('one\ntwo\nthr');
    expect(text(buffer)).toEqual(['one', 'two', 'thr']);
  });

  it('treats CRLF as a single line ending, not a blank line', () => {
    // A Windows runner, or anything piping through a shell on one. Reading \r
    // as "new line" as well as \n double-spaces every log from that agent.
    const buffer = new TerminalBuffer();
    buffer.write('alpha\r\nbeta\r\n');
    expect(text(buffer)).toEqual(['alpha', 'beta', '']);
  });

  it('drops the remaining C0 controls rather than printing them', () => {
    const buffer = new TerminalBuffer();
    buffer.write('be\x07ll\x00');
    expect(text(buffer)).toEqual(['bell']);
  });
});

describe('carriage return', () => {
  it('collapses a progress bar to one line', () => {
    const buffer = new TerminalBuffer();
    for (let percent = 0; percent <= 100; percent += 1) {
      buffer.write(`\rProgress: ${percent}%`);
    }
    expect(buffer.lineCount).toBe(1);
    expect(text(buffer)).toEqual(['Progress: 100%']);
  });

  it('overwrites in place and leaves the tail of the longer previous line', () => {
    // Exactly what a real terminal does, and the reason programs emit \x1b[K.
    // Hiding it here would make the buffer disagree with the tty the output
    // came from.
    const buffer = new TerminalBuffer();
    buffer.write('abcdef\rXY');
    expect(text(buffer)).toEqual(['XYcdef']);
  });

  it('erase-to-end-of-line after a return clears the stale tail', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`abcdef\r${ESC}[KXY`);
    expect(text(buffer)).toEqual(['XY']);
  });

  it('erase-whole-line leaves an empty line', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`downloading 40%${ESC}[2Mdone`);
    // 2M is not erase-line; only 2K is. Guard against matching on the parameter
    // and ignoring the final byte.
    expect(text(buffer)).toEqual(['downloading 40%done']);

    const other = new TerminalBuffer();
    other.write(`downloading 40%\r${ESC}[2K`);
    expect(text(other)).toEqual(['']);
  });
});

describe('backspace and tabs', () => {
  it('backspace moves the cursor so the next character overwrites', () => {
    const buffer = new TerminalBuffer();
    buffer.write('cat\b\bup');
    expect(text(buffer)).toEqual(['cup']);
  });

  it('tab advances to the next eight-column stop', () => {
    const buffer = new TerminalBuffer();
    buffer.write('ab\tc');
    expect(text(buffer)).toEqual(['ab      c']);
  });

  it('a tab over already-written text moves without erasing it', () => {
    const buffer = new TerminalBuffer();
    buffer.write('abcdefghij\rX\tZ');
    // X at col 0, tab to col 8, Z at col 8: b..h survive.
    expect(text(buffer)).toEqual(['XbcdefghZj']);
  });
});

describe('SGR styling', () => {
  it('maps the ANSI colours onto cockpit tokens', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[31mfail${ESC}[32mpass${ESC}[33mflake${ESC}[0mplain`);
    const [line] = buffer.lines();
    expect(line!.spans.map((span) => [span.text, span.style.fg])).toEqual([
      ['fail', 'fail'],
      ['pass', 'pass'],
      ['flake', 'flake'],
      ['plain', undefined],
    ]);
  });

  it('combines attributes from one sequence and turns them off individually', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[1;4;31mboth${ESC}[24monly bold`);
    const [line] = buffer.lines();
    expect(line!.spans[0]!.style).toEqual({ bold: true, underline: true, fg: 'fail' });
    expect(line!.spans[1]!.style).toEqual({ bold: true, fg: 'fail' });
  });

  it('treats a bare ESC[m as a full reset', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[1;31mred${ESC}[mplain`);
    const [line] = buffer.lines();
    expect(line!.spans[1]!.style).toEqual({});
  });

  it('coalesces adjacent characters that share a style', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[32mPASSED${ESC}[0m`);
    expect(buffer.lines()[0]!.spans).toHaveLength(1);
  });

  it('consumes 24-bit colour parameters so the trailing codes are not misread', () => {
    // `38;2;255;0;0;1m`: if the RGB triple leaks back into the parameter loop,
    // `255` is nothing, `0` resets, and `1` then applies bold to text the
    // program asked to be plain red. Consuming is what keeps the tail correct.
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[38;2;255;0;0;1mtinted`);
    const [line] = buffer.lines();
    expect(line!.spans[0]!.style.bold).toBe(true);
  });

  it('maps a 256-colour index through the index space, not the SGR code space', () => {
    // The two numberings are different and confusing them is silent: index 1 is
    // red (SGR 31) while SGR code 1 is bold, and index 32 is a cube blue while
    // SGR code 32 is green. Both directions are pinned here.
    const red = new TerminalBuffer();
    red.write(`${ESC}[38;5;1mred`);
    expect(red.lines()[0]!.spans[0]!.style.fg).toBe('fail');

    const brightBlue = new TerminalBuffer();
    brightBlue.write(`${ESC}[38;5;12mblue`);
    expect(brightBlue.lines()[0]!.spans[0]!.style.fg).toBe('accent');

    // Out of the basic sixteen: no honest token, so no colour rather than a
    // guess. Index 32 must NOT come back as the green of SGR code 32.
    const cube = new TerminalBuffer();
    cube.write(`${ESC}[38;5;32mcube`);
    expect(cube.lines()[0]!.spans[0]!.style.fg).toBeUndefined();
  });

  it('ignores a background colour without disturbing the foreground', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[31m${ESC}[48;5;236mstill red`);
    expect(buffer.lines()[0]!.spans[0]!.style.fg).toBe('fail');
  });
});

describe('chunk reassembly', () => {
  it('holds a sequence split mid-parameter and renders it as one colour', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[3`);
    buffer.write('1mred');
    expect(text(buffer)).toEqual(['red']);
    expect(buffer.lines()[0]!.spans[0]!.style.fg).toBe('fail');
  });

  it('holds a chunk that ends on the bare ESC', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`ok${ESC}`);
    expect(text(buffer)).toEqual(['ok']);
    buffer.write('[32mgo');
    expect(text(buffer)).toEqual(['okgo']);
    expect(buffer.lines()[0]!.spans[1]!.style.fg).toBe('pass');
  });

  it('holds a chunk that ends on the CSI introducer', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`x${ESC}[`);
    buffer.write('1mbold');
    expect(text(buffer)).toEqual(['xbold']);
    expect(buffer.lines()[0]!.spans[1]!.style.bold).toBe(true);
  });

  it('survives being fed one character at a time', () => {
    // The degenerate split. Anything the parser holds across a boundary is
    // exercised at every boundary here.
    const source = `${ESC}[1;31mFAILED${ESC}[0m spec.ts:12\n${ESC}]0;title\x07next`;
    const buffer = new TerminalBuffer();
    for (const ch of source) buffer.write(ch);
    expect(text(buffer)).toEqual(['FAILED spec.ts:12', 'next']);
  });

  it('gives up on an unterminated sequence rather than buffering forever', () => {
    const buffer = new TerminalBuffer();
    // 300 digits with no final byte: past the hold limit, so the ESC is dropped
    // and the digits print. The property under test is that memory is bounded
    // and output resumes, not the exact cosmetics.
    buffer.write(`${ESC}[${'9'.repeat(300)}`);
    buffer.write('!');
    const rendered = bufferText(buffer.lines());
    expect(rendered).not.toContain(ESC);
    expect(rendered.endsWith('!')).toBe(true);
  });
});

describe('string-terminated sequences', () => {
  it('swallows an OSC title ended with BEL', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}]0;playwright test\x07running`);
    expect(text(buffer)).toEqual(['running']);
  });

  it('swallows an OSC ended with the two-byte string terminator', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}]8;;https://example.test${ESC}\\link`);
    expect(text(buffer)).toEqual(['link']);
  });

  it('holds an unterminated OSC across chunks', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}]0;half`);
    expect(text(buffer)).toEqual(['']);
    buffer.write('-title\x07done');
    expect(text(buffer)).toEqual(['done']);
  });
});

describe('cursor sequences this buffer does not model', () => {
  it('consumes cursor movement instead of printing it', () => {
    // Dropping is the honest failure for output we cannot place. Printing
    // `[2A` into someone's log is not.
    const buffer = new TerminalBuffer();
    buffer.write(`line${ESC}[2A${ESC}[?25l${ESC}[s more`);
    expect(text(buffer)).toEqual(['line more']);
  });

  it('honours absolute-column addressing, which progress code uses like \\r', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`abcdef${ESC}[1GZ`);
    expect(text(buffer)).toEqual(['Zbcdef']);
  });

  it('clears the whole buffer on ESC[2J', () => {
    const buffer = new TerminalBuffer();
    buffer.write('old\nolder\n');
    buffer.write(`${ESC}[2Jfresh`);
    expect(text(buffer)).toEqual(['fresh']);
  });

  it('drops a malformed CSI without resyncing on the rest of the stream', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`a${ESC}[1\x01bc`);
    expect(bufferText(buffer.lines())).not.toContain(ESC);
    expect(bufferText(buffer.lines())).toContain('bc');
  });
});

describe('bounds', () => {
  it('caps scrollback and reports exactly how much it dropped', () => {
    const buffer = new TerminalBuffer({ maxLines: 100 });
    for (let i = 0; i < 5_000; i += 1) buffer.write(`line ${i}\n`);
    // 5000 committed lines capped at 100, plus the empty line in progress.
    expect(buffer.droppedLines).toBe(4_900);
    expect(buffer.lineCount).toBe(101);
    expect(text(buffer)[0]).toBe('line 4900');
    expect(text(buffer)[99]).toBe('line 4999');
  });

  it('truncates a single enormous line rather than wrapping it into thousands', () => {
    // A `cat` of a minified bundle. Wrapping would evict the whole session
    // through the line cap; truncating costs one line's tail and says so.
    const buffer = new TerminalBuffer({ maxLines: 10, maxColumns: 40 });
    buffer.write('x'.repeat(100_000));
    expect(buffer.lineCount).toBe(1);
    const [line] = buffer.lines();
    expect(lineText(line!)).toHaveLength(40);
    expect(line!.truncated).toBe(true);
  });

  it('clears the truncation flag when the line is erased', () => {
    const buffer = new TerminalBuffer({ maxColumns: 4 });
    buffer.write(`longer than four\r${ESC}[2K`);
    expect(buffer.lines()[0]!.truncated).toBe(false);
  });

  it('starts a fresh line untruncated after a newline', () => {
    const buffer = new TerminalBuffer({ maxColumns: 6 });
    buffer.write('overlong\nshort');
    const lines = buffer.lines();
    expect(lines[0]!.truncated).toBe(true);
    expect(lines[1]!.truncated).toBe(false);
  });

  it('ships defaults that are bounded', () => {
    expect(DEFAULT_MAX_LINES).toBeLessThanOrEqual(10_000);
    expect(DEFAULT_MAX_COLUMNS).toBeLessThanOrEqual(10_000);
  });
});

describe('clear', () => {
  it('empties the scrollback but keeps counting what was dropped before it', () => {
    const buffer = new TerminalBuffer({ maxLines: 2 });
    for (let i = 0; i < 10; i += 1) buffer.write(`l${i}\n`);
    const droppedBefore = buffer.droppedLines;
    buffer.clear();
    expect(buffer.lineCount).toBe(1);
    expect(buffer.droppedLines).toBe(droppedBefore);
  });
});

describe('text extraction', () => {
  it('joins spans and lines for a copy affordance', () => {
    const buffer = new TerminalBuffer();
    buffer.write(`${ESC}[31mE${ESC}[0mrror\nat spec.ts:3`);
    expect(bufferText(buffer.lines())).toBe('Error\nat spec.ts:3');
  });
});
