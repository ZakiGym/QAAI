/**
 * Server-rendered markup for the demo store.
 *
 * Written to be *realistically* accessible rather than perfectly so: labelled
 * inputs and named buttons (which is what the Explorer's role/label selectors
 * key off), but with a couple of genuine axe violations left in — the low
 * contrast footer and the icon-only search button — so the accessibility
 * runner has something true to report on a first run.
 */

import { formatMoney, type CartLine, type Order, type Product } from './store.js';

function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const STYLES = `
  :root { --ink:#16181d; --muted:#5b6472; --line:#e3e6ea; --accent:#1f6feb; --bg:#fbfcfd; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         color:var(--ink); background:var(--bg); }
  header { border-bottom:1px solid var(--line); background:#fff; }
  .bar { max-width:960px; margin:0 auto; padding:14px 20px; display:flex; gap:20px; align-items:center; }
  .bar a { color:var(--ink); text-decoration:none; font-weight:500; }
  .bar a:hover { color:var(--accent); }
  .brand { font-weight:700; font-size:18px; margin-right:auto; }
  main { max-width:960px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:26px; margin:0 0 4px; }
  h2 { font-size:19px; margin:28px 0 10px; }
  .sub { color:var(--muted); margin:0 0 22px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:16px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px; }
  .price { font-weight:600; font-size:17px; }
  .oos { color:#b42318; font-size:14px; font-weight:500; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line);
          border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:11px 14px; border-bottom:1px solid var(--line); }
  th { background:#f5f7f9; font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  tr:last-child td { border-bottom:none; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  label { display:block; font-weight:500; margin:12px 0 5px; }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:7px;
                  font-size:15px; background:#fff; }
  button { background:var(--accent); color:#fff; border:0; border-radius:7px; padding:10px 16px;
           font-size:15px; font-weight:500; cursor:pointer; }
  button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }
  form.inline { display:inline; }
  .totals { max-width:340px; margin-left:auto; }
  .totals div { display:flex; justify-content:space-between; padding:6px 0; }
  .totals .grand { border-top:2px solid var(--ink); margin-top:8px; padding-top:10px;
                   font-weight:700; font-size:18px; }
  .flash { background:#eef5ff; border:1px solid #cfe0ff; border-radius:8px; padding:11px 14px; margin-bottom:18px; }
  .flash.err { background:#fef3f2; border-color:#fecdc9; color:#912018; }
  /* Deliberate axe finding: 2.1:1 contrast, below the 4.5:1 AA threshold. */
  footer { max-width:960px; margin:0 auto; padding:22px 20px; color:#c9ced6; font-size:13px; }
  .empty { color:var(--muted); background:#fff; border:1px dashed var(--line);
           border-radius:10px; padding:34px; text-align:center; }
`;

export function layout(opts: {
  title: string;
  body: string;
  cartCount: number;
  user: { name: string; role: string } | null;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} — Ground Coffee Co.</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <nav class="bar" aria-label="Main">
    <a class="brand" href="/">Ground Coffee Co.</a>
    <a href="/products">Products</a>
    <a href="/cart">Cart (${opts.cartCount})</a>
    ${
      opts.user
        ? `${opts.user.role === 'admin' ? '<a href="/admin">Admin</a>' : ''}
           <a href="/account">${esc(opts.user.name)}</a>
           <form class="inline" method="post" action="/logout">
             <button class="secondary" type="submit">Sign out</button>
           </form>`
        : '<a href="/login">Sign in</a>'
    }
  </nav>
</header>
<main>${opts.body}</main>
<footer>Demo storefront for QAAI. No real orders are placed and no payment is taken.</footer>
</body>
</html>`;
}

export function flash(message: string | null, kind: 'info' | 'err' = 'info'): string {
  if (!message) return '';
  return `<p class="flash ${kind === 'err' ? 'err' : ''}" role="${
    kind === 'err' ? 'alert' : 'status'
  }">${esc(message)}</p>`;
}

export function homePage(): string {
  return `
<h1>Coffee gear that earns its counter space</h1>
<p class="sub">A small catalogue of brewing equipment, for testing purposes.</p>
<p><a href="/products"><button type="button">Browse products</button></a></p>
<h2>Why shop here</h2>
<ul>
  <li>Free shipping on orders over $150.</li>
  <li>Thirty-day returns on unopened equipment.</li>
  <li>Beans roasted the week they ship.</li>
</ul>`;
}

