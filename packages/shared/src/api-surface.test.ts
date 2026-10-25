import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_ACCESS_DECLARED,
  API_AUTH_DECLARATIONS,
  API_BOUNDARY_EDGE_KINDS,
  API_BOUNDARY_EXPECTATIONS,
  API_OPERATION_METHODS,
  API_OPERATION_VERIFICATIONS,
  BACKGROUND_SURFACE_DIMENSION,
  BACKGROUND_SURFACE_KINDS,
  BACKGROUND_TRIGGERS,
  COMPONENT_ITEM_KINDS,
  COMPONENT_STATE_KINDS,
  CONFIRMED_VERIFICATIONS,
  FLAG_PROVIDERS,
  LOCALE_CATALOGUE_READERS,
  NON_HAPPY_PATH_STATES,
  NOT_PROBED_REASONS,
  type ApiParameterBound,
  type BackgroundSurfaceFact,
  apiOperationSchema,
  apiParameterSchema,
  backgroundSurfaceAxis,
  backgroundSurfaceSchema,
  backgroundTrigger,
  boundaryEdges,
  componentHasOwnAxis,
  componentItemSchema,
  describeTrafficCaps,
} from './api-surface';
import { HTTP_METHODS } from './codebase';
import { DIMENSION_AXIS, SURFACE_DIMENSION_KINDS, SURFACE_KINDS } from './surface';

/**
 * The machine-read vocabularies, pinned at the words they were introduced with,
 * for the same reason surface.test.ts pins its own: every one of these is
 * STORED — `ApiOperation.authDeclaration`, `ApiOperation.verification`,
 * `ComponentItem.kind`, `ComponentState.kind` — so a member respelled in
 * transit does not fail to compile. It fails to match a row somebody already
 * wrote, which is silent and permanent.
 */
