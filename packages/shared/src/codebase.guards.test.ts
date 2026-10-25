/**
 * The guard verdict, driven from one application that has all five cases in it.
 *
 * codebase.test.ts drives each guard reader against a fixture built for that
 * reader. This file does the opposite: ONE repository with a Next middleware, an
 * Express chain, a role decorator, a genuinely public page and a guard written
 * through an indirection no static pass can follow — all at once, because the
 * failure these tests exist to catch is a route falling between two readers and
 * landing on the default. The default is UNGUARDED, and UNGUARDED is spent
 * downstream as a POSITIVE claim: it is what makes a plan propose an anonymous
 * scenario, what makes `accessibilityItem` sweep a page signed out, and what
 * makes an admin route appear in a customer's list of uncovered PUBLIC pages.
 *
 * So the assertion that matters most here is the fifth one. A guard this pass
 * cannot resolve must come out UNKNOWN. If it comes out UNGUARDED the product
 * reports an admin route as uncovered-and-public, a generated test gets a
 * redirect to /login, and the redirect is recorded as the page.
 */

import { describe, expect, it } from 'vitest';
import { analyseCodebase, type CodebaseAnalysis } from './codebase';
import type { RepoFile } from './detect';

const f = (path: string, content?: string): RepoFile =>
  content === undefined ? { path } : { path, content };

const guardOf = (a: CodebaseAnalysis, route: string) => {
  const found = a.routes.find((r) => r.route === route);
  if (!found) throw new Error(`no route ${route}; got ${a.routes.map((r) => r.route).join(', ')}`);
  return found.guard;
};
const endpointGuardOf = (a: CodebaseAnalysis, path: string) => {
  const found = a.endpoints.find((e) => e.path === path);
  if (!found) {
    throw new Error(`no endpoint ${path}; got ${a.endpoints.map((e) => e.path).join(', ')}`);
  }
  return found.guard;
};

/**
 * One application, five access situations.
 *
 * Deliberately a POLYGLOT — a Next front end, an Express API and a Spring
 * service in one checkout — because that is the shape of the repositories QAAI
 * is pointed at, and because a reader that is right in isolation can still
 * credit one file's guard to another file's route. Every assertion below names
 * which situation it is about.
 */
const FIVE_SITUATIONS: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0', express: '^4.19.0' } }),
  ),

  // ── 1. Behind Next.js middleware, whose matcher names the path. ──
  f(
    'middleware.ts',
    `import { getToken } from 'next-auth/jwt';
     import { NextResponse } from 'next/server';
     export async function middleware(req) {
       const token = await getToken({ req });
       if (!token) return NextResponse.redirect('/login');
     }
     export const config = { matcher: ['/admin/:path*'] };`,
  ),
  f('app/admin/page.tsx', 'export default function Admin() { return <main/>; }'),
  f('app/admin/users/page.tsx', 'export default function Users() { return <main/>; }'),

  // ── 4. Genuinely public: the matcher does not name it and we read the
  //       matcher, so UNGUARDED is EARNED rather than defaulted. ──
  f('app/pricing/page.tsx', 'export default function Pricing() { return <main/>; }'),

  // ── 2. Behind an Express guard, named between the path and the handler. ──
  //      `/health` in the same file is the control: two arguments, no
  //      middleware, nothing unread.
  f(
    'server/routes.ts',
    `import express from 'express';
     import { requireRole } from './auth';
     const app = express();
     app.get('/reports', requireRole('ADMIN'), (req, res) => res.json({}));
     app.get('/health', (req, res) => res.json({ ok: true }));`,
  ),

  // ── 3. Behind a @Roles('admin') decorator. ──
  f(
    'src/main/java/com/acme/AuditController.java',
    `@RestController
     @RequestMapping("/audit")
     public class AuditController {
       @Roles("admin")
       @GetMapping("/entries")
       public List<Row> entries() { return rows; }
     }`,
  ),

  // ── 5. A guard computed in a way static analysis CANNOT follow. ──
  //      The policy is real, it is in the chain, and its name is produced by a
  //      function whose definition is in another module.
  f(
    'server/exports.ts',
    `import express from 'express';
     import { POLICIES } from './policies';
     const app = express();
     const policyFor = (name) => POLICIES[name];
     app.get('/exports', policyFor('finance'), (req, res) => res.json({}));`,
  ),
];

