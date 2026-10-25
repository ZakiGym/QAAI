/**
 * Desktop-shell apps under test — Electron, Tauri, a bare WebView (§4 DESKTOP).
 *
 * A customer whose product ships as a desktop shell could not be covered at
 * all. Not partially: at all. Every plugin in this directory either drives a
 * browser at a `baseUrl` or shells out to a CLI, and a shell has no base URL —
 * its renderer is reached by attaching to a process this worker started. So the
 * whole class of customer scored zero and the product had no sentence to say
 * about why.
 *
 * ── What is distinctive here, and why it is most of this file ───────────────
 *
 * The renderer window is the EASY part: once attached it is a DOM, and a DOM is
 * what the rest of this directory already knows how to assert on. The surface
 * that makes a desktop app a desktop app is the part that is not a DOM at all:
 *
 *   · more than one window, and a second window that no DOM query can see from
 *     the first — a preferences window, an about box, a detached devtools;
 *   · the native menu bar, where a third of a desktop app's commands live;
 *   · tray and dock actions, which are the whole UI of some apps;
 *   · the main-process IPC boundary, which is the app's actual back end and
 *     the only privileged code in it;
 *   · auto-update, which is the single highest-consequence path in a desktop
 *     product and the one nobody can test by hand;
 *   · deep links, which arrive from the OS and not from a page;
 *   · native file dialogs, which are OS windows and not the app's at all.
 *
 * ── UNEXERCISABLE, and why omission would be the defect ─────────────────────
 *
 * Several of those cannot be reached from here, and the reasons are honest
 * ones: a native file dialog is drawn by the OS, and a code-signed updater
 * refuses an unsigned build on purpose. The temptation is to leave them out of
 * the result. That is exactly the lie this product cannot afford — a surface
 * left out of the denominator makes the percentage go UP, so quietly omitting
 * the seven hardest things in a desktop app would score such an app higher
 * than a web app where everything is reachable.
 *
 * So every capability this plugin knows about is reported. One that cannot be
 * driven here comes back UNEXERCISABLE with the reason and the remedy, as a
 * SKIPPED step, and a SKIPPED step is not a pass. {@link DESKTOP_CAPABILITIES}
 * is the closed list, and `capabilityPresence` below is the compiler-enforced
 * record that stops it drifting from the schema that has to accept it.
 *
 * ── Injected surfaces (rule 8) ──────────────────────────────────────────────
 *
 * There is no Electron on this worker and no shell to launch in a test, so
 * {@link DesktopLauncher} is the seam: the plugin's logic runs against a fake
 * in tests, and the one real adapter is thin enough to read in a sitting. A
 * launcher that cannot provide a capability says so by returning null from the
 * matching accessor, which is what produces an UNEXERCISABLE rather than a
 * thrown error — "we could not reach it" and "it is broken" are opposite facts.
 */

import { z } from 'zod';
import type {
  ConsoleEntry,
  ExecutableTest,
  RunContext,
  StepResult,
  TestExecution,
} from '@qaai/shared';

// ─── The capability axis ─────────────────────────────────────────────────────

/**
 * Everything a desktop shell can be asked to do, as a closed list.
 *
 * Closed on purpose. An open-ended `string` here would let a spec name a
 * capability no adapter has ever heard of, and the result would be a step that
 * passed because nothing checked it — this directory's recurring defect in a
 * new costume. A spec naming something outside this list is a validation error
 * with the list printed, which is a sentence the author can act on.
 */
export const DESKTOP_CAPABILITIES = [
  /** Reach the renderer window(s) and assert on their DOM. */
  'RENDERER_WINDOW',
  /** A second (third, fourth) window, which no query from the first can see. */
  'MULTI_WINDOW',
  /** The native application menu: File → New, and the other two-thirds of the UI. */
  'MENU_BAR',
  /** System-tray / menu-bar-extra items and their click targets. */
  'TRAY',
  /** Dock (macOS) or taskbar (Windows) context actions and badge state. */
  'DOCK',
  /** The main-process IPC boundary — the app's privileged back end. */
  'MAIN_PROCESS_IPC',
  /** The auto-updater's check/download/apply path. */
  'AUTO_UPDATE',
  /** An OS-delivered deep link (myapp://…) and what the app does with it. */
  'DEEP_LINK',
  /** A native open/save dialog, drawn by the OS rather than by the app. */
  'FILE_DIALOG',
] as const;
export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

