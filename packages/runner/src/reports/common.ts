/**
 * Primitives the format parsers share: a forgiving XML reader, a forgiving JSON
 * reader, and the duration conversions.
 *
 * Both readers are written for one hostile case in particular — a file that was
 * being written when the process died. A strict parser answers "invalid" and
 * throws away the ninety tests that made it to disk; these answer with those
 * ninety tests and `truncated: true`, which is the difference between a run you
 * can triage and a run you have to repeat.
 *
 * No XML or JSON dependency is added for this. The dialects here are small and
 * machine-generated, and the tolerance we need (recover from a half-written
 * tail) is precisely what a conforming parser refuses to provide.
 */

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * XML entities, including the hex numeric form. TRX leans on `&#xD;&#xA;` for
 * every newline inside a message, so a decoder that only handles decimal turns
 * .NET stack traces into one unreadable line.
 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// ─── A tiny, tolerant XML DOM ────────────────────────────────────────────────

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text of this element, CDATA unwrapped and entities decoded. */
  text: string;
}

export interface XmlDocument {
  roots: XmlNode[];
  /** The document ends mid-element or mid-token. */
  truncated: boolean;
  diagnostics: string[];
}

const NAME_END = /[\s/>]/;

/**
 * Read XML into a node tree, giving up on nothing.
 *
 * Deliberately not a validating parser: mismatched close tags are resolved by
 * popping to the nearest matching ancestor, unknown constructs are skipped, and
 * an element still open at EOF is kept with whatever children it collected.
 */
export function parseXml(input: string): XmlDocument {
  const xml = stripBom(input);
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  const diagnostics: string[] = [];
  let truncated = false;
  let i = 0;

  const top = (): XmlNode | undefined => stack[stack.length - 1];
  const addText = (raw: string): void => {
    const parent = top();
    if (!parent || raw.length === 0) return;
    parent.text += raw;
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      addText(decodeXmlEntities(xml.slice(i)));
      break;
    }
    if (lt > i) addText(decodeXmlEntities(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) {
        truncated = true;
        break;
      }
      i = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) {
        // Half-written CDATA: keep the text we have, it is usually the failure
        // message we most want.
        addText(xml.slice(lt + 9));
        truncated = true;
        break;
      }
      addText(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) {
        truncated = true;
        break;
      }
      i = end + 2;
      continue;
    }

    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) {
        truncated = true;
        break;
      }
      i = end + 1;
      continue;
    }

    if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) {
        truncated = true;
        break;
      }
      const name = xml.slice(lt + 2, end).trim();
      const at = findOpen(stack, name);
      if (at >= 0) stack.length = at;
      // A close with no matching open is noise from a partial file; ignore it.
      i = end + 1;
      continue;
    }

    const tagEnd = findTagEnd(xml, lt + 1);
    if (tagEnd < 0) {
      // The file stops inside a start tag — the runner was killed mid-write.
      truncated = true;
      break;
    }

    let nameEnd = lt + 1;
    while (nameEnd < tagEnd && !NAME_END.test(xml[nameEnd] as string)) nameEnd += 1;
    const name = xml.slice(lt + 1, nameEnd);
    let attrsRaw = xml.slice(nameEnd, tagEnd);
    const selfClosing = attrsRaw.trimEnd().endsWith('/');
    if (selfClosing) attrsRaw = attrsRaw.trimEnd().slice(0, -1);

    const node: XmlNode = { name, attrs: parseAttrs(attrsRaw), children: [], text: '' };
    const parent = top();
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);

    i = tagEnd + 1;
  }

  if (stack.length > 0) {
    truncated = true;
    diagnostics.push(
      `XML ended inside <${stack.map((n) => n.name).join('> <')}> — the file is incomplete.`,
    );
  }

  return { roots, truncated, diagnostics };
}

/** Index of the nearest open element with this name, or -1. */
function findOpen(stack: XmlNode[], name: string): number {
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    if (eqName(stack[k]?.name ?? '', name)) return k;
  }
  return -1;
}

/**
 * The `>` that closes a start tag, skipping any inside quoted attribute values.
 * `>` is legal unescaped in an attribute value and Python's ElementTree — which
 * writes pytest's JUnit XML — does not escape it, so `name="a > b"` is real.
 */
function findTagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let k = from; k < xml.length; k += 1) {
    const ch = xml[k];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return k;
  }
  return -1;
}

const ATTR_RE = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const key = m[1];
    if (!key) continue;
    out[key.toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

function eqName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Attribute lookup, case-insensitive because emitters disagree on casing. */
export function attr(node: XmlNode, name: string): string | null {
  const v = node.attrs[name.toLowerCase()];
  return v === undefined ? null : v;
}

export function child(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((c) => eqName(c.name, name)) ?? null;
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => eqName(c.name, name));
}