export function productsPage(products: Product[], query: string): string {
  const cards = products
    .map(
      (p) => `
  <article class="card" data-testid="product-${esc(p.id)}">
    <h3><a href="/products/${esc(p.id)}">${esc(p.name)}</a></h3>
    <p class="sub">${esc(p.description)}</p>
    <p class="price">${formatMoney(p.priceCents)}</p>
    ${
      p.stock > 0
        ? `<form method="post" action="/cart/add">
             <input type="hidden" name="productId" value="${esc(p.id)}">
             <input type="hidden" name="quantity" value="1">
             <button type="submit">Add ${esc(p.name)} to cart</button>
           </form>`
        : '<p class="oos">Out of stock</p>'
    }
  </article>`,
    )
    .join('');

  return `
<h1>Products</h1>
<p class="sub">${products.length} item${products.length === 1 ? '' : 's'}</p>
<form method="get" action="/products" role="search">
  <label for="q">Search products</label>
  <input id="q" name="q" type="search" value="${esc(query)}" placeholder="e.g. grinder">
  <!-- Deliberate axe finding: icon-only control with no accessible name. -->
  <button type="submit" aria-hidden="true">🔍</button>
</form>
<div class="grid">${cards || '<p class="empty">No products match that search.</p>'}</div>`;
}

export function productPage(p: Product): string {
  return `
<h1>${esc(p.name)}</h1>
<p class="sub">${esc(p.category)}</p>
<p>${esc(p.description)}</p>
<p class="price" data-testid="product-price">${formatMoney(p.priceCents)}</p>
${
  p.stock > 0
    ? `<form method="post" action="/cart/add">
         <label for="quantity">Quantity</label>
         <input id="quantity" name="quantity" type="number" value="1" min="1" max="${p.stock}">
         <input type="hidden" name="productId" value="${esc(p.id)}">
         <p><button type="submit">Add to cart</button></p>
       </form>`
    : '<p class="oos">Out of stock</p>'
}
<p><a href="/products">Back to products</a></p>`;
}

export function cartPage(
  lines: Array<CartLine & { product: Product }>,
  totals: { subtotal: number; shipping: number; tax: number; total: number },
): string {
  if (lines.length === 0) {
    return `<h1>Your cart</h1>
      <p class="empty">Your cart is empty. <a href="/products">Browse products</a>.</p>`;
  }

  const rows = lines
    .map(
      (l) => `
  <tr data-testid="cart-line-${esc(l.productId)}">
    <td>${esc(l.product.name)}</td>
    <td class="num">${formatMoney(l.product.priceCents)}</td>
    <td class="num">${l.quantity}</td>
    <td class="num">${formatMoney(l.product.priceCents * l.quantity)}</td>
    <td>
      <form class="inline" method="post" action="/cart/remove">
        <input type="hidden" name="productId" value="${esc(l.productId)}">
        <button class="secondary" type="submit">Remove ${esc(l.product.name)}</button>
      </form>
    </td>
  </tr>`,
    )
    .join('');

  return `
<h1>Your cart</h1>
<table>
  <caption class="sub">Items in your cart</caption>
  <thead><tr>
    <th scope="col">Item</th><th scope="col" class="num">Price</th>
    <th scope="col" class="num">Qty</th><th scope="col" class="num">Line total</th>
    <th scope="col">Actions</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${totalsBlock(totals)}
<p><a href="/checkout"><button type="button">Proceed to checkout</button></a></p>`;
}

export function totalsBlock(t: {
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
}): string {
  return `
<div class="totals">
  <div><span>Subtotal</span><span data-testid="subtotal">${formatMoney(t.subtotal)}</span></div>
  <div><span>Shipping</span><span data-testid="shipping">${formatMoney(t.shipping)}</span></div>
  <div><span>Tax</span><span data-testid="tax">${formatMoney(t.tax)}</span></div>
  <div class="grand"><span>Order total</span><span data-testid="order-total">${formatMoney(
    t.total,
  )}</span></div>
</div>`;
}

export function checkoutPage(
  totals: { subtotal: number; shipping: number; tax: number; total: number },
  email: string,
): string {
  return `
<h1>Checkout</h1>
<p class="sub">No payment is taken — this is a demo storefront.</p>
${totalsBlock(totals)}
<form method="post" action="/checkout">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" value="${esc(email)}" required autocomplete="email">

  <label for="fullName">Full name</label>
  <input id="fullName" name="fullName" type="text" required autocomplete="name">

  <label for="address">Street address</label>
  <input id="address" name="address" type="text" required autocomplete="street-address">

  <label for="city">City</label>
  <input id="city" name="city" type="text" required autocomplete="address-level2">

  <label for="postalCode">Postal code</label>
  <input id="postalCode" name="postalCode" type="text" required autocomplete="postal-code">

  <label for="cardNumber">Card number</label>
  <input id="cardNumber" name="cardNumber" type="text" required inputmode="numeric"
         placeholder="4242 4242 4242 4242" autocomplete="cc-number">

  <p><button type="submit">Place order</button></p>
</form>`;
}

