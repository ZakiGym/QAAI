/**
 * The desktop plugin, and the one way it could be worse than not existing.
 *
 * A desktop shell's distinctive surface — the menu bar, the tray, the IPC
 * boundary, the updater, native dialogs — is largely unreachable from a CI
 * worker. The temptation is to leave the unreachable parts out of the result,
 * and leaving a surface out makes the percentage go UP: a desktop app would
 * then score HIGHER than a web app precisely because the hard half of it could
 * not be touched.
 *
 * So most of what is asserted here is about what the plugin SAYS when it cannot
 * do something, and the counter-tests matter as much as the tests: a real
 * failing assertion must still fail, or "UNEXERCISABLE" becomes a way to hide
 * every bug in a desktop app.
 */

import { describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import {
  DESKTOP_CAPABILITIES,
  DESKTOP_CAPABILITY_LABELS,
  DESKTOP_CAPABILITY_PRESENCE,
  DESKTOP_SHELLS,
  DESKTOP_SHELL_PRESENCE,
  DEFAULT_UNEXERCISABLE_REASONS,
  capabilityReach,
  desktopPlugin,
  desktopTestSpecSchema,
  pickWindow,
  runDesktopTest,
  unavailableDesktopLauncher,
  windowBudgetNote,
} from './desktop.js';
import type {
  DesktopCapability,
  DesktopLauncher,
  DesktopShellSession,
  DesktopStep,
  DesktopWindowSurface,
} from './desktop.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

function makeCtx(signal?: AbortSignal): RunContext & { logged: string[] } {
  const logged: string[] = [];
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://localhost:3000',
    secrets: {},
    storageState: null,
    artifacts: {
      put: async () => 'key',
      putFile: async () => 'key',
      get: async () => null,
      putPersistent: async () => 'key',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: (event) => logged.push(`${event.status} ${event.title}`),
    },
    signal: signal ?? new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    logged,
  };
}