/**
 * The compiler-enforced presence record this codebase requires beside any
 * vocabulary with a write path.
 *
 * Eight GateRule kinds shipped unsaveable for two slices because only the zod
 * half existed: the schema accepted a kind, the UI offered it, and nothing
 * could honour it. `check:wiring` cannot see that class of defect, so the
 * guard is this — a `Record<DesktopCapability, true>` the compiler refuses to
 * let drift, plus the run-time parity test in desktop.test.ts that asserts
 * this record, the exported list and the zod enum's options are the same set.
 * One of the two alone has been proven insufficient twice.
 */
export const DESKTOP_CAPABILITY_PRESENCE: Record<DesktopCapability, true> = {
  RENDERER_WINDOW: true,
  MULTI_WINDOW: true,
  MENU_BAR: true,
  TRAY: true,
  DOCK: true,
  MAIN_PROCESS_IPC: true,
  AUTO_UPDATE: true,
  DEEP_LINK: true,
  FILE_DIALOG: true,
};

/** Human labels, for the cockpit's per-capability rows. */
export const DESKTOP_CAPABILITY_LABELS: Record<DesktopCapability, string> = {
  RENDERER_WINDOW: 'Renderer window',
  MULTI_WINDOW: 'Multiple windows',
  MENU_BAR: 'Native menu bar',
  TRAY: 'Tray / menu-bar extra',
  DOCK: 'Dock / taskbar actions',
  MAIN_PROCESS_IPC: 'Main-process IPC',
  AUTO_UPDATE: 'Auto-update',
  DEEP_LINK: 'Deep links',
  FILE_DIALOG: 'Native file dialogs',
};

/**
 * The shells QAAI can attach to. Each reaches its renderer differently —
 * Electron over the Chrome DevTools Protocol, Tauri over its own IPC and a
 * WebView inspector — which is a difference of transport, not of shape, so
 * they share one plugin the way the five mobile drivers do.
 */
export const DESKTOP_SHELLS = ['ELECTRON', 'TAURI', 'WEBVIEW'] as const;
export type DesktopShell = (typeof DESKTOP_SHELLS)[number];

export const DESKTOP_SHELL_PRESENCE: Record<DesktopShell, true> = {
  ELECTRON: true,
  TAURI: true,
  WEBVIEW: true,
};

// ─── The spec ────────────────────────────────────────────────────────────────

/**
 * One assertion against the shell.
 *
 * Deliberately narrow. A desktop step either reads something out of a renderer
 * window, invokes a native affordance, or crosses the IPC boundary — and each
 * of those names the capability it needs, so a step whose capability is
 * UNEXERCISABLE here is reported as such instead of being silently dropped.
 */
export const desktopStepSchema = z.object({
  /** What this step is for, printed in the cockpit. */
  title: z.string().min(1).max(200),
  capability: z.enum(DESKTOP_CAPABILITIES),
  /** Which window, by title substring. Absent means the main window. */
  window: z.string().min(1).max(200).optional(),
  /** A DOM selector, for the renderer capabilities. */
  selector: z.string().min(1).max(500).optional(),
  /** Menu path (['File', 'New Window']), tray item name, or deep-link URL. */
  path: z.array(z.string().min(1).max(100)).max(10).optional(),
  /** IPC channel name, for MAIN_PROCESS_IPC. */
  channel: z.string().min(1).max(200).optional(),
  /** JSON-serialisable IPC argument. */
  payload: z.unknown().optional(),
  /** The assertion: the text the step expects to find afterwards. */
  expectText: z.string().min(1).max(1000).optional(),
  /** The assertion: how many windows the step expects to exist afterwards. */
  expectWindowCount: z.number().int().min(0).max(50).optional(),
});
export type DesktopStep = z.infer<typeof desktopStepSchema>;

export const desktopTestSpecSchema = z.object({
  shell: z.enum(DESKTOP_SHELLS),
  /**
   * How to start the app. A path inside the run's checkout, or an already
   * running instance's debug port.
   *
   * One of the two is required and the schema enforces it below: a spec with
   * neither would launch nothing and then assert against nothing, which is the
   * shape that produces a green result with no evidence in it.
   */
  launch: z
    .object({
      /** Executable or project path, relative to the repository root. */
      command: z.string().min(1).max(500).optional(),
      args: z.array(z.string().max(500)).max(50).default([]),
      /** Attach to an already-running shell on this CDP/inspector port. */
      attachPort: z.number().int().min(1).max(65535).optional(),
      /** How long to wait for the first renderer window. */
      readyTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    })
    .refine((v) => v.command !== undefined || v.attachPort !== undefined, {
      message: 'set `command` to launch the shell, or `attachPort` to attach to a running one',
    }),
  /**
   * The most windows this test will enumerate.
   *
   * A cap that BIT must be reported as a count AND a reason (rule 10), which
   * `windowBudgetNote` below does — otherwise a 40-window app looks like a
   * 5-window app and the four surfaces past the cap were never counted as
   * uncovered.
   */
  maxWindows: z.number().int().min(1).max(50).default(10),
  steps: z.array(desktopStepSchema).min(1).max(100),
});
export type DesktopTestSpec = z.infer<typeof desktopTestSpecSchema>;

