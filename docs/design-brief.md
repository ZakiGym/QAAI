# QAAI — Design Brief

> **Paste everything below into a fresh Claude session.** It is written to be
> self-contained: it explains the product, the constraints, the exact design
> tokens already in code, every screen that exists today (with an honest note on
> what's weak), and every surface still missing. End with the deliverables list.

---

## THE ASK

You are designing **QAAI**, a macOS desktop application (Electron) that is an
**AI QA engineer**: it explores a web app, proposes a test plan a human approves,
writes real Playwright tests, runs them, and explains failures.

The app is functional but **designed by an engineer, not a designer**. The
layout, hierarchy, and visual language need your work. I want a coherent design
system and screen designs I can implement in Tailwind v4 + React.

Two things make this product's design unusual, and they are the heart of the
brief:

1. **It is two products in one shell.** Half of it is an *IDE* (a code editor,
   a file tree, a command palette — Cursor/VS Code language: dense, monospace,
   keyboard-first, chrome-less). The other half is an *analytics and review
   product* (dashboards, run reports, failure triage — dense-but-calm language:
   cards, charts, generous spacing). Right now both halves use the same flat dark
   panels and it reads as neither. **Resolving this tension is the primary design
   problem.**

2. **The product's core promise is trust in a machine's judgment.** An AI wrote
   this test. An AI decided this failure is a real bug, not a flake. An AI
   proposes changing this selector. Every one of those claims needs a visual
   language for **confidence, evidence, provenance, and undo** — a user must
   always be able to see *why* the machine believes something and disagree with
   it in one click. There is currently no such language. Inventing it is the
   second big ask.

---

## WHO IT'S FOR

- **Primary: a QA lead / QA engineer** at a 20–200 person software company. Lives
  in this app all day. Cares about: what broke, is it real, can I trust the
  suite, is the release safe to ship. Comfortable with code and a terminal.
- **Secondary: an engineer** who gets pulled in when a test blocks their PR. Visits
  rarely, needs to understand a failure in 30 seconds without a tutorial.
- **Tertiary: an engineering manager** who wants a weekly "is quality improving"
  read without reading test code.

The emotional job: **"I can stop babysitting the test suite."** The design should
feel like a calm, competent colleague showing you their work — not a dashboard
shouting metrics, and not a black box asking for faith.

---

## PLATFORM & TECHNICAL CONSTRAINTS (please respect these)

- **Electron desktop app**, macOS-first. Default window **1440×900**, minimum
  **1100×700**. It opens like Cursor — no browser chrome.
- **Frameless on macOS** (`titleBarStyle: hiddenInset`). The traffic lights are
  drawn over the page at roughly **x 18–78, y 15–33**. The left sidebar owns that
  corner and insets 40px from the top to clear them. Any design must leave that
  corner alone.
- The window is dragged by the sidebar (there is no title bar), so the sidebar
  cannot be filled edge-to-edge with click targets.
- **Dark-first.** A light theme exists only for the marketing page; the app itself
  is designed for the dark palette. You may propose a light theme, but dark is
  the one that must be excellent.
- **Tailwind v4** with tokens in an `@theme` block (no `tailwind.config.js`).
  Please express color/spacing decisions as CSS custom properties so they drop in.
- The code editor is **Monaco** (the real VS Code editor). Its chrome is
  themeable, its internals are not — assume standard Monaco behaviour for
  gutters, minimap, suggest widgets, find bar.
- No design-system dependency is installed (no shadcn, no Radix, no icon
  library). Icons today are hand-written inline SVGs. **Feel free to specify a
  proper icon set** — say which and why.
- Fonts today: system UI stack for prose, `ui-monospace / SF Mono / Menlo` for
  code and identifiers. **A typeface recommendation is welcome** (must be
  embeddable/licensable for a desktop app).

---

## THE DESIGN SYSTEM THAT EXISTS TODAY

These are the literal tokens in `apps/web/app/globals.css`. Treat them as a
starting point to critique and replace, not a constraint.

```css
@theme {
  /* Text */
  --color-ink:        #e9ecf1;  /* primary text */
  --color-ink-dim:    #99a1ad;  /* secondary text */
  --color-ink-faint:  #646c7a;  /* tertiary / metadata */

  /* Surfaces (3 levels) */
  --color-surface:    #0b0d11;  /* app background */
  --color-surface-1:  #14171d;  /* cards, panels */
  --color-surface-2:  #1c2029;  /* raised / active row */

  /* Borders */
  --color-line:        #262b34;
  --color-line-strong: #333a45;  /* hover */

  /* Brand */
  --color-accent:   #5b8dff;   /* primary blue */
  --color-accent-2: #8b5cff;   /* violet, used in a gradient with accent */

  /* Semantic status — load-bearing, used everywhere */
  --color-pass:  #3fb950;  /* green  — test passed */
  --color-fail:  #f85149;  /* red    — test failed */
  --color-flake: #e3a723;  /* amber  — flaky / needs review */
  --color-skip:  #646c7a;  /* grey   — skipped */

  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
}
```

Also in use:
- The app background has two faint radial accent glows in the top corners
  (`background-attachment: fixed`) for depth.
- `.brand-gradient` = `linear-gradient(135deg, accent, accent-2)` — used on the
  "Q" logo mark.
- `.lift` = cards translate up 1px and brighten their border on hover.
- A 4-state status dot component (pass/fail/flake/skip) is the most repeated
  element in the product.

**Known inconsistencies to fix:** the Monaco editor background is `#0e1013` and
the Electron splash is `#0e1013`, but the app surface is `#0b0d11` — three
near-blacks that should be one system. Radii are ad-hoc (`rounded`, `rounded-md`,
`rounded-lg`, `rounded-xl` all appear). Type scale is ad-hoc — sizes from
`text-[9px]` to `text-3xl` chosen per-component with no scale.

---

## WHAT EXISTS TODAY — SCREEN INVENTORY

The persistent shell: a **left sidebar** (240px, collapses to a 64px icon rail,
choice persisted) containing a logo mark, a ⌘K search button, nav items (Runs,
Dashboard, Editor, Environments, Source control, Import, Add app) and a footer
(Settings, collapse toggle). **⌘K** = command palette, **⌘P** = fuzzy file open,
**⌘\** = collapse sidebar. Login and the marketing page render outside the shell.

| # | Screen | Route | What it does today | What's weak |
|---|---|---|---|---|
| 1 | **Marketing / landing** | `/` | Hero, how-it-works, 4 pricing tiers | Generic SaaS layout; doesn't convey the product at all |
| 2 | **Login** | `/login` | Email + password, centered, `max-w-sm` | Bare; no brand presence; desktop app should feel native, not like a web form |
| 3 | **Runs (home)** | `/runs` | Project cards with a "▶ Run <env>" button; a list of the 25 most recent runs (status dot, id chip, env, pass/fail counts, relative time) | This is the app's home and it's just two lists. No sense of "what needs my attention". Polls every 4s but nothing animates |
| 4 | **Run cockpit** | `/runs/[runId]` | The most important screen. 3 panes: left = per-test list with status dots; center = the selected test's step timeline (numbered cards, duration, failing step highlighted); right = triage verdict, failure screenshot, expected-vs-actual, error text, trace/video download, live event log. Header has back, re-run, gate result, JUnit XML | Panes are fixed-width and equally weighted; the failing step (the thing you came for) isn't dominant. Expected-vs-actual is two code blocks, not a diff. The live event log is raw JSON. No timeline scrubbing, no way to compare against the last passing run |
| 5 | **Dashboard** | `/dashboard` | 4 stat cards (total runs, pass rate, flakes, open failures), a bar chart of pass rate over the last 15 runs, project list, recent runs | Charts are bare divs. No trend/delta, no date range, no drill-down. Doesn't answer "is quality getting better" |
| 6 | **Editor** | `/editor` | 3 panes: file tree (real nested folders from test file paths, folder/file icons, review-flag badges, fixtures shown as data) → Monaco (Playwright types loaded, ⌘S save, ⌘↵ run) → agent chat panel + last-run result. Header shows the open file path, Record, Save, Run | Only ONE file can be open — no tabs. Header is a strip of buttons with no hierarchy. The agent panel is an empty box with placeholder copy. No diff view, no version history UI, no breadcrumb |
| 7 | **Environments** | `/environments` | Left: environment list (name, kind chip, secret count). Right: base URL editor + secrets panel (name + masked `••••••••1234`, add, delete, paste-a-.env bulk import) | Functional but plain. Nothing communicates the *safety* story (encrypted at rest, never shown again), which is the main thing a user is anxious about here |
| 8 | **Source control** | `/source-control` | Preview of exactly what would be committed (file list + byte sizes), "Download as zip" (no credentials needed), connect a GitHub/GitLab/Bitbucket repo with a token, push with an explicit confirm step | The file list is a raw monospace dump. The push confirm is an inline amber box. No diff against what's already in the repo |
| 9 | **Import a suite** | `/import` | Drop existing Cypress/Selenium/Postman/etc. files, auto-detect the framework, convert to Playwright, report what was gained/lost | The wedge feature for adoption, presented as a plain form. No sense of progress, confidence, or before/after |
| 10 | **Add app (onboarding)** | `/onboarding` | Name + URL, kicks off a crawl | First-run experience is a 2-field form. No sense of what's about to happen or how long |
| 11 | **Plan approval** | `/projects/[id]/plan` | The agent's proposed test plan grouped by feature; tick the items you want; approve → tests get generated | **Conceptually the most important screen in the product** (this is where a human stays in control of an AI) and it's a checkbox list |
| 12 | **Settings** | `/settings` | Tabs: Organization / Members / API keys (create-once-reveal-once secret) | Fine, plain |

---

## WHAT'S MISSING — SURFACES WITH BACKEND CAPABILITY BUT NO UI

The backend has **40 data models**; the app has **12 screens**. Everything below
is already modelled and mostly implemented server-side, and has **no interface at
all**. This is the bulk of the design work, and it's where the product becomes
worth its price.

**The trust loop (highest value — this is the product's soul)**

1. **Flow map** — a visual graph of the app QAAI crawled: pages, journeys,
   selectors, auth walls. An API endpoint exists and returns it. This should be
   the "QAAI understands your app" moment. Needs a real graph/diagram design.
2. **Triage review queue** — the AI's verdict on every failure, one of
   `REAL_BUG / INTENDED_CHANGE / FLAKE / ENV_ISSUE`, each with a confidence
   score, an explanation, and an evidence list (step, network, console, diff,
   history) plus an optional suspect commit. A human can **accept, override, or
   mute** each. Today only a raw verdict blob shows in the cockpit. This screen
   is where trust is won or lost — design the evidence presentation.
3. **Self-healing proposals** — when the app changes, QAAI proposes a code fix as
   a **diff**, tagged with a risk level: `SELECTOR_ONLY` (safe) /
   `ASSERTION_CHANGE` (careful) / `STRUCTURAL` (review properly). A human
   approves or rejects. Needs a diff-review design where risk is instantly
   legible. Orgs can opt into auto-approving selector-only fixes.
4. **Agent proposals inbox** — the agent's pending suggestions
   (`PENDING / APPLIED / REJECTED`) across the project. Needs an inbox pattern.

**Test quality & coverage**

5. **Findings browser** — accessibility, security, performance, localization and
   visual findings across the whole project, with severity
   (`CRITICAL / SERIOUS / MODERATE / MINOR`). Currently only visible per-test.
6. **Visual regression review** — baseline vs current screenshots with a diff.
   The baseline model exists; there's no comparison UI at all. Needs a proper
   image-diff design (side-by-side / onion-skin / difference toggle).
7. **Flake radar / quarantine** — per-test flake rate is tracked and tests can be
   quarantined. No UI. Needs a "which tests can't I trust" view.
8. **Test version history** — every save writes a version with an author and
   source (`HUMAN` / generator / applied heal). The endpoint exists; no timeline UI.
9. **Suites** — saved test selections. Modelled, no management UI.
10. **CI gate rules editor** — the rules that decide whether a run blocks a
    deploy (e.g. "block on a real bug in critical-path tests", "warn above 5%
    flake rate"). Stored as JSON on the project; edited by nobody. Needs a
    human-readable rule builder.

**Automation & scheduling**

11. **Schedules** — cron-style recurring runs. Modelled, no UI.
12. **Monitors** — synthetic production monitoring with alerting. Modelled, no UI.
13. **Auth profiles** — reusable "how to log into my app" recipes:
    `FORM_LOGIN`, `MAGIC_LINK`, `SSO_BYPASS_TOKEN`, `COOKIE_INJECTION`,
    `TOTP_MFA`. Modelled with per-kind config, no UI. This is a genuinely tricky
    form-design problem (5 shapes, secret-bearing fields, a "test this login"
    action).

**Integrations & operations**

14. **Notification integrations** — Slack, Teams, Discord, Jira, Linear,
    PagerDuty, generic signed webhooks (all in the enum; only git is built), plus
    a **webhook delivery log** with retry status.
15. **Audit log viewer** — every mutation is already recorded with actor, action,
    target, and masked metadata. No viewer.
16. **Usage & LLM spend** — per-agent-call token cost is recorded
    (`EXPLORER / GENERATOR / TRIAGE / HEALER / CHAT`), with a monthly budget cap.
    No UI. Users will want to see what the AI costs them.
17. **Billing** — Stripe subscription, plan limits (projects, parallel workers,
    runs/month), upgrade flow. Modelled, no UI.
18. **Team invites** — modelled; settings currently says invites "are not built yet".

**Editor maturity (to actually earn the "like Cursor" claim)**

19. **Multi-tab editing** with dirty indicators and persistence across navigation.
20. **Diff view** — human edit vs agent proposal, and version vs version.
21. **Record mode UX** — clicking through your app to generate a test exists as a
    button; the recording *experience* (overlay, live step capture, review before
    save) is undesigned.
22. **Test-run output panel** — a proper terminal/results panel in the editor.

**Cross-cutting, currently absent**

23. **Empty states** — every list renders one line of grey text. There are ~15 of
    them and they're the first thing a new user sees.
24. **Loading / skeleton states** — currently the word "Loading…".
25. **Error states** — a red bordered box, everywhere, regardless of severity.
26. **Notifications / toasts** — none. Long jobs finish silently.
27. **Onboarding / first-run** — no guided path from install → first green run.
28. **Keyboard-shortcut discoverability** — ⌘K/⌘P/⌘S/⌘↵/⌘\ exist and are
    undiscoverable.

---

## DESIGN PRINCIPLES I WANT YOU TO WORK FROM

1. **Evidence over assertion.** Never let the AI simply state a conclusion. Every
   machine judgment shows its work — confidence, the evidence it used, and a
   one-click way to disagree. If a design element can't be traced back to
   evidence, it shouldn't look authoritative.
2. **The failing thing is the subject.** In any run view, the failure is why the
   user is here. It should dominate. Passing tests are context, not content.
3. **Calm under bad news.** This product mostly delivers bad news (things are
   broken). It must not feel alarming or gamified. Red is information, not
   punishment.
4. **Dense but not cramped.** The user is a professional living here all day.
   Prefer information density over whitespace-heavy marketing aesthetics — but
   the density must be *organised*, which is exactly what's missing today.
5. **Keyboard-first, discoverable.** Every frequent action needs a shortcut, and
   every shortcut needs to be visible somewhere.
6. **Honest about uncertainty.** When the AI is unsure, the UI says so plainly.
   A flagged test, a low-confidence verdict, and a risky heal must all look
   different from their confident equivalents.

## ANTI-GOALS

- Don't make it look like a generic SaaS dashboard (no big rounded cards with
  drop shadows floating on a light grey page).
- Don't add a marketing voice to the app UI. No exclamation marks, no "🎉".
- Don't gamify quality (no streaks, no badges, no scores out of 100).
- Don't hide the code. "Your tests are plain Playwright and you keep them" is a
  core promise — the code should be visible and first-class, not tucked away.
- Don't design for mobile. It's a desktop app. (A responsive read-only view of a
  run report is a *maybe*, not a requirement.)

---

## DELIVERABLES I'D LIKE

In priority order — feel free to tell me if you'd sequence it differently:

1. **A design system**, expressed as CSS custom properties I can drop into a
   Tailwind v4 `@theme` block: a resolved neutral/near-black ramp (fixing the
   three-different-blacks problem), semantic status colors, a type scale with
   named roles, a spacing and radius scale, elevation rules for a dark UI, and an
   icon-set + typeface recommendation.
2. **A resolution of the IDE-vs-dashboard tension**: a stated rule for when a
   surface uses "tool" language versus "report" language, and how the shell holds
   both without feeling like two apps.
3. **A visual language for machine judgment**: confidence, evidence, provenance
   (human vs which agent), risk level, and disagreement/undo. This is the most
   valuable thing you can give me.
4. **Redesigns of the three screens that matter most**, at 1440×900:
   **the run cockpit** (#4), **plan approval** (#11), and **triage review** (#2,
   which doesn't exist yet).
5. **Designs for the highest-value missing surfaces**: flow map, healing-proposal
   review, visual-diff review, and the findings browser.
6. **The cross-cutting states**: a reusable empty state, loading state, error
   state, and toast pattern.
7. **The first-run path**: install → add app → crawl → approve plan → first green
   run, as a designed sequence rather than four disconnected forms.

For anything visual, static mockups are fine — HTML/CSS I can lift is better.
Tell me what you'd change about my assumptions.
