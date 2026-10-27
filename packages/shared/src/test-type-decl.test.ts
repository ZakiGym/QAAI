import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANY_TEST_TYPES,
  PENDING_TEST_TYPES,
  PENDING_TEST_TYPE_LABELS,
  TEST_TYPES,
  TEST_TYPE_LABELS,
  isPendingTestType,
  isTestType,
  mintTestTypeSteps,
} from './constants';
import {
  ALL_TEST_TYPE_DECLARATIONS,
  DATA_EFFECTS,
  DATA_EFFECT_LIST,
  DECLARABLE_PRINCIPAL_KINDS,
  DECLARABLE_SURFACE_KINDS,
  DECLARED_TEST_TYPE_NAMES,
  DEVICE_NEEDS,
  DEVICE_NEED_LIST,
  EGRESS_NEEDS,
  EGRESS_NEED_LIST,
  MUTATING_DATA_EFFECTS,
  OUR_UNASSERTED_REASONS,
  PENDING_TEST_TYPE_DECLARATIONS,
  REPOSITORY_NEEDS,
  REPOSITORY_NEED_LIST,
  TEST_TYPE_DECLARATIONS,
  TEST_TYPE_PRODUCERS,
  TEST_TYPE_PRODUCER_LIST,
  UNASSERTED_REASONS,
  UNASSERTED_REASON_LABELS,
  UNASSERTED_REASON_LIST,
  declarationFor,
  declarationProblems,
  incoherentDeclarations,
  requirementsForType,
  surfaceKindsNoTypeCovers,
  typesEmittableBy,
  typesNeedingMaterialisedRepo,
  typesWithNoProducer,
} from './test-type-decl';
import type { TestTypeDeclaration } from './test-type-decl';
import {
  CHAOS_FAULTS,
  CHAOS_FAULT_LIST,
  DEVICE_BOUND_PUSH_TRANSPORTS,
  DOCUMENT_SOURCES,
  DOCUMENT_SOURCE_LIST,
  I18N_CHECKS,
  I18N_CHECK_LIST,
  OUTCOME_FORCING_SCENARIOS,
  PAYMENT_SCENARIO_KINDS,
  PAYMENT_SCENARIO_KIND_LIST,
  PUSH_TRANSPORTS,
  PUSH_TRANSPORT_LIST,
  PWA_CHECKS,
  PWA_CHECK_LIST,
  chaosFaultSchema,
  chaosTestSpecSchema,
  dataEffectSchema,
  deviceNeedSchema,
  documentArtifactSchema,
  documentSourceSchema,
  egressNeedSchema,
  i18nCheckSchema,
  i18nDeepSpecSchema,
  isRtlLocale,
  paymentScenarioKindSchema,
  paymentScenarioSchema,
  pushDeliverySchema,
  pushTransportSchema,
  pwaCheckSchema,
  pwaTestSpecSchema,
  repositoryNeedSchema,
  testResultVariantCellSchema,
  testTypeDeclarationSchema,
  testTypeProducerSchema,
  unassertedReasonSchema,
} from './schemas';
import { PRINCIPAL_KINDS } from './principals';
import { SURFACE_KINDS } from './surface';

/*
 * ── The parity guards ───────────────────────────────────────────────────────
 *
 * Same two-mechanism arrangement as principals.ts and browser-matrix.ts, for
 * the same reason: the `Record<Union, true>` in the module is the compiler half
 * and makes every `*_LIST` derived, and these are the run-time half, because
 * zod's `.options` exist only at run time and `check:wiring` cannot see a list
 * that grew without its write path.
 */
describe('every closed union has both halves of its parity guard', () => {
  const pairs: Array<[string, readonly string[], readonly string[], { options: readonly string[] }]> =
    [
      [
        'TEST_TYPE_PRODUCERS',
        TEST_TYPE_PRODUCERS,
        TEST_TYPE_PRODUCER_LIST,
        testTypeProducerSchema,
      ],
      ['REPOSITORY_NEEDS', REPOSITORY_NEEDS, REPOSITORY_NEED_LIST, repositoryNeedSchema],
      ['DEVICE_NEEDS', DEVICE_NEEDS, DEVICE_NEED_LIST, deviceNeedSchema],
      ['EGRESS_NEEDS', EGRESS_NEEDS, EGRESS_NEED_LIST, egressNeedSchema],
      ['DATA_EFFECTS', DATA_EFFECTS, DATA_EFFECT_LIST, dataEffectSchema],
      ['UNASSERTED_REASONS', UNASSERTED_REASONS, UNASSERTED_REASON_LIST, unassertedReasonSchema],
    ];

  it.each(pairs)('%s: the derived list is the declared list', (_n, declared, derived) => {
    expect([...derived].sort()).toEqual([...declared].sort());
  });

  it.each(pairs)("%s: the zod schema's options are the declared list", (_n, declared, _d, schema) => {
    expect([...schema.options].sort()).toEqual([...declared].sort());
  });

  it('labels every unasserted reason, because a code with no sentence is unactionable', () => {
    for (const reason of UNASSERTED_REASONS) {
      expect(UNASSERTED_REASON_LABELS[reason].length, reason).toBeGreaterThan(0);
    }
  });

  it('keeps OUR gap apart from the environment’s', () => {
    // The two halves go to different people: NOT_IMPLEMENTED is a roadmap item
    // and CAPABILITY_ABSENT is a Dockerfile line. A report that merged them
    // would send a customer to install something that does not exist.
    expect(OUR_UNASSERTED_REASONS).toContain('NOT_IMPLEMENTED');
    expect(OUR_UNASSERTED_REASONS).not.toContain('CAPABILITY_ABSENT');
    expect(OUR_UNASSERTED_REASONS).not.toContain('PROVIDER_TEST_MODE_LIMIT');
    for (const reason of OUR_UNASSERTED_REASONS) expect(UNASSERTED_REASONS).toContain(reason);
  });

  it('derives the declarable principal and surface vocabularies rather than restating them', () => {
    // A hand-written parallel list is how BROWSER_ENGINES came to exist twice,
    // and how the provider catalogue's shape probe came to cover 16 of 27
    // declared shapes.
    expect(DECLARABLE_PRINCIPAL_KINDS).toEqual(PRINCIPAL_KINDS);
    expect(DECLARABLE_SURFACE_KINDS).toEqual(SURFACE_KINDS);
  });
});