describe('the stored vocabularies', () => {
  it('API_AUTH_DECLARATIONS is these five, in this order', () => {
    expect([...API_AUTH_DECLARATIONS]).toEqual([
      'REQUIRED',
      'OPTIONAL',
      'NONE',
      'UNSTATED',
      'NOT_READ',
    ]);
  });

  it('keeps the document’s silence apart from ours and from "no auth"', () => {
    /*
     * The three that a boolean would have merged. NONE is the document taking a
     * position; UNSTATED is the document saying nothing; NOT_READ is US not
     * having looked. Collapsed, every operation whose document we did not read
     * reads as PUBLIC, a negative-auth test is generated, it gets a 401, and
     * the 401 is reported as the application correctly refusing anonymous
     * access — a passing test that asserted nothing.
     */
    expect([...ANONYMOUS_ACCESS_DECLARED]).toEqual(['OPTIONAL', 'NONE']);
    expect(ANONYMOUS_ACCESS_DECLARED).not.toContain('UNSTATED');
    expect(ANONYMOUS_ACCESS_DECLARED).not.toContain('NOT_READ');
    expect(ANONYMOUS_ACCESS_DECLARED).not.toContain('REQUIRED');
  });

  it('API_OPERATION_VERIFICATIONS is these four and asserts absence nowhere', () => {
    expect([...API_OPERATION_VERIFICATIONS]).toEqual([
      'DECLARED',
      'CONFIRMED',
      'NO_ANSWER',
      'NOT_PROBED',
    ]);
    /*
     * There is deliberately no REFUTED / ABSENT / NOT_FOUND member. An
     * unreloaded gateway, a flag that is off, an authorisation wall that hides
     * existence and a genuinely undeployed operation all return the same 404
     * and cannot be told apart from outside, so no member of this enum may
     * claim an operation does not exist.
     */
    for (const forbidden of ['REFUTED', 'ABSENT', 'NOT_FOUND', 'MISSING', 'GONE']) {
      expect(API_OPERATION_VERIFICATIONS).not.toContain(forbidden);
    }
    expect([...CONFIRMED_VERIFICATIONS]).toEqual(['CONFIRMED']);
  });

  it('NOT_PROBED has a reason for every way it can happen', () => {
    // NOT_PROBED with no reason is indistinguishable from a bug in the prober,
    // and BUDGET_SPENT in particular is a cap WE applied — the report has to be
    // able to say how many operations it hid.
    expect([...NOT_PROBED_REASONS]).toEqual([
      'NO_BASE_URL',
      'REFUSED_BY_POLICY',
      'BUDGET_SPENT',
      'UNSAFE_VERB',
      'NO_CREDENTIAL',
    ]);
  });

  it('API_OPERATION_METHODS is HTTP_METHODS plus UNKNOWN, and not a second list', () => {
    // Spread rather than retyped, so a verb added to `HTTP_METHODS` cannot fail
    // to be storable here. 'UNKNOWN' is a real answer carried over from
    // `HttpEndpoint.method`: an endpoint whose verbs are unreadable is still an
    // endpoint, and saying GET would be a guess dressed as a fact.
    expect([...API_OPERATION_METHODS]).toEqual([...HTTP_METHODS, 'UNKNOWN']);
  });

  it('COMPONENT_STATE_KINDS is these six, and five of them are not the happy path', () => {
    expect([...COMPONENT_STATE_KINDS]).toEqual([
      'DEFAULT',
      'LOADING',
      'EMPTY',
      'ERROR',
      'FORBIDDEN',
      'SLOW',
    ]);
    expect([...NON_HAPPY_PATH_STATES]).toEqual(['LOADING', 'EMPTY', 'ERROR', 'FORBIDDEN', 'SLOW']);
  });

  it('COMPONENT_ITEM_KINDS is these six', () => {
    expect([...COMPONENT_ITEM_KINDS]).toEqual([
      'COMPONENT',
      'PAGE',
      'LAYOUT',
      'HOOK',
      'CONTEXT_PROVIDER',
      'UTILITY',
    ]);
  });

  it('FLAG_PROVIDERS has no UNKNOWN member', () => {
    // `DimensionDetail.FLAG.provider` is `string | null` and documented as
    // "null when unknown". An UNKNOWN member would be a second spelling of the
    // same fact, and two spellings of one fact is how a filter starts missing
    // rows.
    expect(FLAG_PROVIDERS).not.toContain('UNKNOWN');
    expect(FLAG_PROVIDERS).toContain('ENV_GATE');
    expect(FLAG_PROVIDERS).toContain('LAUNCHDARKLY');
  });

  it('LOCALE_CATALOGUE_READERS names the catalogues a locale can come from', () => {
    expect(LOCALE_CATALOGUE_READERS).toContain('NEXT_INTL');
    expect(LOCALE_CATALOGUE_READERS).toContain('HREFLANG');
    expect(new Set(LOCALE_CATALOGUE_READERS).size).toBe(LOCALE_CATALOGUE_READERS.length);
  });
});

describe('componentHasOwnAxis', () => {
  it('reports the ROUTE axis for the kinds already counted on it', () => {
    /*
     * The double-counting guard. A Next.js `page.tsx` is both an exported
     * component and a ROUTE; counting it twice is not a bigger measurement of
     * the application, it is the same application divided by a larger number.
     * Three disjoint inventories on three screens is the defect this round
     * exists to end.
     */
    expect(componentHasOwnAxis('PAGE')).toBe('ROUTE');
    expect(componentHasOwnAxis('LAYOUT')).toBe('ROUTE');
  });

  it('reports null for the kinds counted nowhere else', () => {
    expect(componentHasOwnAxis('COMPONENT')).toBeNull();
    expect(componentHasOwnAxis('HOOK')).toBeNull();
    expect(componentHasOwnAxis('CONTEXT_PROVIDER')).toBeNull();
    expect(componentHasOwnAxis('UTILITY')).toBeNull();
  });

  it('answers for every kind, with an axis that exists', () => {
    for (const kind of COMPONENT_ITEM_KINDS) {
      const axis = componentHasOwnAxis(kind);
      if (axis !== null) expect(SURFACE_KINDS).toContain(axis);
    }
  });
});

