/**
 * The lint config that `npm run lint` has been promising since the first commit.
 *
 * ESLint 10 has been a devDependency the whole time and there was no config
 * file, so `eslint .` died with "Could not find config file". It is the third
 * advertised-but-missing script in this repo (`npm run dev` pointed at a file
 * that did not exist; `check:enums` pointed at another), which is why this one
 * is written to PASS on the codebase as it stands rather than to describe an
 * ideal it does not meet. A lint script that reports a hundred problems on a
 * clean tree is the same thing as no lint script: nobody runs it, CI cannot
 * gate on it, and the one real bug in there is never seen.
 *
 * ── Who owns what ───────────────────────────────────────────────────────────
 *   prettier owns STYLE.       Quotes, semicolons, width, trailing commas. None
 *                              of it is configured here, so the two can never
 *                              disagree and no `eslint-config-prettier` is
 *                              needed to referee them.
 *   eslint owns CORRECTNESS.   Rules that catch what a reviewer would call a
 *                              bug: an un-awaited promise, an async function
 *                              handed to something that will not await it, a
 *                              binding nobody reads.
 *
 * Type-aware linting is on, because the rule most worth having here —
 * `no-floating-promises` — cannot work without types.
 *
 * ── The ratchet ─────────────────────────────────────────────────────────────
 * Every correctness rule below is an ERROR by default, and the files that
 * violate it TODAY are listed by name in the ratchet block at the bottom, where
 * it drops to a warning. That is deliberate and it is the only arrangement that
 * both passes now and bites later:
 *
 *   - new code cannot introduce the violation, because it errors everywhere
 *     that is not on the list;
 *   - the existing backlog stays visible as warnings rather than being hidden
 *     behind an `off`;
 *   - the list only ever shrinks, and when it empties the entry is deleted.
 *
 * A blanket `'warn'` was the alternative and it is worse: `eslint .` would then
 * exit 0 no matter what anyone wrote, which is how this script rotted the first
 * time. Each entry records what was in it when the ratchet was set, so drift is
 * obvious.
 *
 * ── Written as CommonJS on purpose ──────────────────────────────────────────
 * The root package.json has no `"type": "module"`, so a `.js` file here IS
 * CommonJS by Node's own resolution rules. Writing ESM in it works only because
 * Node detects the syntax and re-parses, printing a MODULE_TYPELESS_PACKAGE_JSON
 * warning on every single lint run. Since package.json is not this file's to
 * edit, matching the format it actually declares is the honest fix.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

/**
 * Everything generated, built, or dropped by a crashed run.
 *
 * `.qaai-runs/` matters more than it looks: the Playwright harness materialises
 * a workspace per run there, and a worker killed mid-run leaves one behind. That
 * directory holds generated specs nobody wrote and no author owns — the exact
 * trap that already had to be closed in vitest.config.ts, arriving here for the
 * same reason.
 */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/out/**',
  '**/coverage/**',
  'apps/api/src/generated/**', // prisma client — regenerated, never hand-edited
  '.qaai-runs/**',
  '.artifacts/**',
  'test-results/**',
  '**/next-env.d.ts', // next writes it, and the file itself says not to edit it
];

/**
 * Globals for the plain-JS files. TypeScript files need none of this:
 * typescript-eslint turns `no-undef` off for them, because the compiler already
 * answers that question and answers it better.
 */
const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  fetch: 'readonly',
};

/**
 * A stand-in for `eslint-plugin-react-hooks`, which is NOT installed.
 *
 * Four files in apps/web carry `// eslint-disable-next-line
 * react-hooks/exhaustive-deps`. ESLint reports a disable directive naming a
 * rule it cannot find as an error — so without this, the web app fails to lint
 * because of comments that are correct and were written for a linter this repo
 * never wired up.
 *
 * The stub declares the rule names and does nothing with them. It is not
 * pretending to check hooks: it is admitting the checker is missing while
 * keeping the annotations that a real one would need. Installing
 * eslint-plugin-react-hooks and deleting this block is a package.json change,
 * which is why it is a note in the handover rather than an edit here.
 */
const noop = { meta: { schema: [] }, create: () => ({}) };
const reactHooksStub = { rules: { 'exhaustive-deps': noop, 'rules-of-hooks': noop } };

