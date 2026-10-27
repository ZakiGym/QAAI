/**
 * DECLARED FORM CONSTRAINTS, READ OFF THE SOURCE.
 *
 * `detectForms` read no `maxlength`, `minlength`, `min`, `max`, `step` or
 * `pattern`, so on the source path every one of them landed in CONSTRAINT_UNREAD
 * and ten of the twenty attribute-governed boundary classes were unreachable BY
 * CONSTRUCTION — a boundary test cannot say "one character over the limit" when
 * nothing ever read the limit.
 *
 * The three states are the whole subject of this file:
 *   absent/undefined → NOT_CAPTURED   (nothing could read it)
 *   null             → DECLARED_ABSENT (we read the tag; it declares none)
 *   a value          → READ
 *
 * Collapsing the first two is the defect these tests exist to prevent: it makes
 * the product assert, ten times per field, that an application declares no
 * limits on the strength of a regex that never looked.
 */

import { describe, expect, it } from 'vitest';
import { analyseCodebase, SOURCE_FORM_CONSTRAINTS } from './codebase';

const fieldsOf = (path: string, content: string) => {
  const form = analyseCodebase([{ path, content }]).forms[0];
  if (!form) throw new Error(`no form detected in ${path}`);
  return new Map(form.fields.map((field) => [field.name, field]));
};

describe('literal markup: an absent attribute is DECLARED_ABSENT', () => {
  const fields = fieldsOf(
    'signup.html',
    `<form name="signup">
       <input type="text" name="zip" maxlength="5" pattern="[0-9]{5}" required>
       <input type="number" name="qty" min="1" max="99" step="1">
       <input type="text" name="nick">
     </form>`,
  );

  it('READS the attributes the markup declares', () => {
    expect(fields.get('zip')!.maxLength).toBe(5);
    expect(fields.get('zip')!.pattern).toBe('[0-9]{5}');
    // Strings, not numbers: `min` is "2024-01-01" on a date input and "08:00" on
    // a time input, and parsing at capture time throws those away.
    expect(fields.get('qty')!.min).toBe('1');
    expect(fields.get('qty')!.max).toBe('99');
    expect(fields.get('qty')!.step).toBe('1');
  });

  it('answers NULL for an attribute the tag genuinely does not carry', () => {
    // This is the state that licenses the UNBOUNDED classes: "no maxlength is
    // declared here, so send 10,000 characters and assert the app copes".
    const nick = fields.get('nick')!;
    for (const key of SOURCE_FORM_CONSTRAINTS) {
      expect(key in nick).toBe(true);
      expect(nick[key]).toBeNull();
    }
  });

  it('does not let a brace inside a quoted VALUE make the tag unreadable', () => {
    /*
     * `pattern="[0-9]{5}"` — the `{` is inside a quoted literal, so the tag's
     * STRUCTURE is still fully readable. The first version of the opacity test
     * looked for `{` anywhere and lost the other five constraints on every
     * field that declared a quantified pattern, which is one of the commonest
     * things on a real form. It erred safely, so nothing failed; it was only
     * visible by reading the output.
     */
    const zip = fields.get('zip')!;
    expect(zip.min).toBeNull();
    expect(zip.max).toBeNull();
    expect(zip.step).toBeNull();
    expect(zip.minLength).toBeNull();
  });
});

describe('JSX and templates: an absent attribute is NOT_CAPTURED', () => {
  const fields = fieldsOf(
    'Signup.tsx',
    `<form name="jsxform">
       <input type="text" name="zip" maxLength={MAX} />
       <input type="text" name="city" className={styles.input} />
       <input type="text" name="pin" maxLength={"4"} />
     </form>`,
  );

  it('leaves every unreadable constraint ABSENT, never null', () => {
    /*
     * THE LOAD-BEARING ASSERTION OF THIS FILE. `maxLength={MAX}` cannot be read
     * by a regex, and neither can a `{...props}` spread or a wrapper component,
     * so "no maxlength" is not a claim this reader is entitled to make. Writing
     * null here would flip CONSTRAINT_UNREAD into UNBOUNDED and the product
     * would assert that a React form declares no limits.
     */
    const city = fields.get('city')!;
    for (const key of SOURCE_FORM_CONSTRAINTS) expect(key in city).toBe(false);
  });

  it('still READS a quoted JSX literal, because opacity only governs silence', () => {
    expect(fields.get('pin')!.maxLength).toBe(4);
  });

  it('keeps the unreadable siblings of a readable attribute absent', () => {
    const zip = fields.get('zip')!;
    // The value `{MAX}` is not a string literal, so it is not read at all...
    expect('maxLength' in zip).toBe(false);
    // ...and the tag is opaque, so nothing else on it is claimed either.
    expect('pattern' in zip).toBe(false);
  });
});

describe('present but unparseable is NOT_CAPTURED, not DECLARED_ABSENT', () => {
  it('refuses to call a templated maxlength "no limit"', () => {
    /*
     * `maxlength="{{limit}}"` is the page DECLARING a limit we cannot turn into
     * a number. An earlier draft answered null here, which says "the page
     * declares no limit" about a page that visibly declares one — the same lie
     * as the opacity bug, one arm further in.
     */
    const fields = fieldsOf(
      'form.html',
      '<form name="t"><input type="text" name="z" maxlength="{{limit}}"></form>',
    );
    expect('maxLength' in fields.get('z')!).toBe(false);
    // The tag's structure IS readable, so its silence about the others counts.
    expect(fields.get('z')!.min).toBeNull();
  });

  it('treats a non-numeric maxlength the same way', () => {
    const fields = fieldsOf(
      'form.html',
      '<form name="t"><input type="text" name="z" maxlength="ten"></form>',
    );
    expect('maxLength' in fields.get('z')!).toBe(false);
  });

  it('reads a conditionally-rendered attribute block as opaque', () => {
    const fields = fieldsOf(
      'form.hbs',
      '<form name="t"><input type="text" name="z" {{#if max}}maxlength="5"{{/if}}></form>',
    );
    // The attribute IS literally present and readable...
    expect(fields.get('z')!.maxLength).toBe(5);
    // ...but the tag carries a template directive, so its SILENCE about the
    // others proves nothing: an attribute could be inside another branch.
    expect('min' in fields.get('z')!).toBe(false);
  });
});

describe('textarea and select', () => {
  it('reads maxlength off a textarea, where it is a real rule', () => {
    const fields = fieldsOf(
      'form.html',
      '<form name="t"><textarea name="bio" maxlength="500"></textarea></form>',
    );
    expect(fields.get('bio')!.maxLength).toBe(500);
  });

  it('does not invent constraints for a select', () => {
    const fields = fieldsOf(
      'form.html',
      '<form name="t"><select name="country"><option>GB</option></select></form>',
    );
    // Null, not a number: the tag was read and declares none. Whether a length
    // class APPLIES to a select is the boundary vocabulary's decision, not this
    // reader's — it reports what the markup says and nothing more.
    expect(fields.get('country')!.maxLength).toBeNull();
  });
});

describe('the constraint list is the single source of truth', () => {
  it('names exactly the six attributes the reader attempts', () => {
    expect([...SOURCE_FORM_CONSTRAINTS].sort()).toEqual([
      'max',
      'maxLength',
      'min',
      'minLength',
      'pattern',
      'step',
    ]);
  });
});