describe('background surfaces', () => {
  it('names the nine the register asked for', () => {
    expect([...BACKGROUND_SURFACE_KINDS]).toEqual([
      'CRON',
      'QUEUE_CONSUMER',
      'WEBHOOK_RECEIVER',
      'OUTBOUND_EMAIL',
      'UPLOAD',
      'WEBSOCKET',
      'SSE',
      'SERVER_ACTION',
      'TRPC_PROCEDURE',
    ]);
  });

  it('maps every kind onto a dimension surface.ts already has', () => {
    // Two values and that is the point: surface.ts already decided that a job
    // and an outbound email are the two enumerable background dimensions, and
    // these nine are a finer reading of the same two rather than a third.
    for (const kind of BACKGROUND_SURFACE_KINDS) {
      expect(SURFACE_DIMENSION_KINDS).toContain(BACKGROUND_SURFACE_DIMENSION[kind]);
    }
    expect(BACKGROUND_SURFACE_DIMENSION.OUTBOUND_EMAIL).toBe('EMAIL');
    expect(BACKGROUND_SURFACE_DIMENSION.CRON).toBe('JOB');
  });

  it('derives its axis through DIMENSION_AXIS and not a second mapping', () => {
    /*
     * A second copy of "which axis does a JOB land on" is how BACKGROUND_JOB
     * and NOTIFICATION would come to be counted differently on two screens.
     * This asserts the derivation rather than the answer: change
     * `DIMENSION_AXIS` and `backgroundSurfaceAxis` moves with it.
     */
    for (const kind of BACKGROUND_SURFACE_KINDS) {
      expect(backgroundSurfaceAxis(kind)).toBe(DIMENSION_AXIS[BACKGROUND_SURFACE_DIMENSION[kind]]);
      expect(SURFACE_KINDS).toContain(backgroundSurfaceAxis(kind));
    }
    expect(backgroundSurfaceAxis('OUTBOUND_EMAIL')).toBe('NOTIFICATION');
    expect(backgroundSurfaceAxis('QUEUE_CONSUMER')).toBe('BACKGROUND_JOB');
  });

  it('keeps the JOB trigger inside the five words surface.ts documents', () => {
    /*
     * `DimensionDetail.JOB.trigger`'s doc comment names five words. Writing
     * nine into that field would make the comment false, and a doc comment that
     * contradicts the code under it is one of the lies this product cannot
     * afford. The finer kind lives in `CoverageItem.meta` instead.
     */
    expect([...BACKGROUND_TRIGGERS]).toEqual(['CRON', 'QUEUE', 'WEBHOOK', 'STARTUP', 'MANUAL']);
    for (const kind of BACKGROUND_SURFACE_KINDS) {
      const trigger = backgroundTrigger(kind);
      if (trigger !== null) expect(BACKGROUND_TRIGGERS).toContain(trigger);
    }
  });

  it('gives OUTBOUND_EMAIL no trigger, because EMAIL detail has no such field', () => {
    expect(backgroundTrigger('OUTBOUND_EMAIL')).toBeNull();
  });

  it('calls a long-lived connection STARTUP and not WEBHOOK', () => {
    // Nothing posts to a websocket or an SSE stream, so an unsigned-payload
    // negative test makes no sense against one — which is the decision this
    // mapping encodes rather than leaving to each reader.
    expect(backgroundTrigger('WEBSOCKET')).toBe('STARTUP');
    expect(backgroundTrigger('SSE')).toBe('STARTUP');
    expect(backgroundTrigger('WEBHOOK_RECEIVER')).toBe('WEBHOOK');
  });
});

/**
 * The write path, and both halves of the guard eight unsaveable GateRule kinds
 * earned this codebase: the compiler enforces `BACKGROUND_SURFACE_KINDS`
 * against the union, and this enforces zod's own options against that list at
 * run time.
 */
function zodBackgroundKinds(): string[] {
  return backgroundSurfaceSchema.options.map((option) => option.shape.kind.value as string);
}

