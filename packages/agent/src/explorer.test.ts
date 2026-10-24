/**
 * The Explorer's role binding — the one producer a database constraint cannot
 * protect.
 *
 * `PlanItem.authProfileId` is a loose column with no foreign key (see the
 * PlanItem model in schema.prisma). Everywhere else in this change an invalid
 * profile id is refused by Postgres or by the API's project join, but here the
 * value arrives from a language model, is written straight into that column,
 * and travels to the Generator unchecked. A plausible-looking invented id would
 * then produce a test bound to a profile that does not exist — and depending on
 * the runner, that is either a hard failure a long way from its cause or a test
 * that quietly runs anonymously and passes. The second one is the exact defect
 * the whole `authProfileId` change exists to remove, re-entering through the
 * one door no constraint watches.
 *
 * So two things are asserted: the model is TOLD which profiles exist (it cannot
 * name a role it was never shown — the prompt used to say "always null"), and
 * every id it hands back is checked against that list before it leaves this
 * function, with the discard explained in `skipped` rather than dropped in
 * silence.
 *
 * No key and no network: `llm.structured` is stubbed, because what is under test
 * is what we send and what we do with the reply, not the reply itself.
 */

import { describe, expect, it } from 'vitest';
import type { FlowMap, TestPlan } from '@qaai/shared';
import { proposePlan } from './explorer.js';
import type { AuthProfileChoice } from './coverage.js';
import type { CallContext, LlmService } from './llm.js';

const ADMIN: AuthProfileChoice = { id: 'prof_admin', name: 'Admin', kind: 'FORM_LOGIN' };
const SHOPPER: AuthProfileChoice = { id: 'prof_shopper', name: 'Shopper', kind: 'FORM_LOGIN' };

const CTX: CallContext = { orgId: 'org_1', projectId: 'proj_1', agent: 'EXPLORER' };

function flowMap(): FlowMap {
  return {
    projectId: 'proj_1',
    environmentId: 'env_1',
    version: 3,
    baseUrl: 'https://shop.test',
    exploredAt: '2026-07-01T00:00:00.000Z',
    truncatedReason: null,
    nodes: [
      {
        id: 'n-home',
        route: '/',
        url: 'https://shop.test/',
        title: 'Home',
        stateKey: 'default',
        requiresRoles: [],
        behindAuth: false,
        forms: [],
        affordances: [],
        screenshotKey: null,
        a11yViolationCount: 0,
      },
      {
        id: 'n-admin',
        route: '/admin/users',
        url: 'https://shop.test/admin/users',
        title: 'Manage users',
        stateKey: 'default',
        // The application's own word on who may see this. Leaving it out of the
        // prompt was half of why the Explorer had nothing to go on.
        requiresRoles: ['admin', 'owner'],
        behindAuth: true,
        forms: [],
        affordances: [],
        screenshotKey: null,
        a11yViolationCount: 0,
      },
    ],
    edges: [],
    journeys: [],
    features: [{ name: 'Admin', nodeIds: ['n-admin'] }],
  };
}

interface Reply {
  authProfileId: string | null;
  title?: string;
}

/** Captures the prompt, and answers with a one-item plan of our choosing. */
function stubLlm(replies: Reply[]): { llm: LlmService; prompts: string[] } {
  const prompts: string[] = [];
  const llm = {
    structured: async (_ctx: unknown, call: { prompt: string }) => {
      prompts.push(call.prompt);
      const plan: TestPlan = {
        flowMapVersion: 0,
        summary: 'a plan',
        skipped: [{ what: 'Payments', why: 'no test card' }],
        items: replies.map((reply, index) => ({
          id: `item-${index}`,
          title: reply.title ?? `item ${index}`,
          rationale: 'because',
          feature: 'Admin',
          priority: 'IMPORTANT' as const,
          testType: 'E2E' as const,
          steps: ['do a thing'],
          assertions: ['something is true'],
          journeyId: null,
          authProfileId: reply.authProfileId,
        })),
      };
      return plan;
    },
  } as unknown as LlmService;
  return { llm, prompts };
}