describe('the new types\u2019 own vocabularies have both halves too', () => {
  /*
   * Six closed unions belonging to the seven pending types. Their write paths
   * ship this round and their plugins do not, which is exactly the window in
   * which a list and its `z.enum` drift apart unnoticed — the eight unsaveable
   * GateRule kinds were born in the same window.
   */
  const pairs: Array<[string, readonly string[], readonly string[], { options: readonly string[] }]> =
    [
      [
        'PAYMENT_SCENARIO_KINDS',
        PAYMENT_SCENARIO_KINDS,
        PAYMENT_SCENARIO_KIND_LIST,
        paymentScenarioKindSchema,
      ],
      ['DOCUMENT_SOURCES', DOCUMENT_SOURCES, DOCUMENT_SOURCE_LIST, documentSourceSchema],
      ['PWA_CHECKS', PWA_CHECKS, PWA_CHECK_LIST, pwaCheckSchema],
      ['PUSH_TRANSPORTS', PUSH_TRANSPORTS, PUSH_TRANSPORT_LIST, pushTransportSchema],
      ['CHAOS_FAULTS', CHAOS_FAULTS, CHAOS_FAULT_LIST, chaosFaultSchema],
      ['I18N_CHECKS', I18N_CHECKS, I18N_CHECK_LIST, i18nCheckSchema],
    ];

  it.each(pairs)('%s: the derived list is the declared list', (_n, declared, derived) => {
    expect([...derived].sort()).toEqual([...declared].sort());
  });

  it.each(pairs)("%s: the zod schema's options are the declared list", (_n, declared, _d, schema) => {
    expect([...schema.options].sort()).toEqual([...declared].sort());
  });

  it('keeps the outcome-forcing scenarios a subset of the scenario kinds', () => {
    // A member of this list that is not a scenario kind is a refusal that can
    // never fire, so a decline test would drive an ordinary card and pass.
    for (const kind of OUTCOME_FORCING_SCENARIOS) expect(PAYMENT_SCENARIO_KINDS).toContain(kind);
    // And WEBHOOK_TRANSITION is deliberately NOT in it: the event, not a card,
    // is what forces that outcome.
    expect(OUTCOME_FORCING_SCENARIOS).not.toContain('WEBHOOK_TRANSITION');
  });

  it('keeps the device-bound push transports a subset of the transports', () => {
    for (const t of DEVICE_BOUND_PUSH_TRANSPORTS) expect(PUSH_TRANSPORTS).toContain(t);
    // WEB_PUSH is the one arm an emulated browser context can serve.
    expect(DEVICE_BOUND_PUSH_TRANSPORTS).not.toContain('WEB_PUSH');
  });

  it('recognises an RTL locale by its language subtag, not its region', () => {
    expect(isRtlLocale('ar-EG')).toBe(true);
    expect(isRtlLocale('he')).toBe(true);
    expect(isRtlLocale('HE-IL')).toBe(true);
    expect(isRtlLocale('de-DE')).toBe(false);
    // `ar` as a REGION is not a right-to-left locale, which a substring match
    // would have got wrong: es-AR is Argentina.
    expect(isRtlLocale('es-AR')).toBe(false);
  });
});

describe('the two tiers of the registry', () => {
  it('declares every MINTED type, with no gap for the compiler to find at run time', () => {
    // A `Record<TestType, …>` is the compiler half; this is the run-time one,
    // because a minted type with no declaration is a type the preflight cannot
    // describe and the funnel cannot route to.
    expect(Object.keys(TEST_TYPE_DECLARATIONS).sort()).toEqual([...TEST_TYPES].sort());
  });

  it('declares every PENDING type', () => {
    expect(Object.keys(PENDING_TEST_TYPE_DECLARATIONS).sort()).toEqual([...PENDING_TEST_TYPES].sort());
  });

  it('keeps the two tiers disjoint', () => {
    /*
     * The guard on the guard, and the one that catches the NEXT person. A name
     * in both lists means somebody minted a type and left its pending entry
     * behind, so `ALL_TEST_TYPE_DECLARATIONS` would carry whichever spread won —
     * and the declaration a preflight reads would be the stale one.
     */
    for (const pending of PENDING_TEST_TYPES) {
      expect((TEST_TYPES as readonly string[]).includes(pending), pending).toBe(false);
    }
  });

  it('merges both tiers into one lookup with nothing lost', () => {
    expect(Object.keys(ALL_TEST_TYPE_DECLARATIONS).sort()).toEqual([...ANY_TEST_TYPES].sort());
    expect(DECLARED_TEST_TYPE_NAMES).toHaveLength(TEST_TYPES.length + PENDING_TEST_TYPES.length);
  });

  it('gives every declaration a type field that matches the key it is filed under', () => {
    // Nothing in the type system ties them together, so a copy-paste that filed
    // the PUSH declaration under PWA would compile and then describe the wrong
    // type's requirements to a preflight.
    for (const [key, decl] of Object.entries(ALL_TEST_TYPE_DECLARATIONS)) {
      expect(String(decl.type), key).toBe(key);
    }
  });

  it('labels both tiers, so a surface can offer or refuse a type by name', () => {
    for (const type of TEST_TYPES) expect(TEST_TYPE_LABELS[type].length).toBeGreaterThan(0);
    for (const type of PENDING_TEST_TYPES) {
      expect(PENDING_TEST_TYPE_LABELS[type].length, type).toBeGreaterThan(0);
    }
  });

  it('narrows a minted type and a pending one differently', () => {
    // "QAAI cannot test your Electron app" and "QAAI can, and you cannot create
    // the test yet" are different facts with different remedies.
    expect(isTestType('E2E')).toBe(true);
    expect(isTestType('PAYMENTS')).toBe(false);
    expect(isPendingTestType('PAYMENTS')).toBe(true);
    expect(isPendingTestType('E2E')).toBe(false);
    expect(isTestType('NOT_A_TYPE')).toBe(false);
    expect(isPendingTestType(null)).toBe(false);
  });

  it('names all four mint edits, not the two a reader would guess', () => {
    /*
     * `reasonUnsupported` in packages/runner/src/registry.ts could only say two
     * of the four, and a remedy that is three-quarters complete sends somebody
     * to ship a mint that fails a different guard. All four edits go in ONE
     * change, because the three guards are mutually blocking.
     */
    const steps = mintTestTypeSteps('PAYMENTS');
    expect(steps).toHaveLength(4);
    const joined = steps.join('\n');
    expect(joined).toMatch(/TEST_TYPES in packages\/shared\/src\/constants\.ts/);
    expect(joined).toMatch(/test-type-decl\.ts/);
    expect(joined).toMatch(/ALTER TYPE "TestType" ADD VALUE 'PAYMENTS'/);
    expect(joined).toMatch(/preflight\.ts/);
    expect(joined).toMatch(/spec-strategies\.ts/);
  });
});

