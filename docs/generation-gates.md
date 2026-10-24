# What has to be true before a generated test is kept

A generated test that is stored and counted closes a coverage gap. If it does
not parse, asserts nothing, tests a different scenario than the one approved,
or already exists in the suite, the gap is closed on paper and open in the
product — which is worse than leaving it open, because nobody looks at a closed
gap again.

So nothing reaches the suite without passing, or visibly failing, a fixed set of
checks. `admit()` in `packages/agent/src/admission.ts` runs them and returns one
verdict. Three paths write test code — the Generator, the inline editor and the
Healer — and all three go through it.

## The rule that the rest of this depends on

**A check that could not run never reports success.** Its status is
`UNAVAILABLE`, and the words it reports are a sentence about what nobody
confirmed:

> Nobody has confirmed this file parses: no syntax checker was wired in, so a
> missing brace would first show up as "the runner produced no report" at run
> time.

Every `UNAVAILABLE` lands in the test's review flags, so "admitted" never
quietly means "unchecked". There is exactly one exception, and it is
conditional: the mutation check cannot run during generation at all, so when
nothing is wired in it is not flagged — a flag that appears on every test ever
admitted is a flag nobody reads. The moment a mutation capability *is* supplied
and comes back unavailable, that is a fact about that one test, and it is
flagged like everything else.

## The checks

| Check | What it answers | On failure |
|---|---|---|
| `SYNTAX` | Does this file parse? | Rewrite, then refuse |
| `TYPECHECK` | Does it typecheck against the repo's own config? | Rewrite, then flag |
| `FORMAT` | Is it in the project's own style? | Stores the formatted source |
| `LINT` | Does it break a rule the team enforces? | Rewrite, then flag |
| `ASSERTIONS` | Does it assert anything, and anything worth asserting? | Rewrite, then refuse |
| `LOCATORS` | Are the selectors resilient or generated-class soup? | Rewrite, then flag |
| `FIDELITY` | Does it test the scenario that was approved? | Rewrite, then refuse |
| `NO_LOCK_IN` | Does it import anything of ours? | Rewrite, then flag |
| `NO_FIXED_SLEEP` | Does it sleep for a fixed time? | Flag |
| `PATH_CONVENTION` | Will the runner actually collect this file? | Corrected, and said out loud |
| `DUPLICATE` | Does the suite already have this test? | Refuse immediately |
| `MUTATION` | Does it fail when the behaviour it covers breaks? | Rewrite, then flag |

A first failure is a rewrite — the model is told exactly what to fix, quoting
the offending lines — and a second failure of the same kind is final. Two
attempts, never a loop.

`DUPLICATE` is the one check with no second chance: re-prompting cannot fix
"you already have this test", and a duplicate inflates the numerator without
covering anything new.

A path the runner cannot collect is corrected rather than refused, because the
convention is mechanical. The correction is reported, since a package, class or
namespace declaration inside the file may no longer match.

### Why a brittle locator is not a refusal

A refused test covers nothing at all. A test with one questionable selector
covers the behaviour and costs a human thirty seconds. One brittle locator
among nine is usually a real element the crawl missed; a third or more means the
model stopped using the locators it was handed, which is worth a rewrite. The
threshold is a named constant with that reasoning next to it.

### What fidelity can and cannot catch

It compares the plan item's own words against the code, with a stated floor,
after a deliberately crude stemmer — because a correct implementation of "the
order confirmation shows a total of $42.00" says "confirmed", not
"confirmation". It catches wholesale plan drift: a test generated for a
different scenario than the one approved. It does **not** catch `toBe(200)`
where the plan said 500. The check says so in its own output rather than
implying more.

## The mutation check

The objection that decides these purchases is always the same: *AI-written tests
assert nothing.* The answer that cannot be argued with is to break the behaviour
the test claims to cover and watch the test go red.

One mutant, one test, repeated a bounded number of times: negate a conditional
the test's path runs through, invert an equality, remove a validation, change a
constant the test's own assertions depend on. Mutants are generated only from
code the test plausibly reaches — mutating code it never touches produces a
survivor that proves nothing and makes the check a liar.

