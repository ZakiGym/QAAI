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

// ─── Fixture 6: a React Router SPA ───────────────────────────────────────────

/**
 * Modelled on a real 1245-file React Router application, down to the file names.
 *
 * Its `src/pages/` tree is a naming convention and nothing more: eight of the
 * files below are the tab components of ONE analytics page, and
 * `/admin/analytics/ChurnTab` is a URL that has never existed. The route table
 * is in App.tsx, where it is nested three deep, and reading it is the only way
 * to learn that the members area lives under `/portal/:gymId/member`.
 */
const REACT_ROUTER_SPA: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({
      name: 'gym',
      dependencies: { react: '^18.3.1', 'react-router-dom': '^6.26.2' },
      devDependencies: { vite: '^5.4.0', cypress: '^13.0.0' },
    }),
  ),
  f('vite.config.ts', 'export default {};'),
  // The components. Every one of these was reported as a page route before.
  f('src/pages/LandingPage.tsx', 'export default function LandingPage() { return null; }'),
  f('src/pages/NotFound.tsx', 'export default function NotFound() { return null; }'),
  f('src/pages/admin/AdminProfile.tsx', 'export default function AdminProfile() { return null; }'),
  f('src/pages/admin/analytics/AnalyticsPage.tsx', 'export default function A() { return null; }'),
  f('src/pages/admin/analytics/ChurnTab.tsx', 'export default function ChurnTab() { return null; }'),
  f('src/pages/admin/analytics/FeedbackTab.tsx', 'export default function F() { return null; }'),
  f('src/pages/admin/analytics/RevenueTab.tsx', 'export default function R() { return null; }'),
  f('src/pages/superadmin/dashboard/DashboardPage.tsx', 'export default function D(){ return null; }'),
  f('src/pages/members/MemberBookings.tsx', 'export default function MB() { return null; }'),
  // The route table.
  f(
    'src/App.tsx',
    `import { Routes, Route } from "react-router-dom";

     /* Two identical <Route path="pricing"> declarations used to exist here;
        React Router took the first and the second was dead. */
     export default function App() {
       return (
         <Routes>
           <Route path="/" element={<RootRedirect />} />
           <Route path="/pricing" element={<PricingRoute />} />
           <Route path="auth" element={<AuthLayout />}>
             <Route path="login" element={<Login />} />
             <Route path="accept-invite/:token" element={<AcceptInvite />} />
           </Route>
           <Route
             path="superadmin/*"
             element={
               <RequireRoles roles={["superadmin"]}>
                 <SuperAdminLayout />
               </RequireRoles>
             }
           >
             <Route path="dashboard" element={<SADashboard />} />
             <Route path="gyms/:gymId" element={<SAGymLayout />}>
               <Route index element={<SAGymOverview />} />
               <Route path="features" element={<SAGymFeatures />} />
             </Route>
           </Route>
           <Route path="portal/:gymId/member" element={<MemberLayout />}>
             <Route path="bookings" element={<MemberBookings />} />
           </Route>
           <Route path="crm/*" element={<CrmRoutes />} />
           <Route path="*" element={<NotFound />} />
         </Routes>
       );
     }`,
  ),
  // A descendant route table: mounted by whoever renders <CrmRoutes />, and
  // nothing in this file says where that is.
  f(
    'src/routes/crmRoutes.tsx',
    `import { Routes, Route, Navigate } from "react-router-dom";
     export default function CrmRoutes() {
       return (
         <Routes>
           <Route index element={<CrmDashboard />} />
           <Route path="contacts" element={<ContactsPage />} />
           <Route path="contacts/:contactId" element={<ContactDetailPage />} />
           <Route path="*" element={<Navigate to="../.." replace />} />
         </Routes>
       );
     }`,
  ),
  // Nav links. `path:` in an options bag is not a route declaration, and the
  // file imports react-router only because it renders <Link>.
  f(
    'src/components/site/SiteNavbar.tsx',
    `import { Link } from "react-router-dom";
     const LINKS = [
       { path: "/terms", label: "Terms" },
       { path: "/support", label: "Support" },
       { path: "/help-me-i-am-not-a-route", label: "Help" },
     ];
     export const SiteNavbar = () => LINKS.map((l) => <Link to={l.path}>{l.label}</Link>);`,
  ),
];

