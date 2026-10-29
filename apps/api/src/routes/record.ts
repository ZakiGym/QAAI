/**
 * Record mode (§C) — the marquee feature: click through your app, get a test.
 *
 * The recorder opens a real browser window, so it runs on the host that has a
 * screen — the desktop app or local dev — not on a headless worker. The API is
 * that host in both cases, so it spawns codegen directly and tracks the session
 * in memory rather than through the queue.
 *
 * Lifecycle: start → the user clicks through their app → they close the browser
 * → the spec is read, cleaned, and offered back. The client then saves it as a
 * test through the normal create-test path, so a recorded test is an ordinary
 * test with ordinary history from the moment it exists.
 *
 * ── WHY THIS FILE IS ALSO AN ENUMERATION SOURCE ─────────────────────────────
 *
 * Record mode reaches exactly what the crawler cannot. A human clicks through
 * the wizard, opens the modal, gets past the payment step, holds the role, has
 * the data. The crawler sees a button and a spinner; the person sees three more
 * pages behind it.
 *
 * Until now that reach widened the SUITE and never the DENOMINATOR. The spec
 * was handed back, saved as a test, and the pages it had just proved exist were
 * still absent from the inventory — so a route only a human could reach was not
 * uncovered, it was INVISIBLE, and the one source that could see it threw the
 * evidence away. Absent and uncovered are opposite facts: uncovered lowers the
 * percentage and gets a line in the named list, absent raises it and gets
 * nothing.
 *
 * So the merge below runs when a recording becomes ready: the routes it visited
 * and the forms it submitted go into `CoverageItem` — which IS the surface
 * registry; nothing here mints a second one — with `MANUAL` in `sources` and
 * the evidence sentence naming the recording. A route only a human reached is
 * still surface.
 *
 * ── WHAT THE MERGE REFUSES TO CLAIM ─────────────────────────────────────────
 *
 *  · It ADDS and never retires. A recording is one person's path; its silence
 *    about a route says nothing at all, and retiring on it would delete real
 *    surface from the denominator and raise the percentage.
 *  · A route the parser could not resolve — `page.goto(url)` where `url` is a
 *    variable — is reported as UNRESOLVED and counted, never dropped and never
 *    guessed at. "We could not read it" and "there was nothing there" are
 *    different facts.
 *  · The merge's own outcome is reported, including when it FAILED. A silent
 *    failure here would look exactly like a recording that touched nothing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { cleanupRecordedSpec, startRecording, type RecordingSession } from '@qaai/runner';
import { canonicalRoute } from '@qaai/agent';
import {
  originFromSources,
  promoteRecordingSchema,
  type SurfaceKind,
  type SurfaceSource,
} from '@qaai/shared';
import { prisma } from '../lib/prisma.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const recordRouter: Router = Router();

recordRouter.use(requireAuth);

// ─── Reading surface out of a recorded spec ──────────────────────────────────

/**
 * The things a recorded session can tell us a surface exists.
 *
 * A VOCABULARY WITH A WRITE PATH, so it carries both halves of the guard this
 * codebase insists on: {@link RECORDED_ACTION_PRESENT} is a
 * `Record<RecordedAction['kind'], true>` the compiler refuses to let drift from
 * the union, and a run-time parity test in record.test.ts compares that list
 * against the extractor's own output kinds. Eight `GateRule` kinds shipped
 * unsaveable for two slices because only one of those two mechanisms existed.
 */
export type RecordedAction =
  | {
      kind: 'NAVIGATE';
      /** The canonical route, or null when the argument was not a literal. */
      route: string | null;
      /** The source line, for the evidence sentence. */
      line: number;
      /** The literal as written, when it was one. Never a fabricated path. */
      literal: string | null;
    }
  | {
      kind: 'CONTROL';
      /** `click` / `check` / `selectOption` / `press` — what the human did. */
      verb: string;
      /** The accessible name or label the locator used, when it carried one. */
      name: string | null;
      line: number;
    }
  | {
      kind: 'FIELD';
      /** The field's accessible name or label. */
      name: string;
      line: number;
    };

/**
 * Every discriminant {@link RecordedAction} has, as a run-time value. The
 * compiler enforces this record; record.test.ts enforces the extractor against
 * it.
 */
const RECORDED_ACTION_PRESENT: Record<RecordedAction['kind'], true> = {
  NAVIGATE: true,
  CONTROL: true,
  FIELD: true,
};

