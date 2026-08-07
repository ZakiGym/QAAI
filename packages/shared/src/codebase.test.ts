/**
 * Source-analysis tests, written as applications QAAI will actually be pointed at.
 *
 * The fixtures are synthesized for the same reason detect.test.ts synthesizes
 * its own: the interesting cases are the ones a real checkout will not hand you
 * on demand — a repo uploaded as paths with no bodies, a front end whose
 * `axios.get('/api/orders')` must NOT be read as an endpoint the server offers,
 * a Rails file whose seven-route macro is the only place those routes exist.
 * Each fixture is small but *plausible*: the files a human would find in that
 * project, in the places they live, because every detector here keys on layout
 * or on a line of real syntax.
 *
 * Two things every case asserts beyond the happy path:
 *
 *  1. **The detector report.** An empty `endpoints` array is three different
 *     answers and the whole design of this module is to tell them apart. A test
 *     that only checked `endpoints.length` would pass just as happily on a
 *     detector that never ran.
 *  2. **What was NOT claimed.** Over-reporting is the failure mode — a route
 *     list that reads well and does not match the app. So the negative
 *     assertions (no layout routes, no client call sites, no guessed verbs) are
 *     load-bearing, not decoration.
 */

import { describe, expect, it } from 'vitest';
import {
  SOURCE_DETECTORS,
  analyseCodebase,
  summariseAnalysis,
  type CodebaseAnalysis,
  type SourceDetectorId,
} from './codebase';
import { detectProject, type RepoFile } from './detect';

const f = (path: string, content?: string): RepoFile =>
  content === undefined ? { path } : { path, content };

const routes = (a: CodebaseAnalysis): string[] => a.routes.map((r) => r.route).sort();
const endpoints = (a: CodebaseAnalysis): string[] =>
  a.endpoints.map((e) => `${e.method} ${e.path}`).sort();
const detector = (a: CodebaseAnalysis, id: SourceDetectorId) => {
  const report = a.detectors.find((d) => d.id === id);
  if (!report) throw new Error(`no report for detector ${id}`);
  return report;
};

// ─── Fixture 1: a Next.js App Router application ─────────────────────────────

const NEXT_APP: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({
      name: 'shop',
      dependencies: { next: '^15.0.0', react: '^19.0.0' },
      devDependencies: { '@playwright/test': '^1.49.0' },
    }),
  ),
  f('next.config.ts', 'export default {};'),
  f('app/page.tsx', 'export default function Home() { return <main>Shop</main>; }'),
  f('app/layout.tsx', 'export default function Layout({ children }) { return children; }'),
  f('app/(marketing)/pricing/page.tsx', 'export default function Pricing() { return null; }'),
  f('app/orders/[id]/page.tsx', 'export default function Order() { return null; }'),
  f('app/blog/[...slug]/page.tsx', 'export default function Post() { return null; }'),
  f('app/_components/Button.tsx', 'export const Button = () => null;'),
  f(
    'app/api/orders/route.ts',
    `import { NextResponse } from 'next/server';
     export async function GET() { return NextResponse.json([]); }
     export async function POST(req: Request) { return NextResponse.json({}, { status: 201 }); }`,
  ),
  f(
    'app/api/orders/[id]/route.ts',
    `export async function GET() {}
     export async function DELETE() {}`,
  ),
  f('app/login/page.tsx', 'export default function Login() { return null; }'),
  f(
    'components/LoginForm.tsx',
    `export function LoginForm() {
       return (
         <form action="/api/auth/session" method="post" id="signin">
           <label for="email">Work email</label>
           <input id="email" name="email" type="email" required />
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required />
           <select name="workspace"><option>Acme</option><option>Globex</option></select>
           <button type="submit">Sign in</button>
         </form>
       );
     }`,
  ),
  // A client call site. The server does not serve this — the front end calls it.
  f(
    'lib/api.ts',
    `import axios from 'axios';
     export const listOrders = () => axios.get('/api/orders');
     export const trackEvent = () => axios.post('/api/telemetry');`,
  ),
  f('e2e/checkout.spec.ts', "import { test } from '@playwright/test'; test('x', async () => {});"),
];