describe('every shipped declaration holds together', () => {
  it('reports no incoherent declaration across both tiers', () => {
    /*
     * The check that matters, because a rule nothing in the product satisfies is
     * a rule somebody deletes. Asserted over the SHIPPED tables rather than over
     * a fixture.
     */
    expect(incoherentDeclarations()).toEqual([]);
  });

  it('refuses a BROWSER type that mutates data with no principal', () => {
    // A browser type that changes the customer's data with no identity named is
    // a type nothing can refuse to point at their production login, and
    // `proveDisposable` never gets asked.
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.E2E,
      dataEffect: 'WRITES',
      principalKinds: [],
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/no principal kind is declared/);
  });

  it('does not demand a principal from a type that acts as a checkout or a connection', () => {
    /*
     * The narrowing this test pins, and the reason for it. The broad version of
     * the rule refused four of the product's own declarations — INTEGRATION,
     * DATABASE, CLI and JOBS — each correctly: `npm test` runs as the checkout,
     * a DATABASE test as a connection string, a CLI test as a shell, JOBS
     * through a broker. There is no identity for a `Principal` to BE, and
     * satisfying the rule would have meant writing PERSISTENT into all four,
     * which is a claim nothing produced about an actor that does not exist.
     */
    for (const type of ['INTEGRATION', 'DATABASE', 'CLI'] as const) {
      expect(TEST_TYPE_DECLARATIONS[type].dataEffect, type).toBe('WRITES');
      expect(TEST_TYPE_DECLARATIONS[type].principalKinds, type).toEqual([]);
      expect(declarationProblems(TEST_TYPE_DECLARATIONS[type]), type).toEqual([]);
    }
    // And what guards them instead is declared rather than assumed.
    expect(TEST_TYPE_DECLARATIONS.INTEGRATION.repository).toBe('MATERIALISED');
    expect(
      TEST_TYPE_DECLARATIONS.DATABASE.requirements.some((r) => r.kind === 'UNPROBED'),
    ).toBe(true);
  });

  it('keeps the DESTROYS rule unconditional, including for a non-browser type', () => {
    // Where the teeth are: destroying data is the one effect that costs the
    // customer something they cannot get back, so a type with no engine at all
    // must still say whose disposable identity it is destroying.
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.CLI,
      dataEffect: 'DESTROYS',
    };
    expect(decl.engines).toEqual([]);
    expect(declarationProblems(decl).join(' ')).toMatch(/costs the customer the only way in/);
  });

  it('refuses DESTROYS without a DISPOSABLE principal', () => {
    // Signing out, expiring a session or deleting a row against a PERSISTENT
    // identity costs the customer the only way in.
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.E2E,
      dataEffect: 'DESTROYS',
      principalKinds: ['PERSISTENT'],
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/costs the customer the only way in/);
    expect(
      declarationProblems({ ...decl, principalKinds: ['DISPOSABLE'] }).join(' '),
    ).not.toMatch(/only way in/);
  });

  it('refuses a provider-test-mode type that does not refuse live credentials', () => {
    const decl: TestTypeDeclaration = {
      ...PENDING_TEST_TYPE_DECLARATIONS.PAYMENTS,
      refusesLiveCredentials: false,
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/structurally incapable/);
  });

  it('refuses an empty producer list, which says nothing', () => {
    const decl: TestTypeDeclaration = { ...TEST_TYPE_DECLARATIONS.API, producers: [] };
    expect(declarationProblems(decl).join(' ')).toMatch(/\['NONE'\]/);
  });

  it('refuses NONE beside a real producer, which is a contradiction', () => {
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.API,
      producers: ['NONE', 'CRAWL'],
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/contradiction/);
  });

  it('refuses an emulated device with no engine to drive it', () => {
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.API,
      device: 'EMULATED',
      engines: [],
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/something has to drive it/);
  });

  it('refuses a browser requirement for an engine the type says it never drives', () => {
    const decl: TestTypeDeclaration = {
      ...TEST_TYPE_DECLARATIONS.VISUAL,
      requirements: [
        { kind: 'BROWSER', scope: 'TYPE', name: 'webkit', install: 'npx playwright install' },
      ],
    };
    expect(declarationProblems(decl).join(' ')).toMatch(/says it never drives/);
  });

  it('declares MUTATING_DATA_EFFECTS as the two above READS_ONLY', () => {
    expect([...MUTATING_DATA_EFFECTS].sort()).toEqual(['DESTROYS', 'WRITES']);
  });
});