describe('the Explorer is shown the roles it may name', () => {
  it('lists every configured profile by id and name', async () => {
    const { llm, prompts } = stubLlm([{ authProfileId: null }]);
    await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN, SHOPPER] });

    const prompt = prompts[0]!;
    expect(prompt).toContain('AUTH PROFILES');
    expect(prompt).toContain('prof_admin — "Admin"');
    expect(prompt).toContain('prof_shopper — "Shopper"');
  });

  it('shows the roles the application says a state requires', async () => {
    const { llm, prompts } = stubLlm([{ authProfileId: null }]);
    await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });
    expect(prompts[0]!).toContain('(BEHIND AUTH) (REQUIRES ROLES: admin, owner)');
  });

  it('says plainly when there is nothing to name, instead of staying quiet', async () => {
    // The old prompt said "authProfileId always null" with no explanation, which
    // is why every item the Explorer ever produced was unbound.
    const { llm, prompts } = stubLlm([{ authProfileId: null }]);
    await proposePlan(llm, CTX, flowMap(), {});
    expect(prompts[0]!).toContain('(none configured on this environment');
    expect(prompts[0]!).not.toContain('always null (auth profiles are wired up separately)');
  });

  it('never puts a credential in the prompt', async () => {
    const { llm, prompts } = stubLlm([{ authProfileId: null }]);
    await proposePlan(llm, CTX, flowMap(), {
      authProfiles: [{ id: 'prof_admin', name: 'Admin', kind: 'FORM_LOGIN' }],
    });
    // Choosing a role does not require knowing a password, and a prompt is the
    // last place to put one. `AuthProfileChoice` carries no secret-bearing
    // field at all, which is the structural half of this guarantee.
    expect(prompts[0]!).not.toMatch(/password|secret|token/i);
  });
});

describe('an invented profile id never reaches the database', () => {
  it('keeps an id that exists', async () => {
    const { llm } = stubLlm([{ authProfileId: 'prof_admin' }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });
    expect(plan.items[0]!.authProfileId).toBe('prof_admin');
  });

  it('nulls one that does not, and says so in skipped', async () => {
    const { llm } = stubLlm([{ authProfileId: 'prof_admin_2', title: 'Reach the admin page' }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });

    expect(plan.items[0]!.authProfileId).toBeNull();
    const why = plan.skipped.map((s) => `${s.what} ${s.why}`).join(' ');
    expect(why).toContain('prof_admin_2');
    expect(why).toMatch(/do not exist on this environment/i);
    expect(why).toMatch(/Reach the admin page/);
    // The item itself survives — only its binding was discarded. A plan that
    // lost whole items to a bad id would read as the Explorer's judgement.
    expect(plan.items).toHaveLength(1);
  });

  it('keeps the Explorer’s own skipped list rather than replacing it', async () => {
    const { llm } = stubLlm([{ authProfileId: 'nope' }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });
    expect(plan.skipped.map((s) => s.what)).toContain('Payments');
  });

  it('discards every id when no profile was offered at all', async () => {
    const { llm } = stubLlm([{ authProfileId: 'prof_admin' }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), {});
    expect(plan.items[0]!.authProfileId).toBeNull();
    expect(plan.skipped.map((s) => s.what).join(' ')).toMatch(/Auth profile bindings/);
  });

  it('adds nothing to skipped when every id checks out', async () => {
    const { llm } = stubLlm([{ authProfileId: 'prof_admin' }, { authProfileId: null }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.what).toBe('Payments');
  });

  it('still pins the plan to the crawl it was proposed from', async () => {
    const { llm } = stubLlm([{ authProfileId: 'prof_admin' }]);
    const { plan } = await proposePlan(llm, CTX, flowMap(), { authProfiles: [ADMIN] });
    // The model answers `flowMapVersion: 0`; the crawl is authoritative.
    expect(plan.flowMapVersion).toBe(3);
  });
});
