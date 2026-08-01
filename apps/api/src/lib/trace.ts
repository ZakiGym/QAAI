/**
 * Playwright trace unpacking (§8) — turning the zip nobody downloads into JSON
 * the cockpit can render.
 *
 * The product's central claim is that it tells you *why* a test failed, with
 * evidence. Until now the evidence was a link to a `.zip`, which means in
 * practice the claim went unmet at the exact moment it mattered. Everything in
 * this file exists so the browser never sees that zip: we unpack it here and
 * hand out a timeline, a rebuilt DOM snapshot, and the network/console slice
 * for one action.
 *
 * A trace is a zip holding newline-delimited JSON event logs plus a resource
 * pool:
 *
 *   test.trace       the test runner's steps — human titles, stacks, errors
 *   <n>-trace.trace  the browser side — calls, DOM snapshots, screencast frames
 *   <n>-trace.network  one HAR entry per request, as `resource-snapshot` lines
 *   resources/<sha1>   response bodies, screencast JPEGs, attachments
 *
 * Two things about that format drive the shape of this code.
 *
 * First, DOM snapshots are *incremental*: a node can be the literal reference
 * `[[distance, nodeIndex]]`, meaning "the node at that post-order index in the
 * snapshot `distance` earlier for this same frame". Rebuilding one snapshot
 * therefore needs every earlier snapshot of its frame, which is why we keep
 * them in emission order per frame and never drop from the middle.
 *
 * Second, a trace can be enormous. Every collection here has a cap and every
 * cap sets a flag that reaches the UI, because a viewer that silently shows you
 * three quarters of a trace is worse than one that admits it.
 */

import JSZip from 'jszip';

// ─── Caps ────────────────────────────────────────────────────────────────────

/**
 * Above this we refuse rather than pull the whole thing into the API's heap.
 * A 200MB trace is real; loading it to answer one page view is not.
 */
export const MAX_TRACE_BYTES = 100 * 1024 * 1024;

/** DOM snapshots dominate the parsed model's footprint, so they are capped twice. */
const MAX_SNAPSHOTS = 4000;
const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;

const MAX_ACTIONS = 3000;
const MAX_NETWORK = 6000;
const MAX_CONSOLE = 4000;
const MAX_LOG_LINES_PER_ACTION = 200;

/** Response bodies we keep so a snapshot can inline its own stylesheets/images. */
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_ONE_RESOURCE_BYTES = 512 * 1024;

/** Screencast frames, kept so "the screenshot at that moment" costs no zip re-read. */
const MAX_FRAMES = 240;
const MAX_FRAME_BYTES = 12 * 1024 * 1024;

/** A rebuilt snapshot past this is truncated — the browser has to render it. */
const MAX_RENDERED_HTML_BYTES = 6 * 1024 * 1024;
/** Total bytes of inlined `data:` resources inside one rebuilt snapshot. */
const MAX_INLINE_BYTES = 6 * 1024 * 1024;

// ─── Public shapes ───────────────────────────────────────────────────────────

export type TraceUnavailableReason =
  /** The run kept no trace — `retain-on-failure` means a green test has none. */
  | 'NOT_RECORDED'
  /** The row points at a key the bucket no longer has (retention swept it). */
  | 'MISSING'
  | 'TOO_LARGE'
  | 'UNREADABLE'
  /** A well-formed zip with no trace events in it. */
  | 'EMPTY';

export type ActionCategory = 'step' | 'action' | 'expect' | 'hook' | 'fixture' | 'attach' | 'other';

export interface TraceSourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface TraceAction {
  id: string;
  parentId: string | null;
  depth: number;
  /** "Click getByRole('button', …)" — Playwright's own wording where it has one. */
  title: string;
  /** `Frame.click`, `Test.expect` — the API behind the title. */
  apiName: string;
  category: ActionCategory;
  /** Inside Before/After Hooks or a fixture: real, but not what anyone came for. */
  isSetup: boolean;
  startMs: number;
  endMs: number;
  durationMs: number;
  error: { message: string; stack: string | null } | null;
  /** The deepest action that carries the error — the one to open the viewer on. */
  failing: boolean;
  location: TraceSourceLocation | null;
  params: Record<string, string>;
  /** What the call returned, when it is a value worth reading ("$63.00"). */
  result: string | null;
  pageId: string | null;
  /** Snapshot names this action can show. Absent members were never recorded. */
  snapshots: { before: string | null; action: string | null; after: string | null };
  /** Where the DOM the UI shows by default came from. `nearest` = no exact match. */
  defaultSnapshot: { name: string; kind: 'before' | 'action' | 'after' | 'nearest' } | null;
  /** Viewport-space point of a click/tap, for the marker over the snapshot. */
  point: { x: number; y: number } | null;
  counts: { log: number; network: number; console: number };
}

export interface TraceNetworkEntry {
  id: string;
  startMs: number;
  durationMs: number;
  method: string;
  url: string;
  status: number;
  statusText: string;
  mimeType: string;
  requestBytes: number;
  responseBytes: number;
  /** True for 4xx/5xx and for requests that never got a status at all. */
  failed: boolean;
  pageId: string | null;
}

export interface TraceConsoleEntry {
  id: string;
  timeMs: number;
  /** `error` | `warning` | `log` | `stdout` | `stderr` — rendered as a tone. */
  level: string;
  text: string;
  location: string | null;
}

export interface TraceLogLine {
  timeMs: number;
  message: string;
}

export interface TraceAttachment {
  name: string;
  contentType: string;
  sha1: string;
  bytes: number;
}

export interface TraceMeta {
  browserName: string | null;
  playwrightVersion: string | null;
  platform: string | null;
  baseUrl: string | null;
  viewport: { width: number; height: number } | null;
  startedAt: string | null;
  durationMs: number;
  pageIds: string[];
}

/** Every cap that actually bit, in words the UI can print verbatim. */
export interface TraceLimits {
  truncated: boolean;
  notes: string[];
}

export interface ParsedTrace {
  meta: TraceMeta;
  actions: TraceAction[];
  network: TraceNetworkEntry[];
  console: TraceConsoleEntry[];
  attachments: TraceAttachment[];
  limits: TraceLimits;
  /** Non-public: everything the render/slice helpers below need. */
  readonly internals: TraceInternals;
}

