/**
 * Surviving mutants → the thing to assert. The cleanest closure signal in the
 * product, and until now it had no consumer.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The mutation plugin already NAMES EACH MISSING ASSERTION. It flips `>` to
 * `>=` on line 84 of `src/cart.ts`, the suite still passes, and it writes a
 * `MutationSurvivor` row saying exactly that. Nothing reads those rows. So the
 * most precise instruction this product ever generates — "nothing asserts the
 * boundary at cart.ts:84" — went into a table, scored a percentage, and stopped.
 *
 * A surviving mutant is better evidence than a coverage gap. A gap says "no
 * test goes here"; a survivor says "a test goes here, executes this line, and
 * would not have noticed if the behaviour were wrong". The second is a
 * one-line instruction.
 *
 * ── AND THE PART THAT IS NOT TRUE OF EVERY SURVIVOR ─────────────────────────
 *
 * Two kinds of survivor are NOT missing assertions, and generating a test for
 * either produces a test that CANNOT PASS — which is the worst thing this
 * module could ship, because a test that cannot pass teaches a team to ignore
 * the generator:
 *
 *   EQUIVALENT    the mutation changed the source and not the behaviour. There
 *                 is no observable difference to assert. A test asserting one
 *                 is asserting that two identical things differ.
 *   UNREACHABLE   nothing can execute the line. No assertion reaches it.
 *
 * Neither can be inferred from an operator's NAME. `VoidMethodCall` removing a
 * call looks equivalent and may be the only side effect in the function;
 * `StringLiteral` on a message looks cosmetic and may be the error code a
 * customer's integration switches on. So equivalence here is only ever claimed
 * from EVIDENCE: the tool's own detail reporting a replacement identical to the
 * original, or a caller that supplies dead-code analysis with a reason. With no
 * evidence the class is UNCLASSIFIED — counted, reported, and never generated
 * for. "We do not know" is a third answer and it is the honest one.
 *
 * ── NO MODEL, AND THE TOOL'S WORDS STAY IN QUOTES ───────────────────────────
 *
 * Classification is a table lookup over the operator name and a string
 * comparison over the detail. Grouping is a sort. Ranking is arithmetic.
 *
 * `mutator`, `detail` and `file` all come out of a third-party mutation tool
 * reading the customer's own repository, which makes all three RUNNER_OUTPUT —
 * untrusted. The prose in a plan item is therefore composed from
 * {@link MUTANT_BEHAVIOUR_RULES} and from numbers, never from the tool's text;
 * the tool's own words travel in a FENCED block and in a length-bounded echo
 * field, where they cannot change what the item asks for.
 */

import { createHash } from 'node:crypto';
import { fence, untrusted } from './untrusted.js';
import type { FenceDisclosure, FencedBlock } from './untrusted.js';

// ─── What a survivor row looks like ─────────────────────────────────────────

/**
 * One `MutationSurvivor` row as the caller reads it back.
 *
 * `reason` is the producer's own union (`SurvivingMutant['reason']`,
 * packages/shared/src/types.ts) and the column is a String for the reason
 * recorded on the schema: there is no `PAIRS` entry for it, so promoting it to
 * a Prisma enum would add an enum with no drift guard. A value this module does
 * not recognise is handled rather than assumed — see {@link classifySurvivor}.
 */
export interface MutationSurvivorRow {
  id: string;
  /** Path or class exactly as the tool named it. Never normalised. */
  file: string;
  /** Null when the tool reported no line. NOT 0 — line 0 does not exist. */
  line: number | null;
  /** The operator: `ArithmeticOperator`, `ConditionalsBoundary`, `mutmut`, … */
  mutator: string;
  detail: string | null;
  reason: string;
  /** Which result produced it, so an item can point at a run. */
  testResultId: string;
}

// ─── Classes ────────────────────────────────────────────────────────────────

