/**
 * The bundled demo store (apps/demo).
 *
 * This is the app QAAI explores during onboarding and the app its own dogfood
 * suite runs against. It is deliberately small, server-rendered, and free of a
 * build step so `docker compose up` brings it online instantly.
 *
 * Two things in here are intentional and should not be "fixed":
 *   1. `orderTotalCents` carries the planted checkout bug (see store.ts).
 *   2. `GET /orders/:id` has no ownership check — an IDOR for the security
 *      smoke runner to find. It is marked inline.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Mailbox, startSmtpCatcher } from './mailbox.js';
import {
  PRODUCTS,
  USERS,
  findProduct,
  formatMoney,
  freshState,
  orderTotalCents,
  shippingFor,
  subtotalCents,
  taxCents,
  type CartLine,
  type DemoState,
} from './store.js';
import {
  accountPage,
  adminPage,
  cartPage,
  checkoutPage,
  flash,
  homePage,
  layout,
  loginPage,
  notFoundPage,
  orderConfirmationPage,
  otpPage,
  productPage,
  productsPage,
} from './views.js';

const PORT = Number(process.env.DEMO_PORT ?? 5050);
const SMTP_PORT = Number(process.env.DEMO_SMTP_PORT ?? 5051);
const PLANTED_BUG = process.env.DEMO_PLANTED_BUG !== 'false';

const app = express();
const mailbox = new Mailbox();
let state: DemoState = freshState();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.disable('x-powered-by');

// ─── Session handling ────────────────────────────────────────────────────────

const SESSION_COOKIE = 'demo_sid';

declare module 'express-serve-static-core' {
  interface Request {
    sessionId: string;
    demoUser: (typeof USERS)[number] | null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies[SESSION_COOKIE];
  if (!sid) {
    sid = randomUUID();
    // Lax rather than Strict: the checkout POST is same-site, but a magic-link
    // click arrives as a cross-site top-level navigation and must keep the cart.
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  req.sessionId = sid;

  const email = state.sessions.get(sid);
  req.demoUser = email ? (USERS.find((u) => u.email === email) ?? null) : null;
  next();
});

function cartFor(sid: string): CartLine[] {
  return state.carts.get(sid) ?? [];
}

function render(req: Request, title: string, body: string): string {
  return layout({
    title,
    body,
    cartCount: cartFor(req.sessionId).reduce((n, l) => n + l.quantity, 0),
    user: req.demoUser ? { name: req.demoUser.name, role: req.demoUser.role } : null,
  });
}

function totalsFor(lines: CartLine[]) {
  const subtotal = subtotalCents(lines);
  return {
    subtotal,
    shipping: shippingFor(subtotal),
    tax: taxCents(subtotal),
    total: orderTotalCents(lines, PLANTED_BUG),
  };
}

// ─── Storefront ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.type('html').send(render(req, 'Home', homePage()));
});

app.get('/products', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? PRODUCTS.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.description.toLowerCase().includes(needle) ||
          p.category.toLowerCase().includes(needle),
      )
    : PRODUCTS;
  res.type('html').send(render(req, 'Products', productsPage(matches, query)));
});

app.get('/products/:id', (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) {
    res
      .status(404)
      .type('html')
      .send(render(req, 'Not found', notFoundPage()));
    return;
  }
  res.type('html').send(render(req, product.name, productPage(product)));
});

app.post('/cart/add', (req, res) => {
  const productId = String(req.body.productId ?? '');
  const quantity = Math.max(1, Number.parseInt(String(req.body.quantity ?? '1'), 10) || 1);
  const product = findProduct(productId);

  if (!product || product.stock <= 0) {
    res
      .status(400)
      .type('html')
      .send(render(req, 'Cart', flash('That product is unavailable.', 'err') + cartPageFor(req)));
    return;
  }

  const lines = cartFor(req.sessionId);
  const existing = lines.find((l) => l.productId === productId);
  if (existing) existing.quantity = Math.min(product.stock, existing.quantity + quantity);
  else lines.push({ productId, quantity: Math.min(product.stock, quantity) });

  state.carts.set(req.sessionId, lines);
  res.redirect(303, '/cart');
});

app.post('/cart/remove', (req, res) => {
  const productId = String(req.body.productId ?? '');
  state.carts.set(
    req.sessionId,
    cartFor(req.sessionId).filter((l) => l.productId !== productId),
  );
  res.redirect(303, '/cart');
});

function cartPageFor(req: Request): string {
  const lines = cartFor(req.sessionId)
    .map((l) => ({ ...l, product: findProduct(l.productId)! }))
    .filter((l) => l.product);
  return cartPage(lines, totalsFor(cartFor(req.sessionId)));
}

app.get('/cart', (req, res) => {
  res.type('html').send(render(req, 'Cart', cartPageFor(req)));
});

// ─── Checkout ────────────────────────────────────────────────────────────────

app.get('/checkout', (req, res) => {
  const lines = cartFor(req.sessionId);
  if (lines.length === 0) {
    res.redirect(303, '/cart');
    return;
  }
  res
    .type('html')
    .send(render(req, 'Checkout', checkoutPage(totalsFor(lines), req.demoUser?.email ?? '')));
});

app.post('/checkout', (req, res) => {
  const lines = cartFor(req.sessionId);
  if (lines.length === 0) {
    res.redirect(303, '/cart');
    return;
  }

  const email = String(req.body.email ?? '').trim();
  const required = ['email', 'fullName', 'address', 'city', 'postalCode', 'cardNumber'];
  const missing = required.filter((f) => !String(req.body[f] ?? '').trim());
  if (missing.length > 0) {
    res
      .status(400)
      .type('html')
      .send(
        render(
          req,
          'Checkout',
          flash(`Missing required field: ${missing[0]}`, 'err') +
            checkoutPage(totalsFor(lines), email),
        ),
      );
    return;
  }

  const totals = totalsFor(lines);
  const order = {
    id: `ORD-${++state.orderSeq}`,
    email,
    lines: lines.map((l) => {
      const product = findProduct(l.productId)!;
      return {
        productId: l.productId,
        name: product.name,
        quantity: l.quantity,
        priceCents: product.priceCents,
      };
    }),
    subtotalCents: totals.subtotal,
    shippingCents: totals.shipping,
    taxCents: totals.tax,
    totalCents: totals.total,
    placedAt: new Date().toISOString(),
  };

  state.orders.push(order);
  state.carts.delete(req.sessionId);

  mailbox.add({
    to: email,
    from: 'orders@groundcoffee.example',
    subject: `Your order ${order.id}`,
    text: `Thanks for your order.\n\nOrder ${order.id}\nTotal: ${formatMoney(order.totalCents)}\n`,
    html: null,
  });

  res.redirect(303, `/orders/${order.id}`);
});

/**
 * SECURITY SMOKE TARGET — intentional IDOR.
 *
 * Any caller who guesses an order id can read someone else's order, including
 * the customer's email address. Order ids are sequential, so guessing is
 * trivial. Left in on purpose: §4's security-smoke runner probes exactly this
 * (an id in the URL, no ownership check) and should report it.
 */