// ─── The injected shell surface ──────────────────────────────────────────────

/** One renderer window, as this plugin needs it. */
export interface DesktopWindowSurface {
  /** Stable within a session; used to tell two same-titled windows apart. */
  readonly id: string;
  readonly title: string;
  /** Visible text of the first match, or null when the selector matches nothing. */
  text(selector: string): Promise<string | null>;
  click(selector: string): Promise<void>;
}

/** The native menu bar, when the shell exposes one. */
export interface DesktopMenuSurface {
  /** Every menu item path the app declares — the enumerable native surface. */
  items(): Promise<string[][]>;
  invoke(path: readonly string[]): Promise<void>;
}

/** Tray or dock items, when the shell exposes them. */
export interface DesktopTraySurface {
  items(): Promise<string[]>;
  invoke(item: string): Promise<void>;
}

/** The main-process IPC boundary, when a preload bridge exposes it. */
export interface DesktopIpcSurface {
  /** Channels the main process listens on — the enumerable privileged surface. */
  channels(): Promise<string[]>;
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

/** The auto-updater, when the build is signed and a feed is configured. */
export interface DesktopUpdateSurface {
  check(): Promise<{ available: boolean; version: string | null }>;
}

/** OS-delivered deep links, when the shell registered a scheme. */
export interface DesktopDeepLinkSurface {
  open(url: string): Promise<void>;
}

/**
 * An attached shell.
 *
 * Every capability accessor beyond `windows()` returns `null` when the shell
 * cannot provide it, and that is the whole design: a null is an UNEXERCISABLE
 * with a reason attached, not an error and not an empty pass. `windows()` is
 * not optional because a shell with no renderer is not a shell we attached to.
 */
export interface DesktopShellSession {
  windows(): Promise<DesktopWindowSurface[]>;
  menu(): DesktopMenuSurface | null;
  tray(): DesktopTraySurface | null;
  dock(): DesktopTraySurface | null;
  ipc(): DesktopIpcSurface | null;
  updater(): DesktopUpdateSurface | null;
  deepLinks(): DesktopDeepLinkSurface | null;
  /**
   * Why a capability is absent, in the shell's own words.
   *
   * The session knows things this plugin cannot: that the build is unsigned, or
   * that no preload bridge was configured. A generic "not available" would send
   * the customer looking in the wrong place, so the adapter supplies the
   * sentence and this plugin prints it.
   */
  unavailableReason(capability: DesktopCapability): string | null;
  close(): Promise<void>;
}

export interface DesktopLaunchRequest {
  shell: DesktopShell;
  command: string | null;
  args: readonly string[];
  attachPort: number | null;
  readyTimeoutMs: number;
  /** The run's checkout root; `command` resolves against it. */
  workspaceRoot: string | null;
  /** Secrets the shell needs in its environment. Never logged. */
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

/**
 * How a shell gets started or attached to.
 *
 * `launch` rejects only when the attempt itself failed — a missing executable,
 * a refused debug port. It must NOT reject to signal "this worker has no
 * Electron": that is {@link DesktopLauncher.available}, and the difference is
 * the difference between the customer's app being broken and this worker being
 * the wrong machine for the job.
 */
export interface DesktopLauncher {
  /**
   * Can this worker drive this shell at all? A reason when not.
   *
   * Separate from `launch` because an absent toolchain is an environment gap
   * that must be reported BLOCKED_BY_ENV with nothing marked failed, and a
   * launcher that signalled it by throwing would be indistinguishable from the
   * app crashing on start.
   */
  available(shell: DesktopShell): { ok: true } | { ok: false; reason: string };
  launch(request: DesktopLaunchRequest): Promise<DesktopShellSession>;
}

// ─── Capability reachability ─────────────────────────────────────────────────

/** A capability the test asked for and this session cannot drive. */
export interface Unexercisable {
  capability: DesktopCapability;
  /** Printable verbatim: what is missing and what to do about it. */
  reason: string;
}

/**
 * Default sentences for the capabilities an adapter most often cannot reach.
 *
 * Used only when the session declines to supply its own
 * ({@link DesktopShellSession.unavailableReason}). Each one names the remedy
 * where a remedy exists and says plainly that there is none where there is not
 * — a reason with no action in it is an UNEXERCISABLE the reader can only
 * shrug at, which is barely better than the omission this replaces.
 */
export const DEFAULT_UNEXERCISABLE_REASONS: Record<DesktopCapability, string> = {
  RENDERER_WINDOW: 'No renderer window was reachable on this session.',
  MULTI_WINDOW: 'This session exposed only one window, so a second could not be enumerated.',
  MENU_BAR:
    'This shell exposes no application menu to the automation bridge. Electron apps need the ' +
    'test build to expose Menu.getApplicationMenu() over the preload bridge; Tauri needs the ' +
    'menu plugin enabled.',
  TRAY: 'No tray item was exposed to the automation bridge.',
  DOCK: 'Dock and taskbar actions are drawn by the OS shell and are not reachable from here.',
  MAIN_PROCESS_IPC:
    'No preload bridge exposed the main-process IPC channels. Expose them in the test build ' +
    'only — a bridge in your shipped build would be a privilege-escalation path.',
  AUTO_UPDATE:
    'The auto-updater refuses to run against an unsigned or locally built binary, by design. ' +
    'This path can only be exercised against a signed build pointed at a staging feed.',
  DEEP_LINK:
    'No URL scheme is registered for this build on this worker, so the OS has nothing to ' +
    'deliver a deep link through.',
  FILE_DIALOG:
    'A native open/save dialog is an OS window, not part of your app, and no automation ' +
    'surface here can drive it. Route the test at the handler your dialog calls instead.',
};

/**
 * Which of the capabilities this spec needs the session can actually drive.
 *
 * Exported and tested directly because it is the honesty-critical half of this
 * plugin and it is pure: given a session's accessors it decides what gets
 * asserted and what gets reported unreachable, with no shell and no clock in
 * the way.
 */
export function capabilityReach(
  session: DesktopShellSession,
  capability: DesktopCapability,
): { ok: true } | { ok: false; reason: string } {
  const present = (surface: unknown): boolean => surface !== null && surface !== undefined;

  const available = ((): boolean => {
    switch (capability) {
      // Both of these are properties of the windows themselves, checked when
      // the step runs rather than here: a session always has a `windows()`.
      case 'RENDERER_WINDOW':
      case 'MULTI_WINDOW':
        return true;
      case 'MENU_BAR':
        return present(session.menu());
      case 'TRAY':
        return present(session.tray());
      case 'DOCK':
        return present(session.dock());
      case 'MAIN_PROCESS_IPC':
        return present(session.ipc());
      case 'AUTO_UPDATE':
        return present(session.updater());
      case 'DEEP_LINK':
        return present(session.deepLinks());
      // A native dialog is never reachable from this plugin. It is in the list
      // precisely so that it is REPORTED rather than forgotten — the surface
      // exists in the customer's app whether or not we can touch it.
      case 'FILE_DIALOG':
        return false;
    }
  })();

  if (available) return { ok: true };
  return {
    ok: false,
    reason: session.unavailableReason(capability) ?? DEFAULT_UNEXERCISABLE_REASONS[capability],
  };
}

// ─── Step recording ──────────────────────────────────────────────────────────

/**
 * Steps, in the shape the cockpit streams them.
 *
 * A near-copy of the recorders in mobile.ts and protocol.ts rather than a
 * shared one, matching what this directory already does: each plugin's
 * recorder has grown its own needs (this one counts unexercisables) and the
 * two existing copies have not drifted in a way that hurt.
 */
class StepRecorder {
  readonly steps: StepResult[] = [];
  readonly unexercisable: Unexercisable[] = [];
  private failed = false;