describe('behindAuth: the five situations, in one application', () => {
  const analysis = analyseCodebase(FIVE_SITUATIONS);

  it('1. a Next middleware matcher makes the routes it covers GUARDED', () => {
    expect(guardOf(analysis, '/admin')?.access).toBe('GUARDED');
    expect(guardOf(analysis, '/admin/users')?.access).toBe('GUARDED');
    expect(guardOf(analysis, '/admin')?.declaredBy.map((d) => d.kind)).toEqual([
      'NEXT_MIDDLEWARE',
    ]);
  });

  it('2. an Express guard in the chain makes the endpoint GUARDED, with its role', () => {
    expect(endpointGuardOf(analysis, '/reports')?.access).toBe('GUARDED');
    // The role is the interesting cell of the route × role matrix. The tail of
    // the registration runs to the end of the line and not to the first `)`,
    // which is what keeps `requireRole('ADMIN')` from being cut to an
    // unbalanced fragment no role pattern can match.
    expect(endpointGuardOf(analysis, '/reports')?.roles).toEqual(['ADMIN']);
  });

  it('3. a @Roles decorator makes the endpoints its file declares GUARDED, with their role', () => {
    expect(endpointGuardOf(analysis, '/audit/entries')?.access).toBe('GUARDED');
    expect(endpointGuardOf(analysis, '/audit/entries')?.roles).toEqual(['admin']);
    // The application's own spelling. `admin` and `Admin` are two roles until
    // the customer says otherwise, and folding them merges two cells.
    expect(endpointGuardOf(analysis, '/audit/entries')?.roles).not.toEqual(['ADMIN']);
  });

  it('4. a genuinely public route is UNGUARDED, and says what was looked at', () => {
    const guard = guardOf(analysis, '/pricing');
    expect(guard?.access).toBe('UNGUARDED');
    expect(guard?.roles).toBeNull();
    expect(guard?.evidence).toContain('no guard was found');
    expect(guard?.evidence).toContain('any middleware matcher covering /pricing');
  });

  it('5. A GUARD THIS PASS CANNOT RESOLVE IS UNKNOWN, NEVER PUBLIC', () => {
    /*
     * THE FINDING THIS FILE EXISTS FOR. `policyFor('finance')` sits between the
     * path and the handler; `GUARD_NAME` does not match it, so no declaration
     * was made, and `resolveGuards` found no declaration and no blind site and
     * answered UNGUARDED — "the guard pass read this route's own declaration
     * sites and found no guard". It read the declaration site and found a
     * middleware it could not read, which is the opposite claim.
     *
     * UNGUARDED here means the plan proposes an anonymous smoke test for a
     * finance export, the test gets a 401 or a redirect, and the redirect is
     * recorded as the page. UNKNOWN costs nothing: the crawl tries the route
     * either way and the matrix records that the source did not tell us.
     */
    const guard = endpointGuardOf(analysis, '/exports');
    expect(guard?.access).toBe('UNKNOWN');
    expect(guard?.access).not.toBe('UNGUARDED');
    // The argument is NAMED, so a human can dismiss a `cors()` in one glance
    // instead of learning to distrust the verdict.
    expect(guard?.evidence).toContain("policyFor('finance')");
    expect(guard?.evidence).toContain('import graph');
  });

  it('does not cloud the two-argument registration beside it', () => {
    // `/health` is declared in a file with no unreadable middleware at all, and
    // UNGUARDED there is earned. UNKNOWN everywhere is not honesty, it is an
    // unusable report.
    expect(endpointGuardOf(analysis, '/health')?.access).toBe('UNGUARDED');
  });

  it('does not let one file’s unreadable chain cloud another file’s route', () => {
    /*
     * `server/exports.ts` registers `/exports`. A blind site scoped by PREFIX
     * alone would match any route whose path is `/exports` in any file — and in
     * the `app.get('/', cors(), home)` case, which is the common one, it would
     * have clouded the Next.js home page declared in app/page.tsx. A
     * registration's scope is its own file.
     */
    const home = analyseCodebase([
      f(
        'package.json',
        JSON.stringify({ name: 'a', dependencies: { next: '^15', express: '^4' } }),
      ),
      f('app/page.tsx', 'export default function H() { return <main/>; }'),
      f(
        'server/api.ts',
        `const app = express();
         app.get('/', cors(), (req, res) => res.json({}));`,
      ),
    ]);
    expect(guardOf(home, '/')?.access).toBe('UNGUARDED');
    expect(endpointGuardOf(home, '/')?.access).toBe('UNKNOWN');
  });

  it('reports the unreadable chain as a shortfall, so the count is on the report', () => {
    const row = (analysis.shortfalls ?? []).find(
      (s) => s.detector === 'route-guards' && s.reason === 'UNRESOLVED_IMPORT',
    );
    expect(row).toBeDefined();
    expect(row?.detail).toContain('/exports');
    expect(row?.detail).toContain('UNKNOWN rather than public');
  });

  it('never answers UNGUARDED for a route it did not fully read', () => {
    /*
     * The invariant over the whole fixture, which is what stops the next reader
     * from being added with a fall-through. Every verdict must exist and must
     * name something; only a GUARDED verdict may carry roles.
     */
    const verdicts = [
      ...analysis.routes.map((r) => r.guard),
      ...analysis.endpoints.map((e) => e.guard),
    ];
    expect(verdicts.every((g) => g !== undefined)).toBe(true);
    for (const guard of verdicts) {
      expect(guard?.evidence.length ?? 0).toBeGreaterThan(0);
      if (guard?.access !== 'GUARDED') expect(guard?.roles).toBeNull();
    }
  });
});