describe('a React Router application', () => {
  const analysis = analyseCodebase(REACT_ROUTER_SPA);

  it('does not turn a component in src/pages/ into a page route', () => {
    // The bug this fixture exists for: eight tab components read as eight URLs.
    for (const invented of [
      '/admin/analytics/ChurnTab',
      '/admin/analytics/FeedbackTab',
      '/admin/analytics/RevenueTab',
      '/admin/analytics/AnalyticsPage',
      '/admin/AdminProfile',
      '/superadmin/dashboard/DashboardPage',
      '/LandingPage',
      '/NotFound',
    ]) {
      expect(routes(analysis)).not.toContain(invented);
    }
    expect(analysis.routes.every((r) => r.detector !== 'pages-directory')).toBe(true);
  });

  it('says WHY the pages/ tree was not read, rather than silently skipping it', () => {
    const report = detector(analysis, 'pages-directory');
    expect(report.filesExamined).toBe(9);
    expect(report.found).toBe(0);
    expect(report.blocked).toMatch(/React Router/);
    expect(report.blocked).toMatch(/react-router-dom in dependencies/);
    expect(report.blocked).toMatch(/component, not a URL/);
    // And it is in the summary a user reads, not only in the detector table.
    expect(analysis.notes.some((n) => n.includes('component, not a URL'))).toBe(true);
  });

  it('reads the route table out of the source, nesting and all', () => {
    expect(routes(analysis)).toEqual([
      '/',
      '/auth',
      '/auth/accept-invite/:token',
      '/auth/login',
      '/crm/*',
      '/portal/:gymId/member',
      '/portal/:gymId/member/bookings',
      '/pricing',
      '/superadmin',
      '/superadmin/dashboard',
      '/superadmin/gyms/:gymId',
      '/superadmin/gyms/:gymId/features',
    ]);
  });

  it('resolves a parent chain instead of reporting a child path on its own', () => {
    const login = analysis.routes.find((r) => r.route === '/auth/login');
    expect(login?.evidence).toBe(
      'src/App.tsx declares <Route path="login"> nested under "/auth"',
    );
    // /login is what the old pass reported, and it 404s.
    expect(routes(analysis)).not.toContain('/login');
    expect(routes(analysis)).not.toContain('/dashboard');
    expect(routes(analysis)).not.toContain('/bookings');
  });

  it('drops a parent’s trailing splat, which exists only so children can match', () => {
    // Verified against the router itself: matchRoutes(['superadmin/*' > 'dashboard'])
    // matches the URL /superadmin/dashboard, not /superadmin/*/dashboard.
    expect(routes(analysis)).toContain('/superadmin/dashboard');
    expect(routes(analysis)).not.toContain('/superadmin/*/dashboard');
    expect(routes(analysis)).toContain('/superadmin');
    // A splat on a LEAF route is left alone: there it names a real prefix.
    expect(routes(analysis)).toContain('/crm/*');
  });

  it('reads an index route as the URL its parent sits at', () => {
    const overview = analysis.routes.find((r) => r.route === '/superadmin/gyms/:gymId');
    expect(overview).toBeTruthy();
    expect(overview!.dynamic).toBe(true);
  });

  it('never claims the catch-all, which matches every URL and names none', () => {
    expect(routes(analysis)).not.toContain('/*');
  });

  it('refuses a descendant route table whose mount point it cannot resolve', () => {
    // crmRoutes.tsx is mounted at /crm by App.tsx, but only an import graph says so.
    expect(routes(analysis)).not.toContain('/contacts');
    expect(routes(analysis)).not.toContain('/contacts/:contactId');
    expect(analysis.routes.every((r) => r.file !== 'src/routes/crmRoutes.tsx')).toBe(true);
    expect(analysis.notes.some((n) => n.includes('declares only relative paths'))).toBe(true);
    expect(analysis.notes.some((n) => n.includes('would send every test to a 404'))).toBe(true);
  });

  it('does not read a nav-link array as a route table', () => {
    expect(routes(analysis)).not.toContain('/help-me-i-am-not-a-route');
    expect(analysis.routes.every((r) => !r.file.includes('SiteNavbar'))).toBe(true);
  });

  it('is not fooled by a <Route> written inside a comment', () => {
    // A phantom opening tag with no closing partner reparents every declaration
    // after it, which is how a whole route table silently becomes unresolvable.
    expect(routes(analysis)).toContain('/pricing');
    expect(analysis.routes.find((r) => r.route === '/pricing')!.evidence).not.toMatch(/nested/);
  });

  it('never claims a file path implies a URL in an app whose router is code', () => {
    for (const route of analysis.routes) {
      expect(route.evidence).not.toMatch(/path is the URL/);
      expect(route.evidence).toMatch(/declares/);
    }
  });

  it('names React Router as the framework and finds the login surface', () => {
    expect(analysis.frameworks.map((x) => x.framework)).toContain('React Router');
    expect(analysis.authSurfaces.map((s) => s.path)).toContain('/auth/login');
  });
});