export const RECORDED_ACTION_KINDS = Object.keys(RECORDED_ACTION_PRESENT) as ReadonlyArray<
  RecordedAction['kind']
>;

/** What a recorded spec proved exists. */
export interface RecordedSurface {
  /** Routes visited, in first-visit order, canonicalised. */
  routes: string[];
  /** Controls a human exercised, attributed to the route they were on. */
  controlsByRoute: Record<string, string[]>;
  /**
   * Every distinct form submission read, in the order they happened.
   *
   * ── THE DEFECT THIS FIELD EXISTS TO FIX ───────────────────────────────────
   *
   * {@link formsByRoute} is keyed by ROUTE, so it holds one field set per
   * route and the second submission on a page REPLACED the first. A person who
   * saved their email and then their password on `/account` submitted two
   * forms, and the inventory got one — the LAST one, silently, with
   * `formsSubmitted: 1` beside it and nothing anywhere saying a form had been
   * dropped. A surface that exists and is absent from the denominator costs
   * nothing, while an uncovered one lowers the percentage, so a silent drop is
   * the flattering direction.
   *
   * The identity is the route plus the sorted field names, which is what
   * `writesFor` already builds its registry key from — so the key format
   * always supported two forms on one page and only the collection did not.
   * Deduplicated on that identity: submitting the same form twice in one
   * recording is one surface walked twice.
   */
  forms: Array<{ route: string; fields: string[] }>;
  /**
   * The LAST form submitted on each route.
   *
   * A route-scoped view kept for readers that want "what did a person do on
   * this page"; it is NOT the enumeration, because a route can carry several
   * forms. {@link forms} is what the denominator is built from.
   */
  formsByRoute: Record<string, string[]>;
  /**
   * Navigations whose target could not be read — `page.goto(target)` with a
   * variable, a template with an interpolation we will not guess at.
   *
   * COUNTED AND NAMED BY LINE, never dropped. A recording that visited four
   * pages and had one unreadable goto has reached at least five surfaces, and a
   * report that silently showed four would be claiming completeness it has not
   * got. The line number is given so a human can read the spec and say.
   */
  unresolvedNavigations: number[];
  /** Every action read, so the extractor's own coverage is checkable. */
  actions: RecordedAction[];
}

/*
 * The four patterns Playwright codegen actually emits, and nothing else.
 *
 * Deliberately NOT a TypeScript parse. The input is codegen's own output —
 * machine-written, one statement per line, a fixed vocabulary — so a line
 * matcher reads it exactly and a parser would add a dependency and a failure
 * mode for no additional truth. Anything these do not match is reported as
 * unread rather than inferred, which is why `unresolvedNavigations` exists.
 */