export interface RenderedSnapshot {
  html: string;
  viewport: { width: number; height: number } | null;
  frameUrl: string | null;
  timeMs: number;
  /** Scroll offsets we could not apply server-side; the client re-applies them. */
  notes: string[];
  truncated: boolean;
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface StoredSnapshot {
  name: string;
  frameId: string;
  pageId: string | null;
  frameUrl: string | null;
  doctype: string | null;
  html: unknown;
  viewport: { width: number; height: number } | null;
  /** Absolute wall-clock ms; every clock in the model is normalised to this. */
  absMs: number;
  resourceOverrides: Array<{ url: string; sha1?: string; ref?: number }>;
  isMainFrame: boolean;
  /** Post-order node list, memoised on first reference resolution. */
  nodes?: unknown[];
}

interface StoredResource {
  url: string;
  method: string;
  status: number;
  mimeType: string;
  sha1: string | null;
  frameId: string | null;
  /** Response monotonic time, normalised — used to pick the body a snapshot saw. */
  absMs: number;
}

interface StoredFrame {
  pageId: string;
  sha1: string;
  width: number;
  height: number;
  absMs: number;
}

interface TraceInternals {
  /** Snapshots in emission order, grouped by frame — reference distances need this. */
  snapshotsByFrame: Map<string, StoredSnapshot[]>;
  snapshotIndex: Map<string, { frameId: string; index: number }>;
  /** Every snapshot in time order, for the "nearest" fallback. */
  snapshotsByTime: StoredSnapshot[];
  resources: StoredResource[];
  frames: StoredFrame[];
  /** sha1 → bytes, for resources small enough to have been kept. */
  bodies: Map<string, Buffer>;
  logsByAction: Map<string, TraceLogLine[]>;
  /**
   * Action id → the call id its log lines are filed under.
   *
   * They are rarely the same. Playwright logs against the browser-side call
   * (`call@12`), while the timeline is built from the test runner's step
   * (`pw:api@44`), so looking logs up by the id the UI knows about finds
   * nothing at all.
   */
  logSourceByAction: Map<string, string>;
  zeroMs: number;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeAttribute = (value: string): string =>
  value.replace(/[&<>"']/gu, (c) => ESCAPES[c] ?? c);

/** Text nodes only need `&` and `<` escaped, and over-escaping breaks CSS. */
const escapeText = (value: string): string => value.replace(/[&<]/gu, (c) => ESCAPES[c] ?? c);

const VOID_ELEMENTS = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'COMMAND',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'KEYGEN',
  'LINK',
  'MENUITEM',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR',
]);

/** `http-equiv` values that are inert in a rebuilt page; everything else is neutered. */
const SAFE_HTTP_EQUIV = new Set(['content-type', 'content-language', 'default-style']);

function isReference(node: unknown): node is [[number, number]] {
  return Array.isArray(node) && Array.isArray(node[0]);
}

function isElement(node: unknown): node is unknown[] {
  return Array.isArray(node) && typeof node[0] === 'string';
}

/**
 * Post-order list of a snapshot's own nodes.
 *
 * References are *not* counted — that is the whole contract of the index in
 * `[[distance, index]]`, and counting them shifts every later index by one,
 * which renders as a page built out of the wrong fragments.
 */
function snapshotNodes(snapshot: StoredSnapshot): unknown[] {
  if (snapshot.nodes) return snapshot.nodes;
  const nodes: unknown[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      nodes.push(node);
      return;
    }
    if (isElement(node)) {
      for (let i = 2; i < node.length; i++) visit(node[i]);
      nodes.push(node);
    }
  };
  visit(snapshot.html);
  snapshot.nodes = nodes;
  return nodes;
}

/** Strip the throwaway workspace prefix off a spec path so the line is readable. */
function tidyPath(file: string): string {
  const marker = file.match(/\.qaai-runs[/\\][^/\\]+[/\\](.*)$/);
  if (marker?.[1]) return marker[1].replace(/\\/g, '/');
  return file;
}

/** Playwright wraps failures in ANSI colour; a JSON field is not a terminal. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface RawCall {
  callId: string;
  stepId: string | null;
  parentId: string | null;
  startTime: number;
  endTime: number | null;
  className: string | null;
  method: string | null;
  title: string | null;
  params: Record<string, unknown> | null;
  stack: unknown[] | null;
  error: { message: string; stack: string | null } | null;
  result: unknown;
  pageId: string | null;
  beforeSnapshot: string | null;
  afterSnapshot: string | null;
  inputSnapshot: string | null;
  point: { x: number; y: number } | null;
  attachments: TraceAttachment[];
  /** ms offset that turns this file's monotonic clock into wall-clock. */
  offset: number;
}

interface ParseState {
  notes: string[];
  truncated: boolean;
}

function note(state: ParseState, text: string): void {
  state.truncated = true;
  if (!state.notes.includes(text)) state.notes.push(text);
}

/**
 * Unpack and normalise one Playwright trace zip.
 *
 * Throws only on a zip that cannot be opened at all; a zip that opens but holds
 * nothing recognisable comes back with `actions: []` and a note, because an
 * empty timeline with an explanation is a better answer than a 500.
 */
