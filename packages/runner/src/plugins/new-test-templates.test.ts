/**
 * The editor's "+ new test" picker is only as honest as this file forces it
 * to be.
 *
 * The picker offers `CREATABLE_TEST_TYPES`; each entry ships the code and
 * spec the editor will POST verbatim. History's failure mode — the generator
 * emitting Playwright prose for an API test, validate rejecting the null
 * spec, FAILED "invalid spec" — is exactly one bad template away from coming
 * back, so every template is held to the only standard that matters: the
 * type's own plugin, the runnable truth, must accept it in `validate()`.
 * The schemas in @qaai/shared are not enough on their own — ACCESSIBILITY and
 * SECURITY_SMOKE parse their specs by hand inside the plugin.
 */

import { describe, expect, it } from 'vitest';
import {
  CREATABLE_TEST_TYPES,
  NEW_TEST_TEMPLATES,
  SPEC_DRIVEN_TEST_TYPES,
  TEST_TYPES,
  testFileSlug,
  type ExecutableTest,
  type NewTestTemplate,
  type TestType,
} from '@qaai/shared';
import { pluginFor } from '../registry.js';

/** Exactly what the editor's createFile() sends, run through the plugin's eyes. */
function scaffold(type: TestType, template: NewTestTemplate): ExecutableTest {
  return {
    id: 'template-under-test',
    name: 'New test',
    type,
    code: template.code,
    filePath: `hand-written/${testFileSlug('New test')}${template.fileSuffix}`,
    spec: template.spec ?? null,
    timeoutMs: 60_000,
    quarantined: false,
    tags: [],
  };
}

describe('the new-test templates', () => {
  it('the picker and the registry agree on which types exist', () => {
    // Both directions matter: a template without a plugin is a file that can
    // never run, and a plugin without a template is a capability the UI hides.
    expect(CREATABLE_TEST_TYPES).toEqual(TEST_TYPES.filter((t) => pluginFor(t) !== null));
  });

  for (const type of CREATABLE_TEST_TYPES) {
    const template = NEW_TEST_TEMPLATES[type]!;

    it(`${type}: the plugin accepts the template it will be handed`, () => {
      const plugin = pluginFor(type);
      expect(plugin, `${type} is offered by the picker but has no plugin`).not.toBeNull();
      expect(() => plugin!.validate(scaffold(type, template))).not.toThrow();
    });
  }

  it('spec-driven templates seed a spec that survives the editor round trip', () => {
    for (const type of SPEC_DRIVEN_TEST_TYPES) {
      const template = NEW_TEST_TEMPLATES[type as TestType]!;
      expect(template.spec, `${type} is spec-driven and must seed a spec`).toBeDefined();
      // The buffer is JSON.stringify(spec) and save is JSON.parse(buffer); a
      // spec that loses anything in that trip would save something different
      // from what it showed.
      expect(JSON.parse(JSON.stringify(template.spec))).toEqual(template.spec);
    }
  });

  it('file suffixes follow the buffer: source gets .spec.ts, specs get .json', () => {
    for (const type of CREATABLE_TEST_TYPES) {
      const template = NEW_TEST_TEMPLATES[type]!;
      if (template.buffer === 'code') expect(template.fileSuffix).toBe('.spec.ts');
      else expect(template.fileSuffix).toMatch(/\.json$/);
    }
  });
});