export const MUTANT_CLASSES = [
  /** The suite executed this line and did not notice. A precise instruction. */
  'MISSING_ASSERTION',
  /**
   * `no-coverage`: no test executed the mutant at all. A missing TEST, not a
   * missing assertion, and the difference decides where the work goes — the
   * generator cannot add an assertion to a test that does not exist.
   */
  'NO_TEST_EXECUTED',
  /** Provably no observable behaviour change. A test for it cannot pass. */
  'EQUIVALENT_MUTANT',
  /** Nothing can execute the line. Needs caller evidence; never inferred. */
  'UNREACHABLE_CODE',
  /**
   * No evidence either way: an operator this module does not recognise, or a
   * `reason` outside the producer's union. Counted and reported, NEVER folded
   * into MISSING_ASSERTION — a survivor generated for on a guess is a test that
   * may not be able to pass.
   */
  'UNCLASSIFIED',
] as const;
export type MutantClass = (typeof MUTANT_CLASSES)[number];

/** What closing this survivor needs. */
export const MUTANT_NEEDS = ['ASSERTION', 'TEST'] as const;
export type MutantNeed = (typeof MUTANT_NEEDS)[number];

/**
 * Which classes produce work, and of what kind.
 *
 * A `satisfies Record<MutantClass, …>`, so a sixth class cannot be added
 * without deciding whether it generates anything — the decision that, left
 * implicit, is how an unobservable difference becomes a test that cannot pass.
 */
export const MUTANT_CLASS_RULES = {
  MISSING_ASSERTION: { generates: true, need: 'ASSERTION' },
  NO_TEST_EXECUTED: { generates: true, need: 'TEST' },
  EQUIVALENT_MUTANT: { generates: false, need: null },
  UNREACHABLE_CODE: { generates: false, need: null },
  UNCLASSIFIED: { generates: false, need: null },
} as const satisfies Record<MutantClass, { generates: boolean; need: MutantNeed | null }>;

// ─── Behaviours: what the mutant exposes ────────────────────────────────────

/**
 * The BEHAVIOUR a mutant exposes, which is what survivors are grouped by.
 *
 * Grouping by operator name would produce one group per tool dialect — Stryker
 * says `EqualityOperator`, PIT says `NegateConditionals`, and a customer on two
 * toolchains would see the same missing assertion twice under two names.
 * Grouping by BEHAVIOUR means "nothing asserts the boundary in cart.ts" is one
 * item however the tool spelled it.
 */
export const MUTANT_BEHAVIOURS = [
  'BOUNDARY',
  'EQUALITY',
  'CONDITION',
  'LOGICAL',
  'ARITHMETIC',
  'RETURN_VALUE',
  'LITERAL',
  'OPTIONAL_CHAIN',
  'REGEX',
  'METHOD_CALL',
  /** The operator name is not one this module recognises. Never generated for. */
  'UNKNOWN',
] as const;
export type MutantBehaviour = (typeof MUTANT_BEHAVIOURS)[number];

export interface MutantBehaviourRule {
  /**
   * 0–3. How strongly a survivor of this behaviour implies a missing assertion.
   *
   * A DECLARED weight from this table, not a measurement, and the ranking says
   * so. A surviving negated conditional means the guard is not asserted at all;
   * a surviving string literal often means a message nobody should assert on.
   * The weights put the first at the top of the queue.
   */
  readonly weight: number;
  /**
   * WHICH assertion is missing, in QAAI's own words. The sentence a plan item
   * is built from — never built out of the tool's `detail`.
   */
  readonly assertion: string;
  /**
   * A surviving mutant of this behaviour is strong enough to raise on its own.
   * False for LITERAL and METHOD_CALL, which are the two that most often
   * survive for a good reason, and for UNKNOWN, which is not a finding.
   */
  readonly raiseAlone: boolean;
}