describe('a Next.js App Router application', () => {
  const analysis = analyseCodebase(NEXT_APP);

  it('reads every page route off the directory layout, including groups and catch-alls', () => {
    expect(routes(analysis)).toEqual([
      '/',
      '/blog/:slug*',
      '/login',
      '/orders/:id',
      '/pricing', // the (marketing) group contributes no URL segment
    ]);
  });

  it('never invents a route for a layout or a private folder', () => {
    // app/layout.tsx wraps a subtree and is navigable at no URL of its own;
    // app/_components/ is private. Both would be plausible routes and neither exists.
    expect(routes(analysis)).not.toContain('/_components');
    expect(analysis.routes.some((r) => r.file.endsWith('layout.tsx'))).toBe(false);
  });

  it('reads the HTTP verbs a route handler actually exports', () => {
    expect(endpoints(analysis)).toEqual([
      'DELETE /api/orders/:id',
      'GET /api/orders',
      'GET /api/orders/:id',
      'POST /api/orders',
    ]);
  });

  it('does not read an axios call site as an endpoint the server offers', () => {
    // lib/api.ts POSTs to /api/telemetry. Nothing in this repo SERVES it, and a
    // consumed URL reported as a served one is the most plausible wrong answer
    // this module could produce.
    expect(endpoints(analysis)).not.toContain('POST /api/telemetry');
    expect(analysis.endpoints.every((e) => !e.file.includes('lib/api.ts'))).toBe(true);
  });

  it('extracts the login form with fields, labels and generation hints', () => {
    expect(analysis.forms).toHaveLength(1);
    const form = analysis.forms[0]!;
    expect(form.action).toBe('/api/auth/session');
    expect(form.method).toBe('POST');
    expect(form.submitLabel).toBe('Sign in');
    expect(form.fields.map((x) => [x.name, x.semantic, x.required])).toEqual([
      ['email', 'email', true],
      ['password', 'password', true],
      ['workspace', 'unknown', false],
    ]);
    expect(form.fields[0]!.label).toBe('Work email');
    expect(form.fields[2]!.options).toEqual(['Acme', 'Globex']);
  });

  it('finds the auth surfaces from both the route name and the password field', () => {
    const kinds = analysis.authSurfaces.map((s) => `${s.kind}:${s.from}`).sort();
    expect(kinds).toContain('LOGIN:route');
    expect(kinds).toContain('LOGIN:form');
    // /api/auth/session is a session exchange, and it is found from the endpoint
    // list rather than from anybody naming a page "login".
    expect(analysis.authSurfaces.some((s) => s.kind === 'SESSION' || s.path.includes('auth'))).toBe(
      true,
    );
  });

  it('names Next.js as the application framework, which detect.ts never does', () => {
    expect(analysis.frameworks.map((x) => x.framework)).toContain('Next.js');
  });

  it('skips the test suite, because a spec declares no route the app serves', () => {
    expect(analysis.routes.every((r) => !r.file.startsWith('e2e/'))).toBe(true);
    expect(analysis.coverage.filesIgnored).toBeGreaterThan(0);
  });

  it('reports every detector, including the ones with nothing to look at', () => {
    expect(analysis.detectors.map((d) => d.id).sort()).toEqual([...SOURCE_DETECTORS].sort());
    expect(detector(analysis, 'next-app-router').found).toBeGreaterThan(0);
    // Django ran in the sense that it exists and reported honestly: no urls.py.
    expect(detector(analysis, 'django-urls').filesExamined).toBe(0);
    expect(detector(analysis, 'django-urls').found).toBe(0);
    expect(detector(analysis, 'django-urls').blocked).toBeNull();
  });
});

// ─── Fixture 2: an Express API ───────────────────────────────────────────────