// ─── Fixture 7: a route table built from objects ─────────────────────────────

const DATA_ROUTER: RepoFile[] = [
  f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.26.0' } })),
  f('src/pages/Dashboard.tsx', 'export default function Dashboard() { return null; }'),
  f(
    'src/router.tsx',
    `import { createBrowserRouter } from "react-router-dom";
     export const router = createBrowserRouter([
       {
         path: "/",
         element: <Root />,
         errorElement: <ErrorPage message="a { brace } and a 'quote'" />,
         children: [
           { index: true, element: <Home /> },
           { path: "orders", element: <Orders />, children: [
             { path: ":orderId", element: <Order /> },
           ] },
           { path: "*", element: <NotFound /> },
         ],
       },
       { path: "/login", element: <Login /> },
     ]);`,
  ),
];

describe('a route table built from objects', () => {
  const analysis = analyseCodebase(DATA_ROUTER);

  it('follows children: into the nesting', () => {
    expect(routes(analysis)).toEqual(['/', '/login', '/orders', '/orders/:orderId']);
  });

  it('is not derailed by braces and quotes inside a sibling property', () => {
    expect(routes(analysis)).not.toContain('/a { brace } and a ');
  });

  it('says the nested ones are nested', () => {
    const order = analysis.routes.find((r) => r.route === '/orders/:orderId');
    expect(order?.evidence).toMatch(/nested under "\/orders"/);
    expect(order?.dynamic).toBe(true);
  });
});

// ─── Fixture 8: Vue Router ───────────────────────────────────────────────────

const VUE_APP: RepoFile[] = [
  f('package.json', JSON.stringify({ dependencies: { vue: '^3.4.0', 'vue-router': '^4.4.0' } })),
  f('src/pages/AboutPanel.vue', '<template><div /></template>'),
  f(
    'src/router/index.ts',
    `import { createRouter, createWebHistory } from 'vue-router';
     const routes = [
       { path: '/', component: Home },
       { path: '/users/:id', component: User, children: [
         { path: 'profile', component: Profile },
       ] },
     ];
     export default createRouter({ history: createWebHistory(), routes });`,
  ),
];

describe('a Vue Router application', () => {
  const analysis = analyseCodebase(VUE_APP);

  it('resolves child records against their parent record', () => {
    expect(routes(analysis)).toEqual(['/', '/users/:id', '/users/:id/profile']);
  });

  it('leaves the pages/ directory alone, because Vue Router is not a file router', () => {
    expect(routes(analysis)).not.toContain('/AboutPanel');
    expect(detector(analysis, 'pages-directory').blocked).toMatch(/Vue Router/);
  });
});

// ─── The file-convention half must stay confident ────────────────────────────