export const MUTANT_BEHAVIOUR_RULES = {
  BOUNDARY: {
    weight: 3,
    assertion:
      'Assert the behaviour AT the boundary, not just inside it: the value exactly on the limit, and the first value past it. The comparison was changed from `>` to `>=` (or back) and every test still passed, so nothing distinguishes those two cases.',
    raiseAlone: true,
  },
  EQUALITY: {
    weight: 3,
    assertion:
      'Assert the value, not the shape. The comparison was inverted to answer the opposite question and the suite did not notice, which means no assertion depends on which branch ran.',
    raiseAlone: true,
  },
  CONDITION: {
    weight: 3,
    assertion:
      'Assert the GUARDED behaviour on both sides of the condition. The condition was negated or removed and the suite still passed, so there is no test in which the guard matters.',
    raiseAlone: true,
  },
  LOGICAL: {
    weight: 2,
    assertion:
      'Assert a case where only ONE of the conditions holds. `&&` was changed to `||` and every test still passed, which means every test satisfies both conditions or neither.',
    raiseAlone: true,
  },
  ARITHMETIC: {
    weight: 2,
    assertion:
      'Assert the computed VALUE, not merely that a value appeared. The operator was swapped and the result still satisfied every assertion.',
    raiseAlone: true,
  },
  RETURN_VALUE: {
    weight: 3,
    assertion:
      'Assert the RETURNED value. The return was replaced (with a constant, with null, or removed) and the suite still passed, so nothing downstream checks it.',
    raiseAlone: true,
  },
  LITERAL: {
    weight: 1,
    assertion:
      'If this literal is part of the contract — an error code, a status, a key — assert it exactly. If it is a human-facing message, it may be correct that no test asserts it, and this item can be dismissed.',
    raiseAlone: false,
  },
  OPTIONAL_CHAIN: {
    weight: 2,
    assertion:
      'Assert the ABSENT case. `?.` was changed to `.` and nothing threw, which means no test exercises the path where the value is missing.',
    raiseAlone: true,
  },
  REGEX: {
    weight: 2,
    assertion:
      'Assert a value the pattern must REJECT as well as one it must accept. The pattern was altered and every test still passed, so only accepting inputs are covered.',
    raiseAlone: true,
  },
  METHOD_CALL: {
    weight: 1,
    assertion:
      'Assert the OUTCOME of this call rather than that it happened. The method was swapped for a neighbour (`startsWith` for `endsWith`, and so on) and the suite did not notice.',
    raiseAlone: false,
  },
  UNKNOWN: {
    weight: 0,
    assertion:
      'QAAI does not recognise this mutation operator, so it will not say what is missing. The tool’s own description is quoted beside this item.',
    raiseAlone: false,
  },
} as const satisfies Record<MutantBehaviour, MutantBehaviourRule>;

/**
 * Operator names, as the four supported tools spell them, mapped to behaviour.
 *
 * Keys are lower-cased with a trailing `mutator` stripped, which is how PIT
 * names arrive (`ConditionalsBoundaryMutator`). A name that is not here maps to
 * UNKNOWN and is REPORTED as unrecognised rather than guessed at — an operator
 * silently bucketed into BOUNDARY would produce a confident instruction about a
 * mutation nobody here has seen.
 */