app.get('/orders/:id', (req, res) => {
  const order = state.orders.find((o) => o.id === req.params.id);
  if (!order) {
    res
      .status(404)
      .type('html')
      .send(render(req, 'Not found', notFoundPage()));
    return;
  }
  res.type('html').send(render(req, `Order ${order.id}`, orderConfirmationPage(order)));
});

// ─── Auth ────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  const next = typeof req.query.next === 'string' ? req.query.next : '/account';
  res.type('html').send(render(req, 'Sign in', loginPage(null, next)));
});

app.post('/login', (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const password = String(req.body.password ?? '');
  const next = String(req.body.next ?? '/account');

  const user = USERS.find((u) => u.email.toLowerCase() === email && u.password === password);
  if (!user) {
    res
      .status(401)
      .type('html')
      .send(render(req, 'Sign in', loginPage('Email or password is incorrect.', next)));
    return;
  }

  state.sessions.set(req.sessionId, user.email);
  // Open-redirect guard: only same-origin paths are honoured.
  res.redirect(303, next.startsWith('/') && !next.startsWith('//') ? next : '/account');
});

app.post('/logout', (req, res) => {
  state.sessions.delete(req.sessionId);
  res.redirect(303, '/');
});

app.post('/login/otp/request', (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
  state.otps.set(email, { code, expiresAt: Date.now() + 10 * 60_000 });

  mailbox.add({
    to: email,
    from: 'no-reply@groundcoffee.example',
    subject: 'Your sign-in code',
    text: `Your one-time sign-in code is ${code}. It expires in 10 minutes.`,
    html: null,
  });

  res.type('html').send(render(req, 'Enter your code', otpPage(email, null)));
});