export async function parseTrace(bytes: Buffer): Promise<ParsedTrace> {
  const zip = await JSZip.loadAsync(bytes);
  const state: ParseState = { notes: [], truncated: false };

  const traceFiles: string[] = [];
  const networkFiles: string[] = [];
  const resourceNames: string[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    if (path.endsWith('.trace')) traceFiles.push(path);
    else if (path.endsWith('.network')) networkFiles.push(path);
    else if (path.startsWith('resources/')) resourceNames.push(path.slice('resources/'.length));
  });
  // `test.trace` carries the human step titles, so it must be read before the
  // browser-side files that only reference their step ids.
  traceFiles.sort((a, b) =>
    a === 'test.trace' ? -1 : b === 'test.trace' ? 1 : a.localeCompare(b),
  );

  const calls = new Map<string, RawCall>();
  const testRunnerCallIds = new Set<string>();
  const libraryByStepId = new Map<string, RawCall>();
  const logsByAction = new Map<string, TraceLogLine[]>();
  const snapshotsByFrame = new Map<string, StoredSnapshot[]>();
  const snapshotIndex = new Map<string, { frameId: string; index: number }>();
  const snapshotsByTime: StoredSnapshot[] = [];
  const frames: StoredFrame[] = [];
  const consoleEntries: TraceConsoleEntry[] = [];
  const attachments: TraceAttachment[] = [];

  const meta: TraceMeta = {
    browserName: null,
    playwrightVersion: null,
    platform: null,
    baseUrl: null,
    viewport: null,
    startedAt: null,
    durationMs: 0,
    pageIds: [],
  };

  let snapshotBytes = 0;
  let earliestWall = Number.POSITIVE_INFINITY;
  let latestWall = Number.NEGATIVE_INFINITY;
  /** Files without their own context-options borrow the first clock we saw. */
  let fallbackOffset: number | null = null;
  const offsetByFile = new Map<string, number>();
  const pageIds = new Set<string>();

  const track = (absMs: number): void => {
    if (!Number.isFinite(absMs)) return;
    if (absMs < earliestWall) earliestWall = absMs;
    if (absMs > latestWall) latestWall = absMs;
  };

  for (const path of traceFiles) {
    const text = await zip.file(path)?.async('string');
    if (!text) continue;

    const isTestRunner = path === 'test.trace';
    let offset = 0;
    let offsetKnown = false;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: Record<string, unknown> | null = null;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        continue; // A half-written line at the tail of an aborted run.
      }
      if (!event) continue;
      const type = str(event.type);

      if (type === 'context-options') {
        const wallTime = num(event.wallTime);
        const monotonicTime = num(event.monotonicTime);
        if (wallTime !== null && monotonicTime !== null) {
          offset = wallTime - monotonicTime;
          offsetKnown = true;
          if (fallbackOffset === null) fallbackOffset = offset;
          track(wallTime);
        }
        meta.browserName ||= str(event.browserName) || null;
        meta.playwrightVersion ||= str(event.playwrightVersion);
        meta.platform ||= str(event.platform);
        const options = asRecord(event.options);
        if (options) {
          meta.baseUrl ||= str(options.baseURL);
          const viewport = asRecord(options.viewport);
          const w = viewport ? num(viewport.width) : null;
          const h = viewport ? num(viewport.height) : null;
          if (w !== null && h !== null && !meta.viewport) meta.viewport = { width: w, height: h };
        }
        continue;
      }

      if (!offsetKnown && fallbackOffset !== null) offset = fallbackOffset;

      switch (type) {
        case 'before': {
          const callId = str(event.callId);
          if (!callId) break;
          if (calls.size >= MAX_ACTIONS * 3) {
            note(state, `Only the first ${MAX_ACTIONS} actions of this trace were parsed.`);
            break;
          }
          const startTime = num(event.startTime) ?? 0;
          const call: RawCall = {
            callId,
            stepId: str(event.stepId),
            parentId: str(event.parentId),
            startTime: startTime + offset,
            endTime: null,
            className: str(event.class),
            method: str(event.method),
            title: str(event.title),
            params: asRecord(event.params),
            stack: Array.isArray(event.stack) ? event.stack : null,
            error: null,
            result: null,
            pageId: str(event.pageId),
            beforeSnapshot: str(event.beforeSnapshot),
            afterSnapshot: null,
            inputSnapshot: null,
            point: null,
            attachments: [],
            offset,
          };
          track(call.startTime);
          if (isTestRunner) {
            testRunnerCallIds.add(callId);
            calls.set(callId, call);
          } else {
            calls.set(callId, call);
            if (call.stepId) libraryByStepId.set(call.stepId, call);
          }
          if (call.pageId) pageIds.add(call.pageId);
          break;
        }

        case 'input': {
          const call = calls.get(str(event.callId) ?? '');
          if (!call) break;
          call.inputSnapshot = str(event.inputSnapshot);
          const point = asRecord(event.point);
          const x = point ? num(point.x) : null;
          const y = point ? num(point.y) : null;
          if (x !== null && y !== null) call.point = { x, y };
          break;
        }

        case 'after': {
          const call = calls.get(str(event.callId) ?? '');
          if (!call) break;
          const endTime = num(event.endTime);
          call.endTime = endTime === null ? null : endTime + offset;
          if (call.endTime !== null) track(call.endTime);
          call.afterSnapshot = str(event.afterSnapshot);
          const error = asRecord(event.error);
          if (error) {
            const message = str(error.message) ?? str(error.value) ?? 'Failed';
            call.error = {
              message: stripAnsi(message),
              stack: stripAnsi(str(error.stack) ?? '') || null,
            };
          }
          const result = asRecord(event.result);
          if (result && 'value' in result) call.result = result.value;
          if (Array.isArray(event.attachments)) {
            for (const raw of event.attachments) {
              const record = asRecord(raw);
              const sha1 = record ? str(record.sha1) : null;
              if (!record || !sha1) continue;
              call.attachments.push({
                name: str(record.name) ?? 'attachment',
                contentType: str(record.contentType) ?? 'application/octet-stream',
                sha1,
                bytes: 0,
              });
            }
          }
          break;
        }

        case 'log': {
          const callId = str(event.callId);
          const message = str(event.message);
          if (!callId || !message) break;
          const bucket = logsByAction.get(callId) ?? [];
          if (bucket.length < MAX_LOG_LINES_PER_ACTION) {
            bucket.push({ timeMs: (num(event.time) ?? 0) + offset, message });
            logsByAction.set(callId, bucket);
          }
          break;
        }

        case 'console': {
          if (consoleEntries.length >= MAX_CONSOLE) {
            note(state, `Console output was cut off at ${MAX_CONSOLE} messages.`);
            break;
          }
          const location = asRecord(event.location);
          const url = location ? str(location.url) : null;
          const lineNumber = location ? num(location.lineNumber) : null;
          consoleEntries.push({
            id: `console-${consoleEntries.length}`,
            timeMs: (num(event.time) ?? 0) + offset,
            level: str(event.messageType) ?? 'log',
            text: stripAnsi(str(event.text) ?? ''),
            location: url ? `${url}${lineNumber === null ? '' : `:${lineNumber + 1}`}` : null,
          });
          break;
        }

        case 'stdout':
        case 'stderr': {
          const text_ = str(event.text);
          if (!text_ || consoleEntries.length >= MAX_CONSOLE) break;
          consoleEntries.push({
            id: `console-${consoleEntries.length}`,
            timeMs: (num(event.timestamp) ?? num(event.time) ?? 0) + offset,
            level: type,
            text: stripAnsi(text_),
            location: null,
          });
          break;
        }

        case 'frame-snapshot': {
          const snapshot = asRecord(event.snapshot);
          if (!snapshot) break;
          if (snapshotsByTime.length >= MAX_SNAPSHOTS || snapshotBytes >= MAX_SNAPSHOT_BYTES) {
            note(
              state,
              'This trace holds more DOM snapshots than one page can hold in memory, so the ' +
                'later ones were dropped. Actions past that point fall back to the closest ' +
                'snapshot that was kept.',
            );
            break;
          }
          const frameId = str(snapshot.frameId) ?? 'frame@unknown';
          const name = str(snapshot.snapshotName);
          if (!name) break;
          const viewportRecord = asRecord(snapshot.viewport);
          const vw = viewportRecord ? num(viewportRecord.width) : null;
          const vh = viewportRecord ? num(viewportRecord.height) : null;
          const timestamp = num(snapshot.timestamp) ?? 0;
          const wallTime = num(snapshot.wallTime);
          const stored: StoredSnapshot = {
            name,
            frameId,
            pageId: str(snapshot.pageId),
            frameUrl: str(snapshot.frameUrl),
            doctype: str(snapshot.doctype),
            html: snapshot.html,
            viewport: vw !== null && vh !== null ? { width: vw, height: vh } : null,
            absMs: wallTime ?? timestamp + offset,
            resourceOverrides: Array.isArray(snapshot.resourceOverrides)
              ? (snapshot.resourceOverrides as StoredSnapshot['resourceOverrides'])
              : [],
            isMainFrame: snapshot.isMainFrame === true,
          };
          snapshotBytes += line.length;
          const list = snapshotsByFrame.get(frameId) ?? [];
          // A snapshot's index inside its frame's list *is* the reference base;
          // only ever append.
          //
          // Names are unique per frame, not per trace: a page with an iframe
          // emits `after@call@8` twice, once per frame. The main frame wins the
          // by-name lookup, because that is the document the viewer renders —
          // resolving to a sub-frame would show a fragment as if it were a page.
          const claimed = snapshotIndex.get(name);
          if (!claimed || stored.isMainFrame) {
            const existing = claimed
              ? snapshotsByFrame.get(claimed.frameId)?.[claimed.index]
              : undefined;
            if (!existing?.isMainFrame || stored.isMainFrame) {
              snapshotIndex.set(name, { frameId, index: list.length });
            }
          }
          list.push(stored);
          snapshotsByFrame.set(frameId, list);
          snapshotsByTime.push(stored);
          track(stored.absMs);
          if (stored.pageId) pageIds.add(stored.pageId);
          break;
        }

        case 'screencast-frame': {
          const sha1 = str(event.sha1);
          if (!sha1) break;
          if (frames.length >= MAX_FRAMES) {
            note(state, `Only the first ${MAX_FRAMES} screencast frames were kept.`);
            break;
          }
          const pageId = str(event.pageId) ?? '';
          const absMs = num(event.frameSwapWallTime) ?? (num(event.timestamp) ?? 0) + offset;
          frames.push({
            pageId,
            sha1,
            width: num(event.width) ?? 0,
            height: num(event.height) ?? 0,
            absMs,
          });
          if (pageId) pageIds.add(pageId);
          track(absMs);
          break;
        }

        case 'event': {
          const pageId = str(event.pageId);
          if (pageId) pageIds.add(pageId);
          break;
        }

        default:
          break;
      }
    }

    offsetByFile.set(path, offsetKnown ? offset : (fallbackOffset ?? 0));
  }

  // ── Network ────────────────────────────────────────────────────────────────

  const network: TraceNetworkEntry[] = [];
  const resources: StoredResource[] = [];

  for (const path of networkFiles) {
    const text = await zip.file(path)?.async('string');
    if (!text) continue;
    const sibling = path.replace(/\.network$/, '.trace');
    const offset = offsetByFile.get(sibling) ?? fallbackOffset ?? 0;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event: Record<string, unknown> | null = null;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      const entry = event ? asRecord(event.snapshot) : null;
      if (!entry) continue;

      const request = asRecord(entry.request);
      const response = asRecord(entry.response);
      if (!request || !response) continue;
      const content = asRecord(response.content);

      const startedIso = str(entry.startedDateTime);
      const monotonic = num(entry._monotonicTime);
      const startMs = startedIso
        ? Date.parse(startedIso)
        : monotonic !== null
          ? monotonic + offset
          : Number.NaN;
      const status = num(response.status) ?? 0;

      if (Number.isFinite(startMs)) track(startMs);

      resources.push({
        url: str(request.url) ?? '',
        method: (str(request.method) ?? 'GET').toUpperCase(),
        status,
        mimeType: str(content?.mimeType) ?? '',
        sha1: str(content?._sha1),
        frameId: str(entry._frameref),
        absMs: monotonic !== null ? monotonic + offset : startMs,
      });

      if (network.length >= MAX_NETWORK) {
        note(state, `Only the first ${MAX_NETWORK} network requests were parsed.`);
        continue;
      }

      network.push({
        id: `net-${network.length}`,
        startMs: Number.isFinite(startMs) ? startMs : 0,
        durationMs: Math.max(0, Math.round(num(entry.time) ?? 0)),
        method: (str(request.method) ?? 'GET').toUpperCase(),
        url: str(request.url) ?? '',
        status,
        statusText: str(response.statusText) ?? '',
        mimeType: (str(content?.mimeType) ?? '').split(';')[0] ?? '',
        requestBytes: Math.max(0, num(request.bodySize) ?? 0),
        responseBytes: Math.max(0, num(content?.size) ?? 0),
        failed: status === 0 || status >= 400,
        pageId: str(entry.pageref),
      });
    }
  }

  // ── Resource bodies ────────────────────────────────────────────────────────

  const bodies = new Map<string, Buffer>();
  const wantedFrames = new Set(frames.map((f) => f.sha1));
  let bodyBytes = 0;
  let frameBytes = 0;
  let skippedBodies = 0;

  for (const name of resourceNames) {
    const file = zip.file(`resources/${name}`);
    if (!file) continue;
    const declared = uncompressedSize(file);
    const isFrame = wantedFrames.has(name);
    const cap = isFrame ? MAX_FRAME_BYTES : MAX_RESOURCE_BYTES;
    const used = isFrame ? frameBytes : bodyBytes;

    if (declared !== null && declared > MAX_ONE_RESOURCE_BYTES && !isFrame) {
      skippedBodies++;
      continue;
    }
    if (used >= cap) {
      skippedBodies++;
      continue;
    }

    const buffer = await file.async('nodebuffer');
    if (!isFrame && buffer.length > MAX_ONE_RESOURCE_BYTES) {
      skippedBodies++;
      continue;
    }
    if (used + buffer.length > cap) {
      skippedBodies++;
      continue;
    }
    bodies.set(name, buffer);
    if (isFrame) frameBytes += buffer.length;
    else bodyBytes += buffer.length;
  }

  if (skippedBodies > 0) {
    note(
      state,
      `${skippedBodies} recorded ${skippedBodies === 1 ? 'file was' : 'files were'} too large to ` +
        'keep, so snapshots that referenced them render without those assets.',
    );
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  const zeroMs = Number.isFinite(earliestWall) ? earliestWall : 0;
  const internals: TraceInternals = {
    snapshotsByFrame,
    snapshotIndex,
    snapshotsByTime: snapshotsByTime.slice().sort((a, b) => a.absMs - b.absMs),
    resources: resources.sort((a, b) => a.absMs - b.absMs),
    frames: frames.sort((a, b) => a.absMs - b.absMs),
    bodies,
    logsByAction,
    logSourceByAction: new Map(),
    zeroMs,
  };

  const actions = buildActions({
    calls,
    testRunnerCallIds,
    libraryByStepId,
    internals,
    network,
    consoleEntries,
    state,
  });

  for (const call of calls.values()) {
    for (const attachment of call.attachments) {
      attachment.bytes = bodies.get(attachment.sha1)?.length ?? 0;
      attachments.push(attachment);
    }
  }

  meta.startedAt = Number.isFinite(earliestWall) ? new Date(earliestWall).toISOString() : null;
  meta.durationMs =
    Number.isFinite(latestWall) && Number.isFinite(earliestWall)
      ? Math.max(0, Math.round(latestWall - earliestWall))
      : 0;
  meta.pageIds = [...pageIds];

  // Times leave this function relative to the trace's own start, so the UI never
  // has to know that Playwright keeps two different clocks.
  for (const entry of network) entry.startMs = Math.max(0, Math.round(entry.startMs - zeroMs));
  for (const entry of consoleEntries) entry.timeMs = Math.round(entry.timeMs - zeroMs);

  return {
    meta,
    actions,
    network,
    console: consoleEntries.sort((a, b) => a.timeMs - b.timeMs),
    attachments,
    limits: { truncated: state.truncated, notes: state.notes },
    internals,
  };
}