describe('an inline middleware is one we DID read', () => {
  it('leaves a route behind an inline function UNGUARDED when its body has no guard', () => {
    /*
     * The line between "unresolved" and "read". An arrow function's body is
     * right there in the file, `GUARD_NAME` and the session-read pattern have
     * both scanned it, so a route in front of one is a route we are entitled to
     * speak about. Treating it as unresolved would make almost every Express
     * app UNKNOWN end to end, and the customer would learn nothing.
     */
    const a = analyseCodebase([
      f('package.json', JSON.stringify({ name: 'a', dependencies: { express: '^4' } })),
      f(
        'server/api.ts',
        `const app = express();
         app.get('/ping', (req, res, next) => { res.set('x-trace', '1'); next(); }, (req, res) => res.json({}));`,
      ),
    ]);
    expect(endpointGuardOf(a, '/ping')?.access).toBe('UNGUARDED');
  });

  it('still reads a guard named inside an inline middleware', () => {
    const a = analyseCodebase([
      f('package.json', JSON.stringify({ name: 'a', dependencies: { express: '^4' } })),
      f(
        'server/api.ts',
        `const app = express();
         app.get('/vault', (req, res, next) => requireAuth(req, res, next), (req, res) => res.json({}));`,
      ),
    ]);
    expect(endpointGuardOf(a, '/vault')?.access).toBe('GUARDED');
  });
});

describe('a guard declaration that matched no route', () => {
  it('is reported, because an unenumerated route is OUR error and not a public page', () => {
    /*
     * A NestJS controller. `@Roles('admin')` is read — the DECORATOR reader
     * fires on it — but this module has no Nest route detector, so
     * `/audit/entries` is in no inventory and the declaration applies to
     * nothing.
     *
     * That is a REAL and current limitation, and the honest shape of it is what
     * this asserts: the route is ABSENT from the denominator, not present and
     * marked public. Absent raises the coverage percentage and uncovered lowers
     * it, so the declaration surfacing in `analysis.guards` with no route to
     * attach to is the only thing that makes the gap findable at all.
     */
    const a = analyseCodebase([
      f('package.json', JSON.stringify({ name: 'a', dependencies: { '@nestjs/core': '^10' } })),
      f(
        'src/audit.controller.ts',
        `@Controller('audit')
         export class AuditController {
           @Roles('admin')
           @Get('entries')
           entries() { return []; }
         }`,
      ),
    ]);
    expect(a.endpoints).toEqual([]);
    const declarations = a.guards ?? [];
    expect(declarations.map((d) => d.kind)).toEqual(['DECORATOR']);
    expect(declarations[0]?.roles).toEqual(['admin']);
    // And nothing anywhere claims the route is public, because there is no
    // route. The two failures are different and must stay different.
    expect(a.endpoints.some((e) => e.guard?.access === 'UNGUARDED')).toBe(false);
  });
});
