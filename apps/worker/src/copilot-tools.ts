/**
 * The copilot's tools (§3.5).
 *
 * These live in the worker rather than in `packages/agent` because they touch
 * the database and the run queue — the agent package stays free of
 * infrastructure so it can be reasoned about (and eventually tested) on its own.
 *
 * Design rules that apply to every tool here:
 *
 *  - **Read tools return summaries, not dumps.** A tool that returns every
 *    column of every row burns the context window on ids nobody reads. Each one
 *    returns the fields a QA engineer would actually look at.
 *  - **No tool mutates a test.** `propose_test` records a proposal for a human
 *    to accept. The copilot cannot write to the suite, by construction.
 *  - **Descriptions say *when* to call.** Recent models are conservative about
 *    reaching for tools; a description that only states what a tool does gets
 *    called less than one that states the trigger condition.
 */

import { z } from 'zod';
import { defineTool } from '@qaai/agent';
import type { AgentTool } from '@qaai/agent';
import { FIXTURE_PREFIX } from '@qaai/shared';
import type { FlowMap } from '@qaai/shared';
// One toll for every path that creates a Run: the plan gate and the usage
// counter. It lives in the API workspace and takes its Prisma client as an
// argument so this file can call the same implementation POST /runs does.
import { startRun } from '../../api/src/lib/start-run.js';
import { logger, prisma } from './context.js';
import { enqueueRun } from './queues.js';

export interface ToolContext {
  orgId: string;
  projectId: string;
  conversationId: string;
  /** Set once the assistant message row exists, so proposals can attach to it. */
  messageId: string | null;
}

/** How long `run_tests` will wait before handing back a still-running verdict. */
const RUN_WAIT_MS = 180_000;