/** JSZip has no public size accessor; read the private field defensively. */
function uncompressedSize(file: JSZip.JSZipObject): number | null {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : null;
}

function categoryOf(call: RawCall): ActionCategory {
  switch (call.method) {
    case 'test.step':
      return 'step';
    case 'expect':
      return 'expect';
    case 'pw:api':
      return 'action';
    case 'hook':
      return 'hook';
    case 'fixture':
      return 'fixture';
    case 'test.attach':
      return 'attach';
    default:
      break;
  }
  if (call.className === 'Frame' || call.className === 'Page' || call.className === 'ElementHandle')
    return call.method === 'expect' ? 'expect' : 'action';
  return 'other';
}

/** Params worth putting on screen — a selector or a URL, not the whole launch config. */
const INTERESTING_PARAMS = new Set([
  'selector',
  'url',
  'expression',
  'expected',
  'value',
  'text',
  'key',
  'name',
  'timeout',
  'state',
]);

function buildActions(input: {
  calls: Map<string, RawCall>;
  testRunnerCallIds: Set<string>;
  libraryByStepId: Map<string, RawCall>;
  internals: TraceInternals;
  network: TraceNetworkEntry[];
  consoleEntries: TraceConsoleEntry[];
  state: ParseState;
}): TraceAction[] {
  const { calls, testRunnerCallIds, libraryByStepId, internals, network, consoleEntries } = input;

  // Prefer the test runner's view: it is the one with sentences in it. A trace
  // recorded through `context.tracing.start()` has no test.trace at all, and
  // falls back to the raw protocol calls rather than showing nothing.
  const timelineIds = testRunnerCallIds.size > 0 ? [...testRunnerCallIds] : [...calls.keys()];
  const timeline = timelineIds
    .map((id) => calls.get(id))
    .filter((call): call is RawCall => Boolean(call))
    .sort((a, b) => a.startTime - b.startTime || a.callId.localeCompare(b.callId));

  if (timeline.length > MAX_ACTIONS) {
    note(input.state, `Only the first ${MAX_ACTIONS} actions are shown.`);
    timeline.length = MAX_ACTIONS;
  }

  const byId = new Map(timeline.map((call) => [call.callId, call]));

  const depthOf = (call: RawCall): number => {
    let depth = 0;
    let cursor = call.parentId;
    // Guarded: a malformed trace with a parent cycle must not hang the API.
    while (cursor && depth < 24) {
      const parent = byId.get(cursor);
      if (!parent) break;
      depth++;
      cursor = parent.parentId;
    }
    return depth;
  };

  const isSetupOf = (call: RawCall): boolean => {
    let cursor: RawCall | undefined = call;
    let guard = 0;
    while (cursor && guard++ < 24) {
      if (cursor.method === 'hook' || cursor.method === 'fixture') return true;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return false;
  };

  const actions: TraceAction[] = timeline.map((call) => {
    const library = call.stepId ? libraryByStepId.get(call.stepId) : undefined;
    const companion = library ?? (testRunnerCallIds.has(call.callId) ? undefined : call);
    const endTime = call.endTime ?? companion?.endTime ?? call.startTime;

    const stackFrame = asRecord(call.stack?.[0]) ?? asRecord(companion?.stack?.[0]);
    const file = stackFrame ? str(stackFrame.file) : null;
    const location =
      file && !file.startsWith('project#')
        ? {
            file: tidyPath(file),
            line: num(stackFrame?.line) ?? 0,
            column: num(stackFrame?.column) ?? 0,
          }
        : null;

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(call.params ?? companion?.params ?? {})) {
      if (!INTERESTING_PARAMS.has(key)) continue;
      if (value === null || value === undefined) continue;
      params[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    const resultValue = call.result ?? companion?.result ?? null;
    const result =
      resultValue === null || resultValue === undefined
        ? null
        : typeof resultValue === 'string'
          ? resultValue
          : JSON.stringify(resultValue);

    const before = resolveName(internals, companion?.beforeSnapshot ?? call.beforeSnapshot);
    const action = resolveName(internals, companion?.inputSnapshot ?? call.inputSnapshot);
    const after = resolveName(internals, companion?.afterSnapshot ?? call.afterSnapshot);

    let defaultSnapshot: TraceAction['defaultSnapshot'] = null;
    if (after) defaultSnapshot = { name: after, kind: 'after' };
    else if (action) defaultSnapshot = { name: action, kind: 'action' };
    else if (before) defaultSnapshot = { name: before, kind: 'before' };
    else {
      // The failing `expect` on plain values has no browser call and therefore
      // no snapshot of its own. Showing the nearest DOM before it is the whole
      // point of the pane, so fall back rather than render an empty frame.
      const nearest = nearestSnapshot(internals, endTime);
      if (nearest) defaultSnapshot = { name: nearest.name, kind: 'nearest' };
    }

    const logSource = companion?.callId ?? call.callId;
    internals.logSourceByAction.set(call.callId, logSource);
    const logs = internals.logsByAction.get(logSource) ?? [];
    const startMs = Math.max(0, Math.round(call.startTime - internals.zeroMs));
    const endMs = Math.max(startMs, Math.round(endTime - internals.zeroMs));

    return {
      id: call.callId,
      parentId: call.parentId,
      depth: depthOf(call),
      title: call.title || [call.className, call.method].filter(Boolean).join('.') || call.callId,
      apiName: [call.className, call.method].filter(Boolean).join('.'),
      category: categoryOf(call),
      isSetup: isSetupOf(call),
      startMs,
      endMs,
      durationMs: endMs - startMs,
      error: call.error ?? companion?.error ?? null,
      failing: false,
      location,
      params,
      result,
      pageId: call.pageId ?? companion?.pageId ?? null,
      snapshots: { before, action, after },
      defaultSnapshot,
      point: call.point ?? companion?.point ?? null,
      /*
       * Counted against absolute times. Network and console rows are still on
       * the wall clock at this point — `parseTrace` rebases them to the trace's
       * start only after the timeline is built — so comparing them to the
       * already-relative startMs/endMs would count nothing at all.
       */
      counts: {
        log: logs.length,
        network: network.filter((n) => n.startMs >= call.startTime && n.startMs <= endTime).length,
        console: consoleEntries.filter((c) => c.timeMs >= call.startTime && c.timeMs <= endTime)
          .length,
      },
    };
  });

  // The failing action is the *deepest* one carrying the error: `test.step` and
  // its `expect` child hold the same message, and it is the expect that names
  // the assertion someone needs to read.
  const erroredIds = new Set(actions.filter((a) => a.error).map((a) => a.id));
  for (const candidate of actions) {
    if (!candidate.error) continue;
    const hasErroredChild = actions.some(
      (a) => a.parentId === candidate.id && erroredIds.has(a.id),
    );
    candidate.failing = !hasErroredChild;
  }

  return actions;
}

function resolveName(internals: TraceInternals, name: string | null | undefined): string | null {
  if (!name) return null;
  return internals.snapshotIndex.has(name) ? name : null;
}

function nearestSnapshot(internals: TraceInternals, absMs: number): StoredSnapshot | null {
  let best: StoredSnapshot | null = null;
  for (const snapshot of internals.snapshotsByTime) {
    if (snapshot.absMs > absMs) break;
    // Sub-frames are rendered inside their parent page; only a main frame is a
    // page on its own, and showing a stray iframe body is worse than nothing.
    if (snapshot.isMainFrame || !best) best = snapshot;
  }
  return best ?? internals.snapshotsByTime[0] ?? null;
}

// ─── Slices ──────────────────────────────────────────────────────────────────

export interface ActionDetail {
  logs: TraceLogLine[];
  network: TraceNetworkEntry[];
  console: TraceConsoleEntry[];
  screenshot: { sha1: string; width: number; height: number } | null;
}

/** Everything that happened during one action, and nothing that did not. */
export function actionDetail(trace: ParsedTrace, action: TraceAction): ActionDetail {
  const { internals } = trace;
  const logSource = internals.logSourceByAction.get(action.id) ?? action.id;
  const logs = (internals.logsByAction.get(logSource) ?? []).map((log) => ({
    timeMs: Math.round(log.timeMs - internals.zeroMs),
    message: log.message,
  }));

  const anchorMs =
    snapshotByName(trace, action.defaultSnapshot?.name ?? null)?.absMs ??
    action.endMs + internals.zeroMs;

  let screenshot: ActionDetail['screenshot'] = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const frame of internals.frames) {
    if (action.pageId && frame.pageId && frame.pageId !== action.pageId) continue;
    if (!internals.bodies.has(frame.sha1)) continue;
    const delta = Math.abs(frame.absMs - anchorMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      screenshot = { sha1: frame.sha1, width: frame.width, height: frame.height };
    }
  }

  return {
    logs,
    network: trace.network.filter((n) => n.startMs >= action.startMs && n.startMs <= action.endMs),
    console: trace.console.filter((c) => c.timeMs >= action.startMs && c.timeMs <= action.endMs),
    screenshot,
  };
}

export function snapshotByName(trace: ParsedTrace, name: string | null): StoredSnapshot | null {
  if (!name) return null;
  const located = trace.internals.snapshotIndex.get(name);
  if (!located) return null;
  return trace.internals.snapshotsByFrame.get(located.frameId)?.[located.index] ?? null;
}

export function resourceBody(trace: ParsedTrace, sha1: string): Buffer | null {
  return trace.internals.bodies.get(sha1) ?? null;
}

// ─── Snapshot rendering ──────────────────────────────────────────────────────

/**
 * Rebuild one DOM snapshot into standalone HTML.
 *
 * The output is the customer's own markup, so it is treated as hostile
 * throughout: `<script>` elements are dropped, `on*` handlers are dropped, and
 * an injected CSP forbids the document from reaching the network at all. The
 * client renders it in an iframe sandboxed to `allow-same-origin` only, so even
 * if something slipped past, nothing in it can execute.
 *
 * Assets are inlined as `data:` URIs from the trace's own resource pool rather
 * than fetched, which is what makes the CSP possible: a rebuilt page that has
 * to phone the app under test is a page that shows the app as it is now, not as
 * it was when the test failed.
 */
export function renderSnapshot(trace: ParsedTrace, name: string): RenderedSnapshot | null {
  const located = trace.internals.snapshotIndex.get(name);
  if (!located) return null;
  const frameSnapshots = trace.internals.snapshotsByFrame.get(located.frameId);
  const snapshot = frameSnapshots?.[located.index];
  if (!frameSnapshots || !snapshot) return null;

  const parts: string[] = [];
  const notes: string[] = [];
  let size = 0;
  let truncated = false;
  let inlinedBytes = 0;
  let headInjected = false;
  let missingAssets = 0;
  let scrolls = 0;

  const push = (chunk: string): void => {
    if (truncated) return;
    size += chunk.length;
    if (size > MAX_RENDERED_HTML_BYTES) {
      truncated = true;
      return;
    }
    parts.push(chunk);
  };

  const base = snapshot.frameUrl && /^https?:/i.test(snapshot.frameUrl) ? snapshot.frameUrl : null;
  const absolute = (url: string): string | null => {
    try {
      return base ? new URL(url, base).toString() : new URL(url).toString();
    } catch {
      return null;
    }
  };

  const bodyForUrl = (url: string): { buffer: Buffer; mimeType: string } | null => {
    const resolved = absolute(url);
    if (!resolved) return null;
    const withoutHash = resolved.split('#')[0] ?? resolved;
    let match: StoredResource | undefined;
    let sameFrame: StoredResource | undefined;
    for (const resource of trace.internals.resources) {
      if (resource.absMs > snapshot.absMs) break;
      if (resource.status === 304) continue;
      if (resource.method !== 'GET') continue;
      if ((resource.url.split('#')[0] ?? resource.url) !== withoutHash) continue;
      if (resource.frameId && resource.frameId === snapshot.frameId) sameFrame = resource;
      else match = resource;
    }
    // A stylesheet Playwright rewrote mid-test overrides the recorded response.
    const override = snapshot.resourceOverrides.find((entry) => entry.url === withoutHash);
    const sha1 = override?.sha1 ?? sameFrame?.sha1 ?? match?.sha1;
    if (!sha1) return null;
    const buffer = trace.internals.bodies.get(sha1);
    if (!buffer) return null;
    return { buffer, mimeType: (sameFrame ?? match)?.mimeType || 'application/octet-stream' };
  };

  const dataUri = (url: string): string | null => {
    const found = bodyForUrl(url);
    if (!found) return null;
    if (inlinedBytes + found.buffer.length > MAX_INLINE_BYTES) return null;
    inlinedBytes += found.buffer.length;
    const mime = found.mimeType.split(';')[0] || 'application/octet-stream';
    return `data:${mime};base64,${found.buffer.toString('base64')}`;
  };

  const visit = (
    node: unknown,
    snapshotIndex: number,
    parentTag: string | undefined,
    parentAttrs: Array<[string, string]> | undefined,
  ): void => {
    if (truncated) return;

    if (typeof node === 'string') {
      // Stylesheet text is CSS, not markup: escaping `<` inside it is harmless,
      // escaping `&` would corrupt selectors, so it takes the same light path.
      push(escapeText(node));
      return;
    }

    if (isReference(node)) {
      const reference = node[0];
      const targetIndex = snapshotIndex - reference[0];
      if (targetIndex >= 0 && targetIndex <= snapshotIndex) {
        const target = frameSnapshots[targetIndex];
        if (target) {
          const nodes = snapshotNodes(target);
          const nodeIndex = reference[1];
          if (nodeIndex >= 0 && nodeIndex < nodes.length) {
            visit(nodes[nodeIndex], targetIndex, parentTag, parentAttrs);
          }
        }
      }
      return;
    }

    if (!isElement(node)) return;

    const rawName = node[0] as string;
    const upper = rawName.toUpperCase();
    // Never emit script — not even inert. The iframe has no allow-scripts and a
    // CSP of its own, but the cheapest guarantee is the one you can read.
    if (upper === 'SCRIPT' || upper === 'NOEMBED') return;

    const attrs = Object.entries(asRecord(node[1]) ?? {}).map(
      ([key, value]) =>
        [key, typeof value === 'string' ? value : String(value)] as [string, string],
    );
    const children = node.slice(2);
    const tag = upper === 'NOSCRIPT' ? 'X-NOSCRIPT' : rawName;

    // A stylesheet whose bytes we have becomes an inline <style>, because a
    // <link> would need the network the CSP is about to forbid.
    if (upper === 'LINK') {
      const rel = (attrs.find(([k]) => k.toLowerCase() === 'rel')?.[1] ?? '').toLowerCase();
      const href = attrs.find(([k]) => k.toLowerCase() === 'href')?.[1];
      if (rel.includes('stylesheet') && href) {
        const found = bodyForUrl(href);
        if (found) {
          push('<style>');
          push(escapeText(found.buffer.toString('utf8')));
          push('</style>');
        } else {
          missingAssets++;
        }
        return;
      }
      if (!rel.includes('stylesheet')) return; // icons, preloads, prefetches: inert noise.
    }

    const currentSrcKey = '__playwright_current_src__';
    const isImg = upper === 'IMG';
    const isMeta = upper === 'META';
    // The markup's `value` is what the page was served with; Playwright's
    // out-of-band one is what the field held when the snapshot was taken. Emit
    // one attribute, not both, or the browser keeps whichever came first.
    const hasLiveValue = attrs.some(([key]) => key === '__playwright_value_');
    const unsafeHttpEquiv =
      isMeta &&
      attrs.some(
        ([k, v]) =>
          k.toLowerCase() === 'http-equiv' && !SAFE_HTTP_EQUIV.has(v.trim().toLowerCase()),
      );

    push('<');
    push(tag);

    let valueAttr: string | null = null;

    for (const [attr, value] of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('on')) continue; // inline handlers, dropped outright
      if (lower === 'value' && hasLiveValue) continue;

      // Playwright records live form state out-of-band because it is not in the
      // markup. Applying it here is what makes a rebuilt form show what the user
      // actually typed — Playwright's own viewer needs JavaScript to do this.
      if (attr === '__playwright_value_') {
        valueAttr = value;
        continue;
      }
      if (attr === '__playwright_checked_') {
        push(value === 'true' || value === '' ? ' checked=""' : '');
        continue;
      }
      if (attr === '__playwright_selected_') {
        push(value === 'true' || value === '' ? ' selected=""' : '');
        continue;
      }
      if (attr === '__playwright_scroll_top_' || attr === '__playwright_scroll_left_') {
        // Kept as data-* so the client can re-apply them through the iframe's
        // document; there is no markup-only way to express a scroll offset.
        scrolls++;
        push(` data-${attr.replace(/_/g, '-').replace(/^-+|-+$/g, '')}="`);
        push(escapeAttribute(value));
        push('"');
        continue;
      }
      if (attr === '__playwright_target__') continue;

      if (isImg && attr === currentSrcKey) {
        const uri = dataUri(value);
        if (uri) {
          push(' src="');
          push(escapeAttribute(uri));
          push('"');
        } else {
          missingAssets++;
        }
        continue;
      }

      if (lower === 'src' || lower === 'srcset' || lower === 'data' || lower === 'srcdoc') {
        // Frames, objects and embeds are never rebuilt: their content is a
        // separate snapshot we cannot compose without scripting.
        if (upper === 'IFRAME' || upper === 'FRAME' || upper === 'OBJECT' || upper === 'EMBED') {
          push(' data-pw-');
          push(lower);
          push('="');
          push(escapeAttribute(value.slice(0, 512)));
          push('"');
          continue;
        }
        if (lower === 'srcset') continue; // we can only inline one body, not a set
        const uri = value.startsWith('data:') ? value : dataUri(value);
        if (uri) {
          push(' src="');
          push(escapeAttribute(uri));
          push('"');
        } else {
          missingAssets++;
        }
        continue;
      }

      if (lower === 'href' && upper === 'A') {
        // An unknown scheme makes the link inert without hiding where it pointed.
        push(' href="link://');
        push(escapeAttribute(value));
        push('"');
        continue;
      }

      if (lower === 'href') continue;

      if (unsafeHttpEquiv && (lower === 'http-equiv' || lower === 'content')) {
        push(' data-pw-');
        push(lower);
        push('="');
        push(escapeAttribute(value));
        push('"');
        continue;
      }

      push(' ');
      push(attr);
      push('="');
      push(escapeAttribute(value));
      push('"');
    }

    // A <select>'s value is not an attribute — its selected <option> is, and
    // Playwright records that separately as __playwright_selected_.
    if (valueAttr !== null && upper === 'INPUT') {
      push(' value="');
      push(escapeAttribute(valueAttr));
      push('"');
    }

    push('>');

    if (upper === 'HEAD' && !headInjected) {
      headInjected = true;
      push(SNAPSHOT_HEAD);
    }

    if (valueAttr !== null && upper === 'TEXTAREA') {
      push(escapeText(valueAttr));
    } else {
      for (const child of children) visit(child, snapshotIndex, tag, attrs);
    }

    if (!VOID_ELEMENTS.has(upper)) {
      push('</');
      push(tag);
      push('>');
    }
  };

  visit(snapshot.html, located.index, undefined, undefined);

  const doctype = snapshot.doctype?.replace(/[^a-zA-Z0-9]/g, '');
  // If the snapshot had no <head> the CSP has nowhere to live inside the tree;
  // a stray <meta> ahead of <html> is hoisted into head by every parser.
  const prefix = (doctype ? `<!DOCTYPE ${doctype}>` : '') + (headInjected ? '' : SNAPSHOT_HEAD);

  if (missingAssets > 0) {
    notes.push(
      `${missingAssets} ${missingAssets === 1 ? 'asset was' : 'assets were'} not in the trace, ` +
        'so this snapshot renders without them. Playwright records response bodies, not every ' +
        'byte the page fetched.',
    );
  }
  if (scrolls > 0)
    notes.push('Scroll positions are re-applied by the viewer after the frame loads.');
  if (truncated) {
    notes.push('This DOM snapshot is larger than the viewer will render, so it is cut short.');
  }

  return {
    html: prefix + parts.join(''),
    viewport: snapshot.viewport,
    frameUrl: snapshot.frameUrl,
    timeMs: Math.round(snapshot.absMs - trace.internals.zeroMs),
    notes,
    truncated,
  };
}