app.post('/login/otp/verify', (req, res) => {
  const email = String(req.body.email ?? '')
    .trim()
    .toLowerCase();
  const code = String(req.body.code ?? '').trim();
  const pending = state.otps.get(email);

  if (!pending || pending.code !== code || pending.expiresAt < Date.now()) {
    res
      .status(401)
      .type('html')
      .send(render(req, 'Enter your code', otpPage(email, 'That code is not valid.')));
    return;
  }

  state.otps.delete(email);
  const user = USERS.find((u) => u.email.toLowerCase() === email);
  if (!user) {
    res
      .status(401)
      .type('html')
      .send(render(req, 'Enter your code', otpPage(email, 'No account for that address.')));
    return;
  }

  state.sessions.set(req.sessionId, user.email);
  res.redirect(303, '/account');
});

function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!req.demoUser) {
    res.redirect(303, `/login?next=${encodeURIComponent(req.path)}`);
    return;
  }
  next();
}

app.get('/account', requireLogin, (req, res) => {
  const user = req.demoUser!;
  const orders = state.orders.filter((o) => o.email.toLowerCase() === user.email.toLowerCase());
  res.type('html').send(render(req, 'Account', accountPage(user, orders)));
});

// Properly gated, unlike /orders/:id — the security smoke runner should find
// nothing here, which is what makes its IDOR finding meaningful.
app.get('/admin', requireLogin, (req, res) => {
  if (req.demoUser!.role !== 'admin') {
    res
      .status(403)
      .type('html')
      .send(render(req, 'Forbidden', '<h1>Forbidden</h1>'));
    return;
  }
  res.type('html').send(render(req, 'Admin', adminPage(state.orders, PRODUCTS)));
});

// ─── Test hooks (§2 test data manager) ───────────────────────────────────────

app.get('/__health', (_req, res) => {
  res.json({ ok: true, plantedBug: PLANTED_BUG, orders: state.orders.length });
});

/** Mail catcher read API — how the runner completes magic-link and OTP flows. */
app.get('/__mail', (req, res) => {
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.json({ messages: mailbox.list(to) });
});

/** Wipes carts, orders, sessions, and mail. The per-run cleanup hook calls this. */
app.post('/__reset', (_req, res) => {
  state = freshState();
  mailbox.clear();
  res.json({ ok: true });
});

app.use((req, res) => {
  res
    .status(404)
    .type('html')
    .send(render(req, 'Not found', notFoundPage()));
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console -- this app has no logger by design
  console.log(
    `demo store on http://localhost:${PORT} (planted bug: ${PLANTED_BUG ? 'ON' : 'off'})`,
  );
});

const smtp = startSmtpCatcher(mailbox, SMTP_PORT);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    smtp.close(() => server.close(() => process.exit(0)));
  });
}
