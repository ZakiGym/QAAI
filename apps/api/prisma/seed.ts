/**
 * Seeds a working demo: one org, one owner, one project pointed at the bundled
 * demo store, and a starter suite covering four of the five implemented runner
 * plugins.
 *
 * The seeded tests are hand-written in the same shape the Generator emits —
 * standard `@playwright/test`, `test.step()` per action, assertions that check
 * meaning. That is deliberate: it makes the runner, the gates, and the cockpit
 * verifiable end-to-end without an ANTHROPIC_API_KEY, and it documents the
 * output contract the Generator is held to.
 */

import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const params = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const derived = await scrypt(password, salt, 64, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const DEMO_URL = process.env.DEMO_PUBLIC_URL ?? 'http://localhost:5050';
const OWNER_EMAIL = 'owner@qaai.local';
const OWNER_PASSWORD = 'qaai-demo-password-1';

/**
 * The test that finds the planted bug.
 *
 * It never hard-codes a total. It reads the subtotal, shipping, and tax the
 * page itself renders and asserts the grand total is their sum — so it is
 * correct for any cart, and it fails only when the arithmetic is genuinely
 * wrong. A presence check or a screenshot diff would pass on the buggy page.
 */
const CHECKOUT_TOTAL_SPEC = `import { test, expect } from '@playwright/test';

function parseMoney(text: string | null): number {
  if (!text) throw new Error('Expected a money value, found nothing');
  return Math.round(Number.parseFloat(text.replace(/[^0-9.-]/g, '')) * 100);
}

test('Order total equals subtotal plus shipping and tax', async ({ page }) => {
  await test.step('Open the products page', async () => {
    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  });

  await test.step('Add the Brew Scale to the cart', async () => {
    await page.getByRole('button', { name: 'Add Brew Scale to cart' }).click();
  });

  await test.step('Add the Single Origin coffee to the cart', async () => {
    await page.goto('/products');
    await page.getByRole('button', { name: 'Add Single Origin — Yirgacheffe to cart' }).click();
  });

  await test.step('The order total is the sum of its parts', async () => {
    await page.goto('/cart');

    const subtotal = parseMoney(await page.getByTestId('subtotal').textContent());
    const shipping = parseMoney(await page.getByTestId('shipping').textContent());
    const tax = parseMoney(await page.getByTestId('tax').textContent());
    const total = parseMoney(await page.getByTestId('order-total').textContent());

    expect(total).toBe(subtotal + shipping + tax);
  });
});
`;

const SMOKE_SPEC = `import { test, expect } from '@playwright/test';

test('The storefront is up and listing products', async ({ page }) => {
  await test.step('Open the home page', async () => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Ground Coffee Co.' })).toBeVisible();
  });

  await test.step('Products are listed with prices', async () => {
    await page.goto('/products');
    const addButtons = page.getByRole('button', { name: /Add .* to cart/ });
    expect(await addButtons.count()).toBeGreaterThan(0);
  });
});
`;

/**
 * A cart-arithmetic test that passes. Two green tests next to one red one is
 * what makes the failing verdict legible in the cockpit — a suite where
 * everything is red teaches nobody anything.
 */
const SINGLE_ITEM_SPEC = `import { test, expect } from '@playwright/test';

function parseMoney(text: string | null): number {
  if (!text) throw new Error('Expected a money value, found nothing');
  return Math.round(Number.parseFloat(text.replace(/[^0-9.-]/g, '')) * 100);
}

test('A single-line cart totals correctly', async ({ page }) => {
  await test.step('Add one Gooseneck Kettle', async () => {
    await page.goto('/products');
    await page.getByRole('button', { name: 'Add Gooseneck Kettle to cart' }).click();
  });

  await test.step('Free shipping has not been applied below the threshold', async () => {
    await page.goto('/cart');
    expect(parseMoney(await page.getByTestId('shipping').textContent())).toBeGreaterThan(0);
  });

  await test.step('The order total is the sum of its parts', async () => {
    const subtotal = parseMoney(await page.getByTestId('subtotal').textContent());
    const shipping = parseMoney(await page.getByTestId('shipping').textContent());
    const tax = parseMoney(await page.getByTestId('tax').textContent());
    const total = parseMoney(await page.getByTestId('order-total').textContent());

    expect(total).toBe(subtotal + shipping + tax);
  });
});
`;

async function main(): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  if (existing) {
    console.log('Seed data already present — nothing to do.');
    console.log(`  Sign in as ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
    return;
  }

  const org = await prisma.organization.create({
    data: { name: 'QAAI Demo', slug: 'qaai-demo', plan: 'TEAM' },
  });

  const user = await prisma.user.create({
    data: {
      email: OWNER_EMAIL,
      name: 'Demo Owner',
      passwordHash: await hashPassword(OWNER_PASSWORD),
      emailVerified: new Date(),
      memberships: { create: { orgId: org.id, role: 'OWNER' } },
    },
  });

  const project = await prisma.project.create({
    data: {
      orgId: org.id,
      name: 'Ground Coffee Co.',
      slug: 'ground-coffee',
      primaryLanguage: 'TYPESCRIPT',
      primaryFramework: 'PLAYWRIGHT',
      gateRules: [
        { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
        { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' },
      ],
    },
  });

  const environment = await prisma.environment.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      name: 'local',
      kind: 'LOCAL',
      baseUrl: DEMO_URL,
    },
  });

  const suite = await prisma.suite.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      name: 'Starter',
      description: 'Seeded coverage of checkout, availability, accessibility, and security',
    },
  });

  const common = { orgId: org.id, projectId: project.id, suiteId: suite.id };

  await prisma.test.createMany({
    data: [
      {
        ...common,
        name: 'Order total equals subtotal plus shipping and tax',
        type: 'E2E',
        feature: 'Checkout',
        priority: 'CRITICAL_PATH',
        code: CHECKOUT_TOTAL_SPEC,
        filePath: 'checkout/order-total.spec.ts',
        tags: ['smoke', 'checkout'],
        timeoutMs: 60_000,
      },
      {
        ...common,
        name: 'A single-line cart totals correctly',
        type: 'E2E',
        feature: 'Cart',
        priority: 'IMPORTANT',
        code: SINGLE_ITEM_SPEC,
        filePath: 'cart/single-line-total.spec.ts',
        tags: ['cart'],
        timeoutMs: 60_000,
      },
      {
        ...common,
        name: 'The storefront is up and listing products',
        type: 'SMOKE',
        feature: 'Storefront',
        priority: 'CRITICAL_PATH',
        code: SMOKE_SPEC,
        filePath: 'storefront/up.spec.ts',
        tags: ['smoke'],
        timeoutMs: 30_000,
      },
      {
        ...common,
        name: 'Health endpoint reports the store is up',
        type: 'API',
        feature: 'Storefront',
        priority: 'IMPORTANT',
        code: '// API tests are driven by `spec`, not source code.',
        filePath: 'api/health.api.json',
        spec: {
          variables: {},
          steps: [
            {
              name: 'Health check responds quickly and reports ok',
              method: 'GET',
              path: '/__health',
              headers: {},
              assertions: { status: 200, maxLatencyMs: 1000, bodyMatches: { ok: true } },
              extract: {},
            },
          ],
        },
        timeoutMs: 15_000,
      },
      {
        ...common,
        name: 'Storefront pages meet WCAG 2.1 AA',
        type: 'ACCESSIBILITY',
        feature: 'Storefront',
        priority: 'NICE_TO_HAVE',
        code: '// Accessibility tests are driven by `spec`, not source code.',
        filePath: 'a11y/storefront.a11y.json',
        spec: { routes: ['/', '/products', '/cart'] },
        timeoutMs: 60_000,
      },
      {
        ...common,
        name: 'Security smoke: auth walls, object ids, headers',
        type: 'SECURITY_SMOKE',
        feature: 'Storefront',
        priority: 'IMPORTANT',
        code: '// Security smoke tests are driven by `spec`, not source code.',
        filePath: 'security/storefront.security.json',
        spec: {
          authRequiredPaths: ['/admin', '/account'],
          idorProbes: [
            {
              template: '/orders/{id}',
              ids: ['ORD-1001', 'ORD-1002'],
              mustNotContain: '@',
            },
          ],
          headerPaths: ['/', '/products'],
        },
        timeoutMs: 30_000,
      },
    ],
  });

  await prisma.featureFlag.createMany({
    data: [
      { key: 'visual-regression', description: 'Baseline capture and diff UI', enabled: false },
      { key: 'load-testing', description: 'k6 script generation', enabled: false },
      { key: 'github-app', description: 'PR check runs and inline annotations', enabled: false },
      { key: 'auto-heal-selectors', description: 'Auto-apply selector-only heals', enabled: false },
    ],
    skipDuplicates: true,
  });

  const testCount = await prisma.test.count({ where: { projectId: project.id } });

  console.log(`
Seeded.

  Organization  ${org.name} (${org.plan})
  Sign in       ${OWNER_EMAIL} / ${OWNER_PASSWORD}
  Project       ${project.name}
  Environment   ${environment.name} -> ${environment.baseUrl}
  Tests         ${testCount} across ${new Set(['E2E', 'SMOKE', 'API', 'ACCESSIBILITY', 'SECURITY_SMOKE']).size} types

Start the demo store, then trigger a run. With DEMO_PLANTED_BUG=true the
checkout test should fail on the arithmetic — that is the bug it exists to find.
`);

  void user;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