  constructor(
    private readonly ctx: RunContext,
    private readonly testId: string,
  ) {}

  get broken(): boolean {
    return this.failed;
  }

  record(title: string, startedAtMs: number, problems: string[]): void {
    const bad = problems.length > 0;
    if (bad) this.failed = true;
    const index = this.steps.length;
    this.ctx.logger.step({
      testId: this.testId,
      index,
      title,
      status: bad ? 'FAILED' : 'PASSED',
    });
    this.steps.push({
      index,
      title,
      status: bad ? 'FAILED' : 'PASSED',
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      screenshotKey: null,
      error: bad
        ? { message: problems.join('; '), stack: null, selector: null, expected: null, actual: null }
        : null,
    });
  }

  /**
   * A capability this session could not drive.
   *
   * SKIPPED and not FAILED: the customer's app is not broken because our
   * worker cannot open an OS file dialog. The reason rides in the title
   * because `error` on a StepResult means "this failed", and this did not.
   *
   * It is also not silently dropped, which is the entire point — a step
   * missing from the list would make this test look wholly green.
   */
  unreachable(title: string, capability: DesktopCapability, reason: string): void {
    this.unexercisable.push({ capability, reason });
    const index = this.steps.length;
    const text = `${title} — UNEXERCISABLE (${DESKTOP_CAPABILITY_LABELS[capability]}): ${reason}`;
    this.ctx.logger.step({ testId: this.testId, index, title: text, status: 'SKIPPED' });
    this.steps.push({
      index,
      title: text,
      status: 'SKIPPED',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error: null,
    });
  }