describe('an application whose router IS the filesystem', () => {
  it('keeps reading Next.js pages/ paths as URLs, and names what makes that true', () => {
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { next: '^14.2.0' } })),
      f('pages/index.tsx', 'export default function Home() { return null; }'),
      f('pages/orders/[id].tsx', 'export default function Order() { return null; }'),
      f('pages/_app.tsx', 'export default function App({ Component }) { return <Component />; }'),
      f('pages/api/orders.ts', "export default function h(req, res) { if (req.method === 'POST') {} }"),
    ]);
    expect(routes(analysis)).toEqual(['/', '/orders/:id']);
    expect(analysis.routes[0]!.evidence).toMatch(/Next\.js \(next in dependencies/);
    expect(detector(analysis, 'pages-directory').blocked).toBeNull();
    expect(endpoints(analysis)).toEqual(['POST /api/orders']);
  });

  it('reads pages/ on the layout convention alone when no framework is named', () => {
    // A paths-only upload with no manifest body. The convention is all there is,
    // and nothing contradicts it, so it is still read.
    const analysis = analyseCodebase([f('pages/index.vue'), f('pages/_id.vue')]);
    expect(routes(analysis)).toEqual(['/', '/:id']);
    expect(detector(analysis, 'pages-directory').blocked).toBeNull();
  });

  it('still trusts Next when its own specials are the only evidence', () => {
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.0.0' } })),
      f('web/pages/_document.tsx'),
      f('web/pages/settings.tsx'),
    ]);
    expect(routes(analysis)).toContain('/settings');
    expect(analysis.routes[0]!.evidence).toMatch(/only the Pages Router looks for/);
  });

  it('will not read an app/ tree as Next when the router is declared in code', () => {
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.0.0' } })),
      f('src/app/dashboard/page.tsx', 'export default function Page() { return null; }'),
    ]);
    expect(analysis.routes).toEqual([]);
    expect(detector(analysis, 'next-app-router').filesExamined).toBe(1);
    expect(detector(analysis, 'next-app-router').blocked).toMatch(/React Router/);
  });
});

// ─── Bounds on the new scanners ──────────────────────────────────────────────

describe('the route-table scanners under stress', () => {
  it('terminates on a file of unbalanced route syntax', () => {
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.0.0' } })),
      f(
        'src/Broken.tsx',
        `import { Routes, Route } from "react-router-dom";
         <Routes><Route path="/a" element={<X` + '{'.repeat(500),
      ),
      f(
        'src/Broken2.tsx',
        `import { createBrowserRouter } from "react-router-dom";
         createBrowserRouter([{ path: "/b", children: [` + '{ path: "/c", children: ['.repeat(200),
      ),
    ]);
    expect(analysis.detectors).toHaveLength(SOURCE_DETECTORS.length);
    expect(analysis.routes.length).toBeLessThan(50);
  });

  it('bounds one file’s declarations rather than reading all of them', () => {
    const table = Array.from({ length: 4000 }, (_, i) => `<Route path="/p${i}" />`).join('\n');
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.0.0' } })),
      f('src/Many.tsx', `import { Routes } from "react-router-dom";\n<Routes>${table}</Routes>`),
    ]);
    expect(analysis.routes.length).toBe(2000);
  });
});

// ─── Fixture 9: the monorepo, which is what a customer actually uploads ──────

/**
 * Two applications in one upload that disagree about their own routing.
 *
 * `apps/marketing` is Next.js and its `pages/**` really are URLs.
 * `apps/console` is React Router and its `src/pages/**` are components with no
 * URL of their own. A verdict taken once over the whole upload finds `next` in
 * one workspace and unlocks "the path is the URL" in the other — the original
 * defect, scoped to `pages/` rather than removed. Both halves are asserted here
 * because either one alone would pass while the bug is intact: refuse
 * everything and marketing's routes vanish, claim everything and console's tabs
 * come back as URLs that 404.
 */