export function buildCopilotTools(ctx: ToolContext): AgentTool[] {
  const listTests = defineTool({
    name: 'list_tests',
    description:
      'List the tests in this project with their type, feature, priority, flake rate and last result. ' +
      'Call this first whenever the question involves what is or is not covered, or before proposing a new test — ' +
      'so you do not duplicate one that already exists.',
    input: z.object({
      feature: z.string().nullish().describe('Filter to one feature group'),
      failingOnly: z
        .boolean()
        .default(false)
        .describe('Only tests whose most recent result failed'),
    }),
    async execute({ feature, failingOnly }) {
      const tests = await prisma.test.findMany({
        where: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          disabledAt: null,
          // Fixtures are test data; listing them as tests would mislead the agent.
          filePath: { not: { startsWith: FIXTURE_PREFIX } },
          ...(feature ? { feature } : {}),
        },
        orderBy: [{ feature: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          type: true,
          feature: true,
          priority: true,
          filePath: true,
          quarantined: true,
          flakeRate: true,
          lastRunAt: true,
          results: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, createdAt: true },
          },
        },
      });

      const mapped = tests.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        feature: t.feature,
        priority: t.priority,
        filePath: t.filePath,
        quarantined: t.quarantined,
        flakeRatePercent: Math.round(t.flakeRate),
        lastStatus: t.results[0]?.status ?? 'never run',
      }));

      return failingOnly
        ? mapped.filter((t) => t.lastStatus === 'FAILED' || t.lastStatus === 'TIMED_OUT')
        : mapped;
    },
  });

  const readTest = defineTool({
    name: 'read_test',
    description:
      'Read one test in full: its source code (or its JSON spec for API, accessibility and security tests) ' +
      'plus its recent pass/fail history. Call this before proposing an edit — never rewrite a file you have not read.',
    input: z.object({ testId: z.string().describe('Test id from list_tests') }),
    async execute({ testId }) {
      const test = await prisma.test.findFirst({
        where: { id: testId, orgId: ctx.orgId, projectId: ctx.projectId },
        select: {
          id: true,
          name: true,
          type: true,
          feature: true,
          priority: true,
          filePath: true,
          code: true,
          spec: true,
          tags: true,
          quarantined: true,
          flakeRate: true,
          reviewFlags: true,
          results: {
            orderBy: { createdAt: 'desc' },
            take: 8,
            select: { status: true, durationMs: true, errorMessage: true, createdAt: true },
          },
        },
      });
      if (!test) return { error: `No test with id ${testId} in this project` };
      return test;
    },
  });

  const getRunResults = defineTool({
    name: 'get_run_results',
    description:
      'Get the results of a run: per-test status, the step timeline, the failing step with its expected/actual ' +
      'values, findings, and the triage verdict. Call this whenever asked why something failed, or after run_tests. ' +
      'Omit runId for the most recent run.',
    input: z.object({
      runId: z.string().nullish().describe('Defaults to the latest run for this project'),
    }),
    async execute({ runId }) {
      const run = runId
        ? await prisma.run.findFirst({ where: { id: runId, orgId: ctx.orgId } })
        : await prisma.run.findFirst({
            where: { orgId: ctx.orgId, projectId: ctx.projectId },
            orderBy: { queuedAt: 'desc' },
          });
      if (!run) return { error: 'No runs found for this project' };

      const results = await prisma.testResult.findMany({
        where: { runId: run.id },
        select: {
          status: true,
          durationMs: true,
          errorMessage: true,
          retriedAndPassed: true,
          test: { select: { id: true, name: true, type: true, filePath: true } },
          steps: {
            orderBy: { index: 'asc' },
            select: {
              index: true,
              title: true,
              status: true,
              durationMs: true,
              errorMessage: true,
              expected: true,
              actual: true,
              selector: true,
            },
          },
          findings: {
            select: { severity: true, kind: true, code: true, message: true, location: true },
          },
          verdict: { select: { verdict: true, confidence: true, explanation: true } },
        },
      });

      return {
        runId: run.id,
        status: run.status,
        counts: {
          total: run.totalCount,
          passed: run.passedCount,
          failed: run.failedCount,
          flaky: run.flakyCount,
          skipped: run.skippedCount,
        },
        gateResult: run.gateResult,
        results,
      };
    },
  });

  const runTests = defineTool({
    name: 'run_tests',
    description:
      'Execute tests against the app and wait for the result. Pass testIds to run specific tests, or omit to run ' +
      'everything. Call this after a proposal is applied, or when asked to verify something actually works — ' +
      'do not claim a test passes without running it.',
    input: z.object({
      testIds: z.array(z.string()).nullish().describe('Omit to run the whole suite'),
    }),
    async execute({ testIds }) {
      const environment = await prisma.environment.findFirst({
        where: { orgId: ctx.orgId, projectId: ctx.projectId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, baseUrl: true },
      });
      if (!environment) return { error: 'This project has no environment configured' };

      // Resolved through the DB even when ids are supplied, so rows under
      // `fixtures/` (test data, with no runnable code) can never be queued and
      // then reported as failures. Mirrors the guard in POST /runs — the copilot
      // creates the Run directly and would otherwise bypass it.
      const runnable = await prisma.test.findMany({
        where: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          disabledAt: null,
          filePath: { not: { startsWith: FIXTURE_PREFIX } },
          ...(testIds && testIds.length > 0 ? { id: { in: testIds } } : {}),
        },
        select: { id: true },
      });
      const ids = runnable.map((t) => t.id);

      if (ids.length === 0) return { error: 'There are no tests to run' };

      /*
       * Gate, create, count. Mirrors the guard in POST /runs for the same
       * reason the fixture filter above does: the copilot creates the Run
       * directly and would otherwise bypass it — "ask the assistant to run the
       * suite" was an unmetered way around the free tier's only real ceiling.
       *
       * `advisory`, not `enforce`: this executes inside a tool call, and a
       * thrown ApiError would reach the model as a tool failure it would very
       * likely retry. A refusal returned as `error` is what every other tool
       * here does with a condition the user has to resolve, and the model
       * relays it as a sentence the person can act on.
       */
      const started = await startRun({
        db: prisma,
        orgId: ctx.orgId,
        mode: 'advisory',
        data: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          environmentId: environment.id,
          trigger: 'MANUAL',
          totalCount: ids.length,
          results: {
            create: ids.map((testId) => ({ orgId: ctx.orgId, testId, status: 'SKIPPED' as const })),
          },
        },
      });

      if (!started.created) {
        logger.warn(
          { orgId: ctx.orgId, projectId: ctx.projectId },
          'copilot run_tests refused: the org is at its monthly run limit',
        );
        return { error: started.quota.reason ?? 'This org is at its monthly run limit.' };
      }
      const run = started.run;

      await enqueueRun({ orgId: ctx.orgId, runId: run.id });

      // The copilot is expected to report an outcome, so it waits here rather
      // than returning "queued" and leaving the user to ask again.
      const deadline = Date.now() + RUN_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        const latest = await prisma.run.findUnique({
          where: { id: run.id },
          select: { status: true, passedCount: true, failedCount: true, flakyCount: true },
        });
        if (latest && ['PASSED', 'FAILED', 'ERRORED', 'CANCELLED'].includes(latest.status)) {
          return {
            runId: run.id,
            status: latest.status,
            passed: latest.passedCount,
            failed: latest.failedCount,
            flaky: latest.flakyCount,
            note: 'Call get_run_results with this runId for the step-level detail.',
          };
        }
      }

      return {
        runId: run.id,
        status: 'still running',
        note: `Did not finish within ${RUN_WAIT_MS / 1000}s. Call get_run_results later.`,
      };
    },
  });

  const getFlowMap = defineTool({
    name: 'get_flow_map',
    description:
      'Get the map of the application the crawler discovered: pages, states, forms, and the locators available on ' +
      'each. Call this before writing any test code so you use locators that actually exist rather than guessing.',
    input: z.object({
      route: z.string().nullish().describe('Filter to states whose route contains this substring'),
    }),
    async execute({ route }) {
      const row = await prisma.flowMap.findFirst({
        where: { orgId: ctx.orgId, projectId: ctx.projectId },
        orderBy: { version: 'desc' },
      });
      if (!row) {
        return {
          error:
            'No flow map yet — the Explorer has not crawled this app. Tests can still be written from the ' +
            'existing suite as a guide.',
        };
      }

      const map = row.graph as unknown as FlowMap;
      const nodes = route ? map.nodes.filter((n) => n.route.includes(route)) : map.nodes;

      return {
        version: row.version,
        baseUrl: map.baseUrl,
        truncated: map.truncatedReason,
        states: nodes.slice(0, 25).map((n) => ({
          route: n.route,
          title: n.title,
          behindAuth: n.behindAuth,
          buttons: n.affordances.map((a) => a.selector.name ?? a.selector.value).slice(0, 15),
          forms: n.forms.map((f) => ({
            name: f.name,
            fields: f.fields.map((x) => ({
              label: x.label ?? x.name,
              type: x.inputType,
              required: x.required,
            })),
          })),
        })),
      };
    },
  });

  const proposeTest = defineTool({
    name: 'propose_test',
    description:
      'Propose creating or editing a test. This does NOT write anything — it records a diff for the person to ' +
      'accept or reject. Use it for every code change you want to make. Read the existing test first when editing, ' +
      'and pass its testId so the diff is against the real current contents.',
    input: z.object({
      testId: z
        .string()
        .nullish()
        .describe('Omit to create a new test; pass the id to edit an existing one'),
      name: z.string().describe('Test name, as it appears in test(...)'),
      filePath: z.string().describe('Repo-relative path, e.g. checkout/order-total.spec.ts'),
      type: z.enum(['E2E', 'SMOKE', 'API', 'ACCESSIBILITY', 'SECURITY_SMOKE']).default('E2E'),
      code: z.string().describe('The complete new file contents — not a patch'),
      rationale: z.string().describe('One or two sentences on why this change is right'),
    }),
    async execute({ testId, name, filePath, type, code, rationale }) {
      let oldCode = '';
      if (testId) {
        const existing = await prisma.test.findFirst({
          where: { id: testId, orgId: ctx.orgId, projectId: ctx.projectId },
          select: { code: true },
        });
        if (!existing) return { error: `No test with id ${testId} in this project` };
        oldCode = existing.code;

        if (existing.code === code) {
          return { note: 'That is identical to the current file — nothing to propose.' };
        }
      }

      const proposal = await prisma.agentProposal.create({
        data: {
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          testId: testId ?? null,
          filePath,
          oldCode,
          newCode: code,
          rationale,
          testName: name,
          testType: type,
        },
      });

      logger.info({ proposalId: proposal.id, filePath }, 'copilot proposed a change');

      return {
        proposalId: proposal.id,
        state: 'PENDING',
        note:
          'Shown to the user as a diff awaiting approval. Do not call run_tests on it yet — it is not applied. ' +
          'Tell the user what you proposed and why.',
      };
    },
  });

  return [listTests, readTest, getRunResults, runTests, getFlowMap, proposeTest];
}
