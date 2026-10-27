/**
 * Generator (§3.2) — turns an approved plan item into real test code.
 *
 * Three hard requirements from the spec shape everything here:
 *   1. The output is standard code the customer owns. No QAAI imports, no
 *      proprietary helpers — a generated test must run under the ecosystem's own
 *      command (`npx playwright test`, `pytest`, `go test ./...`) with QAAI
 *      uninstalled.
 *   2. Selectors are resilient and assertions check meaning. The Flow Map hands
 *      the model real locators with confidence scores so it does not invent
 *      brittle CSS, and anything low-confidence comes back as a review flag.
 *   3. It is written in the team's OWN dialect. "Correct Python" is not the bar;
 *      a pytest fixture rather than a setUp method is. Everything that makes
 *      code idiomatic per ecosystem lives in `ecosystem-prompts.ts`, and this
 *      file's job is to pick the right one and hold it to the universal rules.
 *
 * ── ADMISSION (§3.2b): nothing is returned that nobody checked ───────────────
 *
 * This file used to do its own post-checks: an `@qaai/` regex, a fixed-sleep
 * scan, a file-path convention test. Each was right and each was a SUBSET of
 * `admission.ts`, which parses the file, typechecks it, formats it, ranks its
 * locators, counts its assertions, traces it back to the plan item a human
 * approved and compares it against the suite it is joining. Two notions of the
 * same check is how one of them starts disagreeing with the other, so the three
 * local ones are gone and `admit` is the only gate. Every review flag a human
 * used to see is still produced — by the gate whose name describes it — and
 * `generator.test.ts` pins each one.
 *
 * What admission adds beyond flags is a VERDICT, and this file honours it:
 *
 *   ADMIT / ADMIT_WITH_FLAGS  the test is returned, with `report.code` (FORMAT
 *                             may have rewritten it) at `report.correctedFilePath`,
 *                             and every flag merged in.
 *   REVISE                    ONE more model call, fed `report.revisePrompt`
 *                             verbatim, then admitted again as attempt 2.
 *   REFUSE                    {@link GenerationRefused} is THROWN. There is no
 *                             shape of this function that hands a caller a
 *                             broken or duplicate test to store, because the
 *                             defect being closed is a test nobody could run
 *                             sitting in the suite counted as coverage.
 *
 * Only the CODE path is gated. See THE SPEC-DRIVEN GAP at `generateSpecDriven`
 * for the measurement behind that, which is not a shortcut: FIDELITY compares
 * the plan's English against the artefact's text, four of the spec schemas have
 * no field that English can live in, and gating them would refuse a correct
 * VISUAL, ACCESSIBILITY, LOAD or PERFORMANCE test every single time.
 */

import { z } from 'zod';
import { NEW_TEST_TEMPLATES, TEST_TYPE_LABELS, generatedTestSchema } from '@qaai/shared';
import type { FlowMap, Language, PlanItem, UiFramework } from '@qaai/shared';
import type { EcosystemId } from './ecosystem-prompts.js';
import { ECOSYSTEMS, UNIVERSAL_RULES, resolveEcosystem, testFilePath } from './ecosystem-prompts.js';
import { FINAL_ATTEMPT, admit } from './admission.js';
import type { AdmissionInput, AdmissionReport, GateId } from './admission.js';
import type { ToolchainGates } from './toolchain.js';
import { LlmError, NO_KEY_SENTENCE } from './llm.js';
import type { CallContext, LlmService } from './llm.js';
import {
  generationStrategyFor,
  specFilePathFor,
  specPointerCode,
  specSchemaText,
} from './spec-strategies.js';
import type { HybridStrategy, SpecDrivenStrategy } from './spec-strategies.js';

export interface GeneratedTest {
  name: string;
  filePath: string;
  code: string;
  reviewFlags: string[];
  /**
   * The plugin-validated JSON for spec-driven and hybrid types; null for the
   * pure code types, whose plugins never read it. Persisted as `Test.spec`.
   */
  spec: unknown;
  /**
   * The gate's own record of what was checked and what could not be — every
   * gate, every status, every line it blamed.
   *
   * NULL means admission did not run, which is a real answer and never a quiet
   * one: it is the spec-driven path described at {@link generateSpecDriven}.
   * A caller that logs or stores this must not read null as "all clear".
   */
  admission: AdmissionReport | null;
  /** Model calls behind this file: 1, or 2 when admission sent the first one back. */
  attempts: number;
}

/**
 * The refusal, thrown rather than returned.
 *
 * A refusal is not an error in the sense of "something went wrong" — the
 * pipeline worked exactly as designed. It is thrown anyway, for one reason: a
 * returned union is a shape a caller can destructure and store by accident,
 * and the defect this whole slice exists to close is a broken or duplicate test
 * stored and counted as coverage. A throw cannot be ignored, and both existing
 * callers (the worker's generate processor and the repro route) already turn a
 * throw from `generateTest` into a recorded, human-visible outcome.
 *
 * Everything a human needs is on the instance rather than only in the message,
 * so the processor can write a structured audit row: `report` carries each
 * gate's verdict and detail lines, `failedGates` names what refused it, and
 * `attempts` says whether the model was given its one chance to fix it.
 */
export class GenerationRefused extends Error {
  readonly report: AdmissionReport;
  readonly attempts: number;
  /** The approved item that produced nothing, for the caller's audit trail. */
  readonly item: PlanItem;
  readonly planItemId: string;
  readonly planItemTitle: string;
  /** The path this test WOULD have had; stored nowhere, recorded in the audit row. */
  readonly filePath: string;
  readonly failedGates: GateId[];

  constructor(args: {
    report: AdmissionReport;
    attempts: number;
    item: PlanItem;
    filePath: string;
  }) {
    const failed = args.report.gates.filter((gate) => gate.status === 'FAIL');
    super(
      `Nothing was stored for the approved plan item "${args.item.title}". After ${
        args.attempts
      } attempt(s) the generated test still fails ${
        failed.map((gate) => gate.gate).join(', ') || 'admission'
      }, and storing it would have counted a broken or duplicate test as coverage. ${failed
        .map((gate) => gate.why)
        .join(' ')}`,
    );
    this.name = 'GenerationRefused';
    this.report = args.report;
    this.attempts = args.attempts;
    this.item = args.item;
    this.planItemId = args.item.id;
    this.planItemTitle = args.item.title;
    this.filePath = args.filePath;
    this.failedGates = failed.map((gate) => gate.gate);
  }
}