const MIXED_MONOREPO: RepoFile[] = [
  f(
    'package.json',
    JSON.stringify({
      name: 'acme',
      private: true,
      workspaces: ['apps/*'],
      devDependencies: { turbo: '^2.3.0' },
    }),
  ),

  f(
    'apps/marketing/package.json',
    JSON.stringify({
      name: '@acme/marketing',
      dependencies: { next: '^15.0.0', react: '^19.0.0' },
    }),
  ),
  f('apps/marketing/next.config.mjs', 'export default {};'),
  f('apps/marketing/pages/index.tsx', 'export default function Home() { return null; }'),
  f('apps/marketing/pages/pricing.tsx', 'export default function Pricing() { return null; }'),
  f('apps/marketing/pages/blog/[slug].tsx', 'export default function Post() { return null; }'),
  f(
    'apps/marketing/pages/api/lead.ts',
    "export default function h(req, res) { if (req.method === 'POST') {} }",
  ),

  f(
    'apps/console/package.json',
    JSON.stringify({
      name: '@acme/console',
      dependencies: { 'react-router-dom': '^6.26.0', react: '^19.0.0' },
    }),
  ),
  f('apps/console/src/pages/Dashboard.tsx', 'export default function Dashboard() { return null; }'),
  f('apps/console/src/pages/billing/InvoicesTab.tsx', 'export const InvoicesTab = () => null;'),
  f('apps/console/src/pages/billing/PlanTab.tsx', 'export const PlanTab = () => null;'),
  f(
    'apps/console/src/routes.tsx',
    `import { Routes, Route } from "react-router-dom";
     export const ConsoleRoutes = () => (
       <Routes>
         <Route path="/console" element={<Dashboard />} />
         <Route path="/console/billing" element={<Billing />} />
       </Routes>
     );`,
  ),
];

describe('a monorepo whose packages route differently', () => {
  const analysis = analyseCodebase(MIXED_MONOREPO);

  it('reads the Next workspace’s pages/ tree as URLs', () => {
    expect(routes(analysis)).toContain('/');
    expect(routes(analysis)).toContain('/pricing');
    expect(routes(analysis)).toContain('/blog/:slug');
    expect(endpoints(analysis)).toContain('POST /api/lead');
    const pricing = analysis.routes.find((r) => r.route === '/pricing')!;
    expect(pricing.detector).toBe('pages-directory');
    // The evidence cites apps/marketing's OWN Next signal, not a sibling's.
    expect(pricing.evidence).toMatch(
      /Next\.js \(found apps\/marketing\/next\.config\.mjs\).*path under pages\/ is the URL/,
    );
  });

  it('does NOT read the React Router workspace’s pages/ tree as URLs', () => {
    for (const invented of ['/Dashboard', '/billing/InvoicesTab', '/billing/PlanTab']) {
      expect(routes(analysis)).not.toContain(invented);
    }
    // And the routes it does have there came from the table, not the tree.
    expect(routes(analysis)).toContain('/console');
    expect(routes(analysis)).toContain('/console/billing');
    expect(analysis.routes.find((r) => r.route === '/console')!.detector).toBe('react-router');
  });

  it('refuses per package, and says which package it is refusing for', () => {
    const report = detector(analysis, 'pages-directory');
    // Four files claimed in apps/marketing (three pages and one api handler),
    // three refused in apps/console.
    expect(report.filesExamined).toBe(7);
    expect(report.found).toBe(4);
    expect(report.blocked).toMatch(/^3 files sit under a pages\/ directory, but apps\/console declares/);
    expect(report.blocked).toMatch(/react-router-dom in dependencies \(apps\/console\/package\.json\)/);
    expect(report.blocked).toMatch(/a file in apps\/console's pages\/ tree is a component, not a URL/);
    // The refusal must not speak for the repository, and must not name the
    // neighbour that is the reason the old global verdict got this wrong.
    expect(report.blocked).not.toMatch(/this repo declares/);
    expect(report.blocked).not.toMatch(/Next\.js/);
    expect(report.blocked).not.toMatch(/apps\/marketing/);
  });

  it('puts the per-package refusal in the summary even though other packages did yield routes', () => {
    // The old condition waited for the detector's total to be zero, which in a
    // monorepo is exactly when the mixed answer is most worth reading.
    expect(analysis.notes.some((n) => n.includes("apps/console's pages/ tree"))).toBe(true);
  });

  it('never lets one workspace’s dependency answer for another', () => {
    for (const route of analysis.routes) {
      const fromMarketing = route.file.startsWith('apps/marketing/');
      if (route.detector === 'pages-directory') expect(fromMarketing).toBe(true);
      if (fromMarketing) expect(route.evidence).not.toMatch(/React Router/);
      else expect(route.evidence).not.toMatch(/Next\.js/);
    }
  });
});

describe('the sentence a refusal ends on', () => {
  it('names a detector id that exists, so the reader can go and read it', () => {
    const analysis = analyseCodebase(MIXED_MONOREPO);
    const blocked = detector(analysis, 'pages-directory').blocked!;
    const named = /see the (\S+) detector/.exec(blocked)?.[1];
    expect(named).toBe('react-router');
    expect(SOURCE_DETECTORS as readonly string[]).toContain(named);
    // The old sentence said "see the React Router detector" — a label, not an id.
    expect(blocked).not.toMatch(/see the React Router detector/);
  });

  it('does not promise a reading for a router this pass cannot read', () => {
    const analysis = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { '@tanstack/react-router': '^1.0.0' } })),
      f('src/pages/Dashboard.tsx', 'export default function Dashboard() { return null; }'),
    ]);
    expect(analysis.routes).toEqual([]);
    const blocked = detector(analysis, 'pages-directory').blocked!;
    expect(blocked).toMatch(/TanStack Router/);
    expect(blocked).toMatch(/no detector for TanStack Router, so its route table was not read/);
    expect(blocked).not.toMatch(/see the .* detector/);
  });

  it('every detector a refusal points at is one this module publishes', () => {
    for (const fixture of [MIXED_MONOREPO, REACT_ROUTER_SPA, VUE_APP]) {
      for (const report of analyseCodebase(fixture).detectors) {
        for (const m of (report.blocked ?? '').matchAll(/see the (\S+) detector/g)) {
          expect(SOURCE_DETECTORS as readonly string[]).toContain(m[1]);
        }
      }
    }
  });
});

