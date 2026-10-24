/**
 * Child-process environment tests.
 *
 * The claim is narrow and total: no platform secret reaches a process that runs
 * tenant-authored code. The processes in question execute a generated spec, a
 * customer's own CLI, or a `command` an org MEMBER typed into a test spec — so
 * "the tenant can read it" means "any customer can read every customer's keys".
 *
 * The important test here is not any single assertion about VAULT_MASTER_KEY.
 * It is {@link https://localhost | the schema sweep}: it parses the API's own
 * `env.ts` for every variable the platform declares and asserts each one is
 * absent from a child's environment. A future commit that adds a secret to the
 * schema and never thinks about this file is exactly the case that test exists
 * to fail — which is why it reads the schema at run time instead of restating
 * the list here, where it would quietly drift.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { childEnv, isForbiddenChildEnvKey } from './child-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_SCHEMA_PATH = join(here, '../../../apps/api/src/env.ts');

/** Every variable name the platform's env schema declares. */
function declaredPlatformEnvVars(): string[] {
  const source = readFileSync(ENV_SCHEMA_PATH, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s{2,}([A-Z][A-Z0-9_]{2,}):/gm)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

/** The subset of those that are secret rather than merely configuration. */
const SECRET_ENV_VARS = [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'VAULT_MASTER_KEY',
  'ANTHROPIC_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'SMTP_PASSWORD',
] as const;

describe('childEnv', () => {
  it('passes through what a child needs to start', () => {
    const env = childEnv();
    // PATH is the one every platform has and every child needs.
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it('does not copy the parent environment wholesale', () => {
    const sentinel = 'QAAI_TEST_SENTINEL_NOT_ALLOWLISTED';
    process.env[sentinel] = 'leaked';
    try {
      expect(childEnv()).not.toHaveProperty(sentinel);
    } finally {
      delete process.env[sentinel];
    }
  });

  // The regression test for the real defect: the harness used to spread
  // process.env, so this value reached every generated spec.
  it.each(SECRET_ENV_VARS)('never leaks %s to a child', (name) => {
    process.env[name] = `secret-value-for-${name}`;
    try {
      const env = childEnv({ extra: { CI: '1' }, secrets: { APP_PASSWORD: 'tenant-own' } });
      expect(env).not.toHaveProperty(name);
      expect(Object.values(env)).not.toContain(`secret-value-for-${name}`);
    } finally {
      delete process.env[name];
    }
  });

  /**
   * The sweep. Every name the platform's schema declares must be absent, so
   * adding a secret to that schema cannot silently widen what a tenant sees.
   *
   * Configuration that is genuinely not secret is allowed to be absent too —
   * a child has no business reading API_PORT either, and the allowlist is
   * deliberately narrower than "everything that is not a password".
   */
  it('leaks nothing the platform env schema declares', () => {
    const declared = declaredPlatformEnvVars();
    // Guard the guard: if the regex stops matching, this test must fail rather
    // than pass vacuously against an empty list.
    expect(declared.length).toBeGreaterThan(20);
    expect(declared).toContain('VAULT_MASTER_KEY');

    const restore: Array<[string, string | undefined]> = [];
    for (const name of declared) {
      restore.push([name, process.env[name]]);
      process.env[name] = `platform-${name}`;
    }
    try {
      const env = childEnv();
      const leaked = declared.filter((name) => name in env);
      expect(leaked).toEqual([]);
    } finally {
      for (const [name, previous] of restore) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
  });

  it('screens a forbidden key passed through extra', () => {
    const env = childEnv({ extra: { VAULT_MASTER_KEY: 'nope', QAAI_RUN_ID: 'run_1' } });
    expect(env).not.toHaveProperty('VAULT_MASTER_KEY');
    expect(env.QAAI_RUN_ID).toBe('run_1');
  });

  it('passes the tenant their own secrets, which is the point', () => {
    const env = childEnv({ secrets: { APP_PASSWORD: 'hunter2', API_TOKEN: 'tenant-token' } });
    expect(env.APP_PASSWORD).toBe('hunter2');
    expect(env.API_TOKEN).toBe('tenant-token');
  });

  it('lets tenant secrets win over an allowlisted passthrough', () => {
    const env = childEnv({ secrets: { LANG: 'tenant-choice' } });
    expect(env.LANG).toBe('tenant-choice');
  });

  /**
   * The stub passthrough is gated on a test runner being present. If that gate
   * ever stops working it becomes a standing hole in the allowlist that a
   * production deployment could open by setting one variable, so it is worth a
   * test of its own.
   */
  describe('the QAAI_STUB_ test-scaffolding passthrough', () => {
    it('passes stub variables while a test runner is present', () => {
      process.env.QAAI_STUB_MODE = 'ok';
      try {
        expect(childEnv().QAAI_STUB_MODE).toBe('ok');
      } finally {
        delete process.env.QAAI_STUB_MODE;
      }
    });

    it('passes nothing when NODE_ENV is not test', () => {
      const nodeEnv = process.env.NODE_ENV;
      process.env.QAAI_STUB_MODE = 'ok';
      process.env.NODE_ENV = 'production';
      try {
        expect(childEnv()).not.toHaveProperty('QAAI_STUB_MODE');
      } finally {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        delete process.env.QAAI_STUB_MODE;
      }
    });

    it('still refuses a stub-prefixed name that looks like a secret', () => {
      process.env.QAAI_STUB_SECRET = 'nope';
      try {
        expect(childEnv()).not.toHaveProperty('QAAI_STUB_SECRET');
      } finally {
        delete process.env.QAAI_STUB_SECRET;
      }
    });
  });

  it('drops an explicitly undefined extra rather than writing "undefined"', () => {
    const env = childEnv({ extra: { QAAI_STORAGE_STATE: undefined } });
    expect(env).not.toHaveProperty('QAAI_STORAGE_STATE');
  });
});

/**
 * The guard that actually catches a regression.
 *
 * The tests above prove `childEnv` is safe; they say nothing about whether the
 * spawn sites USE it. The original defect was not a bad helper — it was six
 * callers spreading `process.env` directly. So this sweeps the package source
 * and fails on any reintroduction, which is the only check that would have
 * caught the bug in the first place.
 */
describe('no spawn site inherits the parent environment', () => {
  const SRC = join(here, '.');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * The parenthesised form matters: `mobile.ts` and `cli.ts` both wrote
   * `...(process.env as Record<string, string>)`, which a naive grep for
   * `...process.env` misses entirely. That cast is why the original audit
   * undercounted the leak by four sites, so the pattern here tolerates a cast,
   * whitespace and a leading paren.
   */
  it('contains no process.env spread outside child-env.ts', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // child-env.ts names the pattern in its own prose, which is the one
      // legitimate mention in the package.
      if (file.endsWith('child-env.ts')) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/\.\.\.\s*\(?\s*process\.env\b/.test(line)) {
          offenders.push(`${relative(SRC, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('routes every spawn through childEnv', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      if (!/\bspawn\s*\(/.test(source)) continue;
      // A spawn that passes no `env` at all inherits the parent's — which is
      // the same leak by omission, so the absence of `env:` is also a failure
      // unless the file routes through childEnv.
      const usesHelper = source.includes('childEnv(');
      const setsEnv = /\benv\s*:/.test(source);
      if (!usesHelper && setsEnv) offenders.push(`${relative(SRC, file)} sets env without childEnv`);
      if (!usesHelper && !setsEnv) offenders.push(`${relative(SRC, file)} spawns with inherited env`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('isForbiddenChildEnvKey', () => {
  it.each([
    'VAULT_MASTER_KEY',
    'SESSION_SECRET',
    'DATABASE_URL',
    'SMTP_PASSWORD',
    'STRIPE_SECRET_KEY',
    'MY_APP_SECRET_KEY',
    'some_private_key',
    'github_token',
  ])('refuses %s', (key) => {
    expect(isForbiddenChildEnvKey(key)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'CI', 'QAAI_RUN_ID', 'QAAI_BASE_URL', 'TZ', 'LANG'])(
    'allows %s',
    (key) => {
      expect(isForbiddenChildEnvKey(key)).toBe(false);
    },
  );
});