  skip(title: string, reason: string): void {
    const index = this.steps.length;
    const text = `${title} — ${reason}`;
    this.ctx.logger.step({ testId: this.testId, index, title: text, status: 'SKIPPED' });
    this.steps.push({
      index,
      title: text,
      status: 'SKIPPED',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      screenshotKey: null,
      error: null,
    });
  }
}

// ─── Window selection and the cap that bit ───────────────────────────────────

/**
 * The disclosure sentence for a window budget that BIT, or null when it did not.
 *
 * Exported and tested on its own because this is the exact lie rule 10 names:
 * a cap applied without being disclosed. An app with 40 windows enumerated at
 * `maxWindows: 10` must say that 30 more existed, or the 30 were never counted
 * as uncovered and the percentage went up for free.
 */
export function windowBudgetNote(seen: number, cap: number): string | null {
  if (seen <= cap) return null;
  return (
    `Enumerated ${cap} of ${seen} windows — the maxWindows budget bit, so at least ` +
    `${seen - cap} more window(s) exist and were NOT examined. Raise maxWindows to cover them.`
  );
}

/**
 * The window a step names, or null when no window matches.
 *
 * Null is distinct from "the main window": a step naming a window that is not
 * open is a failing assertion about the app, and defaulting to the main window
 * would turn it into a passing assertion about a different window.
 */
export function pickWindow(
  windows: readonly DesktopWindowSurface[],
  titleSubstring: string | undefined,
): DesktopWindowSurface | null {
  if (titleSubstring === undefined) return windows[0] ?? null;
  const needle = titleSubstring.toLowerCase();
  return windows.find((w) => w.title.toLowerCase().includes(needle)) ?? null;
}

// ─── Execution ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
}

/** The fields every return path shares. */
function baseExecution(testId: string, consoleEntries: ConsoleEntry[]) {
  return {
    testId,
    network: [],
    console: consoleEntries,
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  } satisfies Omit<TestExecution, 'status' | 'steps' | 'errorMessage' | 'durationMs'>;
}

/**
 * The windows as they are RIGHT NOW, and the two different questions asked of
 * them.
 *
 * `maxWindows` bounds how many windows this test EXAMINES, because examining
 * one costs a DOM round trip per selector. It does not bound how many EXIST:
 * `session.windows()` already returned the whole list, and counting its length
 * is free. Conflating the two made `expectWindowCount` compare the customer's
 * app against our own budget — a 5-window app at `maxWindows: 2` reported
 * "expected 5 window(s), found 2" and blamed the application for a cap.
 */
interface WindowView {
  /** The first `cap` windows: the ones a selector may be run against. */
  examinable: readonly DesktopWindowSurface[];
  /** Every window the shell reported. Its LENGTH is the honest count. */
  all: readonly DesktopWindowSurface[];
  cap: number;
}

async function runStep(
  session: DesktopShellSession,
  step: DesktopStep,
  view: WindowView,
): Promise<string[]> {
  const problems: string[] = [];
  const windows = view.examinable;

  switch (step.capability) {
    case 'RENDERER_WINDOW':
    case 'MULTI_WINDOW': {
      // Against `all`, not `examinable`. See WindowView.
      if (step.expectWindowCount !== undefined && view.all.length !== step.expectWindowCount) {
        problems.push(
          `expected ${step.expectWindowCount} window(s), found ${view.all.length} ` +
            `(${view.all.map((w) => `"${w.title}"`).join(', ') || 'none'})`,
        );
      }
      const target = pickWindow(windows, step.window);
      if (!target) {
        /*
         * A window that exists but sits PAST the cap is a third fact, and
         * reporting it as "no window matched" would be a false assertion about
         * the application caused by our own budget. Named separately with the
         * cap in it, so the remedy is raising maxWindows rather than hunting a
         * window that is open.
         */
        const beyondCap =
          step.window !== undefined &&
          pickWindow(view.all, step.window) !== null;
        problems.push(
          beyondCap
            ? `a window whose title contains "${step.window}" is open, but it is past the ` +
                `maxWindows budget of ${view.cap} (${view.all.length} window(s) are open) and ` +
                'was NOT examined — raise maxWindows to reach it'
            : step.window === undefined
              ? 'the shell exposed no renderer window'
              : `no open window's title contains "${step.window}"`,
        );
        break;
      }
      if (step.selector !== undefined) {
        const text = await target.text(step.selector);
        if (text === null) {
          problems.push(`"${step.selector}" matched nothing in window "${target.title}"`);
        } else if (step.expectText !== undefined && !text.includes(step.expectText)) {
          problems.push(
            `"${step.selector}" in "${target.title}" reads "${text.slice(0, 200)}", ` +
              `which does not contain "${step.expectText}"`,
          );
        }
      }
      break;
    }

    case 'MENU_BAR': {
      // Non-null by construction: capabilityReach() gated this step.
      const menu = session.menu()!;
      if (!step.path || step.path.length === 0) {
        // Enumeration only — the menu is the countable native surface.
        const items = await menu.items();
        if (items.length === 0) problems.push('the application menu declared no items');
        break;
      }
      const items = await menu.items();
      const wanted = step.path.join(' → ');
      const exists = items.some((item) => item.join(' → ') === wanted);
      if (!exists) {
        problems.push(
          `the application menu has no "${wanted}" item (it declares ${items.length}: ` +
            `${items
              .slice(0, 8)
              .map((i) => `"${i.join(' → ')}"`)
              .join(', ')})`,
        );
        break;
      }
      await menu.invoke(step.path);
      break;
    }

    case 'TRAY':
    case 'DOCK': {
      const surface = step.capability === 'TRAY' ? session.tray()! : session.dock()!;
      const items = await surface.items();
      const wanted = step.path?.[0];
      if (wanted === undefined) {
        if (items.length === 0) problems.push('no items were exposed');
        break;
      }
      if (!items.includes(wanted)) {
        problems.push(
          `no "${wanted}" item (found ${items.map((i) => `"${i}"`).join(', ') || 'none'})`,
        );
        break;
      }
      await surface.invoke(wanted);
      break;
    }

    case 'MAIN_PROCESS_IPC': {
      const ipc = session.ipc()!;
      if (step.channel === undefined) {
        const channels = await ipc.channels();
        if (channels.length === 0) problems.push('the main process exposed no IPC channels');
        break;
      }
      const channels = await ipc.channels();
      if (!channels.includes(step.channel)) {
        problems.push(
          `the main process does not listen on "${step.channel}" ` +
            `(it listens on ${channels.length}: ${channels.slice(0, 8).join(', ')})`,
        );
        break;
      }
      const reply = await ipc.invoke(step.channel, step.payload);
      if (step.expectText !== undefined) {
        const rendered = typeof reply === 'string' ? reply : JSON.stringify(reply ?? null);
        if (!rendered.includes(step.expectText)) {
          problems.push(
            `"${step.channel}" replied ${rendered.slice(0, 200)}, which does not contain ` +
              `"${step.expectText}"`,
          );
        }
      }
      break;
    }

    case 'AUTO_UPDATE': {
      const result = await session.updater()!.check();
      if (step.expectText !== undefined) {
        const rendered = `${result.available ? 'available' : 'none'} ${result.version ?? ''}`.trim();
        if (!rendered.includes(step.expectText)) {
          problems.push(`the updater reported "${rendered}", not "${step.expectText}"`);
        }
      }
      break;
    }

    case 'DEEP_LINK': {
      const url = step.path?.[0];
      if (url === undefined) {
        problems.push('a DEEP_LINK step needs the URL to open in `path`');
        break;
      }
      await session.deepLinks()!.open(url);
      if (step.expectText !== undefined || step.selector !== undefined) {
        // The OS delivers the link asynchronously, so the windows are re-read —
        // and capped the same way every other read is, so a deep link cannot
        // examine a window a RENDERER_WINDOW step would have been held back from.
        const after = (await session.windows()).slice(0, view.cap);
        const target = pickWindow(after, step.window);
        if (!target) {
          problems.push(`after opening ${url} no window matched`);
          break;
        }
        if (step.selector !== undefined) {
          const text = await target.text(step.selector);
          if (text === null) {
            problems.push(`after opening ${url}, "${step.selector}" matched nothing`);
          } else if (step.expectText !== undefined && !text.includes(step.expectText)) {
            problems.push(
              `after opening ${url}, "${step.selector}" reads "${text.slice(0, 200)}", ` +
                `not containing "${step.expectText}"`,
            );
          }
        }
      }
      break;
    }

    // Unreachable: capabilityReach() always reports FILE_DIALOG unexercisable,
    // so this step never executes. Kept so the switch is exhaustive and a
    // future reachable dialog surface is a compile error here rather than a
    // silently skipped branch.
    case 'FILE_DIALOG':
      problems.push('a native file dialog cannot be driven from this plugin');
      break;
  }

  return problems;
}

/**
 * Run a desktop test against an injected launcher.
 *
 * Separate from the plugin so tests drive it with a fake shell, which is the
 * only way this logic is testable at all (rule 8): there is no Electron here.
 */
export async function runDesktopTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: DesktopTestSpec,
  launcher: DesktopLauncher,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const recorder = new StepRecorder(ctx, test.id);
  const notes: ConsoleEntry[] = [];