function makeTest(spec: unknown, name = 'the preferences window opens'): ExecutableTest {
  return {
    id: 'test_1',
    name,
    type: 'E2E', // DESKTOP is not in TEST_TYPES yet — see registry.test.ts.
    code: '',
    filePath: 'desktop/prefs.json',
    spec,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

function fakeWindow(
  id: string,
  title: string,
  dom: Record<string, string> = {},
): DesktopWindowSurface & { clicks: string[] } {
  const clicks: string[] = [];
  return {
    id,
    title,
    clicks,
    text: async (selector) => dom[selector] ?? null,
    click: async (selector) => {
      clicks.push(selector);
    },
  };
}

interface FakeShellOptions {
  windows?: DesktopWindowSurface[];
  menuItems?: string[][] | null;
  trayItems?: string[] | null;
  dockItems?: string[] | null;
  ipcChannels?: string[] | null;
  ipcReply?: unknown;
  update?: { available: boolean; version: string | null } | null;
  deepLinks?: boolean;
  reasons?: Partial<Record<DesktopCapability, string>>;
}

function fakeSession(options: FakeShellOptions = {}): DesktopShellSession & {
  invoked: string[];
  closed: boolean;
} {
  const invoked: string[] = [];
  const windows = options.windows ?? [fakeWindow('w1', 'Acme')];
  const session = {
    invoked,
    closed: false,
    windows: async () => windows,
    menu: () =>
      options.menuItems == null
        ? null
        : {
            items: async () => options.menuItems!,
            invoke: async (path: readonly string[]) => {
              invoked.push(`menu:${path.join('/')}`);
            },
          },
    tray: () =>
      options.trayItems == null
        ? null
        : {
            items: async () => options.trayItems!,
            invoke: async (item: string) => {
              invoked.push(`tray:${item}`);
            },
          },
    dock: () =>
      options.dockItems == null
        ? null
        : {
            items: async () => options.dockItems!,
            invoke: async (item: string) => {
              invoked.push(`dock:${item}`);
            },
          },
    ipc: () =>
      options.ipcChannels == null
        ? null
        : {
            channels: async () => options.ipcChannels!,
            invoke: async (channel: string, payload: unknown) => {
              invoked.push(`ipc:${channel}:${JSON.stringify(payload ?? null)}`);
              return options.ipcReply ?? null;
            },
          },
    updater: () =>
      options.update == null ? null : { check: async () => options.update! },
    deepLinks: () =>
      options.deepLinks === true
        ? {
            open: async (url: string) => {
              invoked.push(`link:${url}`);
            },
          }
        : null,
    unavailableReason: (capability: DesktopCapability) => options.reasons?.[capability] ?? null,
    close: async () => {
      session.closed = true;
    },
  };
  return session;
}

function fakeLauncher(session: DesktopShellSession): DesktopLauncher {
  return { available: () => ({ ok: true }), launch: async () => session };
}

const baseSpec = {
  shell: 'ELECTRON' as const,
  launch: { command: 'dist/Acme.app', args: [], readyTimeoutMs: 30_000 },
  maxWindows: 10,
};

function spec(steps: DesktopStep[], overrides: Record<string, unknown> = {}) {
  return desktopTestSpecSchema.parse({ ...baseSpec, ...overrides, steps });
}

function outline(execution: TestExecution): string[] {
  return execution.steps.map((step) => `${step.status} ${step.title}`);
}

// ─── The vocabulary guard ────────────────────────────────────────────────────

describe('the capability vocabulary cannot drift from the schema that stores it', () => {
  /*
   * Eight GateRule kinds shipped unsaveable for two slices because only ONE of
   * the two halves existed — the zod enum accepted a kind no branch honoured.
   * `check:wiring` cannot see that class of defect, so these are the guard:
   * the compiler enforces the presence records, and this asserts they agree
   * with the zod options at run time.
   */
  it('keeps the presence record, the list and the zod enum one set', () => {
    expect(Object.keys(DESKTOP_CAPABILITY_PRESENCE).sort()).toEqual([...DESKTOP_CAPABILITIES].sort());
    expect(Object.keys(DESKTOP_SHELL_PRESENCE).sort()).toEqual([...DESKTOP_SHELLS].sort());

    const stepShape = desktopTestSpecSchema.shape.steps.element.shape;
    expect([...stepShape.capability.options].sort()).toEqual([...DESKTOP_CAPABILITIES].sort());
    expect([...desktopTestSpecSchema.shape.shell.options].sort()).toEqual([...DESKTOP_SHELLS].sort());
  });

  it('gives every capability a label and an unexercisable reason', () => {
    // A capability with no reason would report UNEXERCISABLE with nothing in
    // it, which is an omission wearing a disclosure's clothes.
    for (const capability of DESKTOP_CAPABILITIES) {
      expect(DESKTOP_CAPABILITY_LABELS[capability], capability).toBeTruthy();
      expect(DEFAULT_UNEXERCISABLE_REASONS[capability].length, capability).toBeGreaterThan(20);
    }
  });
});

// ─── What it says when it cannot reach something ─────────────────────────────

describe('an unreachable capability is reported, never omitted', () => {
  it('reports the native file dialog as UNEXERCISABLE even on a perfect session', async () => {
    /*
     * The headline case. A native dialog is an OS window and cannot be driven
     * from here on ANY shell — so a plugin that simply never emitted a step
     * for it would be silently dropping a real surface of the customer's app.
     */
    const session = fakeSession();
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Export dialog', capability: 'FILE_DIALOG' }]),
      fakeLauncher(session),
    );

    expect(outline(execution)[0]).toMatch(/^SKIPPED Export dialog — UNEXERCISABLE/);
    expect(execution.steps[0]!.title).toMatch(/native open\/save dialog is an OS window/);
    // SKIPPED, not FAILED: our worker's limit is not the customer's bug.
    expect(execution.steps[0]!.error).toBeNull();
  });

  it('uses the shell’s own reason when it has one', async () => {
    // The adapter knows things this plugin cannot — that the build is unsigned,
    // that no preload bridge was configured. A generic sentence would send the
    // customer looking in the wrong place.
    const session = fakeSession({
      reasons: { AUTO_UPDATE: 'This build is unsigned, so Squirrel refuses to run.' },
    });
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Update check', capability: 'AUTO_UPDATE' }]),
      fakeLauncher(session),
    );

    expect(execution.steps[0]!.title).toContain('Squirrel refuses to run');
  });

  it('does NOT report PASSED when every step was unexercisable', async () => {
    /*
     * The lie this file exists to prevent. A desktop app whose menu, tray, IPC
     * and dialogs are all unreachable measured NOTHING, and PASSED would make
     * it the best-scoring app in the account.
     */
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        { title: 'File menu', capability: 'MENU_BAR' },
        { title: 'Tray', capability: 'TRAY' },
        { title: 'Save dialog', capability: 'FILE_DIALOG' },
      ]),
      fakeLauncher(fakeSession()),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.status).not.toBe('PASSED');
    expect(execution.notRun?.kind).toBe('UNSUPPORTED');
    expect(execution.notRun?.why).toMatch(/None of this test's 3 step\(s\) could be exercised/);
    // The reason for each one travels with it, so the report can say WHY the
    // three surfaces are uncovered rather than just that they are.
    expect(execution.notRun?.why).toMatch(/preload bridge/);
    expect(execution.notRun?.why).toMatch(/OS window/);
    expect(execution.steps.every((s) => s.status === 'SKIPPED')).toBe(true);
  });

  it('discloses the unexercisable count on a result that DID measure something', async () => {
    // A green result with three unreachable steps in it is still green, and the
    // reader is entitled to know the green covers less than the test claims.
    const session = fakeSession({ windows: [fakeWindow('w1', 'Acme', { h1: 'Dashboard' })] });
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        {
          title: 'Main window',
          capability: 'RENDERER_WINDOW',
          selector: 'h1',
          expectText: 'Dashboard',
        },
        { title: 'Save dialog', capability: 'FILE_DIALOG' },
      ]),
      fakeLauncher(session),
    );

    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toMatch(/1 further step\(s\) were UNEXERCISABLE/);
  });
});

