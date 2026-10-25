/**
 * The enumerate slice's five modules, as one public surface.
 *
 * ── WHY THIS FILE EXISTS, AND WHY NONE OF THE FIVE AUTHORS WROTE IT ─────────
 *
 * All five landed in parallel and none of them could see the others' writes, so
 * a barrel written by any one of them would have been a lost-write race whose
 * failure mode is a module silently missing from the exports — this codebase's
 * signature defect, arriving through the very file meant to prevent it. Each
 * author said so and left it to the integration. This is the integration.
 *
 * ── THE NAME COLLISIONS, AND HOW THEY WERE RESOLVED ─────────────────────────
 *
 * `export *` makes a duplicated name AMBIGUOUS — TypeScript errors TS2308 and
 * ES module semantics drop BOTH — so a collision here is not a style question.
 * Two were resolved before this file was written, by the authors who owned the
 * losing side:
 *
 *   • `canonicaliseUrl` / `CanonicalUrl` / `HASH_ROUTING_MODES` /
 *     `HashRoutingMode` existed in both `frontier` and `harvest`. Harvest
 *     renamed its four to `resolveDiscoveredUrl` / `ResolvedUrl` /
 *     `HARVEST_HASH_MODES` / `HarvestHashMode` and adopted the frontier's three
 *     mode VALUES, so one setting drives both.
 *   • `signatureOf` existed in both `interact` and `variants`. Variants renamed
 *     its to `variantSignatureOf`.
 *
 * `NavigationOutcome` is the third and it is still TWO CONCEPTS: `interact`'s
 * is the RESULT of driving a page (`ok`/`url`/`status`/`error`) and `observe`'s
 * — renamed to `ObservedNavigation` by its author for exactly this reason — is
 * the INPUT to the bounce ledger and carries the url that was REQUESTED. The
 * distinction is load-bearing: an outcome that only knows where it ended up is
 * precisely how `/admin/billing` came to be enumerated as `/login`. Both names
 * survive because both shapes are needed; `crawler.ts` supplies `requestedUrl`
 * from the frontier entry and never from an outcome.
 *
 * ── WHAT IS STILL FORKED, STATED RATHER THAN HIDDEN ─────────────────────────
 *
 * There are three answers to "is this fragment a route":
 *
 *   frontier  AUTO keeps a fragment starting with `/`            (`#/orders`)
 *   harvest   AUTO keeps any fragment containing `/`             (`#!/orders`)
 *   interact  keeps `#/` or `#!/`, or ANY fragment in HASH mode
 *
 * The FRONTIER WINS, because it owns node identity and it is the only one of
 * the three that writes the stored `Frontier`. Harvest offering a fragment the
 * frontier collapses costs nothing; the frontier never seeing one loses a whole
 * class of application, so harvest's wider rule is the right way round.
 * `crawler.ts` rewrites a leading `#!` to `#` before offering, which is what
 * makes the AngularJS form reach the frontier at all.
 */

export * from './frontier.js';
export * from './harvest.js';
export * from './interact.js';
export * from './observe.js';
export * from './variants.js';
