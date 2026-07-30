/**
 * In-memory data + business logic for the demo store.
 *
 * Kept separate from the HTTP layer so the planted bug lives in exactly one
 * function — `orderTotalCents` — which is what makes the DoD walkthrough
 * reproducible: flip DEMO_PLANTED_BUG and the same generated test flips verdict.
 */

export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  stock: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface Order {
  id: string;
  email: string;
  lines: Array<{ productId: string; name: string; quantity: number; priceCents: number }>;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  placedAt: string;
}

export interface DemoUser {
  email: string;
  password: string;
  name: string;
  role: 'customer' | 'admin';
  /** Base32 TOTP seed, so the Email/OTP and MFA auth profiles have something real to drive. */
  totpSeed?: string;
}

export const PRODUCTS: Product[] = [
  {
    id: 'kettle-01',
    name: 'Gooseneck Kettle',
    description: 'Variable-temperature pour-over kettle with a 1L capacity.',
    priceCents: 8900,
    category: 'Brewing',
    stock: 12,
  },
  {
    id: 'grinder-02',
    name: 'Burr Grinder',
    description: '40mm conical burrs, 30 grind settings, stepless adjustment.',
    priceCents: 14900,
    category: 'Brewing',
    stock: 5,
  },
  {
    id: 'scale-03',
    name: 'Brew Scale',
    description: '0.1g resolution with a built-in timer and auto-tare.',
    priceCents: 4500,
    category: 'Brewing',
    stock: 30,
  },
  {
    id: 'beans-04',
    name: 'Single Origin — Yirgacheffe',
    description: '250g, washed, notes of bergamot and stone fruit.',
    priceCents: 1800,
    category: 'Coffee',
    stock: 100,
  },
  {
    id: 'mug-05',
    name: 'Walled Tasting Mug',
    description: 'Double-walled borosilicate, 200ml.',
    priceCents: 2200,
    category: 'Accessories',
    stock: 0, // deliberately out of stock — an edge case worth a generated test
  },
];

export const USERS: DemoUser[] = [
  {
    email: 'ada@example.com',
    password: 'correct-horse-battery',
    name: 'Ada Lovelace',
    role: 'customer',
    totpSeed: 'JBSWY3DPEHPK3PXP',
  },
  {
    email: 'admin@example.com',
    password: 'admin-hunter2-hunter2',
    name: 'Grace Hopper',
    role: 'admin',
  },
];

export const SHIPPING_CENTS = 700;
export const TAX_RATE = 0.08;

/** Free shipping over this threshold — a rule worth its own generated test. */
export const FREE_SHIPPING_THRESHOLD_CENTS = 15000;

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function subtotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => {
    const product = findProduct(line.productId);
    return product ? sum + product.priceCents * line.quantity : sum;
  }, 0);
}

export function shippingFor(subtotal: number): number {
  return subtotal >= FREE_SHIPPING_THRESHOLD_CENTS || subtotal === 0 ? 0 : SHIPPING_CENTS;
}

export function taxCents(subtotal: number): number {
  return Math.round(subtotal * TAX_RATE);
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PLANTED BUG (DoD §12.2)
 * ─────────────────────────────────────────────────────────────────────────────
 * With DEMO_PLANTED_BUG=true and two or more distinct line items, the order
 * total silently drops the cheapest line. Everything else on the page — the
 * per-line prices, the subtotal, the tax — stays correct, so only an assertion
 * that checks *meaning* ("total equals subtotal + shipping + tax") catches it.
 * A pixel diff or a "page loaded" smoke check sails straight past.
 *
 * That is the point: it is the class of bug QAAI claims to find.
 */
export function orderTotalCents(lines: CartLine[], plantedBugEnabled: boolean): number {
  const subtotal = subtotalCents(lines);
  const shipping = shippingFor(subtotal);
  const tax = taxCents(subtotal);
  const correctTotal = subtotal + shipping + tax;

  if (!plantedBugEnabled || lines.length < 2) return correctTotal;

  const cheapestLineCents = Math.min(
    ...lines.map((line) => {
      const product = findProduct(line.productId);
      return product ? product.priceCents * line.quantity : Number.POSITIVE_INFINITY;
    }),
  );
  return correctTotal - cheapestLineCents;
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Mutable state (per process; reset by the /__reset test hook) ────────────

export interface DemoState {
  carts: Map<string, CartLine[]>;
  orders: Order[];
  sessions: Map<string, string>; // sessionId → email
  /** Pending one-time codes for the email/OTP flow, keyed by email. */
  otps: Map<string, { code: string; expiresAt: number }>;
  orderSeq: number;
}

export function freshState(): DemoState {
  return { carts: new Map(), orders: [], sessions: new Map(), otps: new Map(), orderSeq: 1000 };
}