const OPERATOR_BEHAVIOUR: Record<string, MutantBehaviour> = {
  // Stryker (JS/TS)
  arithmeticoperator: 'ARITHMETIC',
  arraydeclaration: 'LITERAL',
  assignmentoperator: 'ARITHMETIC',
  blockstatement: 'RETURN_VALUE',
  booleanliteral: 'LITERAL',
  conditionalexpression: 'CONDITION',
  equalityoperator: 'EQUALITY',
  logicaloperator: 'LOGICAL',
  methodexpression: 'METHOD_CALL',
  objectliteral: 'LITERAL',
  optionalchaining: 'OPTIONAL_CHAIN',
  regex: 'REGEX',
  stringliteral: 'LITERAL',
  unaryoperator: 'ARITHMETIC',
  updateoperator: 'ARITHMETIC',
  // PIT (JVM)
  conditionalsboundary: 'BOUNDARY',
  math: 'ARITHMETIC',
  increments: 'ARITHMETIC',
  invertnegs: 'ARITHMETIC',
  negateconditionals: 'CONDITION',
  removeconditional: 'CONDITION',
  returnvals: 'RETURN_VALUE',
  truereturns: 'RETURN_VALUE',
  falsereturns: 'RETURN_VALUE',
  emptyreturns: 'RETURN_VALUE',
  nullreturns: 'RETURN_VALUE',
  primitivereturns: 'RETURN_VALUE',
  booleantrue: 'LITERAL',
  voidmethodcall: 'METHOD_CALL',
  constructorcall: 'METHOD_CALL',
  argumentpropagation: 'RETURN_VALUE',
  // QAAI's own operator vocabulary (packages/agent/src/mutation-gate.ts), so a
  // survivor produced by the in-house gate classifies the same way as one from
  // a third-party tool.
  negate_conditional: 'CONDITION',
  invert_equality: 'EQUALITY',
  remove_validation: 'CONDITION',
  flip_boolean: 'LITERAL',
  change_constant: 'LITERAL',
  swap_boundary: 'BOUNDARY',
  flip_logical: 'LOGICAL',
  swap_arithmetic: 'ARITHMETIC',
};

/** The behaviour an operator name exposes, or UNKNOWN. */
export function behaviourOf(mutator: string): MutantBehaviour {
  const key = mutator.trim().toLowerCase().replace(/mutator$/, '');
  return OPERATOR_BEHAVIOUR[key] ?? 'UNKNOWN';
}

// ─── Equivalence, only from evidence ────────────────────────────────────────

export const EQUIVALENCE_EVIDENCE_KINDS = [
  /** The tool's own detail reports a replacement identical to the original. */
  'IDENTICAL_REPLACEMENT',
  /** The caller supplied the evidence, with a reason it is accountable for. */
  'DECLARED_BY_CALLER',
] as const;
export type EquivalenceEvidenceKind = (typeof EQUIVALENCE_EVIDENCE_KINDS)[number];

/** A caller's claim that one survivor is equivalent or unreachable. */
export interface SurvivorEvidence {
  file: string;
  /** Null matches every survivor in the file. */
  line: number | null;
  /** Why, in the caller's words. Required: an unexplained exclusion is one somebody inherits. */
  why: string;
}

/**
 * Pull the before/after out of a tool's detail string, if it has one.
 *
 * Handles the three arrow forms the four tools use. Returns null when the
 * detail is prose, because a detail this module cannot parse must leave the
 * survivor UNCLASSIFIED rather than assumed non-equivalent — the two look the
 * same from the outside and only one is a claim.
 */
export function replacementPair(detail: string | null): { from: string; to: string } | null {
  if (detail === null) return null;
  const match = /^([\s\S]{1,400}?)\s*(?:→|->|=>)\s*([\s\S]{1,400})$/.exec(detail.trim());
  if (!match) return null;
  return { from: match[1]!.trim(), to: match[2]!.trim() };
}

/**
 * A replacement identical to the original is a provably equivalent mutation.
 *
 * Compared after collapsing whitespace only. NOT after stripping quotes or
 * normalising case: `"OK"` and `"ok"` are different strings and a test can
 * tell them apart, so collapsing those would claim equivalence for a mutation
 * that is observable.
 */
function isIdenticalReplacement(detail: string | null): boolean {
  const pair = replacementPair(detail);
  if (pair === null) return false;
  const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
  return collapse(pair.from) === collapse(pair.to) && collapse(pair.from).length > 0;
}

function matchesEvidence(row: MutationSurvivorRow, evidence: readonly SurvivorEvidence[]): string | null {
  for (const claim of evidence) {
    if (claim.file !== row.file) continue;
    if (claim.line === null || claim.line === row.line) return claim.why;
  }
  return null;
}