// ─── The counter-tests: real defects must still fail ─────────────────────────

describe('but a real desktop defect is still a failure', () => {
  it('fails when a menu item the app should declare is missing', async () => {
    const session = fakeSession({ menuItems: [['File', 'Open'], ['Help', 'About']] });
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'File → New Window', capability: 'MENU_BAR', path: ['File', 'New Window'] }]),
      fakeLauncher(session),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/no "File → New Window" item/);
    expect(session.invoked).toEqual([]); // never invoked a menu item that is not there
  });

  it('fails when a second window the test expects never opened', async () => {
    // The surface no DOM query from the first window can see, which is why it
    // is asserted on the window LIST and not inside a page.
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Preferences opens', capability: 'MULTI_WINDOW', expectWindowCount: 2 }]),
      fakeLauncher(fakeSession({ windows: [fakeWindow('w1', 'Acme')] })),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/expected 2 window\(s\), found 1/);
  });

  it('fails when the main process does not listen on the IPC channel', async () => {
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        { title: 'Save document', capability: 'MAIN_PROCESS_IPC', channel: 'doc:save' },
      ]),
      fakeLauncher(fakeSession({ ipcChannels: ['doc:open', 'app:quit'] })),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/does not listen on "doc:save"/);
  });

  it('crosses the IPC boundary and asserts the reply when the channel exists', async () => {
    const session = fakeSession({
      ipcChannels: ['doc:save'],
      ipcReply: { ok: true, path: '/tmp/a.txt' },
    });
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        {
          title: 'Save document',
          capability: 'MAIN_PROCESS_IPC',
          channel: 'doc:save',
          payload: { name: 'a.txt' },
          expectText: '/tmp/a.txt',
        },
      ]),
      fakeLauncher(session),
    );

    expect(execution.status).toBe('PASSED');
    expect(session.invoked).toEqual(['ipc:doc:save:{"name":"a.txt"}']);
  });

  it('fails when a named window is not open rather than falling back to the main one', async () => {
    /*
     * The quiet pass this prevents: defaulting to the main window would run
     * the assertion against a DIFFERENT window and report it as satisfied, so
     * "the preferences window shows the account name" would pass on an app
     * whose preferences window never opens.
     */
    const windows = [fakeWindow('w1', 'Acme', { '.email': 'a@b.c' })];
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        {
          title: 'Prefs shows the email',
          capability: 'RENDERER_WINDOW',
          window: 'Preferences',
          selector: '.email',
          expectText: 'a@b.c',
        },
      ]),
      fakeLauncher(fakeSession({ windows })),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/no open window's title contains "Preferences"/);
  });
});

// ─── The window list is read NOW, not at launch ──────────────────────────────