describe('backgroundSurfaceSchema ⇄ BackgroundSurfaceFact parity', () => {
  it('has one arm for every kind the union names, and no others', () => {
    expect(zodBackgroundKinds().slice().sort()).toEqual([...BACKGROUND_SURFACE_KINDS].sort());
  });

  it('refuses a kind the union does not have', () => {
    expect(backgroundSurfaceSchema.safeParse({ kind: 'GRPC_METHOD', method: 'x' }).success).toBe(
      false,
    );
  });

  it('accepts one of each, so no arm is unsaveable', () => {
    const accepted: readonly BackgroundSurfaceFact[] = [
      { kind: 'CRON', expression: '@daily', handler: 'src/jobs/digest.ts' },
      { kind: 'QUEUE_CONSUMER', queue: 'notify', concurrency: 4, handler: null },
      { kind: 'WEBHOOK_RECEIVER', path: '/webhooks/stripe', signatureScheme: 'stripe-signature' },
      { kind: 'OUTBOUND_EMAIL', templateId: 'invoice-paid', sentBy: 'the billing worker' },
      { kind: 'UPLOAD', path: '/api/avatar', acceptedTypes: ['image/png'], maxBytes: 2_000_000 },
      { kind: 'WEBSOCKET', path: '/ws/runs', events: ['run.finished'] },
      { kind: 'SSE', path: '/events/runs', events: [] },
      { kind: 'SERVER_ACTION', module: 'app/orders/actions.ts', exportName: 'refund' },
      { kind: 'TRPC_PROCEDURE', procedure: 'billing.invoices.list', mutation: false },
    ];
    expect(accepted.map((fact) => fact.kind).sort()).toEqual([...BACKGROUND_SURFACE_KINDS].sort());
    for (const fact of accepted) {
      const parsed = backgroundSurfaceSchema.safeParse(fact);
      expect(parsed.success, `${fact.kind} is unsaveable`).toBe(true);
    }
  });

  it('refuses a path that is not matched against a URL path', () => {
    // The same rule `pathGlob` in schemas.ts enforces: a receiver declared as
    // `webhooks/stripe` silently matches nothing, because it is compared
    // against a pathname that always has a leading slash.
    expect(
      backgroundSurfaceSchema.safeParse({
        kind: 'WEBHOOK_RECEIVER',
        path: 'webhooks/stripe',
        signatureScheme: null,
      }).success,
    ).toBe(false);
  });

  it('defaults a webhook’s signature scheme to null, which is not "none"', () => {
    // "We could not tell" and "the receiver authenticates nothing" are
    // different facts, and the difference decides whether an unsigned-payload
    // test is a valid negative case or a guess.
    const parsed = backgroundSurfaceSchema.parse({
      kind: 'WEBHOOK_RECEIVER',
      path: '/webhooks/stripe',
    });
    expect(parsed).toEqual({
      kind: 'WEBHOOK_RECEIVER',
      path: '/webhooks/stripe',
      signatureScheme: null,
    });
  });
});

