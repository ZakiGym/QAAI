import { describe, expect, it } from 'vitest';
import { FORM_FIELD_SEMANTICS, type FlowMap, type FormField } from './flow-map';
import { fillForm, syntheticValue } from './synthetic';

/**
 * The compatibility test for the constraint capture added to `FormField`.
 *
 * A FlowMap is STORED. Every crawl made before today sits in a database as JSON
 * with no `maxLength`, no `pattern`, no `inputMode` — so the new members have to
 * be optional in a way that is true at runtime and not merely true in the type
 * system. The risk is not that TypeScript complains; it is that a consumer
 * written against the new shape reads `field.maxLength`, gets `undefined`, and
 * either crashes or — worse — treats "nobody looked" as "the page declares no
 * limit" and reports a finding about a crawl that never recorded one.
 *
 * So this file parses a frozen pre-change FlowMap from a JSON STRING, exactly
 * as the API would off the wire, and runs the new consumers over it.
 */

/**
 * A FlowMap in the shape this repo produced before constraint capture existed.
 *
 * Deliberately a string literal and not a typed object: a typed fixture would
 * be updated by whoever next changes the interface, and then it would stop
 * being a record of the old shape, which is the only thing it is for.
 */
const PRE_CONSTRAINTS_FLOW_MAP_JSON = `{
  "projectId": "prj_1",
  "environmentId": "env_1",
  "version": 3,
  "baseUrl": "https://shop.example.com",
  "nodes": [
    {
      "id": "node-0",
      "route": "/checkout",
      "url": "https://shop.example.com/checkout",
      "title": "Checkout",
      "stateKey": "Checkout/f1/rnone/populated",
      "requiresRoles": [],
      "behindAuth": false,
      "forms": [
        {
          "id": "form-0",
          "name": "POST /checkout",
          "selector": { "strategy": "CSS", "value": "form:nth-of-type(1)", "confidence": 0.5 },
          "fields": [
            {
              "name": "email",
              "label": "Email",
              "inputType": "email",
              "required": true,
              "selector": { "strategy": "LABEL", "value": "Email", "confidence": 0.9 },
              "semantic": "email"
            },
            {
              "name": "cardNumber",
              "label": "Card number",
              "inputType": "text",
              "required": true,
              "selector": { "strategy": "LABEL", "value": "Card number", "confidence": 0.9 },
              "semantic": "credit_card"
            },
            {
              "name": "country",
              "label": "Country",
              "inputType": "select",
              "required": false,
              "selector": { "strategy": "LABEL", "value": "Country", "confidence": 0.9 },
              "semantic": "country",
              "options": ["Select a country", "Portugal", "Japan"]
            }
          ],
          "submit": { "strategy": "ROLE", "value": "button", "name": "Place order", "confidence": 0.95 }
        }
      ],
      "affordances": [],
      "screenshotKey": null,
      "a11yViolationCount": 0
    }
  ],
  "edges": [],
  "journeys": [],
  "features": [{ "name": "Checkout", "nodeIds": ["node-0"] }],
  "exploredAt": "2026-01-04T10:00:00.000Z",
  "truncatedReason": null
}`;

describe('an old-shaped FlowMap still loads', () => {
  const flowMap = JSON.parse(PRE_CONSTRAINTS_FLOW_MAP_JSON) as FlowMap;
  const form = flowMap.nodes[0]?.forms[0];
  const fields = form?.fields ?? [];

  it('parses, with every pre-existing member intact', () => {
    expect(flowMap.version).toBe(3);
    expect(form?.id).toBe('form-0');
    expect(fields).toHaveLength(3);
    expect(fields[0]?.name).toBe('email');
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.semantic).toBe('email');
    expect(fields[2]?.options).toEqual(['Select a country', 'Portugal', 'Japan']);
  });

  it('reports every new constraint as undefined — "nobody looked", not "nothing declared"', () => {
    // This is the distinction the whole optional-vs-null design exists for. A
    // consumer that cannot tell these apart will claim a pre-change crawl
    // declares no maxlength anywhere, which is a finding about the crawler
    // dressed up as a finding about the application.
    const field = fields[0] as FormField;
    for (const key of [
      'maxLength',
      'minLength',
      'min',
      'max',
      'step',
      'pattern',
      'inputMode',
      'autocomplete',
      'accept',
      'multiple',
      'validationMessage',
    ] as const) {
      expect(field[key], key).toBeUndefined();
    }
  });

  it('still produces valid synthetic values for every field', () => {
    const { values, notes } = fillForm(fields, { seed: 'run-old-map' });
    expect(values.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(values.cardNumber).toBe('4242424242424242');
    // The select's options survived the round trip, so the value is one of them
    // rather than a plausible country name the control does not offer.
    expect(['Portugal', 'Japan']).toContain(values.country);
    expect(notes).toEqual([]);
  });

  it('claims no honoured constraint it did not actually see', () => {
    const result = syntheticValue(fields[0] as FormField, { seed: 'run-old-map' });
    expect(result.honoured).toEqual([]);
    expect(result.unsatisfiable).toEqual([]);
  });
});

describe('FORM_FIELD_SEMANTICS', () => {
  it('keeps every name that predates the additions', () => {
    // These spellings travel in stored FlowMap JSON, so renaming one would
    // silently reclassify every field in every crawl already on disk.
    for (const name of [
      'email',
      'password',
      'person_name',
      'phone',
      'street_address',
      'city',
      'postal_code',
      'country',
      'credit_card',
      'card_expiry',
      'card_cvc',
      'date',
      'number',
      'search',
      'freeform',
      'unknown',
    ] as const) {
      expect(FORM_FIELD_SEMANTICS).toContain(name);
    }
  });

  it('adds the three that were missing', () => {
    expect(FORM_FIELD_SEMANTICS).toContain('url');
    expect(FORM_FIELD_SEMANTICS).toContain('username');
    expect(FORM_FIELD_SEMANTICS).toContain('currency');
  });

  it('has no duplicates', () => {
    expect(new Set(FORM_FIELD_SEMANTICS).size).toBe(FORM_FIELD_SEMANTICS.length);
  });

  it('is exhaustively handled by the synthetic factory', () => {
    // The guarantee that matters: a semantic added to the vocabulary without a
    // generator behind it would fall through to the 'unknown' branch and type
    // a meaningless token into a field, silently. This makes that a test
    // failure instead.
    for (const semantic of FORM_FIELD_SEMANTICS) {
      const result = syntheticValue({ name: `a_${semantic}`, semantic }, { seed: 'run-1' });
      expect(result.value, semantic).not.toBe('');
      if (semantic !== 'unknown') {
        expect(result.value, semantic).not.toMatch(/^qaai-[a-z0-9]{6}$/);
      }
    }
  });
});