const EXPRESS_API: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({
      name: 'billing-api',
      dependencies: { express: '^4.19.0', pg: '^8.11.0' },
    }),
  ),
  f(
    'src/index.js',
    `const express = require('express');
     const app = express();
     const invoices = require('./routes/invoices');
     app.use('/v1', invoices);
     app.get('/health', (req, res) => res.json({ ok: true }));
     app.listen(3000);`,
  ),
  f(
    'src/routes/invoices.js',
    `const express = require('express');
     const router = express.Router();
     router.get('/invoices', list);
     router.get('/invoices/:invoiceId', show);
     router.post('/invoices', create);
     router.delete('/invoices/:invoiceId', destroy);
     module.exports = router;`,
  ),
  f(
    'src/routes/auth.js',
    `const { Router } = require('express');
     const auth = Router();
     auth.post('/login', signIn);
     auth.post('/logout', signOut);
     module.exports = auth;`,
  ),
  f(
    'src/lib/upstream.js',
    `const axios = require('axios');
     exports.fetchRates = () => axios.get('/rates');
     exports.pushLedger = () => http.post('/ledger');`,
  ),
];

describe('an Express API', () => {
  const analysis = analyseCodebase(EXPRESS_API);

  it('reads method and path off every route registration', () => {
    expect(endpoints(analysis)).toEqual([
      'DELETE /invoices/:invoiceId',
      'GET /health',
      'GET /invoices',
      'GET /invoices/:invoiceId',
      'POST /invoices',
      'POST /login',
      'POST /logout',
    ]);
  });

  it('honours a router bound to a name the convention list does not know', () => {
    // src/routes/auth.js calls its router `auth`, not `router`. It is a server
    // because `Router()` produced it, and that is what the detector keys on.
    expect(endpoints(analysis)).toContain('POST /login');
  });

  it('rejects axios and bare http as route registrations', () => {
    expect(endpoints(analysis)).not.toContain('GET /rates');
    expect(endpoints(analysis)).not.toContain('POST /ledger');
  });

  it('says out loud that mount prefixes were NOT applied', () => {
    // app.use('/v1', invoices) means the real URL is /v1/invoices. Resolving that
    // needs an import graph. Reporting /invoices while staying silent about the
    // prefix would be a list of URLs that 404.
    expect(analysis.notes.some((n) => n.includes("app.use('/api', router)"))).toBe(true);
    expect(analysis.notes.some((n) => n.toLowerCase().includes('without that prefix'))).toBe(true);
  });

  it('finds no page routes, and says the page detectors examined nothing', () => {
    expect(analysis.routes).toEqual([]);
    expect(detector(analysis, 'next-app-router').filesExamined).toBe(0);
    expect(detector(analysis, 'sveltekit').filesExamined).toBe(0);
    expect(detector(analysis, 'express-fastify').filesExamined).toBeGreaterThan(0);
  });

  it('classifies the login and logout endpoints as auth surfaces', () => {
    const auth = analysis.authSurfaces.map((s) => `${s.kind} ${s.path}`);
    expect(auth).toContain('LOGIN /login');
    expect(auth).toContain('LOGOUT /logout');
  });
});

// ─── Fixture 3: a Rails application (a non-JS ecosystem) ─────────────────────