/** Every descendant with this name, in document order. */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      if (eqName(c.name, name)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** This element's text plus all of its descendants', in order. */
export function deepText(node: XmlNode): string {
  let out = node.text;
  for (const c of node.children) out += deepText(c);
  return out;
}

// ─── Durations ───────────────────────────────────────────────────────────────

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    // JUnit `time` is locale-formatted by some emitters ("1,234" for 1234).
    const n = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function secondsToMs(value: unknown): number {
  const n = toNumber(value);
  return n === null ? 0 : Math.max(0, Math.round(n * 1000));
}

export function msValue(value: unknown): number {
  const n = toNumber(value);
  return n === null ? 0 : Math.max(0, Math.round(n));
}

/** Cucumber-JS and Cucumber-JVM report step durations in nanoseconds. */
export function nanosToMs(value: unknown): number {
  const n = toNumber(value);
  return n === null ? 0 : Math.max(0, Math.round(n / 1_000_000));
}

/**
 * TRX durations are .NET `TimeSpan`s: `[d.]HH:MM:SS.fffffff`, where the
 * fraction is 100-nanosecond ticks — seven digits, not three. Reading it as
 * milliseconds inflates every duration by 10,000x.
 */
export function timeSpanToMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const m = /^(?:(\d+)[.:])?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) {
    // Some loggers write a bare number of seconds instead.
    const n = toNumber(value);
    return n === null ? 0 : Math.max(0, Math.round(n * 1000));
  }
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const seconds = Number(m[4] ?? 0);
  const fractionDigits = m[5] ?? '';
  // Pad or trim to 7 ticks digits, then convert ticks (100ns) to ms.
  const ticks = fractionDigits === '' ? 0 : Number(fractionDigits.padEnd(7, '0').slice(0, 7));
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000 + ticks / 10_000;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

// ─── Text ────────────────────────────────────────────────────────────────────

export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

export function clip(text: string, max = 4000): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

export function nonEmpty(value: string | null | undefined): string | null {
  const t = (value ?? '').trim();
  return t === '' ? null : t;
}

// ─── A tolerant JSON reader ──────────────────────────────────────────────────

export interface LooseJson {
  value: unknown;
  ok: boolean;
  truncated: boolean;
  diagnostics: string[];
}

/**
 * `JSON.parse`, then two fallbacks that matter in practice.
 *
 * 1. Runners share stdout. A `.rspec` with a second formatter, a stray `puts`,
 *    or npm's own noise lands either side of the document, so we retry on the
 *    span between the first `{`/`[` and its matching close.
 * 2. A file cut off mid-write is closed synthetically at the last point where a
 *    complete value had been written, recovering every test that reached disk.
 */
export function parseJsonLoose(input: string): LooseJson {
  const text = stripBom(input).trim();
  if (text === '') return { value: undefined, ok: false, truncated: false, diagnostics: [] };

  try {
    return { value: JSON.parse(text), ok: true, truncated: false, diagnostics: [] };
  } catch {
    /* fall through */
  }

  const carved = carveJson(text);
  if (carved !== null && carved !== text) {
    try {
      return {
        value: JSON.parse(carved),
        ok: true,
        truncated: false,
        diagnostics: [
          'Ignored non-JSON text around the report — the runner shared stdout with something else.',
        ],
      };
    } catch {
      /* fall through */
    }
  }

  const repaired = repairTruncatedJson(carved ?? text);
  if (repaired !== null) {
    try {
      return {
        value: JSON.parse(repaired),
        ok: true,
        truncated: true,
        diagnostics: ['The JSON report stops mid-write; recovered the tests that reached disk.'],
      };
    } catch {
      /* fall through */
    }
  }

  return { value: undefined, ok: false, truncated: false, diagnostics: [] };
}

/** The span from the first `{`/`[` to the last `}`/`]`, or null if there is none. */
function carveJson(text: string): string | null {
  const startCurly = text.indexOf('{');
  const startSquare = text.indexOf('[');
  const candidates = [startCurly, startSquare].filter((n) => n >= 0);
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (end <= start) return text.slice(start);
  return text.slice(start, end + 1);
}

/**
 * Close a half-written document at the last position that is provably after a
 * complete value: immediately after a `}`/`]`, or immediately after a comma
 * (which can only follow a finished value). Everything past that point is a
 * fragment — a half-written key, a string with no closing quote — and is
 * dropped rather than guessed at.
 */
export function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let cut = -1;
  let cutStack: string[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      cut = i + 1;
      cutStack = [...stack];
      continue;
    }
    if (ch === ',' && stack.length > 0) {
      cut = i; // drop the comma itself; the value before it is complete
      cutStack = [...stack];
    }
  }

  if (stack.length === 0) return null; // nothing was left open; not a truncation
  if (cut < 0 || cutStack.length === 0) return null;

  return text.slice(0, cut) + cutStack.reverse().join('');
}

/** One JSON value per line — `go test -json`. Bad lines are reported, never fatal. */
export interface LooseNdjson {
  rows: unknown[];
  /** The final line is a fragment: the writer was killed mid-line. */
  truncated: boolean;
  /** Lines that were not JSON at all (a runner interleaving plain stdout). */
  skipped: number;
  /** True when at least one line parsed. */
  ok: boolean;
}

export function parseNdjson(input: string): LooseNdjson {
  const text = stripBom(input);
  const lines = text.split('\n');
  const rows: unknown[] = [];
  let skipped = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A fragment on the very last line is a half-written record, not garbage.
      const isLast = lines.slice(i + 1).every((l) => l.trim() === '');
      if (isLast && line.startsWith('{')) truncated = true;
      else skipped += 1;
    }
  }

  return { rows, truncated, skipped, ok: rows.length > 0 };
}

/** Narrowing helpers — the JSON formats are all `unknown` until proven otherwise. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