/**
 * Injected as the first thing in the rebuilt document's <head>.
 *
 * `default-src 'none'` is the load-bearing line: the rebuilt page is the
 * customer's markup, and without it a snapshot could fetch from — or leak a
 * referrer to — the application under test straight from the reviewer's browser.
 * Only `data:` survives, which is exactly what the inliner above produces.
 */
const SNAPSHOT_HEAD =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; " +
  'img-src data:; ' +
  'media-src data:; ' +
  "style-src 'unsafe-inline' data:; " +
  'font-src data:; ' +
  "script-src 'none'; " +
  "frame-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'" +
  '">' +
  '<meta name="referrer" content="no-referrer">';

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * Parsing is expensive and scrubbing a timeline is a burst of requests against
 * the same trace, so a handful stay parsed. Deliberately tiny: each entry can
 * hold tens of megabytes of rebuilt DOM, and the API is not a trace server.
 */
const CACHE_MAX_ENTRIES = 2;
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  trace: Promise<ParsedTrace>;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

export function cachedTrace(key: string, load: () => Promise<Buffer>): Promise<ParsedTrace> {
  const existing = cache.get(key);
  if (existing && Date.now() - existing.storedAt < CACHE_TTL_MS) {
    // Refresh recency so an in-use trace is not the one evicted.
    cache.delete(key);
    cache.set(key, existing);
    return existing.trace;
  }

  const promise = load().then((bytes) => parseTrace(bytes));
  // A failed parse must not be remembered as the answer for the next five
  // minutes; a retry after a transient storage blip should actually retry.
  promise.catch(() => cache.delete(key));

  cache.delete(key);
  cache.set(key, { trace: promise, storedAt: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return promise;
}