export interface SurvivorClassification {
  class: MutantClass;
  behaviour: MutantBehaviour;
  /** Why this class, in QAAI's own words. Never built from the tool's text. */
  because: string;
  /** Set only for EQUIVALENT_MUTANT. */
  equivalenceEvidence: EquivalenceEvidenceKind | null;
}

export interface ClassifyOptions {
  /** Survivors the caller has evidence are equivalent. */
  equivalent?: readonly SurvivorEvidence[];
  /** Lines the caller has evidence are unreachable (dead-code analysis). */
  unreachable?: readonly SurvivorEvidence[];
}

/**
 * Classify one survivor. Deterministic, model-free, and willing to say "I do
 * not know".
 *
 * ORDER MATTERS. Equivalence and unreachability are checked BEFORE
 * `no-coverage` and before the operator lookup, because both are claims that
 * the mutant cannot be closed at all — an equivalent mutant on an uncovered
 * line still needs no test, and classifying it as NO_TEST_EXECUTED would send
 * the generator to write one.
 */
export function classifySurvivor(
  row: MutationSurvivorRow,
  options: ClassifyOptions = {},
): SurvivorClassification {
  const behaviour = behaviourOf(row.mutator);

  const unreachableWhy = matchesEvidence(row, options.unreachable ?? []);
  if (unreachableWhy !== null) {
    return {
      class: 'UNREACHABLE_CODE',
      behaviour,
      because: `The caller supplied evidence that this line cannot execute (${unreachableWhy}). No assertion reaches unreachable code, so this is not a missing assertion.`,
      equivalenceEvidence: null,
    };
  }

  const equivalentWhy = matchesEvidence(row, options.equivalent ?? []);
  if (equivalentWhy !== null) {
    return {
      class: 'EQUIVALENT_MUTANT',
      behaviour,
      because: `The caller supplied evidence that this mutation has no observable behaviour (${equivalentWhy}). A test asserting an unobservable difference cannot pass.`,
      equivalenceEvidence: 'DECLARED_BY_CALLER',
    };
  }

  if (isIdenticalReplacement(row.detail)) {
    return {
      class: 'EQUIVALENT_MUTANT',
      behaviour,
      because:
        'The tool reports a replacement identical to the original, so the mutation changed the source and not the behaviour. There is no observable difference to assert, and a test asserting one cannot pass.',
      equivalenceEvidence: 'IDENTICAL_REPLACEMENT',
    };
  }

  if (row.reason === 'no-coverage') {
    return {
      class: 'NO_TEST_EXECUTED',
      behaviour,
      because:
        'No test executed this code, so the mutation could not be caught by any assertion. This needs a TEST, not an assertion added to an existing one.',
      equivalenceEvidence: null,
    };
  }

  if (row.reason !== 'survived') {
    /*
     * A `reason` outside the producer's union. The column is a String, so this
     * is reachable from a row written by a future writer — and a value nobody
     * here recognises must not be read as `survived`, which would generate an
     * assertion for an outcome whose meaning is unknown.
     */
    return {
      class: 'UNCLASSIFIED',
      behaviour,
      because:
        'This survivor’s outcome is a value QAAI does not recognise, so no claim is made about what it means. It is counted and not generated for.',
      equivalenceEvidence: null,
    };
  }

  if (behaviour === 'UNKNOWN') {
    return {
      class: 'UNCLASSIFIED',
      behaviour,
      because:
        'QAAI does not recognise this mutation operator, so it cannot say which assertion would have caught it. Bucketing it into a behaviour it has not seen would produce a confident instruction about a mutation nobody here understands.',
      equivalenceEvidence: null,
    };
  }

  return {
    class: 'MISSING_ASSERTION',
    behaviour,
    because:
      'A test executed this line, the behaviour was changed, and every assertion still passed. That is a missing assertion and the mutation names which one.',
    equivalenceEvidence: null,
  };
}

// ─── Grouping, ranking, and the plan items ──────────────────────────────────