const RAILS_APP: RepoFile[] = [
  f('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'pg'"),
  f(
    'config/routes.rb',
    `Rails.application.routes.draw do
       root to: 'home#index'
       get 'about', to: 'pages#about'
       get '/login', to: 'sessions#new'
       post '/login', to: 'sessions#create'
       delete '/logout', to: 'sessions#destroy'
       resources :orders
       resources :categories, only: [:index, :show]
       namespace :admin do
         resources :users, except: [:destroy]
       end
     end`,
  ),
  f('app/models/order.rb', 'class Order < ApplicationRecord; end'),
  f('app/controllers/orders_controller.rb', 'class OrdersController < ApplicationController; end'),
  f('app/javascript/controllers/page.js', 'export default class extends Controller {}'),
  f(
    'app/views/sessions/new.html.erb',
    `<form action="/login" method="post">
       <label for="user_email">Email</label>
       <input id="user_email" name="user[email]" type="email" required>
       <label for="user_password">Password</label>
       <input id="user_password" name="user[password]" type="password" required>
       <input type="submit" value="Log in">
     </form>`,
  ),
];

describe('a Rails application', () => {
  const analysis = analyseCodebase(RAILS_APP);

  it('expands resources :orders into the seven routes the macro means', () => {
    const orderRoutes = endpoints(analysis).filter((e) => e.includes('/orders'));
    expect(orderRoutes).toEqual([
      'DELETE /orders/:id',
      'GET /orders',
      'GET /orders/:id',
      'GET /orders/:id/edit',
      'GET /orders/new',
      'PATCH /orders/:id',
      'POST /orders',
    ]);
  });

  it('honours only: and except: rather than expanding all seven regardless', () => {
    const categories = endpoints(analysis).filter((e) => e.includes('/categories'));
    expect(categories).toEqual(['GET /categories', 'GET /categories/:id']);
    // except: [:destroy] leaves six, and DELETE is the one that must be gone.
    expect(endpoints(analysis)).not.toContain('DELETE /admin/users/:id');
    expect(endpoints(analysis)).toContain('GET /admin/users');
  });

  it('applies namespace nesting to the paths inside the block', () => {
    expect(endpoints(analysis)).toContain('POST /admin/users');
    expect(endpoints(analysis)).not.toContain('POST /users');
  });

  it('reads root and the explicit verb declarations', () => {
    expect(endpoints(analysis)).toContain('GET /');
    expect(endpoints(analysis)).toContain('GET /about');
    expect(endpoints(analysis)).toContain('POST /login');
    expect(endpoints(analysis)).toContain('DELETE /logout');
  });

  it('lists the GET routes as pages too, because Rails renders HTML from them', () => {
    expect(routes(analysis)).toContain('/about');
    expect(routes(analysis)).toContain('/orders/:id');
    // A POST is not a page, and must not appear as one.
    expect(analysis.routes.every((r) => r.route !== '/logout')).toBe(true);
  });

  it('does not read Rails app/ subdirectories as Next.js App Router pages', () => {
    // app/javascript/controllers/page.js has the exact shape App Router keys on.
    // Reading it as a page would invent /javascript/controllers out of nothing.
    expect(routes(analysis)).not.toContain('/javascript/controllers');
    expect(detector(analysis, 'next-app-router').filesExamined).toBe(0);
  });

  it('extracts the ERB sign-in form', () => {
    expect(analysis.forms).toHaveLength(1);
    const form = analysis.forms[0]!;
    expect(form.action).toBe('/login');
    expect(form.fields.map((x) => x.semantic)).toEqual(['email', 'password']);
    expect(form.fields[0]!.label).toBe('Email');
  });

  it('names Ruby on Rails as the framework', () => {
    expect(analysis.frameworks.map((x) => x.framework)).toContain('Ruby on Rails');
  });
});

// ─── Fixture 4: Django, Flask and Spring, for the method-honesty rule ────────

describe('a Django URLconf', () => {
  const analysis = analyseCodebase([
    f('manage.py', "import django\nif __name__ == '__main__': pass"),
    f('requirements.txt', 'Django>=5.0\ndjangorestframework>=3.15'),
    f(
      'shop/urls.py',
      `from django.urls import path, include
       from . import views
       urlpatterns = [
           path('', views.index, name='index'),
           path('orders/<int:order_id>/', views.order_detail),
           path('accounts/login/', views.login_view),
           path('api/', include('shop.api.urls')),
       ]`,
    ),
  ]);

  it('reads the URLconf entries and converts Django parameters', () => {
    expect(routes(analysis)).toEqual(['/', '/accounts/login', '/orders/:order_id']);
  });

  it('declares nothing about HTTP methods, because a URLconf declares none', () => {
    expect(analysis.endpoints).toEqual([]);
  });

  it('says that include() nesting was not resolved', () => {
    expect(analysis.notes.some((n) => n.includes('include()'))).toBe(true);
  });

  it('finds the login route as an auth surface', () => {
    expect(analysis.authSurfaces.map((s) => s.kind)).toContain('LOGIN');
  });
});

describe('a Flask + FastAPI service', () => {
  const analysis = analyseCodebase([
    f('requirements.txt', 'flask>=3.0\nfastapi>=0.115'),
    f(
      'app.py',
      `from flask import Flask
       app = Flask(__name__)

       @app.route('/health')
       def health(): return 'ok'

       @app.route('/users/<int:user_id>', methods=['GET', 'DELETE'])
       def user(user_id): return {}`,
    ),
    f(
      'api/routes.py',
      `from fastapi import APIRouter
       router = APIRouter()

       @router.get('/items/{item_id}')
       async def read_item(item_id: int): return {}

       @router.post('/items')
       async def create_item(): return {}`,
    ),
  ]);

  it('uses Flask’s documented GET default only when methods= is absent', () => {
    expect(endpoints(analysis)).toContain('GET /health');
    expect(endpoints(analysis)).toContain('GET /users/:user_id');
    expect(endpoints(analysis)).toContain('DELETE /users/:user_id');
    expect(endpoints(analysis)).not.toContain('POST /users/:user_id');
  });

  it('converts FastAPI path parameters into the shared spelling', () => {
    expect(endpoints(analysis)).toContain('GET /items/:item_id');
    expect(endpoints(analysis)).toContain('POST /items');
  });
});

describe('a Spring MVC controller', () => {
  const analysis = analyseCodebase([
    f('pom.xml', '<project><dependencies><artifactId>spring-boot-starter-web</artifactId></dependencies></project>'),
    f(
      'src/main/java/com/acme/OrderController.java',
      `package com.acme;
       import org.springframework.web.bind.annotation.*;

       @RestController
       @RequestMapping("/api/orders")
       public class OrderController {
           @GetMapping
           public List<Order> list() { return null; }

           @GetMapping("/{id}")
           public Order get(@PathVariable Long id) { return null; }

           @PostMapping
           public Order create(@RequestBody Order o) { return null; }

           @DeleteMapping("/{id}")
           public void remove(@PathVariable Long id) {}
       }`,
    ),
  ]);

  it('joins the class-level @RequestMapping prefix onto every method mapping', () => {
    expect(endpoints(analysis)).toEqual([
      'DELETE /api/orders/:id',
      'GET /api/orders',
      'GET /api/orders/:id',
      'POST /api/orders',
    ]);
  });
});

// ─── The honesty contract ────────────────────────────────────────────────────

describe('the honesty contract', () => {
  it('distinguishes "nothing to look at" from "looked and found nothing"', () => {
    // A repo with a urls.py that declares no patterns: the detector examined a
    // file and found nothing. That is a different answer from Django not being
    // present at all, and an empty endpoints array cannot express the difference.
    const analysis = analyseCodebase([
      f('shop/urls.py', 'from django.urls import path\nurlpatterns = []'),
    ]);
    expect(detector(analysis, 'django-urls').filesExamined).toBe(1);
    expect(detector(analysis, 'django-urls').found).toBe(0);
    expect(detector(analysis, 'django-urls').blocked).toBeNull();

    expect(detector(analysis, 'rails-routes').filesExamined).toBe(0);
  });

  it('says when a detector found its files and was given no contents', () => {
    const analysis = analyseCodebase([f('config/routes.rb'), f('shop/urls.py')]);
    expect(detector(analysis, 'rails-routes').filesExamined).toBe(1);
    expect(detector(analysis, 'rails-routes').blocked).toMatch(/no content/);
    expect(detector(analysis, 'django-urls').blocked).toMatch(/no content/);
  });

  it('still reads file-convention routes from a listing with no file bodies at all', () => {
    // This is the whole reason RepoFile.content is optional: a git tree is cheap.
    const analysis = analyseCodebase([
      f('app/page.tsx'),
      f('app/settings/billing/page.tsx'),
      f('app/api/webhook/route.ts'),
    ]);
    expect(routes(analysis)).toEqual(['/', '/settings/billing']);
    expect(analysis.coverage.filesWithContent).toBe(0);
    expect(analysis.notes.some((n) => n.includes('Only file paths were uploaded'))).toBe(true);
  });

  it('reports UNKNOWN rather than guessing GET for a handler it could not read', () => {
    const analysis = analyseCodebase([f('app/api/webhook/route.ts')]);
    expect(endpoints(analysis)).toEqual(['UNKNOWN /api/webhook']);
    expect(analysis.notes.some((n) => n.includes('rather'))).toBe(true);
    expect(analysis.endpoints[0]!.evidence).toMatch(/no file content was uploaded/);
  });

  it('leads with the static-analysis limit on every single result', () => {
    for (const fixture of [NEXT_APP, EXPRESS_API, RAILS_APP, []]) {
      const analysis = analyseCodebase(fixture);
      expect(analysis.notes[0]).toMatch(/STATIC read of the source/);
      expect(analysis.notes[0]).toMatch(/not what the application does when it runs/);
    }
  });

  it('carries a file and an observation on every fact it reports', () => {
    const analysis = analyseCodebase(NEXT_APP);
    for (const item of [...analysis.routes, ...analysis.endpoints]) {
      expect(item.file).toBeTruthy();
      expect(item.evidence.length).toBeGreaterThan(10);
      expect(item.evidence).toContain(item.file);
    }
  });

  it('summarises without overclaiming', () => {
    const summary = summariseAnalysis(analyseCodebase(NEXT_APP));
    expect(summary).toMatch(/detectors found something/);
    expect(summary).toMatch(/had no files of their kind to look at/);
    expect(summary).toMatch(/All of it is static/);
  });

  it('survives junk input without throwing', () => {
    const junk = [
      null,
      undefined,
      {},
      { path: '' },
      { path: 'a/b/c' },
      { path: 'app/page.tsx', content: 123 },
    ] as unknown as RepoFile[];
    const analysis = analyseCodebase(junk);
    expect(analysis.routes.map((r) => r.route)).toEqual(['/']);
    expect(analysis.detectors).toHaveLength(SOURCE_DETECTORS.length);
  });

  it('is order-independent: the answer describes the repo, not the upload order', () => {
    const forwards = analyseCodebase(NEXT_APP);
    const backwards = analyseCodebase([...NEXT_APP].reverse());
    expect(routes(backwards)).toEqual(routes(forwards));
    expect(endpoints(backwards)).toEqual(endpoints(forwards));
    expect(backwards.forms.map((x) => x.id)).toEqual(forwards.forms.map((x) => x.id));
  });

  it('bounds a hostile upload rather than looping over it', () => {
    const many = Array.from({ length: 9000 }, (_, i) => f(`app/p${i}/page.tsx`));
    const analysis = analyseCodebase(many);
    expect(analysis.coverage.filesAnalysed).toBeLessThanOrEqual(5000);
    expect(analysis.coverage.truncated).toBe(true);
    expect(analysis.warnings.some((w) => w.includes('not analysed'))).toBe(true);
  });
});

// ─── The two analyses answer different questions ─────────────────────────────

describe('alongside detectProject', () => {
  it('answers a question detect.ts cannot, over the very same input', () => {
    // detect.ts is the runner question. It reads the Playwright devDependency and
    // stops; it has no idea this app serves /orders/:id. This module is the other
    // half, and running both over one upload is the point of the ingest.
    const detection = detectProject(NEXT_APP);
    const analysis = analyseCodebase(NEXT_APP);

    expect(detection.candidates.map((c) => c.runner)).toContain('playwright');
    expect(detection.languages.map((l) => l.language)).toContain('TYPESCRIPT');
    // Nothing in ProjectDetection can express a route, an endpoint or a form.
    expect(Object.keys(detection)).not.toContain('routes');

    expect(analysis.routes.length).toBeGreaterThan(0);
    expect(analysis.endpoints.length).toBeGreaterThan(0);
    // And this module says nothing about how to RUN anything, which is detect's job.
    expect(Object.keys(analysis)).not.toContain('candidates');
  });
});