describe('a window a step opened is a window the next step can see', () => {
  /**
   * A shell where File → New Window really does open one.
   *
   * `windows()` returns a COPY, and that detail is the test. Handing back the
   * live array made every assertion below pass even against a plugin that read
   * the list once and held it: the "stale" view's own array kept changing
   * underneath it, so a frozen snapshot behaved like a fresh read and the
   * mutation survived. A real adapter builds a new array per call — CDP returns
   * a fresh target list — so the fake has to as well or it tests nothing.
   */
  function growingSession(initial: string[], opens: string[]): DesktopShellSession {
    const windows = initial.map((title, i) => fakeWindow(`w${i}`, title));
    return {
      windows: async () => [...windows],
      menu: () => ({
        items: async () => [['File', 'New Window']],
        invoke: async () => {
          for (const title of opens) windows.push(fakeWindow(`new-${title}`, title));
        },
      }),
      tray: () => null,
      dock: () => null,
      ipc: () => null,
      updater: () => null,
      deepLinks: () => null,
      unavailableReason: () => null,
      close: async () => {},
    };
  }

  it('counts the second window, instead of failing an app that opened it', async () => {
    /*
     * THE DEFECT. The window list was read once before the step loop, so a step
     * that opened a window was followed by an assertion against the list as it
     * was BEFORE it ran: "expected 2 window(s), found 1" against an application
     * that had opened the second window. A false failure, attributed to the
     * customer, caused by our own stale snapshot — and a second window is the
     * surface no DOM query from the first can reach, which is the reason this
     * plugin exists at all.
     */
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        { title: 'Open a second window', capability: 'MENU_BAR', path: ['File', 'New Window'] },
        { title: 'Two windows are open', capability: 'MULTI_WINDOW', expectWindowCount: 2 },
      ]),
      fakeLauncher(growingSession(['Acme'], ['Acme — Preferences'])),
    );

    expect(execution.status).toBe('PASSED');
    expect(outline(execution)).toEqual([
      'PASSED Open a second window',
      'PASSED Two windows are open',
    ]);
  });

  it('still FAILS when the window the step expected never opened', async () => {
    // The counter-test, and the one that keeps the fix above from being a way to
    // make every window assertion pass. The menu item exists and does nothing.
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([
        { title: 'Open a second window', capability: 'MENU_BAR', path: ['File', 'New Window'] },
        { title: 'Two windows are open', capability: 'MULTI_WINDOW', expectWindowCount: 2 },
      ]),
      fakeLauncher(growingSession(['Acme'], [])),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/expected 2 window\(s\), found 1/);
  });

  it('counts every window that EXISTS, not the ones the budget let it examine', async () => {
    /*
     * `maxWindows` bounds how many windows a selector may be run against,
     * because examining one costs a DOM round trip. It does not bound how many
     * exist — `windows()` already returned the whole list and its length is
     * free. Compared against the capped list, a 5-window app at maxWindows 2
     * reported "expected 5 window(s), found 2" and blamed the application for
     * our cap.
     */
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec(
        [
          { title: 'Open two more', capability: 'MENU_BAR', path: ['File', 'New Window'] },
          { title: 'Five windows exist', capability: 'MULTI_WINDOW', expectWindowCount: 5 },
        ],
        { maxWindows: 2 },
      ),
      fakeLauncher(growingSession(['A', 'B', 'C'], ['D', 'E'])),
    );

    expect(execution.status).toBe('PASSED');
    // And the cap is STILL disclosed, now with the number it really cost: the
    // first read's "at least 1 more" is false once the app has five windows.
    expect(execution.console.some((c) => /Enumerated 2 of 5 windows/.test(c.text))).toBe(true);
    expect(execution.console.some((c) => /at least 3 more window\(s\) exist/.test(c.text))).toBe(
      true,
    );
  });

  it('names the budget when the window a step asked for is open but past the cap', async () => {
    // A third fact, and reporting it as "no window matched" would be a false
    // assertion about the app caused by our own budget. The remedy differs.
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec(
        [{ title: 'Read Preferences', capability: 'RENDERER_WINDOW', window: 'Preferences' }],
        { maxWindows: 1 },
      ),
      fakeLauncher(growingSession(['Acme', 'Acme — Preferences'], [])),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/is open, but it is past the maxWindows budget of 1/);
    expect(execution.errorMessage).toMatch(/raise maxWindows/);
  });
});

// ─── A cancelled run is not an unsupported one ───────────────────────────────