describe('boundaryEdges', () => {
  const bound = (over: Partial<ApiParameterBound>): ApiParameterBound => ({
    name: 'limit',
    location: 'QUERY',
    required: null,
    type: 'integer',
    ...over,
  });

  it('emits both sides of a numeric minimum, with the right expectation', () => {
    /*
     * The off-by-one this function exists to centralise. A test asserting that
     * the application rejects `minimum` itself would pass against a buggy
     * application and FAIL against a correct one, which is the worst kind of
     * generated test: it is red when the code is right.
     */
    const edges = boundaryEdges(bound({ minimum: 1 }));
    expect(edges).toEqual([
      {
        kind: 'BELOW_MINIMUM',
        value: 0,
        expectation: 'REJECT',
        reason: 'the document declares minimum 1, so 0 is out of range',
      },
      {
        kind: 'AT_MINIMUM',
        value: 1,
        expectation: 'ACCEPT',
        reason: 'the document declares minimum 1 inclusive',
      },
    ]);
  });

  it('emits both sides of a maximum', () => {
    const edges = boundaryEdges(bound({ maximum: 100 }));
    expect(edges.map((edge) => [edge.kind, edge.value, edge.expectation])).toEqual([
      ['AT_MAXIMUM', 100, 'ACCEPT'],
      ['ABOVE_MAXIMUM', 101, 'REJECT'],
    ]);
  });

  it('emits nothing at all for a pattern', () => {
    /*
     * Constructing a string that matches an arbitrary regular expression is not
     * something this module will pretend to do. Inventing one that happens to
     * match would produce a test asserting the application accepts a value we
     * GUESSED — a measured claim about something we did not measure.
     */
    expect(boundaryEdges(bound({ pattern: '^[A-Z]{3}-\\d{4}$' }))).toEqual([]);
  });

  it('emits no length edge below a minLength of 0', () => {
    // `minLength: 0` is satisfied by the empty string, so there is no shorter
    // string to send. An edge here would be a value of length -1.
    expect(boundaryEdges(bound({ minLength: 0 }))).toEqual([]);
    expect(boundaryEdges(bound({ minLength: 3 })).map((edge) => edge.value)).toEqual([2]);
  });

  it('emits a value guaranteed not to be in a declared enum', () => {
    // Derived from the members rather than a hard-coded sentinel, because a
    // sentinel is a value one customer's enum will one day contain — and the
    // negative test would then assert a rejection of a documented value.
    const edges = boundaryEdges(bound({ enumValues: ['asc', 'desc'] }));
    const outside = edges.find((edge) => edge.kind === 'OUTSIDE_ENUM');
    expect(outside?.expectation).toBe('REJECT');
    expect(['asc', 'desc']).not.toContain(outside?.value);
    expect(edges.find((edge) => edge.kind === 'IN_ENUM')?.value).toBe('asc');
  });

  it('emits an omission edge only when the document says REQUIRED', () => {
    /*
     * OpenAPI defaults `required` to false, so "not annotated" and "declared
     * optional" are indistinguishable. Asserting a rejection from `required:
     * null` would be asserting from a default nobody wrote.
     */
    expect(boundaryEdges(bound({ required: true })).map((edge) => edge.kind)).toEqual(['OMITTED']);
    expect(boundaryEdges(bound({ required: false }))).toEqual([]);
    expect(boundaryEdges(bound({ required: null }))).toEqual([]);
  });

  it('adds the bounds and never multiplies them', () => {
    // Two bounds on one parameter are two edges to try, not four combinations —
    // the same argument `multiAxisDenominator` makes for not multiplying
    // dimensions.
    const both = boundaryEdges(bound({ minimum: 1, maximum: 10 }));
    expect(both).toHaveLength(4);
  });

  it('emits nothing when the declaration states no bound at all', () => {
    // An empty list here is the honest answer: the document declared nothing to
    // generate from. It is NOT the same as a pattern we cannot use, and both
    // are distinguishable by the caller because the bound fields differ.
    expect(boundaryEdges(bound({}))).toEqual([]);
    expect(boundaryEdges(bound({ minimum: null, maximum: null, maxLength: null }))).toEqual([]);
  });

  it('only ever uses declared kinds and expectations', () => {
    const edges = boundaryEdges(
      bound({ minimum: 1, maximum: 9, minLength: 2, maxLength: 8, enumValues: ['a'], required: true }),
    );
    for (const edge of edges) {
      expect(API_BOUNDARY_EDGE_KINDS).toContain(edge.kind);
      expect(API_BOUNDARY_EXPECTATIONS).toContain(edge.expectation);
      expect(edge.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('apiParameterSchema', () => {
  it('keeps an absent bound absent and an explicit null null', () => {
    /*
     * The three-state capture, and the reason every bound is `.optional()` AND
     * `.nullable()` rather than `.default(null)`. Absent means this reader does
     * not capture the constraint; explicit null means the declaration states no
     * bound. A `maxLength` missing because our reader ignores the keyword is a
     * problem in US, and defaulting it would report it as the application's.
     */
    const parsed = apiParameterSchema.parse({
      name: 'limit',
      location: 'QUERY',
      maxLength: null,
    });
    expect('maxLength' in parsed).toBe(true);
    expect(parsed.maxLength).toBeNull();
    expect('minimum' in parsed).toBe(false);
  });

  it('defaults `required` to null and not to false', () => {
    // OpenAPI's own default is false, and adopting it here would turn "the
    // author never annotated this" into "the author declared it optional".
    expect(apiParameterSchema.parse({ name: 'id', location: 'PATH' }).required).toBeNull();
  });

  it('refuses a location outside the vocabulary', () => {
    expect(apiParameterSchema.safeParse({ name: 'x', location: 'FORM' }).success).toBe(false);
  });
});

describe('apiOperationSchema', () => {
  const valid = {
    method: 'POST',
    pathTemplate: '/orders/{id}/refund',
    sourceDocument: 'https://api.example.com/openapi.json',
    authDeclaration: 'REQUIRED',
    evidence: 'declared in the OpenAPI document at paths./orders/{id}/refund.post',
  };

  it('accepts an operation with no operationId and no shapes', () => {
    const parsed = apiOperationSchema.parse(valid);
    expect(parsed.operationId).toBeNull();
    expect(parsed.requestShape).toBeNull();
    expect(parsed.parameters).toEqual([]);
  });

  it('requires a source document', () => {
    // An operation with no provenance cannot be re-read, re-diffed or disputed.
    const { sourceDocument: _omitted, ...without } = valid;
    expect(apiOperationSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a path template that is not a URL path', () => {
    expect(
      apiOperationSchema.safeParse({ ...valid, pathTemplate: 'orders/{id}' }).success,
    ).toBe(false);
  });

  it('accepts UNKNOWN as a verb', () => {
    expect(apiOperationSchema.safeParse({ ...valid, method: 'UNKNOWN' }).success).toBe(true);
    expect(apiOperationSchema.safeParse({ ...valid, method: 'FETCH' }).success).toBe(false);
  });
});

describe('componentItemSchema', () => {
  it('defaults hasCatalogueEntry to null, which is not false', () => {
    /*
     * Null means NO CATALOGUE WAS READ; false means one was and this component
     * is not in it. Null read as false reports "nothing is in Storybook" about
     * a project whose Storybook we never looked for — a measured claim about
     * something not measured.
     */
    const parsed = componentItemSchema.parse({
      modulePath: 'src/components/OrderTable.tsx',
      exportName: 'OrderTable',
      kind: 'COMPONENT',
      evidence: 'default export of a .tsx module returning JSX',
    });
    expect(parsed.hasCatalogueEntry).toBeNull();
    expect(parsed.catalogueRef).toBeNull();
    expect(parsed.propsSummary).toBeNull();
  });

  it('accepts `default` as an export name', () => {
    expect(
      componentItemSchema.safeParse({
        modulePath: 'app/orders/page.tsx',
        exportName: 'default',
        kind: 'PAGE',
        evidence: 'app/orders/page.tsx — the directory path is the URL',
      }).success,
    ).toBe(true);
  });
});

describe('describeTrafficCaps', () => {
  const accounting = {
    entriesParsed: 50_000,
    entriesSkipped: 120,
    sessions: 3_100,
    journeysStored: 40,
    journeysDroppedByCap: 212,
    capsThatBit: [{ cap: 'maxJourneys', limit: 40, droppedAtLeast: 212 }],
    rule: '',
  };

  it('says "at least N more existed" rather than "stopped early"', () => {
    /*
     * The difference between a shrug and a number that tells a reader how wrong
     * the percentage is. Every cap here is a lever that makes coverage go UP,
     * because truncating shrinks the denominator while the tests that already
     * exist do not move.
     */
    const sentence = describeTrafficCaps(accounting);
    expect(sentence).toContain('at least 212 more existed');
    expect(sentence).toContain('maxJourneys (limit 40)');
  });

  it('says plainly when no cap bit, rather than saying nothing', () => {
    // An empty list because none bit and an empty list because nobody looked
    // are different facts; this is the first one, stated.
    expect(describeTrafficCaps({ ...accounting, capsThatBit: [], journeysStored: 12 })).toBe(
      'no cap bit: all 12 journey(s) the analysis found were stored',
    );
  });

  it('names every cap that bit, not just the first', () => {
    const sentence = describeTrafficCaps({
      ...accounting,
      journeysDroppedByCap: 260,
      capsThatBit: [
        { cap: 'maxJourneys', limit: 40, droppedAtLeast: 212 },
        { cap: 'maxEntries', limit: 50_000, droppedAtLeast: 48 },
      ],
    });
    expect(sentence).toContain('maxJourneys');
    expect(sentence).toContain('maxEntries');
    expect(sentence).toContain('at least 260 more existed');
  });
});