const SYSTEM = `You are the Generator agent inside QAAI, an AI QA engineer.

You turn one approved test plan item into working test code. The code you write
is committed to the customer's own repository and must run without QAAI
installed — it is their code, not ours. Never import anything from a "qaai"
package and never reference QAAI in the source.

You write in whatever language and framework the project uses, and you write it
the way that ecosystem's own engineers would. Code that merely compiles is not
the bar: a test that reads as foreign is a test nobody on the team will maintain.

You are given the exact locators a crawler found on the real page, each with a
confidence score. Use them. Do not invent selectors for elements that are not in
the list; if the plan needs an element you were not given, use the most robust
role- or text-based locator you can and add a reviewFlag saying it was inferred.

Put anything a human should look at into reviewFlags: inferred locators,
low-confidence locators (below 0.6), assumptions about test data, or steps you
could not express faithfully.

${UNIVERSAL_RULES}`;

/**
 * THE NODES AND EDGES A PLAN ITEM IS ABOUT, NAMED RATHER THAN GUESSED AT.
 *
 * A producer that knows which states its item walks says so here. Everything
 * named is PINNED into the prompt: it cannot be evicted by the context budget
 * and it does not have to win a word-overlap contest to be included.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Retrieval used to be substring overlap and nothing else, over `title`,
 * `steps` and `assertions`, keeping the top six nodes by how many >3-character
 * words they shared. It ignored `journeyId` — which the Explorer has always
 * populated — and it ignored edges entirely. The consequence was not a slightly
 * worse prompt: THE PAGE THE ITEM IS ABOUT COULD BE ABSENT FROM IT. An item
 * titled "Check out with two items in the cart" shares no word longer than three
 * characters with a node routed `/order/confirm` titled "Thanks!", so the
 * confirmation page — the only page the assertion is about — scored zero and was
 * dropped, and the model invented a locator for it and flagged the invention.
 * Every such flag read as the model being careful when it was the retrieval
 * being blind.
 *
 * ── THE THREE-TIER RESOLUTION, in order ────────────────────────────────────
 *
 *   1. EXPLICIT. `targets.nodeIds` / `targets.edgeIds`, set by a producer that
 *      derived the item from a specific walk, race, boundary form or access
 *      matrix cell. Authoritative, order-preserving.
 *   2. JOURNEY-GROUNDED. `item.journeyId` resolves to a `Journey`, whose
 *      `edgeIds` are an ORDERED path; the edges' `from`/`to` are the states the
 *      journey actually traverses, in traversal order. This needs no schema
 *      change at all — `journeyId` was on `PlanItem` the whole time and was
 *      simply never read here, which is why this was the cheapest large quality
 *      win available.
 *   3. WORD OVERLAP. Unchanged, and still useful: it fills whatever budget the
 *      first two leave, so an item with no targets and no journey behaves
 *      exactly as it did before.
 *
 * ── OPTIONAL, AND DELIBERATELY STRUCTURAL ──────────────────────────────────
 *
 * `targets` is not on `planItemSchema` in packages/shared/src/schemas.ts and
 * this file does not own that schema, so it is declared as a structural
 * widening: a producer in this package can set it, this function reads it when
 * present, and a `PlanItem` that lacks it is assignable unchanged. The
 * consequence is stated plainly rather than hidden — the field does NOT survive
 * a round trip through `planItemSchema.parse` or through the `PlanItem` table,
 * so an item that travels through the database arrives with tier 1 empty and
 * falls back to tier 2. That is why tier 2 carries the weight, and the exact
 * schema and migration edit that would make tier 1 durable is in this round's
 * handover.
 */
export interface PlanItemTargets {
  /** `FlowNode.id`s this item is about. Pinned, in this order. */
  nodeIds?: readonly string[];
  /** `FlowEdge.id`s this item traverses. Pinned, with both endpoints. */
  edgeIds?: readonly string[];
}

/** A `PlanItem` a producer in this package has annotated with its targets. */
export type TargetedPlanItem = PlanItem & { targets?: PlanItemTargets | null };

/**
 * How many states reach the prompt when nothing is pinned.
 *
 * Six, unchanged from the substring-only version, because the budget was never
 * the defect — the SELECTION was. Pinned states are not subject to it (see
 * {@link ContextSelection.pinnedOverflow}): a cap that silently evicts the page
 * the item names would re-create the exact bug this function exists to remove.
 */
const CONTEXT_NODE_BUDGET = 6;

/** How many transitions are rendered. A journey longer than this is disclosed. */
const CONTEXT_EDGE_BUDGET = 12;

/**
 * What retrieval chose, and everything it could not — so a caller can flag it.
 *
 * `text` alone would make every shortfall invisible, and a budget that bit
 * without being reported reads as "that is all there is". Every count here is
 * paired with the reason it is non-zero.
 */
export interface ContextSelection {
  /** The rendered STATES and TRANSITIONS block for the prompt. */
  text: string;
  /** Node ids actually rendered, in render order. */
  nodeIds: readonly string[];
  /** Edge ids actually rendered, in render order. */
  edgeIds: readonly string[];
  /** How the pinned set was arrived at. `NONE` means pure word overlap. */
  grounding: 'EXPLICIT' | 'JOURNEY' | 'NONE';
  /** Target node ids the flow map does not contain — producer/crawl drift. */
  missingNodeIds: readonly string[];
  /** Target edge ids the flow map does not contain. */
  missingEdgeIds: readonly string[];
  /**
   * Set when `item.journeyId` names a journey this flow map has no record of.
   *
   * A real state, not a tidy-up: a plan outlives the crawl it was proposed
   * against, and an item pointing at a journey from a superseded version has
   * lost its grounding. Reported so the test that is generated anyway says so.
   */
  unknownJourneyId: string | null;
  /** States that matched and did not fit the budget. Never silently dropped. */
  omittedNodes: number;
  /** Transitions of a pinned journey that did not fit {@link CONTEXT_EDGE_BUDGET}. */
  omittedEdges: number;
  /** True when the pinned set alone exceeded the budget, which it is allowed to. */
  pinnedOverflow: boolean;
}