describe('a cancelled run says it was cancelled', () => {
  it('reports CANCELLED, not UNSUPPORTED, when the run was stopped before any step', async () => {
    /*
     * These are different facts and this branch reported the second for both. A
     * run its owner stopped came back as "None of this test's 1 step(s) could be
     * exercised against the ELECTRON shell on this worker" — a permanent claim
     * about QAAI's capability, with the shell named as the cause, about a run
     * that was simply cut short. `NOT_RUN_KINDS` carries CANCELLED for exactly
     * this: nobody wanted the answer.
     */
    const controller = new AbortController();
    controller.abort();

    const execution = await runDesktopTest(
      makeCtx(controller.signal),
      makeTest({}),
      spec([{ title: 'Main window', capability: 'RENDERER_WINDOW', selector: 'h1' }]),
      fakeLauncher(fakeSession()),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('CANCELLED');
    expect(execution.notRun?.why).toMatch(/was cancelled before any of this test's 1 step\(s\)/);
    // And it does NOT claim the shell or the worker is the reason.
    expect(execution.notRun?.why).not.toMatch(/could be exercised against/);
  });

  it('still reports UNSUPPORTED when nothing was cancelled and nothing was reachable', async () => {
    // The counter-test: the UNSUPPORTED sentence is the right one when it is
    // true, and the fix above must not swallow it.
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Save as…', capability: 'FILE_DIALOG' }]),
      fakeLauncher(fakeSession()),
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('UNSUPPORTED');
    expect(execution.notRun?.why).toMatch(/could be exercised against the ELECTRON shell/);
  });
});

describe('pickWindow', () => {
  const windows = [fakeWindow('w1', 'Acme'), fakeWindow('w2', 'Acme — Preferences')];

  it('defaults to the first window only when the step names none', () => {
    expect(pickWindow(windows, undefined)?.id).toBe('w1');
  });

  it('matches on a title substring, case-insensitively', () => {
    expect(pickWindow(windows, 'preferences')?.id).toBe('w2');
  });

  it('returns null rather than a wrong window when nothing matches', () => {
    expect(pickWindow(windows, 'About')).toBeNull();
  });
});

// ─── The cap that bit ────────────────────────────────────────────────────────

describe('a window budget that bit is disclosed as a count and a reason', () => {
  it('says how many more windows existed', () => {
    // Rule 10: a cap applied without being disclosed. 40 windows enumerated at
    // 10 must say that 30 more exist, or they were never counted as uncovered.
    expect(windowBudgetNote(40, 10)).toMatch(/Enumerated 10 of 40 windows/);
    expect(windowBudgetNote(40, 10)).toMatch(/at least 30 more window\(s\) exist/);
  });

  it('says nothing when the cap did not bite', () => {
    expect(windowBudgetNote(3, 10)).toBeNull();
    expect(windowBudgetNote(10, 10)).toBeNull();
  });

  it('puts the disclosure on the RESULT, not only in a log', async () => {
    const windows = Array.from({ length: 12 }, (_, i) => fakeWindow(`w${i}`, `Window ${i}`));
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Main window', capability: 'RENDERER_WINDOW' }], { maxWindows: 4 }),
      fakeLauncher(fakeSession({ windows })),
    );

    expect(execution.console.some((c) => /at least 8 more window/.test(c.text))).toBe(true);
    expect(outline(execution).some((s) => /Window enumeration budget/.test(s))).toBe(true);
  });
});

// ─── Launch failures are not test failures ───────────────────────────────────

describe('a worker that cannot drive a shell is not a broken application', () => {
  it('reports BLOCKED_BY_ENV when no adapter is available, measuring nothing', async () => {
    const launcher: DesktopLauncher = {
      available: () => ({ ok: false, reason: 'No Electron on this image.' }),
      launch: async () => {
        throw new Error('should never be called');
      },
    };
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Main window', capability: 'RENDERER_WINDOW' }]),
      launcher,
    );

    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun).toEqual({ kind: 'BLOCKED_BY_ENV', why: 'No Electron on this image.' });
    expect(execution.steps).toEqual([]);
  });

  it('but a shell that will not START is a failure, because the app did not come up', async () => {
    // The opposite fact from the one above, and the two must not be merged: one
    // is our worker, the other is their application.
    const launcher: DesktopLauncher = {
      available: () => ({ ok: true }),
      launch: async () => {
        throw new Error('exited with code 1');
      },
    };
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Main window', capability: 'RENDERER_WINDOW' }]),
      launcher,
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/ELECTRON shell did not start: exited with code 1/);
    expect(execution.notRun).toBeUndefined();
  });

  it('closes the session even when a step throws', async () => {
    const session = fakeSession({
      windows: [
        {
          id: 'w1',
          title: 'Acme',
          text: async () => {
            throw new Error('renderer detached');
          },
          click: async () => {},
        },
      ],
    });
    const execution = await runDesktopTest(
      makeCtx(),
      makeTest({}),
      spec([{ title: 'Main window', capability: 'RENDERER_WINDOW', selector: 'h1' }]),
      fakeLauncher(session),
    );

    expect(execution.status).toBe('FAILED');
    expect(session.closed).toBe(true);
  });
});