Two asymmetries are deliberate:

- **Zero kills with a decisive survivor fails.** We broke the behaviour and the
  test stayed green; it is provably worthless.
- **Zero kills where every survivor is a boundary change only warns.**
  `price > 100` becoming `price >= 100` is invisible to a fixture of 250. A
  check that makes false accusations gets switched off, and then it protects
  nothing.

The test must also **pass before any mutation is applied**. Without that, every
mutant "kills" an already-red test and the check certifies a broken test as
rigorously asserted.

When a mutant survives, the report says what change the test failed to notice —
"it still passes when the total is computed with `-` instead of `+`" — and which
assertion would have caught it. That sentence is also the best possible input to
the rewrite.

## Heals are judged differently, on purpose

A refused generated test costs a model call. A refused **heal** leaves the
customer with a test that is red right now and no proposal at all. The policy
follows from that asymmetry:

- A heal that does not **parse** is refused on every path, reviewed or not. It
  is strictly worse than the red test it replaces — the red test names a line,
  an unparseable file takes every sibling test in it down with "no report
  produced" — and nobody reads a diff and notices a missing brace.
- Everything else is a flag, because leaving a test red over a `nth-child`
  selector is the worse trade.
- **The unattended path is held higher than the reviewed one.** Auto-apply
  requires every check that could run to have actually passed. A flag is a
  message to a human, and auto-apply is the one path with no human to read it:
  a fixed sleep merely flagged on a reviewed heal becomes, unattended, a flake
  source committed to the customer's repository with nobody told.

### Two notions of "do not weaken a test", and which one can refuse

"Never weaken" is a **relative** question — fewer assertions than before — and
admission only ever sees one file, so it cannot answer it. The applier does,
counting before and after in the test's own language, and it is the only thing
that may refuse a heal for losing an assertion. The `ASSERTIONS` check answers a
different, absolute question: does the result assert anything worth anything.
They cannot contradict each other because they are not the same question.

Where they overlap — a test that asserted nothing before and asserts nothing
after — the applier correctly permits it (zero is not fewer than zero) and the
check correctly dislikes it. Refusing there would not buy a single assertion and
would leave the customer with a broken test and no proposal, so the applier
refuses and the check flags.

## What counts as an assertion

In sixteen dialects, not one. Three modules had independently decided that an
assertion is `expect(`, which is right about JavaScript and wrong about the
other thirteen languages tests get generated for. The consequences were not
symmetrical:

- A correct pytest test was reported as having **no assertions** at high
  severity. One obviously wrong finding is enough for a team to stop trusting
  the page it appeared on.
- The never-weaken guard counted `expect(` before and after a heal. In a Go
  repository that is zero both times — so the guard against a model deleting an
  assertion to make a test pass was a no-op *precisely* where nobody is
  watching.

`packages/shared/src/dialect.ts` is the one lexicon now. Its load-bearing rule:
when it cannot tell what dialect a file is, it says **null**, and null means
"could not read this test" — never "asserts nothing". Strings and comments are
blanked before matching, so `page.getByText('expect(this)')` is not an assertion
and `// assert the total` is not one either, while offsets survive so a finding
still quotes the real line.

## None of this guesses at your tooling

The format and lint checks run **your** prettier, eslint, black, ruff, gofmt or
rubocop, resolved from your own `node_modules/.bin` or configured environment. A
tool that is declared but not installed reports unavailable and says which:

> prettier is not installed — although this repository does configure it
> (`.prettierrc.json`; declared in `package.json`), so it may just need
> installing.

Nothing is ever fetched to run a check. `npx <tool>` on a package that is not
installed downloads and executes whatever is published under that name, on the
machine running your tests, at generation time.

A stray global formatter is also refused unless your repository configures it or
it lives in your own virtualenv — a global `black` reformatting a `ruff format`
repository produces exactly the whole-file diff that gets a generated test
deleted on sight.