function selectorsFor(node: FlowMap['nodes'][number]): string {
  const locators = [
    ...node.affordances.map((a) => ({ label: a.label, sel: a.selector })),
    ...node.forms.flatMap((f) =>
      f.fields.map((x) => ({ label: x.label ?? x.name, sel: x.selector })),
    ),
  ]
    .map(
      (entry) =>
        `      ${describeSelector(entry.sel)}  [confidence ${entry.sel.confidence.toFixed(2)}]`,
    )
    .join('\n');
  return locators || '      (no locators captured)';
}

/**
 * Only the states and transitions this plan item touches — the whole map would
 * blow the budget.
 *
 * EXPORTED for the tests that pin the three-tier resolution. Retrieval is the
 * one part of generation whose correctness is checkable WITHOUT a model: the
 * question "is the page this item is about in the prompt" has an exact answer,
 * and it had no test at all while the answer was frequently no.
 */
export function relevantContext(flowMap: FlowMap, item: TargetedPlanItem): ContextSelection {
  const nodeById = new Map(flowMap.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(flowMap.edges.map((edge) => [edge.id, edge]));

  const missingNodeIds: string[] = [];
  const missingEdgeIds: string[] = [];
  let unknownJourneyId: string | null = null;

  /*
   * TIER 1 and TIER 2 both feed this ordered, de-duplicated pin list. Order is
   * preserved because it is MEANINGFUL: a journey's edges are a path, and
   * rendering its states in traversal order is most of what tells the model
   * which page comes after which.
   */
  const pinnedNodeIds: string[] = [];
  const pinnedEdgeIds: string[] = [];
  const pinNode = (id: string): void => {
    if (!pinnedNodeIds.includes(id)) pinnedNodeIds.push(id);
  };

  const explicitNodes = item.targets?.nodeIds ?? [];
  const explicitEdges = item.targets?.edgeIds ?? [];
  for (const id of explicitNodes) {
    if (nodeById.has(id)) pinNode(id);
    else missingNodeIds.push(id);
  }
  for (const id of explicitEdges) {
    const edge = edgeById.get(id);
    if (!edge) {
      missingEdgeIds.push(id);
      continue;
    }
    if (!pinnedEdgeIds.includes(id)) pinnedEdgeIds.push(id);
    // Both endpoints, because a transition the model cannot see both sides of
    // is not a transition it can write a step for.
    if (nodeById.has(edge.from)) pinNode(edge.from);
    if (nodeById.has(edge.to)) pinNode(edge.to);
  }

  const hadExplicit = pinnedNodeIds.length > 0 || pinnedEdgeIds.length > 0;

  if (item.journeyId !== null) {
    const journey = flowMap.journeys.find((j) => j.id === item.journeyId);
    if (!journey) {
      unknownJourneyId = item.journeyId;
    } else {
      for (const edgeId of journey.edgeIds) {
        const edge = edgeById.get(edgeId);
        if (!edge) {
          // The journey names an edge the graph does not hold. Recorded rather
          // than skipped: it means the journey and the node list came out of
          // different crawls, which is worth a human knowing.
          missingEdgeIds.push(edgeId);
          continue;
        }
        if (!pinnedEdgeIds.includes(edgeId)) pinnedEdgeIds.push(edgeId);
        if (nodeById.has(edge.from)) pinNode(edge.from);
        if (nodeById.has(edge.to)) pinNode(edge.to);
      }
    }
  }

  const grounding: ContextSelection['grounding'] = hadExplicit
    ? 'EXPLICIT'
    : pinnedNodeIds.length > 0 || pinnedEdgeIds.length > 0
      ? 'JOURNEY'
      : 'NONE';

  /*
   * TIER 3. Word overlap over everything not already pinned, exactly as before.
   * `score > 0` is still required unless the whole map is small enough to show,
   * so an unrelated node does not crowd out a pinned one.
   */
  const words = new Set(
    `${item.title} ${item.steps.join(' ')} ${item.assertions.join(' ')}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
  const pinnedSet = new Set(pinnedNodeIds);
  const scored = flowMap.nodes
    .filter((node) => !pinnedSet.has(node.id))
    .map((node) => {
      const hay = `${node.route} ${node.title} ${node.forms
        .map((f) => f.fields.map((x) => `${x.name} ${x.label ?? ''}`).join(' '))
        .join(' ')} ${node.affordances.map((a) => a.label).join(' ')}`.toLowerCase();
      const score = [...words].filter((w) => hay.includes(w)).length;
      return { node, score };
    })
    .filter((entry) => entry.score > 0 || flowMap.nodes.length <= CONTEXT_NODE_BUDGET)
    .sort((a, b) => b.score - a.score);

  const fillBudget = Math.max(0, CONTEXT_NODE_BUDGET - pinnedNodeIds.length);
  const filled = scored.slice(0, fillBudget);
  const omittedNodes = scored.length - filled.length;

  const renderedNodeIds = [...pinnedNodeIds, ...filled.map((entry) => entry.node.id)];
  const renderedEdgeIds = pinnedEdgeIds.slice(0, CONTEXT_EDGE_BUDGET);
  const omittedEdges = pinnedEdgeIds.length - renderedEdgeIds.length;

  const stateBlock = renderedNodeIds
    .map((id) => {
      const node = nodeById.get(id);
      if (!node) return null;
      const pin = pinnedSet.has(id) ? ' *THIS ITEM IS ABOUT THIS STATE*' : '';
      return `  ${node.route} — "${node.title}"${
        node.behindAuth ? ' (behind auth)' : ''
      }${pin}\n${selectorsFor(node)}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join('\n\n');

  /*
   * THE TRANSITIONS, which were absent from this prompt entirely.
   *
   * A multi-step journey test is mostly transitions: what you click on page A
   * to reach page B. The model was given both pages and no statement of what
   * connects them, so it inferred the link from the affordance labels and
   * flagged the inference. The edge's own `action` and `selector` are exactly
   * that statement, and the crawler proved each one by traversing it.
   */
  const edgeBlock = renderedEdgeIds
    .map((id) => {
      const edge = edgeById.get(id);
      if (!edge) return null;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      const how = edge.selector
        ? `${describeSelector(edge.selector)}  [confidence ${edge.selector.confidence.toFixed(2)}]`
        : '(no locator captured — infer it and flag the inference)';
      return `  ${from?.route ?? edge.from} → ${to?.route ?? edge.to}: ${edge.action}
      ${how}${edge.formId ? `\n      fill form "${edge.formId}" first` : ''}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join('\n');

  const text = [
    stateBlock,
    edgeBlock
      ? `\nTRANSITIONS, in the order this item's journey traverses them:\n${edgeBlock}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    nodeIds: renderedNodeIds,
    edgeIds: renderedEdgeIds,
    grounding,
    missingNodeIds,
    missingEdgeIds,
    unknownJourneyId,
    omittedNodes,
    omittedEdges,
    pinnedOverflow: pinnedNodeIds.length > CONTEXT_NODE_BUDGET,
  };
}

/**
 * The review flags retrieval itself owes the human, if any.
 *
 * Separate from `relevantContext` so the selection can be tested on its counts
 * without asserting on prose. Every one of these is a cap or a drift that BIT —
 * the rule being honoured is that a shortfall is reported as a count AND a
 * reason, so the report can say "at least N more existed".
 */
export function contextReviewFlags(selection: ContextSelection): string[] {
  const flags: string[] = [];
  if (selection.unknownJourneyId !== null) {
    flags.push(
      `This item names journey "${selection.unknownJourneyId}", which this flow map does not contain — the plan is older than the crawl it was generated against. The states below were chosen by word overlap instead, so the page the item is about may not be among them.`,
    );
  }
  if (selection.missingNodeIds.length > 0) {
    flags.push(
      `${selection.missingNodeIds.length} state(s) this item targets are not in this flow map (${selection.missingNodeIds
        .slice(0, 3)
        .join(', ')}), so their locators were not available to the generator.`,
    );
  }
  if (selection.missingEdgeIds.length > 0) {
    flags.push(
      `${selection.missingEdgeIds.length} transition(s) this item traverses are not in this flow map (${selection.missingEdgeIds
        .slice(0, 3)
        .join(', ')}), so how to get between those pages was inferred rather than given.`,
    );
  }
  if (selection.omittedNodes > 0) {
    flags.push(
      `Only ${selection.nodeIds.length} of ${
        selection.nodeIds.length + selection.omittedNodes
      } matching states fitted the generator's context budget, so at least ${
        selection.omittedNodes
      } more existed and their locators were not offered.`,
    );
  }
  if (selection.omittedEdges > 0) {
    flags.push(
      `This item's journey is longer than the ${CONTEXT_EDGE_BUDGET} transitions that fitted the context budget; at least ${selection.omittedEdges} more steps exist and were not described.`,
    );
  }
  if (selection.grounding === 'NONE' && selection.nodeIds.length === 0) {
    flags.push(
      'No state in this flow map matched this item by target, journey or wording, so every locator in this test was inferred.',
    );
  }
  return flags;
}

function describeSelector(sel: { strategy: string; value: string; name?: string }): string {
  switch (sel.strategy) {
    case 'ROLE':
      return `getByRole('${sel.value}', { name: ${JSON.stringify(sel.name ?? '')} })`;
    case 'LABEL':
      return `getByLabel(${JSON.stringify(sel.value)})`;
    case 'PLACEHOLDER':
      return `getByPlaceholder(${JSON.stringify(sel.value)})`;
    case 'TEXT':
      return `getByText(${JSON.stringify(sel.value)})`;
    case 'TEST_ID':
      return `getByTestId(${JSON.stringify(sel.value)})`;
    default:
      return `locator(${JSON.stringify(sel.value)})`;
  }
}

export interface GenerateTestArgs {
  /*
   * `TargetedPlanItem`, not `PlanItem`: a producer that knows which states and
   * transitions its item is about names them, and {@link relevantContext} pins
   * them into the prompt. A plain `PlanItem` is assignable unchanged, so every
   * existing caller keeps compiling and keeps getting the journey-grounded
   * fallback.
   */
  item: TargetedPlanItem;
  flowMap: FlowMap;
  language: Language;
  framework: UiFramework;
  /** Secret names available as env vars — values are never sent to the model. */
  availableSecretNames?: string[];
  /**
   * Overrides the (language, framework) default — a Java shop on TestNG, a
   * team that writes Gherkin. Nothing in the product sets this yet; the
   * project model carries no runner preference.
   */
  runner?: EcosystemId | null;

  /**
   * The tests this one is joining, for admission's DUPLICATE gate.
   *
   * THE DEFECT IT CLOSES: approving a plan twice, or approving a plan over an
   * imported suite, mints a second test that walks the same routes and makes
   * the same assertions. It raises the coverage numerator and covers nothing,
   * which is the most direct way the number can lie.
   *
   * OMITTING IT IS NOT FREE. Admission then reports DUPLICATE as UNAVAILABLE
   * and puts that in `reviewFlags`, because "admitted" must never silently
   * mean "unchecked". The caller decides which tests are worth loading — see
   * `duplicateCandidates` in apps/worker/src/processors/generate.ts for the
   * bounded rule and what it can miss; a 5,000-test project cannot have every
   * test's source read into one admission call.
   */
  existing?: AdmissionInput['existing'];

  /**
   * THE TOOLCHAIN SEAM — and today nothing fills it.
   *
   * `toolchainFor({ repoRoot })` runs the CUSTOMER'S OWN prettier, eslint, tsc,
   * black and gofmt over the generated file, which is what SYNTAX, TYPECHECK,
   * FORMAT and LINT need. All four require a materialised checkout, and
   * generation has none: a generate job holds an org, a project, a plan and a
   * flow map, and never puts a line of the customer's code on disk.
   *
   * So this is left undefined by every caller, those four gates report
   * UNAVAILABLE, and all four land in `reviewFlags` — a missing brace is still
   * found at run time rather than here, and the file says so out loud instead
   * of claiming a PASS from a tool that never ran.
   *
   * WHAT IT WOULD TAKE to fill it, concretely:
   *   1. `apps/worker/src/repo-materialise.ts` already does the hard part for
   *      runs (`materialiseRepoWorkspace`: GitHub App token, tarball at a ref,
   *      capped extraction into a temp dir, `cleanup()` in a `finally`). It is
   *      keyed on `runId` and takes the worker's vault `unseal`, so generation
   *      would pass the generate job's own id and hold the workspace for the
   *      whole BATCH rather than per item — a tarball per plan item would
   *      download the same repository ten times.
   *   2. The generate processor would thread `toolchainFor({ repoRoot:
   *      workspace.root })` in here, and keep the no-repo outcome honest the
   *      way the run processor does: an unconnected project is an UNAVAILABLE
   *      with a reason, never a PASS.
   *   3. It costs a download per batch and ~2s of tooling per attempt, which
   *      is why it is a decision and not an oversight.
   */
  toolchain?: ToolchainGates;
}

/**
 * One entry point, three shapes out — decided by the TYPE's strategy, which is
 * decided by what the type's plugin executes. The old behaviour (Playwright
 * prose for every type) shipped tests whose own plugin rejected them at
 * validate(); now a spec-driven item produces a spec the plugin's schema has
 * already accepted, or nothing at all.
 */
export async function generateTest(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
): Promise<GeneratedTest> {
  const strategy = generationStrategyFor(args.item.testType);
  if (strategy.mode === 'spec') return generateSpecDriven(llm, ctx, args, strategy);
  return generateCodeTest(llm, ctx, args, strategy);
}

async function generateCodeTest(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
  strategy: { mode: 'code'; seededSpec?: unknown; forcePlaywright?: boolean } | HybridStrategy,
): Promise<GeneratedTest> {
  const { item, flowMap, language, framework } = args;

  // Test code has no deterministic fallback: a placeholder journey that
  // ignores the plan's steps would go green over nothing, which is worse than
  // this refusal. The sentence is THE no-key sentence, so every surface that
  // already explains the fix explains this too.
  if (!llm.configured) {
    throw new LlmError(
      `${NO_KEY_SENTENCE}. A ${item.testType} test is a journey only a model (or a human in the editor) can write.`,
      'AUTH',
    );
  }

  const projectEcosystem = resolveEcosystem({
    language,
    framework,
    testType: item.testType,
    runner: args.runner ?? null,
  });
  // CROSS_BROWSER and LOCALIZATION execute through the matrix plugin, which
  // drives Playwright itself per engine/locale — their code must be a
  // Playwright TypeScript spec no matter what dialect the project writes.
  const ecosystem = strategy.forcePlaywright ? ECOSYSTEMS.PLAYWRIGHT_TS : projectEcosystem;
  const suggestedPath = testFilePath(ecosystem, { feature: item.feature, title: item.title });

  /*
   * Retrieval runs ONCE and its accounting travels with the test. Calling
   * `relevantContext` twice — once for the prompt and once for the flags —
   * would be two selections that can disagree about what the model was shown.
   */
  const context = relevantContext(flowMap, item);

  const hybridReturnLines =
    strategy.mode === 'hybrid'
      ? `\n  spec         the runner configuration described under THE SPEC below`
      : '';
  const hybridSpecSection =
    strategy.mode === 'hybrid'
      ? `

THE SPEC
${strategy.specNotes}

Its JSON Schema:
${specSchemaText(strategy.schema)}`
      : '';

  const prompt = `TEST PLAN ITEM
  title:      ${item.title}
  rationale:  ${item.rationale}
  feature:    ${item.feature}
  priority:   ${item.priority}
  type:       ${item.testType}

  steps:
${item.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}

  assertions:
${item.assertions.map((a) => `    - ${a}`).join('\n')}

PAGES AND REAL LOCATORS FROM THE CRAWL
These are written in Playwright's role/label vocabulary because that is how the
crawler records them. Translate each one into ${ecosystem.label}'s own locator
API, keeping the same target. Where that ecosystem has no equivalent — no role
engine, CSS only — pick the most stable selector it does have and add a
reviewFlag saying what was lost.
${context.text || '  (no matching states — infer carefully and flag it)'}

BASE URL: ${flowMap.baseUrl} (configured for the suite; navigate with relative paths)
${
  args.availableSecretNames?.length
    ? `AVAILABLE SECRETS (read from the environment, never inline the value):
  ${args.availableSecretNames.join(', ')}`
    : ''
}

ECOSYSTEM: ${ecosystem.label}

${ecosystem.rules}

Return:
  name         the test name as it appears in the test declaration
  filePath     "${suggestedPath}". The convention is ${ecosystem.pathRule}, and the
               runner collects by that pattern — a path outside it is a test that
               silently never runs. Deviate only to satisfy the same convention
               better (a package or class name the code requires).
  code         the complete file contents${hybridReturnLines}
  reviewFlags  anything a human should check before trusting this test${hybridSpecSection}`;

  // Hybrids validate the spec against the plugin's own schema in the same
  // structured call — a near-miss shape gets the one repair retry, and a
  // second miss throws rather than storing a spec the plugin would reject.
  const ask = async (text: string): Promise<ModelTest> =>
    (await llm.structured(ctx, {
      tier: 'strong',
      effort: 'high',
      system: SYSTEM,
      prompt: text,
      schema:
        strategy.mode === 'hybrid'
          ? generatedTestSchema.extend({ spec: strategy.schema })
          : generatedTestSchema,
      schemaName: strategy.mode === 'hybrid' ? `Generated${item.testType}Test` : 'GeneratedTest',
      maxTokens: 16000,
      cacheSystem: true,
    })) satisfies ModelTest;

  /** What goes in `Test.spec`: the hybrid's validated spec, or the type's seed. */
  const specOf = (model: ModelTest): unknown =>
    strategy.mode === 'hybrid' ? model.spec : (strategy.seededSpec ?? null);

  const gate = (model: ModelTest, attempt: number): Promise<AdmissionReport> =>
    admit({
      code: model.code,
      filePath: model.filePath,
      testType: item.testType,
      // The plan item a human APPROVED, which is what FIDELITY traces against.
      // Passing null here would turn a drifted test into an unchecked one.
      item,
      language,
      /*
       * The ecosystem the PROMPT was written against — not the project's
       * default — because that is the convention the file has to satisfy. They
       * differ for CROSS_BROWSER and LOCALIZATION, whose matrix plugin drives
       * Playwright itself: a Python project's CROSS_BROWSER test is a
       * Playwright TypeScript spec, and resolving the gate's ecosystem from
       * `language` alone would "correct" it to a pytest path and then read it
       * as Python. Passing the id also settles the assertion dialect, which is
       * why ASSERTIONS can count `expect(` in a file whose project is Ruby.
       */
      ecosystemId: ecosystem.id,
      spec: specOf(model),
      attempt,
      existing: args.existing,
      toolchain: args.toolchain,
      /*
       * THE MUTATION SEAM, deliberately empty.
       *
       * `mutationGate` in `mutation-gate.ts` is the strongest check in the
       * repo — break the code under test and see whether the test notices —
       * and it needs two things generation does not have: a materialised
       * workspace to mutate and a RUNNABLE test, which this one is not yet
       * (it has no Test row, no runner job, no auth session). The worker would
       * inject it here from the run side, once a generated test has executed
       * at least once.
       *
       * Absent, admission reports MUTATION UNAVAILABLE and — uniquely — does
       * NOT flag it, because a gate that can never run in this configuration
       * would otherwise put a flag on every test ever generated, and a flag
       * that is always there is a flag nobody reads. Supply it and an
       * UNAVAILABLE becomes a fact about THIS test and IS flagged; that
       * asymmetry is `admission.test.ts`'s, not something to re-decide here.
       */
    });

  let attempts = 1;
  let generated = await ask(prompt);
  let report = await gate(generated, attempts);

  /*
   * ONE re-prompt. Not a loop, and the constant is the reason: FINAL_ATTEMPT is
   * the attempt at which admission stops offering REVISE at all, so a second
   * ask is the entire budget this pipeline has. A model that has been told
   * exactly which assertion is missing and produced it missing again does not
   * produce it on the third try — it just spends another strong-tier call.
   *
   * `report.revisePrompt` goes in VERBATIM. It is written as instructions
   * ("add an assertion that proves the total is $42.00, like this:"), not as a
   * report, and it quotes the offending lines; paraphrasing it here would lose
   * the quotes, and the commonest way a repair fails is the model rewriting the
   * file from the plan and dropping what was already right. The previous file
   * goes with it because `llm.structured` is single-shot and carries no history
   * of its own, so without it "return the COMPLETE file again" has nothing to
   * return.
   */
  if (report.verdict === 'REVISE' && report.revisePrompt !== null) {
    const rejected = generated;
    attempts = FINAL_ATTEMPT;
    generated = await ask(`${prompt}

THE FILE YOU PRODUCED LAST TIME, WHICH WAS NOT ACCEPTED
  filePath: ${rejected.filePath}

${rejected.code}

${report.revisePrompt}`);
    report = await gate(generated, attempts);
  }

  /*
   * REFUSE, and the REVISE that could not be acted on (admission always writes
   * instructions with a REVISE, so the second half is unreachable by the
   * arithmetic — but a silent return here would store a test the gate asked to
   * have fixed, which is the defect one level up).
   */
  if (report.verdict === 'REFUSE' || report.verdict === 'REVISE') {
    throw new GenerationRefused({
      report,
      attempts,
      item,
      filePath: report.correctedFilePath ?? generated.filePath,
    });
  }

  /*
   * ADMITTED. Three things come from the report rather than from the model:
   *
   *   `code`  — the FORMAT gate may have rewritten it with the customer's own
   *             prettier/black/gofmt, and storing the model's version instead
   *             would put a reformatting diff in front of the first reviewer,
   *             which is the commonest reason a generated test is deleted
   *             rather than fixed. Every line number in the report refers to
   *             THIS text.
   *   `filePath` — PATH_CONVENTION's correction. A path the runner cannot
   *             collect is worse than a wrong path: the suite goes green over a
   *             file nobody executed.
   *   `reviewFlags` — every WARN and every gate that could not run. This is
   *             where the old `@qaai/`, fixed-sleep and path-convention flags
   *             now come from, each from the gate named after it.
   */
  /*
   * RETRIEVAL'S OWN FLAGS JOIN THE GATE'S.
   *
   * A retrieval that could not find the page the item is about used to be
   * invisible: the model inferred a locator, flagged the inference, and the flag
   * read as the model being careful rather than as the prompt being blind. These
   * say which it was.
   */
  const flags = [
    ...generated.reviewFlags,
    ...report.reviewFlags,
    ...contextReviewFlags(context),
  ];
  const code = report.code;
  const filePath = report.correctedFilePath ?? generated.filePath;

  // E2E and SMOKE execute through QAAI's Playwright harness, which only knows
  // how to run a Playwright TypeScript spec. Everything else is real, ownable
  // code that this worker cannot execute in-process — say so at generation time
  // rather than letting it surface as a confusing validation error at run time.
  if (ecosystem.id !== 'PLAYWRIGHT_TS' && (item.testType === 'E2E' || item.testType === 'SMOKE')) {
    flags.push(
      `Written for ${ecosystem.label}. QAAI runs E2E/SMOKE natively only for Playwright TypeScript — run this through an INTEGRATION test that invokes the suite's own command, or export the repo and run it in your CI.`,
    );
  }

  // The forced dialect deserves the same honesty as the paragraph above: a
  // Python shop should know why this one file is TypeScript.
  if (strategy.forcePlaywright && projectEcosystem.id !== 'PLAYWRIGHT_TS') {
    flags.push(
      `Written as Playwright TypeScript rather than ${projectEcosystem.label}: the ${item.testType} runner executes Playwright specs itself, once per ${
        item.testType === 'LOCALIZATION' ? 'locale' : 'browser engine'
      }.`,
    );
  }

  // A UNIT_GEN spec whose command does not name the generated file runs
  // something else and reports on that instead — flag it against the FINAL
  // path, which may differ from the one the model wrote the command around.
  if (
    strategy.mode === 'hybrid' &&
    item.testType === 'UNIT_GEN' &&
    !JSON.stringify(generated.spec ?? null).includes(filePath)
  ) {
    flags.push(
      `The external command spec does not reference "${filePath}" — check its args actually run the generated file.`,
    );
  }

  return {
    name: generated.name,
    filePath,
    code,
    reviewFlags: flags,
    spec: specOf(generated),
    admission: report,
    attempts,
  };
}

/** What the structured call comes back with, before admission has seen it. */
type ModelTest = z.infer<typeof generatedTestSchema> & { spec?: unknown };

// ─── Spec-driven types (§3.2) ────────────────────────────────────────────────

const SPEC_SYSTEM = `You are the Generator agent inside QAAI, an AI QA engineer.

You turn one approved test plan item into a machine-readable test SPEC — a JSON
document a purpose-built runner executes directly. There is no code to write:
the spec IS the test, and it is validated against a strict schema before it is
stored. A spec that does not parse is discarded, so obey the schema exactly —
no extra keys, no prose in value positions, no placeholders like "<fill me in>".

Ground the spec in the crawl data you are given: real routes, real selectors,
real form fields. Do not invent endpoints or selectors that are not in the
material; when the plan needs something the crawl did not capture, choose the
most plausible value and add a reviewFlag saying it was inferred.

Secrets are referenced BY NAME (the runner resolves them from a vault at
execution time). Never place a credential value, a token, or a DSN in the spec.

Put anything a human should check into reviewFlags: inferred routes or
selectors, assumptions about test data, thresholds chosen without evidence.`;

/**
 * A spec-driven item becomes a JSON spec validated against the PLUGIN's own
 * schema — with a model when a key exists, from the deterministic scaffold
 * when the strategy has one, and an honest refusal otherwise. In no branch can
 * a test row appear whose spec its plugin rejects: `llm.structured` parses the
 * response with the plugin schema (one repair retry, then throw), and the
 * scaffolds are pinned to `plugin.validate()` by the worker's unit tests.
 *
 * ── THE SPEC-DRIVEN GAP: why `admit` is NOT called here ─────────────────────
 *
 * This path returns `admission: null`, which is the honest value and not a
 * shrug. Admission as written cannot grade a JSON spec, and the number that
 * settled it was measured rather than guessed — every scaffoldable type, run
 * through `admit` at the final attempt:
 *
 *   API            ADMIT
 *   VISUAL         REFUSE  (FIDELITY)
 *   ACCESSIBILITY  REFUSE  (FIDELITY)
 *   LOAD           REFUSE  (FIDELITY)
 *   SECURITY_SMOKE REFUSE  (FIDELITY)
 *   PERFORMANCE    REFUSE  (FIDELITY + ASSERTIONS)
 *
 * FIDELITY asks whether the plan assertion a human approved — an English
 * sentence, "the product grid is unchanged at 1280px" — is traceable into the
 * artefact's text. For code it is, which is the gate working. For a spec it
 * cannot be: `{ path, fullPage, viewport, maxDiffRatio }` has NO FIELD THAT
 * ENGLISH CAN LIVE IN, and nor do ACCESSIBILITY's `{ routes }`, LOAD's
 * `{ scenario, thresholds }` or PERFORMANCE's `{ path, iterations, budgets }`.
 * So the overlap is structurally near-zero for a CORRECT spec, a model given
 * the revise prompt cannot fix it (the schema forbids prose), and the verdict
 * is REFUSE on every attempt forever.
 *
 * Wiring it anyway would therefore mean: a key-less deployment — the mode this
 * product currently ships in — generates nothing at all instead of six
 * scaffolded types carrying TODO flags, and a keyed one refuses every VISUAL,
 * ACCESSIBILITY, LOAD and PERFORMANCE test after paying for two strong-tier
 * calls. That is the opposite failure to the one admission exists to prevent,
 * and it is worse, because it refuses work that was right.
 *
 * WHAT WOULD CLOSE IT (both in `admission.ts`, which this change does not own):
 *   1. A spec-aware FIDELITY: trace the plan item against the spec's STRUCTURE
 *      (does a route in the spec match the step's route, does an asserted key
 *      exist for the thing the assertion names) instead of token overlap over
 *      `JSON.stringify(spec)`. Until then FIDELITY should report UNAVAILABLE
 *      for a spec-mode type rather than FAIL — it is the file's own rule 3,
 *      "absence of evidence is not evidence", applied to a measurement the
 *      method cannot make.
 *   2. A way to say "this artefact is UNREVISABLE" (a deterministic scaffold,
 *      or a schema-constrained spec), so the verdict arithmetic treats a hard
 *      fail as a loud flag rather than a refusal — there is no model in the
 *      loop to re-prompt, and the human the scaffold was built for is the only
 *      one who can finish it.
 *
 * NOT flagged on the test row, deliberately, and by this pipeline's own
 * precedent: MUTATION is kept out of `reviewFlags` when it can never run in
 * this configuration, because a flag on every single test is a flag nobody
 * reads. "Admission does not grade specs" is exactly that kind of permanent
 * fact. What a spec-driven test DOES still get is the processor's check that
 * this plan item has no test already, which is the re-approval half of the
 * duplicate defect; the half it misses is a DIFFERENT plan item duplicating an
 * existing spec test.
 */
async function generateSpecDriven(
  llm: LlmService,
  ctx: CallContext,
  args: GenerateTestArgs,
  strategy: SpecDrivenStrategy,
): Promise<GeneratedTest> {
  const { item, flowMap } = args;
  const filePath = specFilePathFor(item.testType, item.title);
  const code = specPointerCode(item.testType);
  // One selection, reused for the prompt and for the flags. Same reason as the
  // code path: two selections could disagree about what the model was shown.
  const context = relevantContext(flowMap, item);

  /**
   * The spec path's gate.
   *
   * `revisable` is the whole reason this is a separate helper. A deterministic
   * scaffold has NO model in the loop — there is nothing a REVISE could ask —
   * so admission collapses a hard failure straight to REFUSE instead of
   * returning a verdict this function could only loop on or silently ignore.
   * A model-written spec is revisable like any generated file: FIDELITY's
   * target mismatch ("this spec is about /dashboard, the plan approved
   * /checkout") is exactly the kind of thing one more call fixes.
   */
  const gate = (producedSpec: unknown, attempt: number, revisable: boolean) =>
    admit({
      code,
      filePath,
      testType: item.testType,
      // The plan item a human APPROVED. FIDELITY compares the spec's TARGET
      // against the routes the plan names and reports the assertions as
      // unmeasurable — a spec's schema has no field English can live in. See
      // `specFidelityGate` in admission.ts.
      item,
      language: args.language ?? null,
      spec: producedSpec,
      attempt,
      revisable,
      existing: args.existing,
      toolchain: args.toolchain,
      /*
       * No `ecosystemId`: a spec file is not written in anybody's dialect.
       * ASSERTIONS reads the spec rather than the pointer comment, and
       * PATH_CONVENTION skips spec-mode types because their path is
       * `specFilePathFor`'s, not an ecosystem's.
       */
    });

  if (!llm.configured) {
    if (strategy.scaffold) {
      const { spec, reviewFlags } = strategy.scaffold({ item, flowMap });
      // `attempts: 0` is the literal truth: no model was called at all.
      /*
       * The scaffold is checked too, and this is not ceremony: a scaffold that
       * declares nothing to assert is a bug in OUR template, and the only way
       * that ever surfaces is a gate refusing it. It is the deployment with no
       * model key — the one this product ships on — so an unchecked scaffold is
       * an unchecked test for most customers.
       */
      const report = await gate(spec, 1, false);
      if (report.verdict === 'REFUSE' || report.verdict === 'REVISE') {
        throw new GenerationRefused({ report, attempts: 0, item, filePath });
      }
      return {
        name: item.title,
        filePath,
        code,
        spec,
        reviewFlags: [...reviewFlags, ...report.reviewFlags, ...contextReviewFlags(context)],
        admission: report,
        attempts: 0,
      };
    }
    // The per-type justification lives on the strategy; the sentence in front
    // of it is THE no-key sentence, unchanged, so the fix reads the same on
    // every surface that reports this.
    throw new LlmError(
      `${NO_KEY_SENTENCE}. A ${item.testType} test cannot be scaffolded without a model because ${strategy.refuseBecause}.`,
      'AUTH',
    );
  }

  const template = NEW_TEST_TEMPLATES[item.testType];

  const prompt = `TEST PLAN ITEM
  title:      ${item.title}
  rationale:  ${item.rationale}
  feature:    ${item.feature}
  priority:   ${item.priority}
  type:       ${item.testType} — ${TEST_TYPE_LABELS[item.testType]}

  steps:
${item.steps.map((s, i) => `    ${i + 1}. ${s}`).join('\n')}

  assertions:
${item.assertions.map((a) => `    - ${a}`).join('\n')}

PAGES AND REAL LOCATORS FROM THE CRAWL
Selectors are written in Playwright's role/label vocabulary because that is how
the crawler records them; where the spec takes CSS selectors, translate to the
most stable equivalent and flag anything you had to infer.
${context.text || '  (no matching states — infer carefully and flag it)'}

BASE URL: ${flowMap.baseUrl} (paths in the spec resolve against it)
${
  args.availableSecretNames?.length
    ? `AVAILABLE SECRETS (reference by name, never by value):
  ${args.availableSecretNames.join(', ')}`
    : ''
}

THE SPEC
${strategy.specNotes}

Its JSON Schema (your "spec" field must satisfy it):
${specSchemaText(strategy.schema)}
${
  template?.spec
    ? `
A MINIMAL VALID EXAMPLE (shape reference only — write the real thing from the plan):
${JSON.stringify(template.spec, null, 2)}`
    : ''
}

Return:
  name         the test's name as a human reads it in the suite
  spec         the complete spec object
  reviewFlags  anything a human should check before trusting this test`;

  const specSchema = z.object({
    name: z.string().min(1).max(160),
    spec: strategy.schema,
    reviewFlags: z.array(z.string()).default([]),
  });

  const ask = (text: string) =>
    llm.structured(ctx, {
      tier: 'strong',
      effort: 'high',
      system: SPEC_SYSTEM,
      prompt: text,
      schema: specSchema,
      schemaName: `${item.testType}TestSpec`,
      maxTokens: 16000,
      cacheSystem: true,
    });

  let attempts = 1;
  let generated = await ask(prompt);
  let report = await gate(generated.spec, attempts, true);

  // ONE re-prompt, same budget and same reasoning as the code path above: the
  // prompt goes in verbatim, with the spec it produced last time, because
  // `llm.structured` is single-shot and carries no history of its own.
  if (report.verdict === 'REVISE' && report.revisePrompt !== null) {
    const rejected = generated;
    attempts = FINAL_ATTEMPT;
    generated = await ask(`${prompt}

THE SPEC YOU PRODUCED LAST TIME, WHICH WAS NOT ACCEPTED

${JSON.stringify(rejected.spec, null, 2)}

${report.revisePrompt}`);
    report = await gate(generated.spec, attempts, true);
  }

  if (report.verdict === 'REFUSE' || report.verdict === 'REVISE') {
    throw new GenerationRefused({ report, attempts, item, filePath });
  }

  return {
    name: generated.name,
    filePath,
    code,
    spec: generated.spec,
    reviewFlags: [...generated.reviewFlags, ...report.reviewFlags, ...contextReviewFlags(context)],
    admission: report,
    attempts,
  };
}