/**
 * Lines listed on one item before the list is capped.
 *
 * Ten. An item carrying 400 line numbers is not an instruction, it is a file
 * that needs a different conversation — and the TOTAL is always reported
 * alongside, so the ten can never read as all of them.
 */
export const MUTANT_CLOSURE_MAX_LINES = 10;

/** The most items one report will carry. The total is reported alongside. */
export const MUTANT_CLOSURE_MAX_ITEMS = 50;

/**
 * The longest operator name echoed back.
 *
 * `mutator` is RUNNER_OUTPUT — a third-party tool's string. Echoed so a reader
 * can search the tool's own report for it, bounded so it cannot be a payload,
 * and never used to compose a sentence.
 */
export const MUTANT_MAX_MUTATOR_CHARS = 80;

export interface MutantClosureItem {
  /**
   * Deterministic over (file, behaviour, need), so a second run of the same
   * mutation report updates one item rather than minting a second. Twelve hex,
   * the same shape and the same hash as `failureClusterKey`.
   */
  id: string;
  need: MutantNeed;
  class: MutantClass;
  behaviour: MutantBehaviour;
  /** The path as the tool named it. Never rewritten: a rewritten path does not open. */
  file: string;
  /** Sorted, de-duplicated, capped at {@link MUTANT_CLOSURE_MAX_LINES}. */
  lines: number[];
  /** Distinct lines in total, so a capped list cannot read as the whole list. */
  lineCount: number;
  /** Survivors behind this item. */
  survivors: number;
  /** WHICH assertion is missing — from the behaviour table, not from the tool. */
  missingAssertion: string;
  /** WHERE, composed from the path and the numbers only. */
  where: string;
  /** Rank: higher first. Declared weight × survivors, not a measurement. */
  rank: number;
  /** The tool's own operator names, bounded and de-duplicated. Data, not prose. */
  reportedMutators: string[];
  /** The tool's own detail, FENCED. Null when the tool said nothing. */
  toolDetail: FencedBlock | null;
  /** What the fence showed, hid and neutralised. */
  toolDetailDisclosure: FenceDisclosure | null;
  /** Result ids behind this item, so a reader can open the run. */
  testResultIds: string[];
}

export interface MutantClosureReport {
  /** Every class, always present. "None of these" and "we did not look" differ. */
  classified: Record<MutantClass, number>;
  /** Survivors that produced no work, with the class that explains each. */
  notGenerated: number;
  items: MutantClosureItem[];
  /** Items before {@link MUTANT_CLOSURE_MAX_ITEMS} bit. */
  itemsTotal: number;
  cappedAt: number | null;
  /** Operator names this module does not recognise, de-duplicated and bounded. */
  unknownMutators: string[];
  /** How many there were, so the bounded list cannot read as all of them. */
  unknownMutatorCount: number;
  /** The sentence. Reports every class out loud, including the zeros that matter. */
  disclosure: string;
  caveats: string[];
}

export interface MutantClosureInput {
  survivors: readonly MutationSurvivorRow[];
  equivalent?: readonly SurvivorEvidence[];
  unreachable?: readonly SurvivorEvidence[];
  maxItems?: number;
}

function groupKey(file: string, behaviour: MutantBehaviour, need: MutantNeed): string {
  return `${file}\u0000${behaviour}\u0000${need}`;
}

/**
 * Twelve hex over the group key.
 *
 * Same formula and same length as `failureClusterKey` (packages/agent/src/
 * triage.ts) on purpose: two 12-hex identities in one product that are computed
 * differently is two identities a reader will try to look up against each
 * other. It is a DIFFERENT key space — the input is a file and a behaviour, not
 * a failure signature — so a key from one must never be looked up against the
 * other, and neither can produce the other's string.
 */
export function mutantGroupKey(file: string, behaviour: MutantBehaviour, need: MutantNeed): string {
  return createHash('sha1').update(groupKey(file, behaviour, need)).digest('hex').slice(0, 12);
}