// ─── The auth vocabulary, on names a real application actually uses ──────────

describe('what a path has to say before it is called a session surface', () => {
  const GYM_SPA: RepoFile[] = [
    f('package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.26.0' } })),
    f(
      'src/routes.tsx',
      `import { Routes, Route } from "react-router-dom";
       export const AppRoutes = () => (
         <Routes>
           <Route path="/portal/:gymId/member/training-sessions" element={<TrainingSessions />} />
           <Route path="/portal/:gymId/member/session-notes" element={<SessionNotes />} />
           <Route path="/portal/:gymId/staff/refresh-schedule" element={<RefreshSchedule />} />
           <Route path="/portal/:gymId/trainer/SessionPlanner" element={<SessionPlanner />} />
           <Route path="/auth/login" element={<Login />} />
         </Routes>
       );`,
    ),
  ];

  const analysis = analyseCodebase(GYM_SPA);

  it('does not read a booking screen as an authentication surface', () => {
    // Each of these matched `session`/`sessions`/`refresh` as a WORD inside a
    // hyphenated or camel-cased segment, and each produced a critical-path test
    // titled "a session outlives a reload" against a page about gym classes.
    const paths = analysis.authSurfaces.map((s) => s.path);
    expect(paths).not.toContain('/portal/:gymId/member/training-sessions');
    expect(paths).not.toContain('/portal/:gymId/member/session-notes');
    expect(paths).not.toContain('/portal/:gymId/staff/refresh-schedule');
    expect(paths).not.toContain('/portal/:gymId/trainer/SessionPlanner');
    expect(analysis.authSurfaces.filter((s) => s.kind === 'SESSION')).toEqual([]);
    // The one real auth surface in the file is still found.
    expect(analysis.authSurfaces.map((s) => `${s.kind} ${s.path}`)).toEqual(['LOGIN /auth/login']);
  });

  it('still reads the session exchange the entry exists for', () => {
    const sessions = analyseCodebase([
      f('package.json', JSON.stringify({ dependencies: { express: '^4.19.0' } })),
      f(
        'src/routes/session.js',
        `const { Router } = require('express');
         const router = Router();
         router.post('/sessions', create);
         router.delete('/session', destroy);
         router.post('/auth/refresh', rotate);
         router.post('/refresh-token', exchange);
         module.exports = router;`,
      ),
    ]);
    const auth = sessions.authSurfaces.map((s) => `${s.kind} ${s.path}`);
    expect(auth).toContain('SESSION /sessions');
    expect(auth).toContain('SESSION /session');
    expect(auth).toContain('SESSION /auth/refresh');
    expect(auth).toContain('SESSION /refresh-token');
  });
});