  const can = launcher.available(spec.shell);
  if (!can.ok) {
    // An absent toolchain is this worker being the wrong machine, not the
    // app being broken. BLOCKED_BY_ENV so the coverage pass excludes it
    // instead of scoring it as a skip.
    return {
      ...baseExecution(test.id, notes),
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: [],
      notRun: { kind: 'BLOCKED_BY_ENV', why: can.reason },
      errorMessage: can.reason,
    };
  }

  let session: DesktopShellSession;
  try {
    session = await launcher.launch({
      shell: spec.shell,
      command: spec.launch.command ?? null,
      args: spec.launch.args,
      attachPort: spec.launch.attachPort ?? null,
      readyTimeoutMs: spec.launch.readyTimeoutMs,
      workspaceRoot: ctx.workspace?.root ?? null,
      env: ctx.secrets,
      signal: ctx.signal,
    });
  } catch (err) {
    // A shell that will not start IS a failing test: the customer's app did
    // not come up. Distinct from the branch above, which never tried.
    return {
      ...baseExecution(test.id, notes),
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps: [],
      errorMessage: `The ${spec.shell} shell did not start: ${errorText(err)}`,
    };
  }

  let cancelled = false;

  try {
    /*
     * ── THE WINDOW LIST IS RE-READ FOR EVERY STEP ─────────────────────────────
     *
     * Read once before the loop — as this did — a step that OPENS a window is
     * asserted against the list as it was before it ran. "File → New Window,
     * then expect 2 windows" reported FAILED with "expected 2 window(s), found
     * 1" against an application that had in fact opened the second window: a
     * false failure, attributed to the customer, caused by our own stale
     * snapshot. A second window is the surface no DOM query from the first can
     * see, which is exactly why this plugin exists, so the one assertion that
     * reaches it must not be the one looking at history.
     *
     * The budget is re-disclosed when it bites HARDER than the last disclosure,
     * because the first read's "at least 1 more window exists" is false once the
     * app has opened four more. Disclosure is added, never replaced: each
     * sentence was true when it was written, and the largest is the one that
     * matters.
     */
    let widest = 0;
    let disclosedAt = 0;

    const readWindows = async (): Promise<WindowView> => {
      const all = await session.windows();
      if (all.length > widest) widest = all.length;
      const budget = windowBudgetNote(widest, spec.maxWindows);
      if (budget && widest > disclosedAt) {
        disclosedAt = widest;
        // Both a count and a reason, on the result rather than in a log: a cap
        // nobody can see in the report is a cap that was never disclosed.
        notes.push({ level: 'warn', text: budget, at: new Date().toISOString() });
        recorder.skip('Window enumeration budget', budget);
      }
      return { examinable: all.slice(0, spec.maxWindows), all, cap: spec.maxWindows };
    };

    // Before the loop as well as inside it, so a test whose every step turns out
    // to be unexercisable still discloses the budget it would have run under.
    await readWindows();

    for (const step of spec.steps) {
      if (ctx.signal.aborted) {
        cancelled = true;
        recorder.skip(step.title, 'the run was cancelled before this step');
        continue;
      }

      const reach = capabilityReach(session, step.capability);
      if (!reach.ok) {
        recorder.unreachable(step.title, step.capability, reach.reason);
        continue;
      }

      const stepStartedAt = Date.now();
      try {
        recorder.record(step.title, stepStartedAt, await runStep(session, step, await readWindows()));
      } catch (err) {
        recorder.record(step.title, stepStartedAt, [errorText(err)]);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  const exercised = recorder.steps.filter((s) => s.status !== 'SKIPPED').length;

  /*
   * A test whose every step was unexercisable did not pass. It measured
   * nothing, and PASSED would be the headline lie this product cannot afford:
   * a desktop app scoring green because the hard half of it is unreachable
   * from our worker.
   */
  if (exercised === 0) {
    const reasons = recorder.unexercisable
      .map((u) => `${DESKTOP_CAPABILITY_LABELS[u.capability]}: ${u.reason}`)
      .join(' | ');
    /*
     * CANCELLED AND UNSUPPORTED ARE DIFFERENT FACTS, and this branch reported
     * the second for both. A run stopped by its owner came back as "None of this
     * test's 3 step(s) could be exercised against the ELECTRON shell on this
     * worker" — a permanent claim about QAAI's capability, with the shell named
     * as the cause, on a run that was simply cut short. `NOT_RUN_KINDS` has
     * CANCELLED precisely for this: "nobody wanted the answer".
     *
     * Cancellation is checked FIRST because it is the stronger explanation. A
     * cancelled run may also have had unexercisable steps, and saying it was
     * cancelled is the fact that tells the reader why there is no result; the
     * capability gaps are still on their own steps either way.
     */
    const why = cancelled
      ? `This run was cancelled before any of this test's ${spec.steps.length} step(s) could be ` +
        `measured, so nothing is claimed about the ${spec.shell} shell or your application.` +
        (reasons === '' ? '' : ` Separately, some steps needed capabilities this worker cannot drive: ${reasons}`)
      : `None of this test's ${spec.steps.length} step(s) could be exercised against the ` +
        `${spec.shell} shell on this worker, so nothing was measured. ${reasons}`;
    return {
      ...baseExecution(test.id, notes),
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps: recorder.steps,
      notRun: { kind: cancelled ? 'CANCELLED' : 'UNSUPPORTED', why },
      errorMessage: cancelled
        ? why
        : `Nothing was measured: every step needed a capability this worker cannot drive. ${reasons}`,
    };
  }

  const failedStep = recorder.steps.find((s) => s.status === 'FAILED');
  const unexercisableNote =
    recorder.unexercisable.length > 0
      ? ` ${recorder.unexercisable.length} further step(s) were UNEXERCISABLE here and were not measured.`
      : '';

  return {
    ...baseExecution(test.id, notes),
    status: recorder.broken ? 'FAILED' : 'PASSED',
    durationMs: Date.now() - startedAt,
    steps: recorder.steps,
    errorMessage: recorder.broken
      ? `${failedStep?.error?.message ?? 'a desktop step failed'}${unexercisableNote}`
      : unexercisableNote.trim() || null,
  };
}

// ─── The real adapter ────────────────────────────────────────────────────────

/**
 * The launcher this plugin uses in production.
 *
 * Thin on purpose (rule 8): every decision above is made against the injected
 * interface, so this is only the part that genuinely needs a machine. It is
 * also, today, the honest report that the adapter is not built — attaching to
 * an Electron main process over CDP and bridging Tauri's IPC are real
 * capabilities that need a real shell on a real worker to develop against, and
 * neither exists in this environment.
 *
 * UNAVAILABLE is an honest answer; a silent pass is not. A stub that returned
 * an empty window list would make every desktop test PASS with nothing
 * measured, which is precisely the defect this file's header is about.
 */
export const unavailableDesktopLauncher: DesktopLauncher = {
  available(shell: DesktopShell) {
    return {
      ok: false,
      reason:
        `QAAI can model a ${shell} shell but has no attach adapter on this worker yet: driving ` +
        `one needs a ${shell === 'ELECTRON' ? 'Chrome DevTools Protocol' : 'WebView inspector'} ` +
        'connection to a running shell, which no worker image here provides. Nothing was ' +
        'measured — this is QAAI’s gap, not your application’s.',
    };
  },
  launch() {
    // Never reached through runDesktopTest, which checks `available` first.
    // Throwing rather than returning an empty session is deliberate: an empty
    // session would be measured as a pass.
    return Promise.reject(
      new Error('No desktop attach adapter is configured on this worker.'),
    );
  },
};

/** Swapped for a fake in tests; the production value is the honest stub above. */
let launcher: DesktopLauncher = unavailableDesktopLauncher;

/**
 * Install a launcher.
 *
 * The seam the tests use, and the seam a worker image with a real shell on it
 * would use. Returns the previous value so a test can restore it rather than
 * leaking a fake into the next test.
 */
export function setDesktopLauncher(next: DesktopLauncher): DesktopLauncher {
  const previous = launcher;
  launcher = next;
  return previous;
}

export const desktopPlugin = {
  type: 'DESKTOP' as const,

  validate(test: ExecutableTest): void {
    const parsed = desktopTestSpecSchema.safeParse(test.spec);
    if (parsed.success) return;

    // Name a bad `shell` before falling back to the union error, which is
    // unreadable when the discriminator itself is what is wrong.
    const raw = test.spec;
    const shell =
      raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).shell : undefined;
    if (typeof shell !== 'string' || !(DESKTOP_SHELLS as readonly string[]).includes(shell)) {
      throw new Error(
        `Desktop test "${test.name}" must set "shell" to one of ${DESKTOP_SHELLS.join(', ')} — got ${JSON.stringify(shell)}.`,
      );
    }

    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Desktop test "${test.name}" has an invalid ${shell} spec — ${issues}`);
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runDesktopTest(ctx, test, desktopTestSpecSchema.parse(test.spec), launcher);
  },
};