/**
 * Turn a run's surviving mutants into ranked, deduplicated work.
 *
 * Grouped by (file, behaviour, need), which is the unit a developer actually
 * fixes: "nothing asserts the boundary in cart.ts" is one sitting, whether the
 * tool reported it on two lines or nine.
 */
export function mutantClosure(input: MutantClosureInput): MutantClosureReport {
  const maxItems = input.maxItems ?? MUTANT_CLOSURE_MAX_ITEMS;
  const classified: Record<MutantClass, number> = {
    MISSING_ASSERTION: 0,
    NO_TEST_EXECUTED: 0,
    EQUIVALENT_MUTANT: 0,
    UNREACHABLE_CODE: 0,
    UNCLASSIFIED: 0,
  };
  const unknown = new Set<string>();

  interface Bucket {
    file: string;
    behaviour: MutantBehaviour;
    need: MutantNeed;
    klass: MutantClass;
    lines: Set<number>;
    survivors: number;
    mutators: Set<string>;
    details: string[];
    resultIds: Set<string>;
  }
  const buckets = new Map<string, Bucket>();

  for (const row of input.survivors) {
    const verdict = classifySurvivor(row, {
      equivalent: input.equivalent,
      unreachable: input.unreachable,
    });
    classified[verdict.class] += 1;
    if (verdict.behaviour === 'UNKNOWN' && row.mutator.trim().length > 0) {
      unknown.add(row.mutator.slice(0, MUTANT_MAX_MUTATOR_CHARS));
    }

    const rule = MUTANT_CLASS_RULES[verdict.class];
    if (!rule.generates) continue;
    const need = rule.need;
    /*
     * Not reachable through the type system alone: `need` is `MutantNeed | null`
     * on the rule and non-null exactly when `generates` is true. Narrowed here
     * rather than asserted, because a sixth class whose author sets
     * `generates: true` and forgets `need` must fall out of the loop rather
     * than crash a sweep over a customer's whole run.
     */
    if (need === null) continue;

    const key = groupKey(row.file, verdict.behaviour, need);
    const bucket = buckets.get(key) ?? {
      file: row.file,
      behaviour: verdict.behaviour,
      need,
      klass: verdict.class,
      lines: new Set<number>(),
      survivors: 0,
      mutators: new Set<string>(),
      details: [],
      resultIds: new Set<string>(),
    };
    // A null line is NOT recorded as 0. Line 0 does not exist and a zero here
    // would send a reader to the top of the file with confidence.
    if (row.line !== null && Number.isInteger(row.line) && row.line > 0) bucket.lines.add(row.line);
    bucket.survivors += 1;
    if (row.mutator.trim().length > 0) {
      bucket.mutators.add(row.mutator.slice(0, MUTANT_MAX_MUTATOR_CHARS));
    }
    if (row.detail !== null && row.detail.length > 0) bucket.details.push(row.detail);
    bucket.resultIds.add(row.testResultId);
    buckets.set(key, bucket);
  }

  const all: MutantClosureItem[] = [...buckets.values()].map((bucket) => {
    const lines = [...bucket.lines].sort((a, b) => a - b);
    const rule = MUTANT_BEHAVIOUR_RULES[bucket.behaviour];
    const detail =
      bucket.details.length === 0
        ? null
        : fence(
            untrusted({
              provenance: 'RUNNER_OUTPUT',
              // Joined, not summarised. A summary of untrusted text is untrusted
              // text with a trustworthy-looking shape.
              text: bucket.details.join('\n'),
              origin: 'mutation tool report',
            }),
          );
    const where =
      lines.length === 0
        ? `${bucket.file} (the tool reported no line numbers)`
        : `${bucket.file}:${lines.slice(0, MUTANT_CLOSURE_MAX_LINES).join(', ')}` +
          (lines.length > MUTANT_CLOSURE_MAX_LINES
            ? ` and ${lines.length - MUTANT_CLOSURE_MAX_LINES} further line(s)`
            : '');
    return {
      id: mutantGroupKey(bucket.file, bucket.behaviour, bucket.need),
      need: bucket.need,
      class: bucket.klass,
      behaviour: bucket.behaviour,
      file: bucket.file,
      lines: lines.slice(0, MUTANT_CLOSURE_MAX_LINES),
      lineCount: lines.length,
      survivors: bucket.survivors,
      missingAssertion:
        bucket.need === 'TEST'
          ? 'No test executes this code, so there is nothing to add an assertion to. This needs a test that reaches it first; once it does, the same mutation will say what to assert.'
          : rule.assertion,
      where,
      // A DECLARED weight times a COUNT. Not a measurement, and the field name
      // and this comment are the only places that can say so.
      rank: rule.weight * bucket.survivors,
      reportedMutators: [...bucket.mutators].sort(),
      toolDetail: detail?.block ?? null,
      toolDetailDisclosure: detail?.disclosure ?? null,
      testResultIds: [...bucket.resultIds].sort(),
    };
  });

  all.sort(
    (a, b) =>
      b.rank - a.rank ||
      b.survivors - a.survivors ||
      a.file.localeCompare(b.file) ||
      a.behaviour.localeCompare(b.behaviour),
  );

  const items = all.length > maxItems ? all.slice(0, maxItems) : all;
  const notGenerated =
    classified.EQUIVALENT_MUTANT + classified.UNREACHABLE_CODE + classified.UNCLASSIFIED;

  const caveats: string[] = [];
  if (classified.EQUIVALENT_MUTANT > 0) {
    caveats.push(
      `${classified.EQUIVALENT_MUTANT} survivor(s) are equivalent mutations — a change with no observable behaviour — and no test is generated for them. A test asserting an unobservable difference cannot pass.`,
    );
  }
  if (classified.UNREACHABLE_CODE > 0) {
    caveats.push(
      `${classified.UNREACHABLE_CODE} survivor(s) are on code the caller has evidence cannot execute. No assertion reaches unreachable code.`,
    );
  }
  if (classified.UNCLASSIFIED > 0) {
    caveats.push(
      `${classified.UNCLASSIFIED} survivor(s) could not be classified, so nothing is claimed about them and nothing is generated. They are counted here rather than folded into the missing-assertion total.`,
    );
  }
  if (unknown.size > 0) {
    caveats.push(
      `${unknown.size} mutation operator(s) are not in QAAI's table: ${[...unknown].sort().slice(0, 8).join(', ')}. They are reported, not guessed at.`,
    );
  }
  if (all.length > items.length) {
    caveats.push(
      `${all.length} items were produced and the first ${maxItems} are listed, ranked by declared behaviour weight times survivor count.`,
    );
  }
  caveats.push(
    'Rank is a DECLARED weight from QAAI’s behaviour table multiplied by a survivor count. It is a priority, not a measurement of how broken anything is.',
  );

  return {
    classified,
    notGenerated,
    items,
    itemsTotal: all.length,
    cappedAt: all.length > items.length ? all.length : null,
    unknownMutators: [...unknown].sort(),
    unknownMutatorCount: unknown.size,
    disclosure: closureDisclosure(classified, all.length),
    caveats,
  };
}

/**
 * The sentence, with the counts of each class.
 *
 * Reports zero out loud and names every class that is non-zero, because "47
 * survivors, 12 of them equivalent" is the only version of this sentence a
 * reader can act on — a bare "47 missing assertions" would be a count inflated
 * by every mutation that cannot be closed.
 */
export function closureDisclosure(
  classified: Record<MutantClass, number>,
  items: number,
): string {
  const total = MUTANT_CLASSES.reduce((sum, klass) => sum + classified[klass], 0);
  if (total === 0) return 'No surviving mutants to close.';
  const parts = MUTANT_CLASSES.filter((klass) => classified[klass] > 0).map(
    (klass) => `${classified[klass]} ${klass}`,
  );
  return `${total} surviving mutant(s): ${parts.join(', ')}. ${items} item(s) of work.`;
}