describe('the evidence on a surface identified by its filename', () => {
  it('describes the filename, not the path the surface sits at', () => {
    const analysis = analyseCodebase(NEXT_APP);
    const surface = analysis.authSurfaces.find(
      (s) => s.from === 'form' && s.file === 'components/LoginForm.tsx',
    )!;
    // The form posts to /api/auth/session, so the surface's own path names no
    // sign-in at all. Reusing the vocabulary's "the path names a sign-in" here
    // described a path that does not say that.
    expect(surface.path).toBe('/api/auth/session');
    expect(surface.kind).toBe('LOGIN');
    expect(surface.evidence).toMatch(/its filename names a sign-in/);
    expect(surface.evidence).not.toMatch(/the path names/);
  });

  it('still says "the path names …" when it really was the path', () => {
    const analysis = analyseCodebase(EXPRESS_API);
    const login = analysis.authSurfaces.find((s) => s.path === '/login')!;
    expect(login.evidence).toMatch(/^POST \/login — the path names a sign-in$/);
  });
});

describe('a sibling workspace does not speak for you', () => {
  /*
   * The scoping fix ended in a union of the whole upload, which quietly put the
   * original defect back one level up: a workspace whose own manifest named no
   * router inherited every OTHER workspace's. A sibling is not an ancestor.
   */
  const files: RepoFile[] = [
    { path: 'package.json', content: '{"name":"root","private":true}' },
    // Names a code-declared router. Its own pages/ must be refused.
    {
      path: 'apps/console/package.json',
      content: '{"name":"console","dependencies":{"react-router-dom":"^6.0.0"}}',
    },
    { path: 'apps/console/src/pages/Dashboard.tsx', content: 'export default () => null;' },
    // Names NOTHING. It must not inherit console's verdict in either direction.
    { path: 'apps/legacy/package.json', content: '{"name":"legacy","dependencies":{"lodash":"^4"}}' },
    { path: 'apps/legacy/pages/reports.tsx', content: 'export default () => null;' },
  ];

  it('refuses the workspace that declares its routes in code', () => {
    const routes = analyseCodebase(files).routes.map((r) => r.route);
    expect(routes).not.toContain('/Dashboard');
  });

  it('does not let that refusal reach a workspace which named no router', () => {
    // `apps/legacy` said nothing, so nothing is known about it — and "unknown"
    // is the permissive answer, the same one a paths-only upload gets. What it
    // must NOT be is an answer borrowed from the workspace next door.
    const analysis = analyseCodebase(files);
    expect(analysis.routes.map((r) => r.route)).toContain('/reports');
  });

  it('names the workspace it refused, never the repo', () => {
    const report = analyseCodebase(files).detectors.find((d) => d.id === 'pages-directory');
    expect(report?.blocked ?? '').toContain('apps/console');
    expect(report?.blocked ?? '').not.toContain('this repo declares');
  });
});

describe('token is only a session token in the right company', () => {
  const surfacesFor = (route: string) =>
    analyseCodebase([
      { path: 'package.json', content: '{"dependencies":{"next":"^14"}}' },
      { path: `pages${route}.tsx`, content: 'export default () => null;' },
    ]).authSurfaces;

  it.each(['/notifications/push-token', '/devices/device-token', '/messaging/fcm-token'])(
    '%s is not an authentication surface',
    (route) => {
      // Each of these would have produced a test titled "a session outlives a
      // reload" pointed at a notification endpoint.
      expect(surfacesFor(route)).toHaveLength(0);
    },
  );

  it.each(['/auth/refresh-token', '/auth/access-token'])('%s still is', (route) => {
    expect(surfacesFor(route).map((s) => s.kind)).toContain('SESSION');
  });
});
