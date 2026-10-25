import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GATE_RULE_KINDS } from '@qaai/shared';
import { describe, expect, it } from 'vitest';
import { actionOf, describeRule, isEditableRule, type StoredGateRule } from './gate-rules';

/**
 * A configured gate must never render as nothing.
 *
 * `GateRule` in @qaai/shared has twelve kinds; this editor has controls for
 * four. That was invisible while the API's `gateRuleSchema` was also four arms
 * behind the union — the other eight could not be saved, so they could not be
 * read back. The schema now accepts all twelve, so a project can hold a rule
 * this screen has never heard of, and the old `describeRule` fell off the end
 * of its switch and returned undefined: a row with a BLOCK badge and no text,
 * which is a gate indistinguishable from no gate.
 */

/*
 * The kinds are read from `GATE_RULE_KINDS`, the runtime list @qaai/shared
 * derives from `Record<GateRule['kind'], true>` — so the compiler guarantees it
 * is the whole union, and this test cannot be fooled by a regex that stopped
 * matching. The editor's own coverage is read out of its SOURCE, because what
 * is being asked is "does this file have an arm for that kind", and the answer
 * lives in the switch rather than in any value it exports.
 */
const EDITOR_SOURCE = fileURLToPath(new URL('./gate-rules.ts', import.meta.url));

describe('the editor knows which kinds it cannot edit', () => {
  it('still has fewer arms than the shared union — which is why the fallback exists', () => {
    // Not a wish for parity: controls for the other eight kinds are a design
    // job, not a repair. What this asserts is that the gap is REAL, so the
    // unrecognised path below is live code and not a branch nothing can reach.
    // If somebody does add all twelve, this test fails and says to delete it.
    const editor = readFileSync(EDITOR_SOURCE, 'utf8');
    const unhandled = GATE_RULE_KINDS.filter((kind) => !editor.includes(`'${kind}'`));
    expect(GATE_RULE_KINDS.length).toBe(12);
    expect(unhandled.length).toBeGreaterThan(0);
    // And the one this test's fixtures use is among them, so the cases below
    // are about a kind this editor genuinely cannot handle.
    expect(unhandled).toContain('MIN_COVERAGE');
  });

  it('describes a kind it cannot edit instead of returning nothing', () => {
    // MIN_COVERAGE is a real member of the shared union and a real saveable
    // rule. Before this it rendered as an empty row.
    const rule: StoredGateRule = { kind: 'MIN_COVERAGE', action: 'BLOCK' };
    const sentence = describeRule(rule);
    expect(sentence).toContain('min coverage');
    expect(sentence).toContain('cannot edit');
    // And it says the save keeps it, because the alternative a reader would
    // assume — that an unknown row is dropped — would be a deleted gate.
    expect(sentence.toLowerCase()).toContain('kept');
  });

  it('refuses to claim a rule is editable because it has an action', () => {
    expect(isEditableRule({ kind: 'MIN_COVERAGE', action: 'BLOCK' })).toBe(false);
    expect(isEditableRule({ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' })).toBe(true);
  });
});

describe('actionOf', () => {
  it('reports BLOCK for a verdict rule, which carries no action of its own', () => {
    expect(actionOf({ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] })).toBe(
      'BLOCK',
    );
  });

  it('reads the stored action of a rule it cannot edit', () => {
    expect(actionOf({ kind: 'MIN_COVERAGE', action: 'WARN' })).toBe('WARN');
  });

  it('is null rather than BLOCK for a rule whose severity it cannot read', () => {
    // A badge reading BLOCK over a rule that only warns is a claim about
    // somebody's merge, made from a default.
    expect(actionOf({ kind: 'SOMETHING_NEW' })).toBeNull();
  });
});

describe('the four it does edit still read as sentences', () => {
  it('names the number and the consequence', () => {
    expect(describeRule({ kind: 'MIN_PASS_RATE', ratePercent: 95, action: 'WARN' })).toBe(
      'Warn when the pass rate falls below 95%.',
    );
    expect(describeRule({ kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'BLOCK' })).toBe(
      'Block when more than 5% of tests are flaky.',
    );
  });

  it('says "every test" by omission for a verdict rule with no priorities', () => {
    expect(
      describeRule({ kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] }),
    ).toBe('Block the deploy when triage calls a failure a real bug.');
  });
});