const GOTO_LITERAL = /\bpage\s*\.\s*goto\s*\(\s*(['"`])([^'"`]*)\1/;
const GOTO_ANY = /\bpage\s*\.\s*goto\s*\(/;
/** `getByRole('button', { name: 'Pay' })`, `getByLabel('Email')`, `getByText(…)`. */
const LOCATOR_NAME = /getBy(?:Role|Label|Text|Placeholder|AltText|Title|TestId)\s*\(\s*(['"`])([^'"`]*)\1(?:[^)]*?name:\s*(['"`])([^'"`]*)\3)?/;
const FILL_VERB = /\.\s*(fill|type|setInputFiles)\s*\(/;
const CONTROL_VERB = /\.\s*(click|check|uncheck|selectOption|press|dblclick|tap)\s*\(/;

/** An interpolated literal is a route we cannot name, not a route named `${x}`. */
const INTERPOLATED = /\$\{/;

/**
 * Reads a recorded spec's surface.
 *
 * PURE, AND THAT IS THE DESIGN. It takes a string and returns facts; it opens
 * no browser, reads no file and touches no database, so every behaviour below
 * is tested against a literal spec and the persistence that follows is thin
 * enough to read in one sitting. 629 lines of crawler.ts have almost no tests
 * because they did the opposite.
 */
export function surfaceFromRecordedSpec(code: string): RecordedSurface {
  const actions: RecordedAction[] = [];
  const routes: string[] = [];
  const controlsByRoute: Record<string, string[]> = {};
  const formsByRoute: Record<string, string[]> = {};
  const forms: Array<{ route: string; fields: string[] }> = [];
  /** Form identities already read, so one form walked twice is one surface. */
  const formIdentities = new Set<string>();
  const unresolvedNavigations: number[] = [];

  /*
   * The route a later action belongs to. Starts null: a click before any goto
   * happened on whatever page the recorder opened at, and attributing it to a
   * route we have not seen would be inventing the attribution. Those actions
   * are kept in `actions` and attributed to nothing.
   */
  let current: string | null = null;
  /** Fields filled since the last submit-ish control, awaiting one. */
  let pendingFields: string[] = [];

  const lines = code.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    const goto = GOTO_LITERAL.exec(line);
    if (goto) {
      const literal = goto[2] ?? '';
      if (!literal || INTERPOLATED.test(literal)) {
        unresolvedNavigations.push(lineNumber);
        actions.push({ kind: 'NAVIGATE', route: null, line: lineNumber, literal: literal || null });
        continue;
      }
      // An absolute URL survives `cleanupRecordedSpec` only when it points
      // somewhere other than the environment's base URL — a third-party IdP,
      // say — which is not this application's surface.
      if (/^[a-z][a-z0-9+.-]*:/i.test(literal)) {
        unresolvedNavigations.push(lineNumber);
        actions.push({ kind: 'NAVIGATE', route: null, line: lineNumber, literal });
        continue;
      }
      const route = canonicalRoute(literal);
      actions.push({ kind: 'NAVIGATE', route, line: lineNumber, literal });
      if (!routes.includes(route)) routes.push(route);
      current = route;
      pendingFields = [];
      continue;
    }
    if (GOTO_ANY.test(line)) {
      // A goto whose argument is not a literal at all: a variable, a helper
      // call. It reached SOMETHING and we cannot say what.
      unresolvedNavigations.push(lineNumber);
      actions.push({ kind: 'NAVIGATE', route: null, line: lineNumber, literal: null });
      continue;
    }

    const locator = LOCATOR_NAME.exec(line);
    const name = locator ? (locator[4] ?? locator[2] ?? null) : null;

    if (FILL_VERB.test(line)) {
      if (name) {
        actions.push({ kind: 'FIELD', name, line: lineNumber });
        if (!pendingFields.includes(name)) pendingFields.push(name);
      }
      continue;
    }

    const control = CONTROL_VERB.exec(line);
    if (control) {
      const verb = control[1] ?? 'click';
      actions.push({ kind: 'CONTROL', verb, name, line: lineNumber });
      if (current && name) {
        const bucket = (controlsByRoute[current] ??= []);
        if (!bucket.includes(name)) bucket.push(name);
      }
      /*
       * A click after one or more fills is a form submission. This is a
       * HEURISTIC and the evidence sentence on the stored row says so — codegen
       * does not record that a <form> existed, only that a person typed into
       * things and then pressed one. Overclaiming here would put a FORM in the
       * denominator that nobody can find.
       */
      if (current && pendingFields.length > 0) {
        const fields = [...pendingFields].sort();
        /*
         * Appended to `forms` on its own identity, not written over the
         * route's slot. Two different field sets on one page are two forms —
         * see the note on `RecordedSurface.forms` for the surface the
         * route-keyed map used to lose.
         */
        const identity = `${current}#${fields.join(',')}`;
        if (!formIdentities.has(identity)) {
          formIdentities.add(identity);
          forms.push({ route: current, fields });
        }
        formsByRoute[current] = fields;
        pendingFields = [];
      }
      continue;
    }
  }

  return { routes, controlsByRoute, forms, formsByRoute, unresolvedNavigations, actions };
}

/**
 * The surface registry writes a recorded session implies.
 *
 * `MANUAL` AND NOT `CRAWL`, and the choice is load-bearing. `SURFACE_SOURCES`
 * splits its members by what they PROVE: CRAWL and TRAFFIC are the two
 * OBSERVATIONS, and both of them mean something specific — our crawler reached
 * it, or production traffic hit it. A recording is neither. Filing it under
 * CRAWL would inflate "the crawl reached N", which is a claim about OUR
 * capability, in the flattering direction; `MANUAL` is the member whose stated
 * purpose is exactly this — "the only declarer for a surface nothing can read".
 *
 * The cost of that choice is that `originFromSources(['MANUAL'])` is
 * SOURCE_ONLY, whose label says "never reached by a crawl" — true — and
 * "declared in source", which is true for most recorded routes and unverified
 * for the rest. A `RECORDING` member of `SurfaceSource` would say the whole
 * truth; see needsFromOtherFiles. Nothing here invents one locally, because a
 * second provenance vocabulary is worse than an imprecise entry in the first.
 */
interface RecordedWrite {
  kind: SurfaceKind;
  key: string;
  label: string;
  evidence: string;
  /**
   * The kind-specific detail the cockpit renders.
   *
   * Typed concretely rather than as `Record<string, unknown>`: it is written
   * into a Prisma `Json` column, and a wide index signature is not assignable
   * to `InputJsonValue` — so the loose type costs a cast at every write site,
   * and a cast is exactly where a non-serialisable value would get in.
   */
  meta:
    | { exercisedControls: string[]; exercisedBy: 'RECORDING' }
    | { fields: string[]; inferredFrom: 'FILLS_THEN_CLICK'; exercisedBy: 'RECORDING' };
}

function writesFor(surface: RecordedSurface, sessionName: string): RecordedWrite[] {
  const writes: RecordedWrite[] = [];

  for (const route of surface.routes) {
    const controls = surface.controlsByRoute[route] ?? [];
    writes.push({
      kind: 'ROUTE',
      key: `ROUTE:${route}`,
      label: route,
      evidence:
        `A person reached this route while recording "${sessionName}"` +
        (controls.length > 0
          ? `, and exercised ${controls.length} control${controls.length === 1 ? '' : 's'} on it`
          : '') +
        '. Human-assisted enumeration: no crawler had to be able to get here.',
      meta: {
        /*
         * Controls live on the route rather than becoming items of their own.
         * `SurfaceKind` has no CONTROL axis and nothing here invents a
         * thirteenth one locally — a kind that exists in one file is a kind no
         * denominator can count. See needsFromOtherFiles.
         */
        exercisedControls: controls,
        exercisedBy: 'RECORDING',
      },
    });
  }

  for (const { route, fields } of surface.forms) {
    /*
     * Identity is the route plus the sorted field names, which is the most
     * stable thing a recording can offer: the order a person fills a form in
     * varies between recordings and the fields do not.
     *
     * It will NOT match the source side's `FORM:<file>#<index>` for the same
     * form, so a form both declarers know can appear twice. That is a real
     * limitation, it is stated here and in needsFromOtherFiles, and it is the
     * right trade today: a double-counted form overstates the denominator by
     * one and understates coverage, which errs against us. Dropping the
     * recorded form instead would hide a surface only a human could reach.
     */
    writes.push({
      kind: 'FORM',
      key: `FORM:${route}#${fields.join(',')}`,
      label: `Form on ${route} (${fields.join(', ')})`,
      evidence:
        `A person filled ${fields.length} field${fields.length === 1 ? '' : 's'} on ${route} and ` +
        `submitted while recording "${sessionName}". Inferred from a click following fills — ` +
        'codegen does not record that a <form> element was involved.',
      meta: { fields, inferredFrom: 'FILLS_THEN_CLICK', exercisedBy: 'RECORDING' },
    });
  }

  return writes;
}

/** The outcome of a merge, including the shapes that are not success. */
export interface RecordedMerge {
  status: 'MERGED' | 'NOTHING_READABLE' | 'FAILED';
  routesVisited: number;
  formsSubmitted: number;
  controlsExercised: number;
  surfaceCreated: number;
  surfaceUpdated: number;
  /**
   * Registry rows that were RETIRED and are live again because this recording
   * reached them.
   *
   * The merge clears `retiredAt`, so this is the denominator growing — and a
   * retirement is a decision somebody took, so reversing it silently leaves a
   * number nobody can account for. Zero is a measurement.
   */
  surfaceReinstated: number;
  /** Navigations whose destination could not be read. Never silently dropped. */
  unresolvedNavigations: number[];
  /** Why, when status is not MERGED. Null when it is. */
  reason: string | null;
}

/**
 * Merges a recorded session's surface into the registry.
 *
 * ADDING ONLY. One person's path is not a census, so its silence about a route
 * is not evidence of anything, and `retiredAt` is only ever cleared here —
 * never set.
 *
 * An existing row keeps its `file`, `line`, `detector` and `exercisability`:
 * the source detector knows where a route is declared and a recording does not,
 * and writing nulls over those would blind the editor link on exactly the rows
 * with the best evidence behind them.
 */
export async function mergeRecordedSurface(input: {
  orgId: string;
  projectId: string;
  environmentId: string;
  sessionName: string;
  code: string;
}): Promise<RecordedMerge> {
  const surface = surfaceFromRecordedSpec(input.code);
  const controlsExercised = Object.values(surface.controlsByRoute).reduce(
    (running, controls) => running + controls.length,
    0,
  );
  const base = {
    routesVisited: surface.routes.length,
    // Every distinct form, not one per route: see RecordedSurface.forms.
    formsSubmitted: surface.forms.length,
    controlsExercised,
    unresolvedNavigations: surface.unresolvedNavigations,
  };

  const writes = writesFor(surface, input.sessionName);
  if (writes.length === 0) {
    /*
     * NOTHING_READABLE and not a zero-filled success. A recording whose spec
     * the extractor could not read anything out of is a fact about our
     * extractor; reporting MERGED with 0 would be a claim that the person's
     * session touched no surface, which is a different and false sentence.
     */
    return {
      ...base,
      status: 'NOTHING_READABLE',
      surfaceCreated: 0,
      surfaceUpdated: 0,
      // Nothing was written, so nothing was reinstated. A measured zero.
      surfaceReinstated: 0,
      reason:
        surface.unresolvedNavigations.length > 0
          ? `No route literal could be read from this recording, though ${surface.unresolvedNavigations.length} ` +
            'navigation(s) happened. Nothing was added to the inventory and nothing is claimed ' +
            'about what the session reached.'
          : 'No navigation or form submission could be read from this recording, so nothing was ' +
            'added to the inventory.',
    };
  }

  const existing = await prisma.coverageItem.findMany({
    where: { projectId: input.projectId, key: { in: writes.map((write) => write.key) } },
    /*
     * `retiredAt` is selected because `shared` below clears it: a recording
     * that reaches a retired surface returns it to the denominator. That is
     * the right call — a person drove it — but somebody retired that row on
     * purpose, and a denominator that grows with no line in the response is a
     * number changing for a reason nobody can find. Counted here, reported on
     * {@link RecordedMerge}.
     */
    select: { key: true, sources: true, retiredAt: true },
  });
  const sourcesByKey = new Map<string, SurfaceSource[]>();
  const retiredKeys = new Set<string>();
  for (const row of existing) {
    if (row.retiredAt !== null) retiredKeys.add(row.key);
    // Three states on `sources`: absent means the row predates the column and
    // nobody recorded a declarer — which is not an empty list and must not be
    // flattened into one. Either way MANUAL now belongs in the union.
    sourcesByKey.set(row.key, Array.isArray(row.sources) ? (row.sources as SurfaceSource[]) : []);
  }

  let created = 0;
  let updated = 0;
  let reinstated = 0;
  await prisma.$transaction(
    writes.map((write) => {
      const before = sourcesByKey.get(write.key);
      const sources = [...new Set<SurfaceSource>([...(before ?? []), 'MANUAL'])];
      if (before === undefined) created += 1;
      else updated += 1;
      if (retiredKeys.has(write.key)) reinstated += 1;

      const shared = {
        sources: sources as unknown as object,
        // Derived, never set independently: an item whose two provenance
        // fields disagree shows one of them on screen and the other nowhere.
        origin: originFromSources(sources) ?? ('SOURCE_ONLY' as const),
        // The environment the recording was driven against. A recorded route
        // is an observation IN one place, so it is scoped to it — a
        // staging-only wizard step must not enter a production denominator.
        environmentId: input.environmentId,
        retiredAt: null,
      };

      return prisma.coverageItem.upsert({
        where: { projectId_key: { projectId: input.projectId, key: write.key } },
        create: {
          ...shared,
          orgId: input.orgId,
          projectId: input.projectId,
          key: write.key,
          kind: write.kind,
          label: write.label,
          evidence: write.evidence,
          detector: 'record-session',
          meta: write.meta,
          /*
           * A person drove it, so our harness provably can. This is the
           * strongest exercisability evidence any declarer produces: not a
           * policy guess, an actual session.
           */
          exercisability: 'EXERCISABLE' as const,
          exerciseDetail: 'A person drove this surface in a recording, so a test can drive it.',
        },
        update: {
          ...shared,
          label: write.label,
          evidence: write.evidence,
          meta: write.meta,
        },
      });
    }),
  );

  return {
    ...base,
    status: 'MERGED',
    surfaceCreated: created,
    surfaceUpdated: updated,
    surfaceReinstated: reinstated,
    reason: null,
  };
}

interface Session {
  orgId: string;
  projectId: string;
  environmentId: string;
  baseUrl: string;
  name: string;
  status: 'recording' | 'ready' | 'error';
  code: string | null;
  error: string | null;
  handle: RecordingSession;
  createdAt: number;
  /**
   * The enumeration merge, once the recording is ready.
   *
   * Null while recording and while the merge is in flight — which is a third
   * state the poll response reports as `null` rather than as a zero-filled
   * result, because "not merged yet" and "merged and found nothing" are
   * different answers.
   */
  enumeration: RecordedMerge | null;
}


// In-memory: sessions are bound to one API process with one screen, and a
// recording that survives a restart would be pointing at a browser that is gone.
const sessions = new Map<string, Session>();

/** A recording nobody collected an hour ago is not coming back. */
function sweepStale(): void {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) {
      session.handle.cancel();
      sessions.delete(id);
    }
  }
}

// Sweep on a timer, not only when a new recording arrives — otherwise a
// low-traffic instance where each org records once and stops never reclaims
// completed sessions, and the map grows for the life of the process. `unref`
// so this interval never keeps the process alive on its own.
setInterval(sweepStale, 10 * 60_000).unref();

recordRouter.post('/projects/:projectId/record', requireRole('MEMBER'), async (req, res) => {
  sweepStale();
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  const environmentId = String(req.body?.environmentId ?? '');
  const name = String(req.body?.name ?? 'Recorded test').slice(0, 160);
  if (!environmentId) throw badRequest('environmentId is required');

  const environment = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { id: true, projectId: true, baseUrl: true },
  });
  if (!environment || environment.projectId !== projectId) throw notFound('Environment');

  const handle = startRecording(environment.baseUrl);
  const id = randomUUID();

  const session: Session = {
    orgId: actor.orgId,
    projectId,
    environmentId: environment.id,
    baseUrl: environment.baseUrl,
    name,
    status: 'recording',
    code: null,
    error: null,
    handle,
    createdAt: Date.now(),
    enumeration: null,
  };
  sessions.set(id, session);

  // The promise settles when the user closes the browser; the client polls for
  // it rather than holding a request open for a multi-minute human session.
  handle.done
    .then(async (raw) => {
      session.code = cleanupRecordedSpec(raw, { name: session.name, baseUrl: session.baseUrl });
      session.status = 'ready';

      /*
       * THE DENOMINATOR MERGE, HERE RATHER THAN BEHIND A SECOND CALL.
       *
       * Everything this recording proved exists is known at exactly this
       * moment, and it is the moment the person stops paying attention — they
       * close the browser, the spec appears, they save it as a test. An
       * enumeration step that needed a separate explicit request would be a
       * step nobody takes, and the surface only a human could reach would stay
       * invisible for the same reason it always has.
       *
       * The spec is already cleaned, so routes are relative and the merge sees
       * `/checkout` rather than one host's absolute URL.
       */
      try {
        session.enumeration = await mergeRecordedSurface({
          orgId: session.orgId,
          projectId: session.projectId,
          environmentId: session.environmentId,
          sessionName: session.name,
          code: session.code,
        });
        await audit({
          actor,
          action: 'record.enumerate',
          targetType: 'Project',
          targetId: projectId,
          metadata: {
            sessionId: id,
            status: session.enumeration.status,
            routesVisited: session.enumeration.routesVisited,
            formsSubmitted: session.enumeration.formsSubmitted,
            surfaceCreated: session.enumeration.surfaceCreated,
            surfaceUpdated: session.enumeration.surfaceUpdated,
            unresolvedNavigations: session.enumeration.unresolvedNavigations.length,
          },
        });
      } catch (err) {
        /*
         * A FAILED merge is reported and never swallowed. Swallowed, it would
         * be indistinguishable from a recording that touched no surface — and
         * the recording itself is still good, so the status above stays
         * `ready` and the person still gets their test.
         */
        logger.error({ err, sessionId: id }, 'recorded-surface merge failed');
        session.enumeration = {
          status: 'FAILED',
          routesVisited: 0,
          formsSubmitted: 0,
          controlsExercised: 0,
          surfaceCreated: 0,
          surfaceUpdated: 0,
          surfaceReinstated: 0,
          unresolvedNavigations: [],
          reason:
            'The recording was captured but its surface could not be merged into the ' +
            `inventory: ${(err as Error).message}. The spec above is unaffected.`,
        };
      }
    })
    .catch((err: Error) => {
      session.error = err.message;
      session.status = 'error';
    });

  await audit({
    actor,
    action: 'record.start',
    targetType: 'Project',
    targetId: projectId,
    metadata: { baseUrl: environment.baseUrl },
  });

  res.status(202).json({ sessionId: id, baseUrl: environment.baseUrl });
});

/** Poll: recording → ready (with code) → the client saves it as a test. */
recordRouter.get('/projects/:projectId/record/:sessionId', (req, res) => {
  const actor = actorOf(req);
  const session = sessions.get(String(req.params.sessionId));
  // Ownership check: a session id is a uuid, but it must still be this org's.
  if (
    !session ||
    session.orgId !== actor.orgId ||
    session.projectId !== String(req.params.projectId)
  ) {
    throw notFound('Recording session');
  }

  /*
   * `status`, `code` and `error` are unchanged — apps/web polls this shape.
   * `enumeration` is additive, and null means one of two things the client can
   * tell apart from `status`: still recording, or ready and the merge has not
   * finished. It is never a zero-filled object standing in for "not yet".
   */
  res.json({
    status: session.status,
    code: session.code,
    error: session.error,
    enumeration: session.enumeration,
  });
});

/** Cancel a recording — closes the browser window. */
recordRouter.delete('/projects/:projectId/record/:sessionId', (req, res) => {
  const actor = actorOf(req);
  const id = String(req.params.sessionId);
  const session = sessions.get(id);
  if (!session || session.orgId !== actor.orgId) throw notFound('Recording session');

  session.handle.cancel();
  sessions.delete(id);
  logger.info({ sessionId: id }, 'recording cancelled');
  res.json({ ok: true });
});

// ─── Promotion: the recording becomes a test, exactly once ───────────────────

/**
 * THE RECORDING KEY IS A CONTENT HASH, AND THIS IS WHERE IT IS CHECKED.
 *
 * `promoteRecordingSchema` carries both the cleaned spec and its key, which
 * means a client could send a key that has nothing to do with the code. Then
 * `@@unique([projectId, recordingKey])` — the whole idempotence mechanism —
 * guards nothing: two promotions of the same session look like different
 * recordings, and two different sessions can be made to look like the same one.
 *
 * So the key is RECOMPUTED here and the request is refused when it disagrees.
 * The hash is over the CLEANED spec, which is what `code` is: cleaning renames
 * the test and makes the URLs relative, so hashing the raw codegen output would
 * make the same session key differently on two machines.
 */
export function recordingKeyOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** The stem of the file a promoted recording lands at. */
const PROMOTED_DIRECTORY = 'recorded';

/**
 * A FILE PATH IS NOT A PLACE TO PUT CUSTOMER TEXT.
 *
 * `name` is `outwardText`, so it is bounded and stripped of control characters,
 * and it is still a human's sentence. It never reaches the path verbatim: the
 * path is built from a slug of it, over a closed alphabet, with twelve
 * characters of the key as the tail so two recordings called the same thing do
 * not land on the same file. An empty slug (a name that is entirely punctuation
 * or a non-Latin script) is not an error — it falls back to the key alone.
 */
export function promotedFilePath(name: string, key: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const tail = key.slice(0, 12);
  return `${PROMOTED_DIRECTORY}/${slug ? `${slug}-${tail}` : tail}.spec.ts`;
}

/**
 * Promote a recording into the suite — the write half of record mode.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * The header above says it plainly: "The client then saves it as a test through
 * the normal create-test path." That path knows nothing about recordings, so
 * two facts were lost. First, "where did this test come from?" had no answer —
 * a recorded test and a generated test were the same row, and the coverage
 * evidence could not tell a human's reach from the crawler's. Second, POST
 * /tests is not idempotent in the recording's terms: a double-click, a retried
 * request or a client that lost the response made TWO tests out of one session,
 * and the second one was indistinguishable from a deliberate copy.
 *
 * ── WHAT IS IDEMPOTENT, AND IN WHICH TERMS ──────────────────────────────────
 *
 * The `RecordingPromotion` row on `(projectId, recordingKey)` is the claim, and
 * the key is the hash of the spec. So:
 *
 *   · PROMOTED, and the test is still there → that test comes back, nothing is
 *     written, and `idempotent: true` says so out loud. Not 409: the caller
 *     asked for this session to be a test and it is.
 *   · PROMOTED, and the test has since been deleted → the test is written again
 *     and the SAME row is repointed at it. There is never a second live test
 *     under a row that claims one, and the audit metadata names the id that was
 *     gone so the sequence is reconstructable.
 *   · REJECTED → 409. A rejected recording is a decision somebody made, and
 *     silently promoting over it would throw that decision away.
 *   · CAPTURED or SUPERSEDED, or no row at all → promote.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 *
 * The suite upsert, the test (with its first version) and the promotion row are
 * one transaction. A promotion row that claims a test which was never written
 * is worse than no row: every retry after it would return the id of nothing.
 */
recordRouter.post('/projects/:projectId/record/promote', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const input = promoteRecordingSchema.parse(req.body);
  const projectId = String(req.params.projectId);

  /*
   * TWO PLACES NAMING THE PROJECT IS TWO FACTS IN ONE REQUEST. Preferring
   * either one silently would promote into a project the caller did not name.
   */
  if (input.projectId !== projectId) {
    throw badRequest(
      'the project in the path and the project in the body disagree, and which one was meant is not ours to guess',
    );
  }

  const computed = recordingKeyOf(input.code);
  if (computed !== input.recordingKey) {
    throw badRequest(
      'recordingKey must be the sha256 of the cleaned spec it comes with — a key that does not match its own code cannot make a retry idempotent',
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw notFound('Project');

  /*
   * `environmentId` is stored as a plain column and not a relation (an
   * environment is deletable and the record of what was recorded where must
   * outlive it), which is exactly why it has to be CHECKED here. Unvalidated,
   * it would let one org's id be filed against another org's recording.
   */
  if (input.environmentId != null) {
    const environment = await prisma.environment.findUnique({
      where: { id: input.environmentId },
      select: { id: true, projectId: true },
    });
    if (!environment || environment.projectId !== projectId) throw notFound('Environment');
  }

  const existing = await prisma.recordingPromotion.findUnique({
    where: { projectId_recordingKey: { projectId, recordingKey: input.recordingKey } },
    select: { id: true, state: true, promotedTestId: true, rejectedReason: true },
  });

  if (existing?.state === 'REJECTED') {
    throw conflict(
      'this recording was rejected, and promoting over a rejection would discard a decision somebody made',
      { recordingKey: input.recordingKey, rejectedReason: existing.rejectedReason },
    );
  }

  let replacedTestId: string | null = null;
  if (existing?.state === 'PROMOTED' && existing.promotedTestId !== null) {
    const live = await prisma.test.findUnique({
      where: { id: existing.promotedTestId },
      select: { id: true, name: true, filePath: true, suiteId: true },
    });
    if (live) {
      res.json({ test: live, idempotent: true, recordingKey: input.recordingKey });
      return;
    }
    replacedTestId = existing.promotedTestId;
  }

  const filePath = promotedFilePath(input.name, input.recordingKey);

  const test = await prisma.$transaction(async (tx) => {
    const suite = await tx.suite.upsert({
      where: { projectId_name: { projectId, name: 'Recorded' } },
      create: {
        orgId: actor.orgId,
        projectId,
        name: 'Recorded',
        description: 'Tests promoted from a recording session',
      },
      update: {},
      select: { id: true },
    });

    const created = await tx.test.create({
      data: {
        orgId: actor.orgId,
        projectId,
        suiteId: suite.id,
        name: input.name,
        type: 'E2E',
        feature: 'Recorded',
        code: input.code,
        filePath,
        versions: {
          create: {
            orgId: actor.orgId,
            version: 1,
            code: input.code,
            source: 'HUMAN',
            authorId: actor.userId,
            message: 'Promoted from a recording',
          },
        },
      },
      select: { id: true, name: true, filePath: true, suiteId: true },
    });

    await tx.recordingPromotion.upsert({
      where: { projectId_recordingKey: { projectId, recordingKey: input.recordingKey } },
      create: {
        orgId: actor.orgId,
        projectId,
        environmentId: input.environmentId ?? null,
        recordingKey: input.recordingKey,
        name: input.name,
        state: 'PROMOTED',
        promotedTestId: created.id,
        recordedBy: actor.userId,
        promotedBy: actor.userId,
        promotedAt: new Date(),
      },
      update: {
        state: 'PROMOTED',
        promotedTestId: created.id,
        promotedBy: actor.userId,
        promotedAt: new Date(),
      },
    });

    return created;
  });

  await audit({
    actor,
    action: 'recording.promote',
    targetType: 'Test',
    targetId: test.id,
    metadata: {
      recordingKey: input.recordingKey,
      environmentId: input.environmentId ?? null,
      /*
       * Null in the ordinary case. Non-null says the row already claimed a test
       * and that test was gone, which is the one path that writes a second
       * `Test` row under one promotion — so it is the one path a reader needs
       * to be able to find.
       */
      replacedTestId,
    },
  });

  res.status(201).json({ test, idempotent: false, recordingKey: input.recordingKey });
});