describe('the funnel’s width is a value, not a comment', () => {
  it('no longer names the three dead plugins, because a producer now emits them', () => {
    /*
     * ── THIS ASSERTION WAS INVERTED, AND THE INVERSION IS THE ROUND ─────────
     *
     * It used to read `expect(dead).toContain(type)` for LOCALIZATION, MOBILE
     * and CROSS_BROWSER: three working plugins that NO PRODUCER EVER EMITTED.
     * The deterministic type funnel in packages/agent/src/explorer.ts
     * (`TYPE_PRECONDITIONS` / `proposeTypeCoverage`) now emits all three from
     * observed signals, and it is REACHED — `planFromCrawl` in
     * apps/worker/src/processors/explore.ts calls it on the no-key path every
     * new customer takes.
     *
     * KEPT BY NAME AND NOT DELETED, and still pinned in both directions, so it
     * keeps exactly the teeth it had: if somebody removes the funnel, or drops
     * DETERMINISTIC from one of these declarations, this goes red and names the
     * type. A test that merely checked the list had shrunk would be satisfied
     * by one type leaving as another joined, which is the trap the original
     * comment recorded.
     */
    const dead = typesWithNoProducer();
    for (const type of ['LOCALIZATION', 'MOBILE', 'CROSS_BROWSER'] as const) {
      expect(dead, type).not.toContain(type);
      expect(TEST_TYPE_DECLARATIONS[type].producers, type).toContain('DETERMINISTIC');
      expect(typesEmittableBy('DETERMINISTIC'), type).toContain(type);
    }
  });

  it('no longer names UNIT_GEN, whose emptiness cost the logic half of every application', () => {
    /*
     * The four halves of that defect, and which change closed each one:
     *
     *   · no producer emitted a UNIT_GEN item → the type funnel emits one when
     *     a declared unit runner AND testable logic are both observed, and
     *     apps/worker/src/processors/analyze-source.ts emits one from source
     *     analysis;
     *   · the prompt handed the model crawl locators → apps/worker/src/lib/
     *     workspace.ts reads the function under test out of the materialised
     *     checkout, fenced as untrusted data;
     *   · the external plugin never read `test.code` → `writeGeneratedTest` in
     *     packages/runner/src/plugins/external.ts now writes it before the
     *     command runs, so the command no longer points at a file that does not
     *     exist;
     *   · the repository was never materialised → `materialiseRepoWorkspace` is
     *     called by processors/run.ts and `runWorkspaceOf(ctx)` is what the
     *     INTEGRATION, UNIT_GEN and MUTATION plugins resolve against.
     *
     * `knownUnasserted` is asserted NON-EMPTY rather than dropped: the type is
     * reachable now and it still does not assert everything it eventually
     * should, and erasing that list would turn a stated hole into a silent one.
     */
    expect(typesWithNoProducer()).not.toContain('UNIT_GEN');
    expect(TEST_TYPE_DECLARATIONS.UNIT_GEN.producers).toContain('DETERMINISTIC');
    expect(TEST_TYPE_DECLARATIONS.UNIT_GEN.producers).toContain('SOURCE_ANALYSIS');
    expect(TEST_TYPE_DECLARATIONS.UNIT_GEN.knownUnasserted.length).toBeGreaterThan(0);
  });

  it('leaves exactly the two types nothing emits, and names them', () => {
    /*
     * The gap that REMAINS, pinned so it cannot grow silently. DESKTOP and JOBS
     * have working plugins, declared preconditions in the funnel's table, and
     * `producers: ['NONE']` — because both are PENDING: `TEST_TYPES` does not
     * contain either, so `planItemSchema.testType` would reject an item
     * carrying one and the funnel reports them UNMINTED rather than emitting
     * something the validator throws away.
     *
     * The other nine pending types declare DETERMINISTIC and cannot be emitted
     * today either, which is an inconsistency in how `producers` is read for a
     * pending type — "who emits it today" versus "who will emit it once
     * minted". It is recorded in this round's handover rather than resolved
     * here, because resolving it means rewriting nine entries on a reading
     * their author did not choose.
     */
    expect(typesWithNoProducer().sort()).toEqual(['DESKTOP', 'JOBS']);
  });

  it('does not claim a producer for a type that has none, in either direction', () => {
    // The two reads are complements, so a type in neither or both is a bug in
    // one of them.
    const dead = new Set(typesWithNoProducer());
    for (const [name, decl] of Object.entries(ALL_TEST_TYPE_DECLARATIONS)) {
      const hasReal = decl.producers.some((p) => p !== 'NONE');
      expect(dead.has(name), name).toBe(!hasReal);
    }
  });

  it('lets the funnel be audited from the producer end too', () => {
    expect(typesEmittableBy('CRAWL')).toContain('E2E');
    expect(typesEmittableBy('CRAWL')).not.toContain('MOBILE');
    // Every new type this round declares is DETERMINISTIC, which is what makes
    // it viable with no API key.
    for (const type of ['CHAOS', 'PAYMENTS', 'DOCUMENT', 'PWA', 'PUSH', 'I18N_DEEP']) {
      expect(typesEmittableBy('DETERMINISTIC'), type).toContain(type);
    }
  });

  it('names the three types that execute inside the customer’s checkout', () => {
    /*
     * The defect this value closes: INTEGRATION, UNIT_GEN and MUTATION executed
     * against the WORKER'S OWN DIRECTORY, so the command resolved against QAAI's
     * package manifest and "no tests found" was reported as a result about the
     * customer's application. `buildRepoTree` already existed; only the zip
     * route used it.
     */
    const materialised = typesNeedingMaterialisedRepo();
    for (const type of ['INTEGRATION', 'UNIT_GEN', 'MUTATION']) {
      expect(materialised, type).toContain(type);
    }
    // And not the browser types, which have no checkout to run in.
    expect(materialised).not.toContain('E2E');
    expect(materialised).not.toContain('VISUAL');
  });

  it('closes the BACKGROUND_JOB and NOTIFICATION surface gaps', () => {
    // Both have been counted by the inventory since it was built while nothing
    // could execute one — a permanent, unexplained shortfall in a denominator.
    const uncovered = surfaceKindsNoTypeCovers();
    expect(uncovered).not.toContain('BACKGROUND_JOB');
    expect(uncovered).not.toContain('NOTIFICATION');
  });

  it('names the surface kinds that still have no type at all, rather than hiding them', () => {
    // Computed, not listed, so it cannot claim a gap a new declaration closed.
    // The assertion is that the read WORKS and is honest, not that the list is
    // empty — a shortfall nobody can act on must be visible, not denied.
    const uncovered = surfaceKindsNoTypeCovers();
    for (const kind of uncovered) expect(SURFACE_KINDS).toContain(kind);
  });
});