describe('the production launcher is honestly unavailable rather than quietly empty', () => {
  it('declines every shell with a reason naming whose gap it is', () => {
    /*
     * A stub returning an empty window list would make every desktop test
     * PASS with nothing measured. UNAVAILABLE is an honest answer; a silent
     * pass is not.
     */
    for (const shell of DESKTOP_SHELLS) {
      const verdict = unavailableDesktopLauncher.available(shell);
      expect(verdict.ok, shell).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/QAAI’s gap, not your application’s/);
    }
  });

  it('rejects rather than returning a session that would measure as a pass', async () => {
    await expect(
      unavailableDesktopLauncher.launch({
        shell: 'ELECTRON',
        command: null,
        args: [],
        attachPort: 1234,
        readyTimeoutMs: 1000,
        workspaceRoot: null,
        env: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/No desktop attach adapter/);
  });
});

// ─── capabilityReach ─────────────────────────────────────────────────────────

describe('capabilityReach', () => {
  it('says yes only for the capabilities the session actually exposes', () => {
    const session = fakeSession({ menuItems: [['File']], ipcChannels: ['a'] });
    expect(capabilityReach(session, 'MENU_BAR').ok).toBe(true);
    expect(capabilityReach(session, 'MAIN_PROCESS_IPC').ok).toBe(true);
    expect(capabilityReach(session, 'TRAY').ok).toBe(false);
    expect(capabilityReach(session, 'AUTO_UPDATE').ok).toBe(false);
    expect(capabilityReach(session, 'DEEP_LINK').ok).toBe(false);
  });

  it('never claims a native file dialog is reachable', () => {
    // Even a session that exposes everything else cannot drive an OS window.
    const everything = fakeSession({
      menuItems: [['File']],
      trayItems: ['Quit'],
      dockItems: ['New'],
      ipcChannels: ['a'],
      update: { available: false, version: null },
      deepLinks: true,
    });
    expect(capabilityReach(everything, 'FILE_DIALOG').ok).toBe(false);
  });
});

// ─── validate ────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('names a bad shell plainly instead of printing a union error', () => {
    expect(() => desktopPlugin.validate(makeTest({ shell: 'QT', steps: [] }))).toThrow(
      /must set "shell" to one of ELECTRON, TAURI, WEBVIEW — got "QT"/,
    );
  });

  it('refuses a spec that would launch nothing and assert against nothing', () => {
    // Neither `command` nor `attachPort`: the shape that produces a green
    // result with no evidence in it.
    expect(() =>
      desktopPlugin.validate(
        makeTest({
          shell: 'ELECTRON',
          launch: {},
          steps: [{ title: 'x', capability: 'RENDERER_WINDOW' }],
        }),
      ),
    ).toThrow(/set `command` to launch the shell, or `attachPort`/);
  });

  it('rejects a capability outside the closed list', () => {
    expect(() =>
      desktopPlugin.validate(
        makeTest({
          shell: 'ELECTRON',
          launch: { command: 'a' },
          steps: [{ title: 'x', capability: 'PRINT_DIALOG' }],
        }),
      ),
    ).toThrow(/invalid ELECTRON spec/);
  });

  it('accepts a well-formed spec', () => {
    expect(() =>
      desktopPlugin.validate(
        makeTest({
          shell: 'TAURI',
          launch: { attachPort: 9222 },
          steps: [{ title: 'x', capability: 'RENDERER_WINDOW', selector: 'h1' }],
        }),
      ),
    ).not.toThrow();
  });
});
