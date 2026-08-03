/**
 * A unified diff, drawn as rows.
 *
 * The heals screen used to hand this to Monaco's side-by-side diff editor,
 * which is the right tool for reviewing a file and the wrong one for reviewing
 * a four-line locator change: it loads an editor, shows two panes of a file you
 * did not ask about, and buries the two lines that actually changed. A heal
 * proposal is a patch, so this renders the patch.
 *
 * It also gives the stale case somewhere to live. When the server says the diff
 * no longer applies there is no "after" to build a side-by-side from, and the
 * old screen fell back to a raw `<pre>` — two different reading experiences for
 * one task, and the worse one shown exactly when the reader most needs to
 * understand what is being proposed.
 */

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Header lines describe the file, not the change; the change is what is shown. */
const HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename )/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];

  for (const text of diff.split('\n')) {
    if (HEADER.test(text)) continue;
    // "\ No newline at end of file" — a note about the patch format, not a line
    // of anybody's test.
    if (text.startsWith('\\')) continue;

    if (text.startsWith('@@')) lines.push({ kind: 'hunk', text });
    else if (text.startsWith('+')) lines.push({ kind: 'add', text });
    else if (text.startsWith('-')) lines.push({ kind: 'del', text });
    else lines.push({ kind: 'context', text });
  }

  while (lines.length > 0 && lines[lines.length - 1]!.text.trim() === '') lines.pop();
  return lines;
}

const LINE: Record<DiffLineKind, string> = {
  add: 'text-pass bg-[color-mix(in_srgb,var(--color-pass)_8%,transparent)]',
  del: 'text-fail bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)]',
  hunk: 'text-ink-faint bg-surface-2/60',
  context: 'text-ink-faint',
};

export function DiffRows({ diff }: { diff: string }) {
  const lines = parseUnifiedDiff(diff);

  if (lines.length === 0) {
    return (
      <p className="text-ink-faint text-micro mt-3">
        The proposal arrived without a diff — there is nothing to review here.
      </p>
    );
  }

  return (
    <div className="border-line mt-3 overflow-hidden rounded-lg border">
      {/* Horizontal scrolling belongs to the diff, never to the page. The rows
          are `w-max` so a washed line runs the full scrolled width rather than
          stopping at the fold. */}
      <div className="max-h-[22rem] overflow-auto font-mono text-[11.5px] leading-[1.6]">
        {lines.map((line, i) => (
          <div key={i} className={`w-max min-w-full px-3 py-[2px] whitespace-pre ${LINE[line.kind]}`}>
            {line.text === '' ? ' ' : line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