describe('requirements are reachable in the shape a preflight wants', () => {
  it('returns the declared list for a known type', () => {
    expect(requirementsForType('LOAD')).toEqual(TEST_TYPE_DECLARATIONS.LOAD.requirements);
    expect(requirementsForType('LOAD').some((r) => r.kind === 'BINARY')).toBe(true);
  });

  it('returns an empty list for an unknown type rather than inventing one', () => {
    // A preflight asked about a type nobody declared must not invent a
    // requirement; `TypeRunnability.runnable` already distinguishes "nothing to
    // check" from "nothing was checked".
    expect(requirementsForType('NOT_A_TYPE')).toEqual([]);
    expect(declarationFor('NOT_A_TYPE')).toBeNull();
  });

  it('declares no version window anywhere, because none has been established', () => {
    /*
     * The honest empty default, and the same judgement as `TYPE_REQUIREMENTS` in
     * preflight.ts and `DEFAULT_TYPE_OBLIGATIONS` in coverage-dimensions.ts. No
     * minimum version for k6, Lighthouse, grpcurl or any mobile driver has ever
     * been established in this repository. A plausible floor reads as
     * measurement, fires on a customer's working binary, and produces a row that
     * is a number this product invented about a tool it never tested.
     */
    for (const decl of Object.values(ALL_TEST_TYPE_DECLARATIONS)) {
      for (const req of decl.requirements) {
        if (req.kind === 'BINARY') expect(req.version, String(decl.type)).toBeUndefined();
      }
    }
  });

  it('gives every requirement something to do about it', () => {
    // A refusal that does not say what to install is a wall.
    for (const decl of Object.values(ALL_TEST_TYPE_DECLARATIONS)) {
      for (const req of decl.requirements) {
        if (req.kind === 'BINARY' || req.kind === 'BROWSER' || req.kind === 'CHANNEL') {
          expect(req.install.length, `${String(decl.type)}/${req.kind}`).toBeGreaterThan(0);
        } else {
          expect(req.why.length, `${String(decl.type)}/${req.kind}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('mirrors preflight’s Requirement union by name, so one can derive from the other', () => {
    /*
     * Asserted by NAME and not by count, on the same reasoning as the dead-plugin
     * test above. `TypeRequirement` carries preflight's four kinds plus CHANNEL,
     * which that union does not have yet — the one-line widening is in the
     * handover, and this test is what fails if somebody removes a kind instead.
     */
    const kinds = new Set<string>();
    for (const decl of Object.values(ALL_TEST_TYPE_DECLARATIONS)) {
      for (const req of decl.requirements) kinds.add(req.kind);
    }
    for (const kind of ['BINARY', 'BROWSER', 'CHANNEL', 'UNPROBED', 'PLATFORM']) {
      expect([...kinds], kind).toContain(kind);
    }
  });
});

describe('the declaration write path', () => {
  it('accepts every declaration the product ships', () => {
    // A write path that rejects the product's own data is a feature nobody can
    // save — the defect `testValueEntrySchema`'s own test exists to catch.
    for (const [name, decl] of Object.entries(ALL_TEST_TYPE_DECLARATIONS)) {
      const parsed = testTypeDeclarationSchema.safeParse(decl);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('refuses a mutating type with no principal, at the write path too', () => {
    const parsed = testTypeDeclarationSchema.safeParse({
      ...TEST_TYPE_DECLARATIONS.API,
      dataEffect: 'DESTROYS',
      principalKinds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown property rather than dropping it', () => {
    expect(
      testTypeDeclarationSchema.safeParse({ ...TEST_TYPE_DECLARATIONS.API, mutatesData: true })
        .success,
    ).toBe(false);
  });

  it('refuses a type name neither tier declares', () => {
    expect(
      testTypeDeclarationSchema.safeParse({ ...TEST_TYPE_DECLARATIONS.API, type: 'INVENTED' })
        .success,
    ).toBe(false);
  });
});

describe('PAYMENTS cannot be pointed at a live account', () => {
  const base = {
    kind: 'DECLINE_INSUFFICIENT_FUNDS' as const,
    testMode: true as const,
    publisher: 'stripe',
    catalogueId: 'stripe-card-insufficient-funds',
    path: '/checkout',
    amountMinor: 1999,
    currency: 'USD',
  };

  it('accepts a test-mode scenario with a forcing value', () => {
    expect(paymentScenarioSchema.safeParse(base).success).toBe(true);
  });

  it('is STRUCTURALLY incapable of expressing a live-mode scenario', () => {
    /*
     * `z.literal(true)`, not `z.boolean()`. A live-mode scenario cannot be
     * constructed, parsed, stored or handed to a plugin. A boolean defaulting to
     * true would be a CONVENTION, and a convention is one careless writer away
     * from a real charge on a customer's account.
     */
    expect(paymentScenarioSchema.safeParse({ ...base, testMode: false }).success).toBe(false);
    const { testMode: _drop, ...noMode } = base;
    expect(paymentScenarioSchema.safeParse(noMode).success).toBe(false);
  });

  it('has nowhere to put a credential, and refuses an extra property', () => {
    // `.strict()` plus no key/secret/token field. The card is named by its
    // catalogue id; the sandbox key lives on a customer-owned Integration row.
    expect(paymentScenarioSchema.safeParse({ ...base, apiKey: 'anything' }).success).toBe(false);
    expect(paymentScenarioSchema.safeParse({ ...base, secretKey: 'anything' }).success).toBe(false);
  });

  it('refuses a decline scenario with no value to force it', () => {
    // Without one the test drives an ordinary card, the charge succeeds, and the
    // decline assertion fails — reported as an application defect that does not
    // exist.
    const parsed = paymentScenarioSchema.safeParse({ ...base, catalogueId: null });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/does not exist/);
  });

  it('refuses a webhook scenario with no event to wait for', () => {
    const parsed = paymentScenarioSchema.safeParse({
      ...base,
      kind: 'WEBHOOK_TRANSITION',
      catalogueId: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/sits unpaid while the customer has been billed/);
  });

  it('refuses a partial capture with no partial amount, and one above the authorisation', () => {
    expect(
      paymentScenarioSchema.safeParse({ ...base, kind: 'PARTIAL_CAPTURE', catalogueId: null })
        .success,
    ).toBe(false);
    expect(
      paymentScenarioSchema.safeParse({
        ...base,
        kind: 'PARTIAL_CAPTURE',
        catalogueId: null,
        partialAmountMinor: 9999,
      }).success,
    ).toBe(false);
    expect(
      paymentScenarioSchema.safeParse({
        ...base,
        kind: 'PARTIAL_CAPTURE',
        catalogueId: null,
        partialAmountMinor: 999,
      }).success,
    ).toBe(true);
  });

  it('declares what test mode can never prove, before the plugin exists', () => {
    // So that the first green PAYMENTS run cannot read as coverage of a path it
    // never drove. These are facts about a provider's test mode, not gaps of
    // ours, which is why they are PROVIDER_TEST_MODE_LIMIT.
    const reasons = PENDING_TEST_TYPE_DECLARATIONS.PAYMENTS.knownUnasserted.map((u) => u.reason);
    expect(reasons).toContain('PROVIDER_TEST_MODE_LIMIT');
    expect(PENDING_TEST_TYPE_DECLARATIONS.PAYMENTS.refusesLiveCredentials).toBe(true);
    expect(PENDING_TEST_TYPE_DECLARATIONS.PAYMENTS.egress).toBe('PROVIDER_TEST_MODE');
    // And it may only be driven as an identity the customer can lose.
    expect(PENDING_TEST_TYPE_DECLARATIONS.PAYMENTS.principalKinds).toEqual(['DISPOSABLE']);
  });
});

describe('DOCUMENT cannot pass on an error page wearing a .pdf name', () => {
  const base = {
    source: 'DOWNLOAD' as const,
    path: '/invoices/1',
    expectFilename: 'invoice-*.pdf',
    minBytes: 2048,
  };

  it('accepts a named artefact with a byte floor', () => {
    expect(documentArtifactSchema.safeParse(base).success).toBe(true);
  });

  it('refuses an artefact that asserts only a size', () => {
    // A different document of the right size would pass, which is the whole
    // thing the type exists to stop.
    const parsed = documentArtifactSchema.safeParse({ source: 'DOWNLOAD', path: '/x', minBytes: 1 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/HTML error page with a \.pdf name/);
  });

  it('has no way to express a zero-byte floor', () => {
    // Zero IS the failure: a server-side error frequently produces a 0-byte file
    // and every assertion short of a floor passes on it.
    expect(documentArtifactSchema.safeParse({ ...base, minBytes: 0 }).success).toBe(false);
    const { minBytes: _drop, ...noFloor } = base;
    expect(documentArtifactSchema.safeParse(noFloor).success).toBe(false);
  });

  it('refuses a ceiling below the floor, and an ignored upload instruction', () => {
    expect(documentArtifactSchema.safeParse({ ...base, maxBytes: 10 }).success).toBe(false);
    expect(
      documentArtifactSchema.safeParse({
        ...base,
        source: 'PRINT_TO_PDF',
        uploadFixture: 'anything.pdf',
      }).success,
    ).toBe(false);
  });

  it('declares the PDF parser SPEC-scoped, so its absence is reported not passed', () => {
    const decl = PENDING_TEST_TYPE_DECLARATIONS.DOCUMENT;
    const parser = decl.requirements.find((r) => r.kind === 'BINARY' && r.name === 'pdftotext');
    expect(parser).toBeDefined();
    expect(parser?.scope).toBe('SPEC');
  });
});

describe('PWA and PUSH report UNAVAILABLE rather than passing on nothing', () => {
  it('refuses an offline check with no path, which would assert the page it is on', () => {
    const parsed = pwaTestSpecSchema.safeParse({ path: '/', checks: ['OFFLINE_NAVIGATION'] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/we did not check/);
    expect(
      pwaTestSpecSchema.safeParse({
        path: '/',
        checks: ['OFFLINE_NAVIGATION'],
        offlinePaths: ['/dashboard'],
      }).success,
    ).toBe(true);
  });

  it('refuses a push delivery that asserts nothing about the notification', () => {
    const parsed = pushDeliverySchema.safeParse({ transport: 'WEB_PUSH', triggerPath: '/orders' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/wrong person, in the wrong language/);
  });

  it('refuses a device-bound transport with no customer sender credential', () => {
    const parsed = pushDeliverySchema.safeParse({
      transport: 'APNS',
      triggerPath: '/orders',
      expectTitle: 'Your order shipped',
    });
    expect(parsed.success).toBe(false);
    // And the remedy is UNAVAILABLE, not SKIPPED: a skipped push test inside a
    // percentage is a notification path that can never fail.
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/reported UNAVAILABLE/);
  });

  it('accepts Web Push against the app’s own setup, with no integration id', () => {
    expect(
      pushDeliverySchema.safeParse({
        transport: 'WEB_PUSH',
        triggerPath: '/orders',
        expectDeepLink: '/orders/1',
      }).success,
    ).toBe(true);
  });

  it('declares both device-bound transports as capability gaps rather than ours', () => {
    const reasons = PENDING_TEST_TYPE_DECLARATIONS.PUSH.knownUnasserted.map((u) => u.reason);
    expect(new Set(reasons)).toEqual(new Set(['CAPABILITY_ABSENT']));
    expect(PENDING_TEST_TYPE_DECLARATIONS.PUSH.device).toBe('REAL_DEVICE');
  });
});

describe('CHAOS uses the interception that already existed, and must assert something', () => {
  const base = { path: '/search', urlPattern: '**/api/search*', fault: 'HTTP_500' as const };

  it('has no way to inject a fault and assert nothing', () => {
    // A chaos test with no expectation passes when the application crashes,
    // because a crash is also a thing that happened.
    const { ...noExpect } = base;
    expect(chaosTestSpecSchema.safeParse(noExpect).success).toBe(false);
    expect(
      chaosTestSpecSchema.safeParse({ ...base, expectVisible: 'Search is unavailable' }).success,
    ).toBe(true);
  });

  it('refuses SLOW_RESPONSE with no delay, and a delay on a fault that ignores it', () => {
    expect(
      chaosTestSpecSchema.safeParse({ ...base, fault: 'SLOW_RESPONSE', expectVisible: 'x' }).success,
    ).toBe(false);
    expect(
      chaosTestSpecSchema.safeParse({ ...base, expectVisible: 'x', delayMs: 5000 }).success,
    ).toBe(false);
  });

  it('declares no binary, because the capability is already on the image', () => {
    // `har.ts` has route interception — 1,528 lines, written and tested — and no
    // test type used it. What was missing was a type that asks for it.
    const decl = PENDING_TEST_TYPE_DECLARATIONS.CHAOS;
    expect(decl.requirements.filter((r) => r.kind === 'BINARY')).toEqual([]);
    // And the synthesised response must never reach the third party it
    // impersonates, which is why it needs no credential and no outside egress.
    expect(decl.egress).toBe('APP_UNDER_TEST');
  });
});

describe('I18N_DEEP finds the defect classes LOCALIZATION cannot', () => {
  const base = {
    path: '/',
    checks: ['TRUNCATION' as const],
    locales: [{ tag: 'de-DE' }],
    seed: 'run-1',
  };

  it('requires a seed, so a truncation finding is reproducible', () => {
    // An unreproducible finding is one nobody fixes.
    expect(i18nDeepSpecSchema.safeParse(base).success).toBe(true);
    const { seed: _drop, ...noSeed } = base;
    expect(i18nDeepSpecSchema.safeParse(noSeed).success).toBe(false);
  });

  it('refuses an RTL check with no right-to-left locale', () => {
    // It would compare a left-to-right layout against itself and pass.
    const parsed = i18nDeepSpecSchema.safeParse({ ...base, checks: ['RTL_MIRRORING'] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/we did not check/);
    expect(
      i18nDeepSpecSchema.safeParse({
        ...base,
        checks: ['RTL_MIRRORING'],
        locales: [{ tag: 'ar-EG' }],
      }).success,
    ).toBe(true);
  });

  it('records that LOCALIZATION detects none of these, rather than leaving it implied', () => {
    /*
     * The plugin only re-runs the same code under another locale and emits ZERO
     * findings, so its `Finding` kind is dead. Said in the declaration so a
     * green de-DE run cannot read as localisation coverage.
     */
    const unasserted = TEST_TYPE_DECLARATIONS.LOCALIZATION.knownUnasserted.map((u) => u.assertion);
    expect(unasserted.join(' ')).toMatch(/RTL mirroring/);
    expect(unasserted.join(' ')).toMatch(/truncation/i);
    expect(unasserted.join(' ')).toMatch(/missing translation key/);
  });

  it('does not claim to judge whether a translation is correct', () => {
    // That needs a human or a model, and claiming it would be the exact
    // dishonesty this type exists to replace.
    const unasserted = PENDING_TEST_TYPE_DECLARATIONS.I18N_DEEP.knownUnasserted;
    expect(unasserted.map((u) => u.assertion).join(' ')).toMatch(/CORRECT/);
  });
});

describe('per-cell evidence cannot record a hole without a reason', () => {
  const cell = { engine: 'chromium' as const };

  it('accepts a cell that ran and asserted everything', () => {
    expect(
      testResultVariantCellSchema.safeParse({ matrixCell: cell, cellStatus: 'AVAILABLE' }).success,
    ).toBe(true);
  });

  it('refuses a refused cell with no remedy', () => {
    // MISSING, WRONG_VERSION, UNSUPPORTED_COMBINATION and NEEDS_BROWSER_GRID are
    // four different next actions, and a status with none of them is a wall.
    for (const status of ['MISSING', 'WRONG_VERSION', 'UNSUPPORTED_COMBINATION', 'NEEDS_BROWSER_GRID']) {
      expect(
        testResultVariantCellSchema.safeParse({ matrixCell: cell, cellStatus: status }).success,
        status,
      ).toBe(false);
    }
  });

  it('refuses a remedy for a cell nobody probed', () => {
    expect(
      testResultVariantCellSchema.safeParse({
        matrixCell: cell,
        cellStatus: 'NOT_CHECKED',
        cellRemedy: 'install chromium',
      }).success,
    ).toBe(false);
  });

  it('refuses an unasserted list with no reason', () => {
    /*
     * The headline defect, refused at the write path: checkout could be clicked
     * through and the money path could not be asserted, and the result was a
     * PASS. A hole with no reason cannot tell a missing binary from a feature
     * nobody has built.
     */
    const parsed = testResultVariantCellSchema.safeParse({
      matrixCell: cell,
      cellStatus: 'AVAILABLE',
      notAsserted: ['the webhook transition'],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/suppressed without being counted/);
  });

  it('refuses a reason with nothing listed as unasserted', () => {
    expect(
      testResultVariantCellSchema.safeParse({
        matrixCell: cell,
        cellStatus: 'AVAILABLE',
        notAssertedReason: 'NOT_IMPLEMENTED',
      }).success,
    ).toBe(false);
  });

  it('accepts a pass with a stated hole in it, which is the point', () => {
    expect(
      testResultVariantCellSchema.safeParse({
        matrixCell: cell,
        cellStatus: 'AVAILABLE',
        notAsserted: ['the settlement', 'the dispute lifecycle'],
        notAssertedReason: 'PROVIDER_TEST_MODE_LIMIT',
      }).success,
    ).toBe(true);
  });
});

describe('the migration carries this round’s content', () => {
  /*
   * ── ASSERTED BY NAME AND CONTENT, NEVER BY POSITION ────────────────────────
   *
   * A test that reads the migrations folder and expects its own to sort LAST
   * goes red the moment the next round lands one, and a red check with no
   * available remedy is a check people start skipping. So this opens its own
   * migration by name and asserts what is IN it.
   */
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        '../../../apps/api/prisma/migrations/20261027090000_browser_matrix_cells_and_unasserted_honesty/migration.sql',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  it('creates both enums with every member the TypeScript lists name', () => {
    // The static half of `check:enums` is over schema.prisma; this is over the
    // MIGRATION, which is the thing that actually reaches a database. The two
    // have disagreed before: five TestType members existed in both the schema
    // and constants.ts while the database was five values behind.
    for (const member of ['AVAILABLE', 'UNSUPPORTED_COMBINATION', 'NEEDS_BROWSER_GRID']) {
      expect(sql, member).toContain(member);
    }
    expect(sql).toContain('CREATE TYPE "MatrixCellStatus" AS ENUM');
    expect(sql).toContain('CREATE TYPE "UnassertedReason" AS ENUM');
    for (const member of UNASSERTED_REASONS) expect(sql, member).toContain(`'${member}'`);
  });

  it('adds the matrix and environment columns to both PlanItem and Test', () => {
    expect(sql).toContain('ALTER TABLE "PlanItem" ADD COLUMN "matrixCells" JSONB;');
    expect(sql).toContain('ALTER TABLE "PlanItem" ADD COLUMN "browserEnv" JSONB;');
    expect(sql).toContain('ALTER TABLE "Test" ADD COLUMN "matrixCells" JSONB;');
    expect(sql).toContain('ALTER TABLE "Test" ADD COLUMN "browserEnv" JSONB;');
  });

  it('gives the four JSONB columns no default, so absent means the browser default', () => {
    // A defaulted environment block would be a set of fabricated values, and a
    // defaulted geolocation would put every location test at Null Island.
    for (const column of ['matrixCells', 'browserEnv']) {
      const lines = sql.split('\n').filter((l) => l.includes(`"${column}" JSONB`));
      expect(lines.length, column).toBeGreaterThan(0);
      for (const line of lines) expect(line, line).not.toMatch(/DEFAULT/);
    }
  });

  it('adds the five per-cell evidence columns to TestResultVariant and none to TestResult', () => {
    expect(sql).toContain('ALTER TABLE "TestResultVariant" ADD COLUMN "matrixCell" JSONB;');
    expect(sql).toContain(
      'ALTER TABLE "TestResultVariant" ADD COLUMN "cellStatus" "MatrixCellStatus";',
    );
    expect(sql).toContain('ALTER TABLE "TestResultVariant" ADD COLUMN "cellRemedy" TEXT;');
    expect(sql).toContain(
      'ALTER TABLE "TestResultVariant" ADD COLUMN "notAsserted" TEXT[] DEFAULT ARRAY[]::TEXT[];',
    );
    expect(sql).toContain(
      'ALTER TABLE "TestResultVariant" ADD COLUMN "notAssertedReason" "UnassertedReason";',
    );
    // "TestResult" is the largest table in the product and keeps every contract
    // its readers were written against.
    expect(sql).not.toMatch(/ALTER TABLE "TestResult" ADD COLUMN/);
  });

  it('leaves cellStatus and notAssertedReason nullable with no default', () => {
    // Null means nobody recorded a cell status, which is the honest reading of
    // every row written before the column. Defaulting to AVAILABLE would assert
    // that every historical cell ran.
    expect(sql).not.toMatch(/"cellStatus" "MatrixCellStatus" NOT NULL/);
    expect(sql).not.toMatch(/"cellStatus" "MatrixCellStatus" DEFAULT/);
    expect(sql).not.toMatch(/"notAssertedReason" "UnassertedReason" (NOT NULL|DEFAULT)/);
  });

  it('adds the index the grouped cellStatus read depends on', () => {
    expect(sql).toContain(
      'CREATE INDEX "TestResultVariant_runId_cellStatus_idx" ON "TestResultVariant"("runId", "cellStatus");',
    );
  });

  it('creates no table, so nothing lands disconnected', () => {
    // A correct Prisma model connected to nothing is this codebase's signature
    // defect, and three keystones in a row shipped one. `check:wiring` reports 0
    // disconnected before this migration and must still report 0 after it.
    expect(sql).not.toMatch(/CREATE TABLE/);
  });

  it('adds no TestType enum value, because the plugins do not exist yet', () => {
    /*
     * Minting a type with no runner plugin fails `check:wiring` by name — "every
     * test of this type is recorded SKIPPED at run time" — and a percentage
     * containing tests that cannot fail is the lie this product cannot afford.
     * The seven new types are declared and not minted; `mintTestTypeSteps` is
     * the four-edit recipe.
     */
    expect(sql).not.toMatch(/ALTER TYPE "TestType" ADD VALUE/);
    for (const pending of PENDING_TEST_TYPES) {
      expect(sql, pending).not.toMatch(new RegExp(`ADD VALUE '${pending}'`));
    }
  });

  it('does not touch the VisualBaseline unique index', () => {
    // `baselineViewportKey` separates the cells under the EXISTING key, which is
    // what keeps every current baseline matching and avoids a 69-byte constraint
    // name PostgreSQL would truncate at 63 silently.
    expect(sql).not.toMatch(/DROP INDEX "VisualBaseline/);
    expect(sql).not.toMatch(/ALTER TABLE "VisualBaseline" ADD COLUMN/);
  });
});
