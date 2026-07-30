import Link from 'next/link';

/**
 * Landing page (§10). The three things a QA lead needs to believe in the first
 * ten seconds: it finds real bugs, it tells you why, and you keep the code.
 */

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    tagline: 'The hook',
    features: ['1 project', '100 E2E runs/mo', 'Community support'],
  },
  {
    name: 'Team',
    price: '$349',
    tagline: 'Unlimited CI runs — no credit model',
    features: ['3 projects', 'Unlimited CI runs', 'All test types', '5 parallel workers'],
    highlight: true,
  },
  {
    name: 'Business',
    price: '$999',
    tagline: 'For orgs with compliance needs',
    features: ['10 projects', '15 workers', 'SSO', 'Audit log', 'Priority support'],
  },
  {
    name: 'Enterprise',
    price: 'Contact',
    tagline: 'On-prem runners, custom retention',
    features: ['SSO / SAML', 'On-prem runner agents', 'Custom retention', 'DPA'],
  },
];

const VERDICTS = [
  { name: 'REAL_BUG', copy: 'The app is wrong. Evidence attached, bug filed in one click.' },
  {
    name: 'INTENDED_CHANGE',
    copy: 'You changed it on purpose. Here is the exact diff to fix the test.',
  },
  { name: 'FLAKE', copy: 'The test is unreliable, not your app. Quarantined, still running.' },
  { name: 'ENV_ISSUE', copy: 'The environment broke. Not your code, not your test.' },
];

export default function LandingPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <nav className="mb-20 flex items-center gap-6 text-sm">
        <span className="mr-auto text-base font-semibold tracking-tight">QAAI</span>
        <a href="#how" className="text-ink-dim hover:text-ink">
          How it works
        </a>
        <a href="#pricing" className="text-ink-dim hover:text-ink">
          Pricing
        </a>
        <Link
          href="/login"
          className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90"
        >
          Sign in
        </Link>
      </nav>

      <section className="mb-24">
        <h1 className="max-w-3xl text-5xl leading-[1.05] font-semibold tracking-tight">
          Your AI QA engineer.
          <br />
          Every PR tested. Zero lock-in.
        </h1>
        <p className="text-ink-dim mt-6 max-w-2xl text-lg">
          QAAI explores your app, proposes a test plan in plain English, writes the tests as
          standard code you own, and tells you <em>why</em> each failure happened — with evidence.
        </p>
        <div className="mt-8 flex gap-3">
          <Link
            href="/login"
            className="rounded-md bg-accent px-5 py-2.5 font-medium text-white hover:opacity-90"
          >
            Open the cockpit
          </Link>
          <a
            href="#how"
            className="border-line hover:bg-surface-1 rounded-md border px-5 py-2.5 font-medium"
          >
            See a verdict
          </a>
        </div>
      </section>

      <section id="how" className="mb-24">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight">It never silently self-heals</h2>
        <p className="text-ink-dim mb-8 max-w-2xl">
          Every failure gets a verdict, a confidence score, and evidence you can check. What happens
          next is your call — not the model&rsquo;s.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {VERDICTS.map((v) => (
            <div key={v.name} className="border-line bg-surface-1 rounded-lg border p-5">
              <code className="font-mono text-sm font-semibold">{v.name}</code>
              <p className="text-ink-dim mt-2 text-sm">{v.copy}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-line bg-surface-1 mb-24 rounded-lg border p-8">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight">
          Already have a Cypress or Selenium suite?
        </h2>
        <p className="text-ink-dim max-w-2xl">
          Upload it. QAAI converts it to Playwright, maps it against the flows it discovered, and
          reports the coverage you gained. Everything it writes is standard code in your language —
          export it back any time. There is nothing to be locked into.
        </p>
      </section>

      <section id="pricing" className="mb-24">
        <h2 className="mb-8 text-2xl font-semibold tracking-tight">Pricing</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`rounded-lg border p-5 ${
                plan.highlight ? 'border-accent bg-surface-1' : 'border-line'
              }`}
            >
              <h3 className="font-semibold">{plan.name}</h3>
              <p className="mt-1 text-2xl font-semibold tracking-tight">
                {plan.price}
                {plan.price.startsWith('$') && plan.price !== '$0' && (
                  <span className="text-ink-faint text-sm font-normal">/mo</span>
                )}
              </p>
              <p className="text-ink-faint mt-1 text-xs">{plan.tagline}</p>
              <ul className="text-ink-dim mt-4 space-y-1.5 text-sm">
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-line text-ink-faint border-t pt-8 text-sm">
        QAAI — the AI QA engineer. Everything it writes is standard code you own.
      </footer>
    </main>
  );
}