module.exports = tseslint.config(
  { ignores: IGNORES },

  // ── Plain JS: this config, the dev launcher, the Electron main process ─────
  // Outside every tsconfig, so no type information is available and these get
  // the syntactic recommended set only.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },

  // ── TypeScript, everywhere ────────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        /*
         * `projectService` rather than an explicit `project: [...]` array: this
         * is a nine-workspace monorepo, and a hand-maintained list of tsconfig
         * paths goes stale the first time somebody adds a package. The service
         * asks TypeScript which project owns each file, exactly as the editor
         * does, so the linter and the editor cannot disagree.
         *
         * `allowDefaultProject` covers the one file that legitimately belongs
         * to no tsconfig — the vitest config at the root. Without it the parser
         * errors on that file instead of linting it.
         */
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      /*
       * The rule this whole file is worth having for.
       *
       * A promise nobody awaits is this codebase's signature failure: the run
       * processor, the queue producers and the tenancy wrapper are all async,
       * and a dropped `await` does not throw — it returns early with the work
       * half done and the caller none the wiser.
       *
       * The tenancy layer makes it worse than usual. Prisma promises are lazy,
       * so an un-awaited query inside `withTenant()` escapes the AsyncLocalStorage
       * scope and runs UNSCOPED — a cross-tenant read produced by a missing
       * keyword. lib/prisma.ts already documents that trap; this rule is what
       * actually watches for it.
       *
       * `void expr` stays the way to say "fire and forget, on purpose", which
       * is what the shard heartbeat and the scheduler arming already do.
       */
      '@typescript-eslint/no-floating-promises': 'error',

      /*
       * An async function passed where a void-returning one is expected: an
       * Express handler, an event listener, a `setInterval` callback. Nothing
       * awaits the result, so a rejection has nowhere to go and surfaces as an
       * unhandled rejection — which, under Node's default policy, takes the
       * whole worker down and every other org's run with it.
       */
      '@typescript-eslint/no-misused-promises': 'error',

      /*
       * `await` on a non-promise. Nearly always a forgotten call, a
       * misremembered signature, or a function that used to be async — and it
       * is invisible at the call site, because awaiting a plain value is legal
       * and does exactly nothing.
       */
      '@typescript-eslint/await-thenable': 'error',

      /*
       * Unused bindings: a renamed argument, an import left behind by a
       * refactor, a destructured field nobody reads. The underscore prefix is
       * the escape hatch for the deliberate cases — notably the unused `_next`
       * on an Express error handler, which must keep four parameters to be
       * recognised as one.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      /*
       * `throw new Error(...)` inside a `catch` that drops the original. The
       * rethrown message is usually better for the reader, but losing `cause`
       * loses the stack that says which of four callees actually failed — and
       * these are exactly the errors that end up in a run's errorMessage and
       * get read by someone who was not there.
       */
      'preserve-caught-error': 'error',

      /*
       * `any` is a hole in the type system, and the type system is the only
       * thing checking these ~180 files. A warning rather than an error: the
       * remaining uses sit at genuine boundaries — Prisma's `Json` columns, the
       * tenancy extension's argument rewriting — where the alternative cast is
       * no safer, and failing the build over them gets the script disabled
       * instead of the `any` removed.
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      /*
       * Real, and a repo-wide codemod rather than a bug hunt: 47 sites, almost
       * all of them `as unknown as object` written to satisfy an older Prisma
       * `Json` signature that has since been widened, plus `!` assertions made
       * redundant by `noUncheckedIndexedAccess`. Left as a warning because
       * removing an assertion can shift inference, and doing that to 47 sites
       * blind — across files owned by other people — is how a "cleanup" breaks
       * a build. Not ratcheted by filename: a 30-entry list is a list nobody
       * maintains.
       */
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      /*
       * Genuinely interesting, and a warning only because there are 20 of them.
       * Most are `${req.query.x ?? ''}` — and Express really does hand you an
       * object or an array there, because `?state[a]=b` and `?state=1&state=2`
       * are both legal query strings. The value that reaches the template is
       * then `[object Object]`. Nothing observed depends on it today, but the
       * ones in apps/api/src/routes/agent.ts (the OAuth `state`) and
       * apps/worker/src/processors/notify.ts (a run id put into a link) are
       * worth a look; see the handover notes.
       */
      '@typescript-eslint/no-base-to-string': 'warn',

      // A `let` that is never reassigned. Tidy-up, not a bug — four sites.
      'prefer-const': 'warn',

      /*
       * ── Off, each for a stated reason ──────────────────────────────────
       */

      /*
       * Fires on `let x = <default>; try { x = compute(); } catch { return; }`
       * — seven sites, all that exact shape. The initialiser is provably dead
       * because every catch path exits, but writing it is what makes the
       * declaration readable and what keeps the type narrow. Rewriting correct
       * defensive code to satisfy a new-in-ESLint-10 rule is churn.
       */
      'no-useless-assignment': 'off',

      /*
       * The unsafe-* family fires on every value crossing a boundary the type
       * system cannot see: `req.body`, Prisma `Json` columns, `JSON.parse`.
       * This codebase hands those to zod immediately — which is the actual fix
       * — but the rules cannot see the validation, so they would report
       * hundreds of sites where the handling is already correct.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Fires on `${err}` and `${count}` in log lines. The coercion is meant.
      '@typescript-eslint/restrict-template-expressions': 'off',

      /*
       * An `async` function with no `await` is how an interface is satisfied —
       * half the runner plugins have a synchronous `validate()` sitting beside
       * an asynchronous `execute()`. Being async is part of the contract.
       */
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',

      // Style, which prettier owns.
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },

  // ── apps/web: React 19 on Next 16, running in a browser ───────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooksStub },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: {
      /*
       * Off here alone. With the stub above, every `react-hooks/exhaustive-deps`
       * disable comment is a directive for a rule that reports nothing — so
       * ESLint would call each one unused and ask for its removal, which is the
       * opposite of the right advice. The day the real plugin is installed,
       * delete this and the stub together.
       */
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',

      /*
       * `onClick={handleAsyncThing}` is idiomatic React, and the default rule
       * flags it. Narrowing to exclude JSX attributes keeps the part that
       * catches real bugs — an async callback handed to something that will
       * call its return value, such as `useEffect(async () => …)`, where React
       * then tries to invoke a Promise as a cleanup function.
       */
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  // ── Tests ─────────────────────────────────────────────────────────────────
  /*
   * A test's job is to be readable and to fail loudly. `no-explicit-any` in a
   * fixture builder buys nothing, and a deliberately impossible value is very
   * often the entire point of the case.
   */
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /*
   * ── THE RATCHET ────────────────────────────────────────────────────────────
   *
   * The pre-existing backlog, by rule and by file, as of the commit that added
   * this config. Everything below is a WARNING here and an ERROR everywhere
   * else, so the list can only shrink: fix a file, take it off the list; when
   * the list is empty, delete the entry.
   *
   * Do not add to these lists to make a build green. That is what the rules are
   * for.
   */

  {
    // 2 sites. lib/events.ts is `subscriber.subscribe()`, whose errors are
    // handled by the callback it also takes — cosmetic. middleware/auth.ts is
    // NOT cosmetic; see the handover notes.
    files: ['apps/api/src/lib/events.ts', 'apps/api/src/middleware/auth.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'warn' },
  },
  {
    // 13 sites: async callbacks handed to Express's `listen`, to BullMQ's
    // worker registration, to `http.createServer`, and to a few React event
    // paths that the attributes exemption above does not cover.
    files: [
      'apps/api/src/index.ts',
      'apps/web/app/import/page.tsx',
      'apps/web/app/onboarding/page.tsx',
      'apps/web/app/settings/billing/page.tsx',
      'apps/web/components/AgentPanel.tsx',
      'apps/web/components/RecordButton.tsx',
      'apps/worker/src/index.ts',
      'packages/runner/src/record.ts',
      'packages/runner/src/plugins/protocol.test.ts',
    ],
    rules: { '@typescript-eslint/no-misused-promises': 'warn' },
  },
  {
    // 3 sites, all `await emit(...)` where `emit` returns void. Harmless as
    // written, and a signal that the emit contract changed under the caller.
    files: ['apps/worker/src/processors/copilot.ts'],
    rules: { '@typescript-eslint/await-thenable': 'warn' },
  },
  {
    // 4 dead bindings: an unused `createHash` import, an unused re-import of
    // `registerStripeWebhook` (the real registration lives in routes/webhooks.ts,
    // so this one is dead code and not a missing webhook), an unused
    // `PLAN_LIMITS`, and an unused `Card`.
    files: [
      'apps/api/prisma/seed.ts',
      'apps/api/src/index.ts',
      'apps/api/src/routes/projects.ts',
      'apps/web/app/settings/billing/page.tsx',
    ],
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },
  {
    // 1 site: a rethrow in the protocol plugin that drops the original error.
    files: ['packages/runner/src/plugins/protocol.ts'],
    rules: { 'preserve-caught-error': 'warn' },
  },
);