export function orderConfirmationPage(order: Order): string {
  const rows = order.lines
    .map(
      (l) => `<tr>
        <td>${esc(l.name)}</td>
        <td class="num">${l.quantity}</td>
        <td class="num">${formatMoney(l.priceCents * l.quantity)}</td>
      </tr>`,
    )
    .join('');

  return `
<h1>Order confirmed</h1>
<p class="sub">Order <strong data-testid="order-id">${esc(order.id)}</strong> — a receipt is on
   its way to ${esc(order.email)}.</p>
<table>
  <caption class="sub">Order contents</caption>
  <thead><tr>
    <th scope="col">Item</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Line total</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${totalsBlock({
  subtotal: order.subtotalCents,
  shipping: order.shippingCents,
  tax: order.taxCents,
  total: order.totalCents,
})}
<p><a href="/products">Continue shopping</a></p>`;
}

export function loginPage(error: string | null, next: string): string {
  return `
<h1>Sign in</h1>
${flash(error, 'err')}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" required autocomplete="email">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password">
  <p><button type="submit">Sign in</button></p>
</form>
<h2>Or use a one-time code</h2>
<form method="post" action="/login/otp/request">
  <label for="otpEmail">Email address</label>
  <input id="otpEmail" name="email" type="email" required>
  <p><button class="secondary" type="submit">Email me a code</button></p>
</form>`;
}

export function otpPage(email: string, error: string | null): string {
  return `
<h1>Enter your code</h1>
<p class="sub">We sent a six-digit code to ${esc(email)}. It expires in ten minutes.</p>
${flash(error, 'err')}
<form method="post" action="/login/otp/verify">
  <input type="hidden" name="email" value="${esc(email)}">
  <label for="code">One-time code</label>
  <input id="code" name="code" type="text" inputmode="numeric" required autocomplete="one-time-code">
  <p><button type="submit">Verify code</button></p>
</form>`;
}

export function accountPage(user: { name: string; email: string }, orders: Order[]): string {
  const rows = orders
    .map(
      (o) => `<tr>
        <td><a href="/orders/${esc(o.id)}">${esc(o.id)}</a></td>
        <td>${esc(new Date(o.placedAt).toLocaleDateString('en-US'))}</td>
        <td class="num">${formatMoney(o.totalCents)}</td>
      </tr>`,
    )
    .join('');

  return `
<h1>${esc(user.name)}</h1>
<p class="sub">${esc(user.email)}</p>
<h2>Order history</h2>
${
  orders.length
    ? `<table>
         <thead><tr>
           <th scope="col">Order</th><th scope="col">Placed</th><th scope="col" class="num">Total</th>
         </tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : '<p class="empty">No orders yet.</p>'
}`;
}

export function adminPage(orders: Order[], products: Product[]): string {
  const orderRows = orders
    .map(
      (o) => `<tr>
        <td><a href="/orders/${esc(o.id)}">${esc(o.id)}</a></td>
        <td>${esc(o.email)}</td>
        <td class="num">${o.lines.length}</td>
        <td class="num">${formatMoney(o.totalCents)}</td>
      </tr>`,
    )
    .join('');

  const stockRows = products
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td>
        <td class="num">${p.stock}</td>
        <td class="num">${formatMoney(p.priceCents)}</td>
      </tr>`,
    )
    .join('');

  return `
<h1>Admin</h1>
<p class="sub">Staff-only view. Reachable at /admin.</p>
<h2>Orders (${orders.length})</h2>
${
  orders.length
    ? `<table><thead><tr>
        <th scope="col">Order</th><th scope="col">Customer</th>
        <th scope="col" class="num">Lines</th><th scope="col" class="num">Total</th>
       </tr></thead><tbody>${orderRows}</tbody></table>`
    : '<p class="empty">No orders yet.</p>'
}
<h2>Inventory</h2>
<table><thead><tr>
  <th scope="col">Product</th><th scope="col" class="num">Stock</th><th scope="col" class="num">Price</th>
</tr></thead><tbody>${stockRows}</tbody></table>`;
}

export function notFoundPage(): string {
  return `<h1>Page not found</h1>
    <p class="sub">That page does not exist. <a href="/products">Back to products</a>.</p>`;
}
