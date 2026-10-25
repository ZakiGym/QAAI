/**
 * Tests for the backend's whole surface: documents, introspection and probes.
 *
 * No network and no vendor SDK appears below, which is the point: every reader
 * in `api-surface.ts` takes its I/O as a one-method injected interface, so each
 * behaviour is driven by a literal. What is asserted here, in rough order of
 * how much it would cost to get wrong:
 *
 *   1. **A SILENCE NEVER BECOMES AN ANSWER.** Three property tests walk whole
 *      outputs rather than single fields: every axis's `found` is null exactly
 *      when it is UNAVAILABLE, every GraphQL reading's `operationsFound` is
 *      null unless it was MEASURED, and every bound that came from an unread
 *      schema has its constraint keys ABSENT rather than null. These are the
 *      three shapes of "a null that became 0" this module could ship.
 *   2. **The OpenAPI `security: [{}, {...}]` case.** The one every parser gets
 *      wrong, and getting it wrong means no negative-auth test is ever
 *      generated for an endpoint that really is open to the internet.
 *   3. **Introspection being off is not an API with no operations.** The
 *      refusal path has its own block, because reporting zero there hands a
 *      customer a denominator of zero and a coverage percentage of 100.
 *   4. **A 404 never confirms and never refutes.** Both halves: it does not
 *      promote an operation to CONFIRMED, and nothing anywhere records it as
 *      absent.
 *   5. **Nothing mutating leaves the prober, and every refusal is recorded.**
 *      A refused probe appears in the ledger with the rule that refused it, so
 *      it is a thing a customer can choose to allow rather than a surface that
 *      does not exist.
 *   6. **Every cap that bit is a count AND a reason.** Including the rate
 *      limit, whose cost is milliseconds rather than discarded candidates.
 *   7. **The union and its write path cannot drift.** `apiProbeFindingSchema`'s
 *      own options are compared against the presence record at run time — the
 *      half the compiler cannot see, and the half eight GateRule kinds shipped
 *      without.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CRAWL_POLICY, type ApiParameterBound, type CrawlPolicy } from '@qaai/shared';
import {
  API_DOCUMENT_KINDS,
  API_DOCUMENT_KIND_LABELS,
  API_INGEST_GAPS,
  API_INGEST_GAP_LABELS,
  API_PROBE_FINDING_KINDS,
  API_PROBE_FINDING_LABELS,
  API_PROBE_KINDS,
  API_PROBE_KIND_LABELS,
  API_SURFACE_AXES,
  API_SURFACE_AXIS_LABELS,
  API_SURFACE_CAPS,
  API_SURFACE_CAP_AS_CRAWL_CAP,
  API_SURFACE_CAP_LABELS,
  DEFAULT_API_SURFACE_CAPS,
  GRAPHQL_INTROSPECTION_DOCUMENT,
  GRAPHQL_ROOTS,
  GRAPHQL_SCHEMA_STATES,
  GRAPHQL_SCHEMA_STATE_LABELS,
  SAFE_PROBE_METHODS,
  apiAxisIsConsistent,
  apiProbeFindingSchema,
  apiSurfaceCapBites,
  detectApiDocumentKind,
  graphqlEndpointOperation,
  graphqlReadingIsConsistent,
  graphqlSurfaceIdentity,
  ingestApiDocument,
  introspectGraphqlSchema,
  postmanRequestTemplate,
  probeApiOperations,
  verificationAfterProbe,
  walkIntrospection,
  type ApiProbeFinding,
  type ApiProbeRequest,
  type ApiProbeResponse,
  type ApiProbeTransport,
  type ApiSurfaceCapBite,
  type GraphqlSchemaReading,
  type GraphqlTransport,
} from './api-surface.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * One OpenAPI 3.1 document carrying every case worth asserting, in one place:
 * a global security default, an operation that overrides it to the empty array,
 * an operation with the `{}`-plus-named OPTIONAL form, a local `$ref`, a remote
 * `$ref`, a composed schema, a path-level parameter an operation overrides, a
 * JSON body, and a multipart body.
 */
const OPENAPI: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '2' },
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    parameters: {
      Page: {
        name: 'page',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
    schemas: {
      NewOrder: {
        type: 'object',
        required: ['sku'],
        properties: {
          sku: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[A-Z]{3}-\\d+$' },
          quantity: { type: 'integer', minimum: 1, maximum: 99 },
          channel: { type: 'string', enum: ['web', 'ios', 'android'] },
        },
      },
    },
  },
  paths: {
    '/orders': {
      // A path-level parameter, which every verb under this item inherits.
      parameters: [{ $ref: '#/components/parameters/Page' }],
      get: {
        operationId: 'listOrders',
        // Declares BOTH anonymous and authenticated access: OPTIONAL.
        security: [{}, { bearer: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] } },
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createOrder',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        // Explicitly opts out of the global default: NONE.
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
      delete: {
        operationId: 'deleteOrder',
        parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
        responses: { '204': { description: 'gone' } },
      },
    },
    '/reports': {
      get: {
        operationId: 'report',
        // Bounds live in another file. NOT followed, and disclosed.
        parameters: [{ $ref: 'common.yaml#/components/parameters/Range' }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/imports': {
      post: {
        operationId: 'upload',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
        responses: { '202': { description: 'queued' } },
      },
      patch: {
        operationId: 'patchImport',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { allOf: [{ type: 'object' }, { required: ['mode'] }] },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
    // A path-level parameter the operation REPLACES with a different bound.
    '/audit': {
      parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', maximum: 10 } }],
      get: {
        operationId: 'audit',
        parameters: [{ name: 'page', in: 'query', schema: { type: 'integer', maximum: 9999 } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

const SWAGGER: Record<string, unknown> = {
  swagger: '2.0',
  info: { title: 'Legacy', version: '1' },
  securityDefinitions: { apiKey: { type: 'apiKey', name: 'X-Key', in: 'header' } },
  security: [{ apiKey: [] }],
  definitions: {
    Customer: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email', maxLength: 254 },
        age: { type: 'integer', minimum: 18, maximum: 120 },
      },
    },
  },
  paths: {
    '/customers': {
      get: {
        operationId: 'listCustomers',
        // Swagger 2.0 puts the keywords on the parameter itself.
        parameters: [
          { name: 'limit', in: 'query', type: 'integer', minimum: 1, maximum: 100 },
          { name: 'q', in: 'query', type: 'string', maxLength: 80 },
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createCustomer',
        parameters: [
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Customer' } },
        ],
        responses: { '201': { description: 'ok' } },
      },
    },
  },
};

function ingest(document: unknown, caps?: Partial<typeof DEFAULT_API_SURFACE_CAPS>) {
  return ingestApiDocument({
    document,
    sourceDocument: 'openapi.json',
    ...(caps ? { caps } : {}),
  });
}

function operation(result: ReturnType<typeof ingest>, method: string, template: string) {
  const found = result.operations.find(
    (entry) => entry.method === method && entry.pathTemplate === template,
  );
  expect(found, `${method} ${template} should have been read`).toBeDefined();
  return found!;
}

function bound(
  result: ReturnType<typeof ingest>,
  method: string,
  template: string,
  name: string,
): ApiParameterBound {
  const found = operation(result, method, template).parameters.find(
    (entry) => entry.name === name,
  );
  expect(found, `${name} should be a bound on ${method} ${template}`).toBeDefined();
  return found!;
}

// ─── 1. Detection ────────────────────────────────────────────────────────────

describe('detectApiDocumentKind', () => {
  it('keys on the version field each format is required to carry', () => {
    expect(detectApiDocumentKind(OPENAPI)).toMatchObject({
      kind: 'OPENAPI_3',
      version: '3.1.0',
    });
    expect(detectApiDocumentKind(SWAGGER)).toMatchObject({ kind: 'SWAGGER_2', version: '2.0' });
    expect(detectApiDocumentKind({ asyncapi: '3.0.0', channels: {} })).toMatchObject({
      kind: 'ASYNCAPI',
      version: '3.0.0',
    });
    expect(
      detectApiDocumentKind({
        info: { name: 'c', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
        item: [],
      }).kind,
    ).toBe('POSTMAN');
  });

  it('refuses rather than guesses, and both refusals are their own member', () => {
    // A YAML string is NOT_JSON, which is a different fact from unrecognised:
    // one needs a parser, the other needs a format we do not read.
    expect(detectApiDocumentKind('openapi: 3.0.0').kind).toBe('NOT_JSON');
    expect(detectApiDocumentKind(null).kind).toBe('NOT_JSON');
    expect(detectApiDocumentKind({ paths: { '/x': { get: {} } } }).kind).toBe('UNRECOGNISED');
  });

  it('does not read a bare `{ item: [] }` as a Postman collection', () => {
    // A structural check only on `item` would claim every array-holding JSON
    // file in a repo is a collection, and each would contribute operations.
    expect(detectApiDocumentKind({ item: [] }).kind).toBe('UNRECOGNISED');
  });

  it('labels every member', () => {
    for (const kind of API_DOCUMENT_KINDS) {
      expect(API_DOCUMENT_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

// ─── 2. OpenAPI 3.x ──────────────────────────────────────────────────────────

describe('ingestApiDocument — OpenAPI 3.x', () => {
  const result = ingest(OPENAPI);

  it('reads every declared verb of every path item', () => {
    expect(
      result.operations.map((entry) => `${entry.method} ${entry.pathTemplate}`).sort(),
    ).toEqual([
      'DELETE /orders/{id}',
      'GET /audit',
      'GET /orders',
      'GET /orders/{id}',
      'GET /reports',
      'PATCH /imports',
      'POST /imports',
      'POST /orders',
    ]);
  });

  describe('the five-valued auth declaration', () => {
    it('reads `security: [{}, {named}]` as OPTIONAL, not REQUIRED', () => {
      /*
       * THE DEFECT THIS PREVENTS: read as REQUIRED, no negative-auth test is
       * ever generated for an operation that really is open to the internet.
       * Read as NONE, a 401 would be reported as a failure of a correct app.
       */
      expect(operation(result, 'GET', '/orders').authDeclaration).toBe('OPTIONAL');
    });

    it('reads `security: []` as NONE — an explicit opt-out of the global default', () => {
      expect(operation(result, 'GET', '/orders/{id}').authDeclaration).toBe('NONE');
    });

    it('inherits the document-level default when the operation is silent', () => {
      expect(operation(result, 'POST', '/orders').authDeclaration).toBe('REQUIRED');
      expect(operation(result, 'DELETE', '/orders/{id}').authDeclaration).toBe('REQUIRED');
    });

    it('is UNSTATED when neither the operation nor the document says anything', () => {
      const silent = ingest({
        openapi: '3.0.0',
        paths: { '/ping': { get: { responses: {} } } },
      });
      expect(operation(silent, 'GET', '/ping').authDeclaration).toBe('UNSTATED');
      // And the caveat refuses to let a generator mint an assertion from it.
      expect(silent.caveats.join(' ')).toContain('a 401 from any of them proves');
    });

    it('files a gap for a scheme the document never defines, and still counts it', () => {
      const undefinedScheme = ingest({
        openapi: '3.0.0',
        paths: { '/x': { get: { security: [{ mystery: [] }], responses: {} } } },
      });
      expect(operation(undefinedScheme, 'GET', '/x').authDeclaration).toBe('REQUIRED');
      expect(undefinedScheme.gaps.map((gap) => gap.kind)).toContain('SECURITY_SCHEME_UNDEFINED');
    });
  });

  describe('parameter bounds', () => {
    it('lifts min/max/length/pattern/enum, which is what negative tests are built from', () => {
      expect(bound(result, 'POST', '/orders', 'quantity')).toMatchObject({
        location: 'BODY',
        type: 'integer',
        minimum: 1,
        maximum: 99,
      });
      expect(bound(result, 'POST', '/orders', 'sku')).toMatchObject({
        minLength: 3,
        maxLength: 32,
        pattern: '^[A-Z]{3}-\\d+$',
      });
      expect(bound(result, 'POST', '/orders', 'channel').enumValues).toEqual([
        'web',
        'ios',
        'android',
      ]);
    });

    it('carries `format` into the type instead of dropping it', () => {
      // `type: string` alone invites a negative test that sends "x" at a field
      // documented as an email and calls the resulting 400 a defect.
      const swagger = ingestApiDocument({ document: SWAGGER, sourceDocument: 's.json' });
      expect(
        swagger.operations
          .find((entry) => entry.method === 'POST')
          ?.parameters.find((entry) => entry.name === 'email')?.type,
      ).toBe('string/email');
    });

    it('resolves a local $ref and inherits a path-level parameter', () => {
      expect(bound(result, 'GET', '/orders', 'page')).toMatchObject({
        location: 'QUERY',
        minimum: 1,
        maximum: 500,
        required: false,
      });
    });

    it('lets an operation-level parameter REPLACE the path-level one, not duplicate it', () => {
      /*
       * Both specifications say the operation wins. Concatenating instead
       * yields two bounds for one parameter, and `boundaryEdges` would then
       * generate two contradictory negative tests for the same field.
       */
      const pages = operation(result, 'GET', '/audit').parameters.filter(
        (entry) => entry.name === 'page',
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]?.maximum).toBe(9999);
    });

    it('defaults `required` to null, except on a path parameter where the spec decides', () => {
      // DELETE /orders/{id} declares no `required` on `id`; the specification
      // makes a path parameter mandatory, so `true` is the document speaking.
      expect(bound(result, 'DELETE', '/orders/{id}', 'id').required).toBe(true);
      // A query parameter with no annotation is null, never false: "optional"
      // would be a claim the author never made.
      expect(bound(result, 'GET', '/orders', 'status').required).toBeNull();
    });

    it('reads a bound the schema omits as null — the declaration states no bound', () => {
      const status = bound(result, 'GET', '/orders', 'status');
      expect(status.maximum).toBeNull();
      expect(status.maxLength).toBeNull();
      // and the keys are PRESENT, because the schema was read.
      expect('maxLength' in status).toBe(true);
    });
  });

  describe('request bodies', () => {
    it('takes bounds from a JSON body and keeps the whole schema on requestShape', () => {
      const post = operation(result, 'POST', '/orders');
      expect(post.parameters.filter((entry) => entry.location === 'BODY')).toHaveLength(3);
      expect(post.requestShape).toMatchObject({ type: 'object' });
    });

    it('marks a property required only when the BODY itself is required', () => {
      /*
       * A property that is required INSIDE an optional body is only required
       * once the body is sent. Asserting "this field is required" of a field in
       * a body nobody has to send is a negative test that fails against a
       * correct application.
       */
      expect(bound(result, 'POST', '/orders', 'sku').required).toBe(true);
      const optionalBody = ingest({
        openapi: '3.0.0',
        paths: {
          '/x': {
            post: {
              requestBody: {
                required: false,
                content: {
                  'application/json': {
                    schema: { type: 'object', required: ['sku'], properties: { sku: {} } },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      expect(bound(optionalBody, 'POST', '/x', 'sku').required).toBe(false);
    });

    it('discloses a media type it takes no bounds from, rather than reporting none', () => {
      const gap = result.gaps.find((entry) => entry.kind === 'BODY_MEDIA_TYPE_NOT_READ');
      expect(gap?.pointer).toBe('/paths/~1imports/post/requestBody/content');
      expect(gap?.detail).toContain('multipart/form-data');
      expect(gap?.detail).toContain('absent rather than stated as none');
      // The operation is still counted: it exists whether or not we read it.
      expect(operation(result, 'POST', '/imports')).toBeDefined();
    });
  });

  describe('$ref and composition: the reader\'s own blind spots, named', () => {
    it('does not follow a remote $ref, and leaves the bounds ABSENT not null', () => {
      /*
       * THE LIE THIS PREVENTS: `maxLength: null` means "the declaration states
       * no limit", which entitles a test to post 10,000 characters. A remote
       * $ref we never read declares nothing we have seen, so the keys must not
       * be there at all.
       */
      const gap = result.gaps.find((entry) => entry.kind === 'REMOTE_REF_NOT_FOLLOWED');
      expect(gap?.detail).toContain('common.yaml');
      expect(result.caveats.join(' ')).toContain('were not followed');
      expect(operation(result, 'GET', '/reports').parameters).toEqual([]);
    });

    it('says out loud that it did not descend into a nested object or array', () => {
      /*
       * THE LIE THIS PREVENTS: the bound pushed for a nested property carries
       * `minimum: null`, `maxLength: null` and the rest, which reads as "this
       * field's declaration states no limits". The limits live one level down
       * and nobody looked — the three-state rule's absent case leaking in
       * through a different door.
       */
      const nested = ingest({
        openapi: '3.0.0',
        paths: {
          '/x': {
            post: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        address: {
                          type: 'object',
                          properties: { postcode: { type: 'string', maxLength: 8 } },
                        },
                        tags: { type: 'array', items: { type: 'string', maxLength: 20 } },
                        name: { type: 'string', maxLength: 50 },
                      },
                    },
                  },
                },
              },
              responses: {},
            },
          },
        },
      });
      const disclosed = nested.gaps.filter(
        (gap) => gap.kind === 'NESTED_SHAPE_NOT_DESCENDED',
      );
      expect(disclosed.map((gap) => gap.pointer).sort()).toEqual([
        '/paths/~1x/post/requestBody/content/application~1json/schema/properties/address',
        '/paths/~1x/post/requestBody/content/application~1json/schema/properties/tags',
      ]);
      expect(disclosed[0]?.detail).toContain('absent from this operation rather than stated as none');
      // The flat property is NOT disclosed, because its bounds really were read.
      expect(bound(nested, 'POST', '/x', 'name').maxLength).toBe(50);
      expect(nested.caveats.join(' ')).toContain('did not descend');
    });

    it('names the composition keyword that stopped the read', () => {
      const gap = result.gaps.find((entry) => entry.kind === 'COMPOSED_SCHEMA_NOT_READ');
      expect(gap?.detail).toContain('allOf');
      expect(gap?.detail).toContain('absent rather than stated as none');
      // The whole schema survives on requestShape, so nothing is lost.
      expect(operation(result, 'PATCH', '/imports').requestShape).toMatchObject({
        allOf: expect.any(Array),
      });
    });

    it('reports a cycle instead of following it for ever', () => {
      const cyclic = ingest({
        openapi: '3.0.0',
        components: { parameters: { A: { $ref: '#/components/parameters/B' }, B: { $ref: '#/components/parameters/A' } } },
        paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/A' }], responses: {} } } },
      });
      expect(cyclic.gaps.map((gap) => gap.kind)).toContain('REF_CYCLE');
    });

    it('reports an unresolvable local $ref as unresolved, not as an empty schema', () => {
      const dangling = ingest({
        openapi: '3.0.0',
        paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Nope' }], responses: {} } } },
      });
      const gap = dangling.gaps.find((entry) => entry.kind === 'LOCAL_REF_UNRESOLVED');
      expect(gap?.detail).toContain('resolves to nothing');
    });

    it('abandons a chain deeper than the cap and discloses the cap', () => {
      const document: Record<string, unknown> = {
        openapi: '3.0.0',
        components: { parameters: {} as Record<string, unknown> },
        paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/p0' }], responses: {} } } },
      };
      const parameters = (document.components as Record<string, Record<string, unknown>>)
        .parameters as Record<string, unknown>;
      for (let index = 0; index < 10; index += 1) {
        parameters[`p${index}`] = { $ref: `#/components/parameters/p${index + 1}` };
      }
      const deep = ingest(document, { refDepth: 3 });
      const gap = deep.gaps.find((entry) => entry.kind === 'REF_DEPTH_EXCEEDED');
      expect(gap?.detail).toContain('deeper than 3');
    });
  });
});

// ─── 3. Swagger 2.0 ──────────────────────────────────────────────────────────

describe('ingestApiDocument — Swagger 2.0', () => {
  const result = ingestApiDocument({ document: SWAGGER, sourceDocument: 'swagger.json' });

  it('reads bounds that live on the parameter rather than in a nested schema', () => {
    /*
     * THE DEFECT THIS PREVENTS: reading only the 3.x shape against a 2.0
     * document produces a parameter list with every bound null — "this API
     * declares no limits on anything" — which suppresses every negative test
     * the document entitles us to write.
     */
    const limit = result.operations
      .find((entry) => entry.method === 'GET')
      ?.parameters.find((entry) => entry.name === 'limit');
    expect(limit).toMatchObject({ location: 'QUERY', minimum: 1, maximum: 100 });
  });

  it('expands an `in: body` parameter into the properties it stands for', () => {
    const post = result.operations.find((entry) => entry.method === 'POST');
    const body = post?.parameters.filter((entry) => entry.location === 'BODY') ?? [];
    expect(body.map((entry) => entry.name).sort()).toEqual(['age', 'email']);
    expect(body.find((entry) => entry.name === 'age')).toMatchObject({ minimum: 18, maximum: 120 });
    // The opaque `body` parameter itself is gone, not left alongside them.
    expect(body.some((entry) => entry.name === 'body')).toBe(false);
  });

  it('reads security out of `securityDefinitions`, not `components`', () => {
    expect(result.operations.every((entry) => entry.authDeclaration === 'REQUIRED')).toBe(true);
    expect(result.gaps.some((gap) => gap.kind === 'SECURITY_SCHEME_UNDEFINED')).toBe(false);
  });
});

// ─── 4. AsyncAPI and Postman ─────────────────────────────────────────────────

describe('ingestApiDocument — AsyncAPI', () => {
  const result = ingestApiDocument({
    document: {
      asyncapi: '3.0.0',
      channels: {
        'order.webhook': {
          address: '/hooks/order',
          title: 'orderWebhook',
          bindings: { http: { method: 'post' } },
        },
        'orders.created': { bindings: { kafka: { topic: 'orders.created' } } },
        'no.bindings': {},
      },
    },
    sourceDocument: 'asyncapi.json',
  });

  it('files an HTTP-bound channel as an operation', () => {
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      method: 'POST',
      pathTemplate: '/hooks/order',
      operationId: 'orderWebhook',
      // A channel is silent about auth by construction: security is on the
      // SERVER. UNSTATED says that; NONE would call the channel public.
      authDeclaration: 'UNSTATED',
    });
  });

  it('refuses to mint `UNKNOWN /topic` for a channel with no method or path', () => {
    /*
     * A Kafka topic is a real surface and belongs on the background-surface
     * inventory. A row in a table keyed on `(method, pathTemplate)` for a thing
     * with neither is a denominator entry nobody can test or match.
     */
    const channels = result.gaps.filter((gap) => gap.kind === 'CHANNEL_NOT_HTTP');
    expect(channels).toHaveLength(2);
    expect(result.caveats.join(' ')).toContain('background-surface inventory');
  });
});

describe('ingestApiDocument — Postman', () => {
  const result = ingestApiDocument({
    document: {
      info: { name: 'Orders', _postman_id: 'abc' },
      item: [
        {
          name: 'Orders',
          item: [
            { name: 'list', request: { method: 'GET', url: { raw: '{{baseUrl}}/orders?page=2' } } },
            {
              name: 'detail',
              request: { method: 'get', url: '{{baseUrl}}/orders/{{orderId}}' },
            },
          ],
        },
        { name: 'broken', request: { method: 'WAT', url: { raw: '{{baseUrl}}/x' } } },
        { name: 'not a request' },
      ],
    },
    sourceDocument: 'collection.json',
  });

  it('normalises a collection URL into the same template an OpenAPI document would write', () => {
    // `{{orderId}}` → `{orderId}` so the same endpoint declared in both lands
    // on one key instead of doubling the denominator; the query is dropped for
    // the same reason.
    expect(result.operations.map((entry) => entry.pathTemplate)).toContain('/orders');
    expect(result.operations.map((entry) => entry.pathTemplate)).toContain('/orders/{orderId}');
  });

  it('records a collection as NOT_READ about auth — our silence, not the server\'s', () => {
    /*
     * A saved request with no Authorization header is not a server declaring
     * the endpoint public. NONE here would authorise a negative-auth test for
     * every request in the collection.
     */
    expect(result.operations.every((entry) => entry.authDeclaration === 'NOT_READ')).toBe(true);
    expect(result.availability.AUTH.state).toBe('UNAVAILABLE');
    expect(result.availability.AUTH.found).toBeNull();
  });

  it('keeps an unreadable verb as UNKNOWN rather than guessing GET', () => {
    expect(result.operations.find((entry) => entry.operationId === 'broken')?.method).toBe(
      'UNKNOWN',
    );
  });

  it('files a non-request item as a gap instead of dropping it silently', () => {
    expect(result.gaps.some((gap) => gap.kind === 'NOT_AN_OPERATION')).toBe(true);
  });
});

describe('postmanRequestTemplate', () => {
  it('strips a leading base-URL variable but keeps one in the middle of a path', () => {
    expect(postmanRequestTemplate('{{baseUrl}}/users/{{userId}}/orders')).toBe(
      '/users/{userId}/orders',
    );
    expect(postmanRequestTemplate('https://api.example.com/v1/orders?page=2')).toBe('/v1/orders');
    expect(postmanRequestTemplate(null)).toBe('/');
    expect(postmanRequestTemplate('orders')).toBe('/orders');
  });
});

// ─── 5. The silence invariants, as properties ────────────────────────────────

describe('no axis reports an unmeasured thing as zero', () => {
  const documents: Array<[string, unknown]> = [
    ['openapi', OPENAPI],
    ['swagger', SWAGGER],
    ['asyncapi', { asyncapi: '2.6.0', channels: {} }],
    ['postman', { info: { _postman_id: 'x' }, item: [] }],
    ['unrecognised', { hello: 'world' }],
    ['not json', 'openapi: 3.0.0'],
  ];

  for (const [name, document] of documents) {
    it(`holds for ${name}`, () => {
      const result = ingestApiDocument({ document, sourceDocument: name });
      for (const axis of API_SURFACE_AXES) {
        const state = result.availability[axis];
        expect(apiAxisIsConsistent(state), `${axis}: ${JSON.stringify(state)}`).toBe(true);
      }
    });
  }

  it('says plainly that zero operations is OUR silence when nothing was read', () => {
    const unread = ingestApiDocument({ document: 'not json', sourceDocument: 'x.yaml' });
    expect(unread.operations).toEqual([]);
    expect(unread.caveats.join(' ')).toContain('must never be rendered as an API with no');
    for (const axis of API_SURFACE_AXES) {
      expect(unread.availability[axis].state).toBe('UNAVAILABLE');
    }
  });

  it('labels every axis', () => {
    for (const axis of API_SURFACE_AXES) {
      expect(API_SURFACE_AXIS_LABELS[axis].length).toBeGreaterThan(0);
    }
  });

  it('labels every gap kind', () => {
    for (const kind of API_INGEST_GAPS) {
      expect(API_INGEST_GAP_LABELS[kind].length).toBeGreaterThan(0);
    }
  });

  it('gives every gap a locatable pointer', () => {
    // A gap with no location is a caveat nobody can act on, and a report full
    // of unlocatable caveats is one people learn to scroll past.
    const result = ingest(OPENAPI);
    expect(result.gaps.length).toBeGreaterThan(0);
    for (const gap of result.gaps) {
      expect(gap.pointer.startsWith('/'), gap.pointer).toBe(true);
      expect(gap.detail.length).toBeGreaterThan(0);
    }
  });
});

// ─── 6. Caps ─────────────────────────────────────────────────────────────────

describe('caps are disclosed as a count and a reason', () => {
  it('reports the operation budget when it bites, with what it cost', () => {
    const capped = ingest(OPENAPI, { operationBudget: 3 });
    expect(capped.operations).toHaveLength(3);
    const bite = capped.caps.find((entry) => entry.cap === 'OPERATION_BUDGET');
    expect(bite).toMatchObject({ limit: 3, bites: 5, discarded: 5 });
    expect(bite?.reason).toContain('at least that many more are declared');
  });

  it('does not report a cap that did not bite', () => {
    // A cap that did not bite is not a caveat.
    expect(ingest(OPENAPI).caps).toEqual([]);
  });

  it('hands back the caps it cannot express rather than losing them', () => {
    const bites: ApiSurfaceCapBite[] = API_SURFACE_CAPS.map((cap) => ({
      cap,
      limit: 1,
      bites: 1,
      discarded: 1,
      scope: null,
      reason: 'x',
    }));
    const { capBites, unexpressible } = apiSurfaceCapBites(bites);
    // Today none of the five has a home in CRAWL_CAPS, and the point is that
    // they come back in a named field instead of being dropped.
    expect(capBites).toHaveLength(
      API_SURFACE_CAPS.filter((cap) => API_SURFACE_CAP_AS_CRAWL_CAP[cap] !== null).length,
    );
    expect(unexpressible.map((entry) => entry.cap).sort()).toEqual([...API_SURFACE_CAPS].sort());
  });

  it('labels every cap', () => {
    for (const cap of API_SURFACE_CAPS) {
      expect(API_SURFACE_CAP_LABELS[cap].length).toBeGreaterThan(0);
    }
  });
});

// ─── 7. GraphQL ──────────────────────────────────────────────────────────────

const SCHEMA_BODY = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: { name: 'Subscription' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'orders',
              isDeprecated: false,
              args: [
                { name: 'first', type: { kind: 'SCALAR', name: 'Int' } },
                {
                  name: 'status',
                  type: { kind: 'NON_NULL', name: null, ofType: { kind: 'ENUM', name: 'Status' } },
                },
              ],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'LIST', name: null, ofType: { kind: 'OBJECT', name: 'Order' } },
              },
            },
            { name: 'legacyOrders', isDeprecated: true, args: [], type: { kind: 'OBJECT', name: 'Order' } },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            {
              name: 'createOrder',
              isDeprecated: false,
              args: [
                {
                  name: 'input',
                  type: { kind: 'NON_NULL', name: null, ofType: { kind: 'INPUT_OBJECT', name: 'OrderInput' } },
                },
              ],
              type: { kind: 'OBJECT', name: 'Order' },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Subscription',
          fields: [{ name: 'orderChanged', isDeprecated: false, args: [], type: { kind: 'OBJECT', name: 'Order' } }],
        },
        { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }] },
        {
          kind: 'INPUT_OBJECT',
          name: 'OrderInput',
          inputFields: [
            { name: 'sku', type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String' } } },
            { name: 'note', type: { kind: 'SCALAR', name: 'String' } },
          ],
        },
        { kind: 'OBJECT', name: 'Order', fields: [{ name: 'id', isDeprecated: false, args: [], type: { kind: 'SCALAR', name: 'ID' } }] },
      ],
    },
  },
};

describe('walkIntrospection', () => {
  const reading = walkIntrospection(SCHEMA_BODY);

  it('walks all three roots, not just the operations somebody named', () => {
    /*
     * THE DEFECT THIS FIXES: the protocol runner's `introspect` only checks the
     * ROOT FIELDS of operations already in a spec file, so a backend with 300
     * queries enumerates as however many entries the file holds.
     */
    expect(reading.state).toBe('MEASURED');
    expect(reading.operationsFound).toBe(4);
    expect(reading.operations.map((entry) => entry.path).sort()).toEqual([
      'Mutation.createOrder',
      'Query.legacyOrders',
      'Query.orders',
      'Subscription.orderChanged',
    ]);
  });

  it('counts a deprecated field, which is the one most likely to be broken', () => {
    const legacy = reading.operations.find((entry) => entry.field === 'legacyOrders');
    expect(legacy?.deprecated).toBe(true);
  });

  it('marks a mutation as mutating, which is what stops a generator driving it', () => {
    expect(reading.operations.find((entry) => entry.root === 'MUTATION')?.mutating).toBe(true);
    expect(reading.operations.find((entry) => entry.root === 'QUERY')?.mutating).toBe(false);
  });

  it('unwraps NON_NULL and LIST to the named type', () => {
    const orders = reading.operations.find((entry) => entry.field === 'orders');
    expect(orders).toMatchObject({ returnType: 'Order', returnNonNull: true });
  });

  it('reads an argument as a BODY bound — a GraphQL argument is not a query string', () => {
    /*
     * A generator reading QUERY would build `?status=OPEN`, which a GraphQL
     * endpoint ignores entirely, and the resulting 200 would be reported as the
     * argument being accepted.
     */
    const orders = reading.operations.find((entry) => entry.field === 'orders');
    expect(orders?.arguments.every((entry) => entry.location === 'BODY')).toBe(true);
    expect(orders?.arguments.find((entry) => entry.name === 'status')).toMatchObject({
      required: true,
      type: 'Status',
      enumValues: ['OPEN', 'CLOSED'],
    });
    expect(orders?.arguments.find((entry) => entry.name === 'first')?.required).toBe(false);
  });

  it('leaves length and numeric bounds ABSENT, because GraphQL cannot declare them', () => {
    /*
     * `maxLength: null` would mean "the schema declares no length limit", which
     * entitles a test to post 10,000 characters. GraphQL has no such keyword,
     * so the key must not be there at all — our blind spot, not the API's.
     */
    for (const operation of reading.operations) {
      for (const argument of operation.arguments) {
        expect('maxLength' in argument, `${operation.path}.${argument.name}`).toBe(false);
        expect('minimum' in argument).toBe(false);
        expect('pattern' in argument).toBe(false);
      }
    }
  });

  it('reads input object types and their non-null constraints', () => {
    const input = reading.inputTypes.find((entry) => entry.name === 'OrderInput');
    expect(input?.fields.find((entry) => entry.name === 'sku')?.required).toBe(true);
    expect(input?.fields.find((entry) => entry.name === 'note')?.required).toBe(false);
  });

  describe('introspection being off is not an API with no operations', () => {
    it('reports INTROSPECTION_REFUSED with operationsFound NULL', () => {
      /*
       * THE LIE THIS PREVENTS: zero here is a denominator of zero and a
       * coverage percentage of 100 for a backend nobody measured.
       */
      const refused = walkIntrospection({
        data: null,
        errors: [{ message: 'GraphQL introspection is not allowed by Apollo Server' }],
      });
      expect(refused.state).toBe('INTROSPECTION_REFUSED');
      expect(refused.operationsFound).toBeNull();
      expect(refused.operations).toEqual([]);
      expect(refused.reason).toContain('UNKNOWN');
    });

    it('separates a refusal from any other error envelope', () => {
      const other = walkIntrospection({ errors: [{ message: 'rate limited' }] });
      expect(other.state).toBe('UNREADABLE');
      expect(other.operationsFound).toBeNull();
    });

    it('still walks a schema that came back alongside warnings', () => {
      // A server can answer with both; discarding the schema because `errors`
      // is non-empty would lose a measurement we actually have.
      const both = walkIntrospection({ ...SCHEMA_BODY, errors: [{ message: 'deprecated' }] });
      expect(both.state).toBe('MEASURED');
      expect(both.operationsFound).toBe(4);
    });
  });

  it('reports a root type whose fields are unreadable as unknown, not empty', () => {
    const headless = walkIntrospection({
      data: {
        __schema: { queryType: { name: 'Query' }, types: [{ kind: 'OBJECT', name: 'Query' }] },
      },
    });
    expect(headless.operations).toEqual([]);
    expect(headless.gaps[0]?.detail).toContain('unknown rather than absent');
  });

  it('discloses the type budget when it bites', () => {
    const capped = walkIntrospection(SCHEMA_BODY, { caps: { introspectionTypeBudget: 2 } });
    const bite = capped.caps.find((entry) => entry.cap === 'INTROSPECTION_TYPE_BUDGET');
    expect(bite).toMatchObject({ limit: 2, discarded: 4 });
    expect(bite?.reason).toContain('at least that many more types exist');
  });

  it('asks for deprecated fields and unwraps deeply enough for [[Int!]!]!', () => {
    expect(GRAPHQL_INTROSPECTION_DOCUMENT).toContain('includeDeprecated: true');
    // Seven levels of ofType; six would report the innermost type as null.
    expect(GRAPHQL_INTROSPECTION_DOCUMENT.match(/ofType/g)?.length).toBeGreaterThanOrEqual(7);
  });
});

describe('introspectGraphqlSchema', () => {
  const transportFor = (response: Partial<GraphqlTransportResponseLike>): GraphqlTransport => ({
    post: async () => ({ status: 200, body: SCHEMA_BODY, error: null, ...response }),
  });
  type GraphqlTransportResponseLike = { status: number | null; body: unknown; error: string | null };

  it('walks the schema when one comes back', async () => {
    const reading = await introspectGraphqlSchema({ transport: transportFor({}) });
    expect(reading.state).toBe('MEASURED');
  });

  it('is NOT_ATTEMPTED with no transport — we did not look', async () => {
    const reading = await introspectGraphqlSchema({ transport: null });
    expect(reading.state).toBe('NOT_ATTEMPTED');
    expect(reading.operationsFound).toBeNull();
  });

  it('is NO_ANSWER when nothing answered, never an empty schema', async () => {
    const refused = await introspectGraphqlSchema({
      transport: transportFor({ status: null, body: null, error: 'ECONNREFUSED' }),
    });
    expect(refused.state).toBe('NO_ANSWER');
    expect(refused.reason).toContain('ECONNREFUSED');

    const thrown = await introspectGraphqlSchema({
      transport: {
        post: async () => {
          throw new Error('socket hang up');
        },
      },
    });
    expect(thrown.state).toBe('NO_ANSWER');
    expect(thrown.reason).toContain('socket hang up');
  });

  it('reads a 400 that carries a refusal as a REFUSAL, not as an unreadable answer', async () => {
    /*
     * Servers commonly answer 400 with the refusal in `errors`. Treating the
     * status as the answer would record it as UNREADABLE and lose exactly the
     * distinction this item exists to make.
     */
    const reading = await introspectGraphqlSchema({
      transport: transportFor({
        status: 400,
        body: { errors: [{ message: 'introspection is disabled' }] },
      }),
    });
    expect(reading.state).toBe('INTROSPECTION_REFUSED');
  });

  it('every state keeps its own fields consistent', async () => {
    const readings: GraphqlSchemaReading[] = [
      await introspectGraphqlSchema({ transport: transportFor({}) }),
      await introspectGraphqlSchema({ transport: null }),
      await introspectGraphqlSchema({ transport: transportFor({ status: null, error: 'x' }) }),
      await introspectGraphqlSchema({
        transport: transportFor({ body: { errors: [{ message: 'introspection off' }] } }),
      }),
      await introspectGraphqlSchema({ transport: transportFor({ body: 'nope' }) }),
    ];
    expect(new Set(readings.map((reading) => reading.state)).size).toBe(5);
    for (const reading of readings) {
      expect(graphqlReadingIsConsistent(reading), JSON.stringify(reading.state)).toBe(true);
    }
  });

  it('labels every state and every root', () => {
    for (const state of GRAPHQL_SCHEMA_STATES) {
      expect(GRAPHQL_SCHEMA_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
    expect([...GRAPHQL_ROOTS]).toEqual(['QUERY', 'MUTATION', 'SUBSCRIPTION']);
  });
});

describe('a GraphQL field is a surface, and the endpoint is the operation', () => {
  const reading = walkIntrospection(SCHEMA_BODY);

  it('gives every field its own registry identity', () => {
    /*
     * `ApiOperation` is keyed `(projectId, method, pathTemplate)` and every
     * field is reached by `POST /graphql`. Writing them as operation rows would
     * collapse 440 operations into 1 — the worst number this file could make.
     */
    const identities = reading.operations.map((operation) =>
      graphqlSurfaceIdentity('/graphql', operation),
    );
    expect(new Set(identities).size).toBe(reading.operations.length);
    expect(identities).toContain('ENDPOINT:POST /graphql#Query.orders');
  });

  it('files ONE operation for the transport endpoint, with the field count as evidence', () => {
    const endpoint = graphqlEndpointOperation({
      endpointPath: '/graphql',
      sourceDocument: 'introspection',
      reading,
    });
    expect(endpoint).toMatchObject({ method: 'POST', pathTemplate: '/graphql' });
    expect(endpoint.evidence).toContain('4 root field(s)');
    // Introspecting anonymously says INTROSPECTION is open, not that `orders`
    // is; NONE here would authorise a negative-auth test against every mutation.
    expect(endpoint.authDeclaration).toBe('NOT_READ');
  });

  it('says the count is UNKNOWN when introspection was refused', () => {
    const refused = walkIntrospection({ errors: [{ message: 'introspection disabled' }] });
    const endpoint = graphqlEndpointOperation({
      endpointPath: '/graphql',
      sourceDocument: 'introspection',
      reading: refused,
    });
    expect(endpoint.evidence).toContain('unknown');
    expect(endpoint.evidence).not.toMatch(/\b0 root field/);
  });
});

// ─── 8. Probing ──────────────────────────────────────────────────────────────

/** A transport that answers from a script and records every request. */
function fakeTransport(script: Record<string, Partial<ApiProbeResponse>>): {
  transport: ApiProbeTransport;
  sent: ApiProbeRequest[];
} {
  const sent: ApiProbeRequest[] = [];
  return {
    sent,
    transport: {
      send: async (request) => {
        sent.push(request);
        const path = new URL(request.url).pathname;
        const scripted = script[`${request.method} ${path}`] ?? script[request.method] ?? {};
        return { status: 200, headers: {}, error: null, ...scripted };
      },
    },
  };
}

/** A clock that never actually waits, and records what it was asked to wait. */
function fakeClock(): { clock: { now(): number; sleep(ms: number): Promise<void> }; waits: number[] } {
  const waits: number[] = [];
  let time = 1_000;
  return {
    waits,
    clock: {
      now: () => time,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
    },
  };
}

const policy: CrawlPolicy = DEFAULT_CRAWL_POLICY;

describe('probeApiOperations', () => {
  it('sends nothing and blames the configuration when there is no base URL', async () => {
    const { transport, sent } = fakeTransport({});
    const report = await probeApiOperations({
      transport,
      baseUrl: null,
      operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
      policy,
    });
    expect(sent).toEqual([]);
    expect(report.verdicts[0]).toMatchObject({
      verification: 'NOT_PROBED',
      notProbedReason: 'NO_BASE_URL',
    });
    expect(report.verdicts[0]?.detail).toContain('says nothing about whether the operation exists');
  });

  describe('read-only by default', () => {
    it('refuses a mutating verb AND records the refusal with its rule', async () => {
      const { transport, sent } = fakeTransport({});
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [
          { method: 'DELETE', pathTemplate: '/orders/{id}', authDeclaration: 'REQUIRED' },
          { method: 'POST', pathTemplate: '/orders', authDeclaration: 'REQUIRED' },
        ],
        policy,
      });
      expect(sent).toEqual([]);
      expect(report.refused).toHaveLength(2);
      expect(report.refused[0]).toMatchObject({ kind: 'UNSAFE_METHOD', route: '/orders/{id}' });
      expect(report.refused[0]?.rule).toContain('read-only by default');
      expect(report.verdicts.every((verdict) => verdict.notProbedReason === 'UNSAFE_VERB')).toBe(
        true,
      );
    });

    it('needs BOTH switches before a mutating verb leaves the process', async () => {
      const operations = [
        { method: 'DELETE' as const, pathTemplate: '/orders/{id}', authDeclaration: 'NONE' as const },
      ];
      const one = fakeTransport({});
      await probeApiOperations({
        transport: one.transport,
        baseUrl: 'https://app.test',
        operations,
        policy,
        allowUnsafeVerbs: true,
      });
      expect(one.sent, 'allowUnsafeVerbs alone must not be enough').toEqual([]);

      const both = fakeTransport({});
      const report = await probeApiOperations({
        transport: both.transport,
        baseUrl: 'https://app.test',
        operations,
        policy: { ...policy, allowDestructive: true },
        allowUnsafeVerbs: true,
      });
      expect(both.sent.map((request) => request.method)).toEqual(['DELETE']);
      expect(report.refused).toEqual([]);
    });

    it('only GET, HEAD and OPTIONS are safe', () => {
      expect([...SAFE_PROBE_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS']);
    });

    it('refuses an UNKNOWN verb for want of a request, not for safety', async () => {
      const { transport, sent } = fakeTransport({});
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'UNKNOWN', pathTemplate: '/orders', authDeclaration: 'NOT_READ' }],
        policy,
        allowUnsafeVerbs: true,
      });
      expect(sent).toEqual([]);
      expect(report.refused[0]?.rule).toContain('UNKNOWN');
      expect(report.verdicts[0]?.detail).toContain('guessed method');
    });
  });

  it('records a policy refusal with the rule that refused it, before any budget decision', async () => {
    const { transport, sent } = fakeTransport({});
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [{ method: 'GET', pathTemplate: '/logout', authDeclaration: 'NONE' }],
      policy,
      caps: { probeBudget: 0 },
    });
    expect(sent).toEqual([]);
    // The POLICY gate ran first, so this is not filed as a budget decision —
    // and the budget's `discarded` is not inflated by a path we would never
    // have visited.
    expect(report.verdicts[0]?.notProbedReason).toBe('REFUSED_BY_POLICY');
    expect(report.caps).toEqual([]);
  });

  it('discloses the probe budget as a count and a reason when it bites', async () => {
    const { transport } = fakeTransport({ GET: { status: 200 } });
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [
        { method: 'GET', pathTemplate: '/a', authDeclaration: 'NONE' },
        { method: 'GET', pathTemplate: '/b', authDeclaration: 'NONE' },
        { method: 'GET', pathTemplate: '/c', authDeclaration: 'NONE' },
      ],
      policy,
      caps: { probeBudget: 1, probeMinIntervalMs: 0 },
    });
    const bite = report.caps.find((entry) => entry.cap === 'PROBE_BUDGET');
    expect(bite).toMatchObject({ limit: 1, bites: 2, discarded: 2 });
    expect(bite?.reason).toContain('at least that many more were declared and not verified');
    expect(
      report.verdicts.filter((verdict) => verdict.notProbedReason === 'BUDGET_SPENT'),
    ).toHaveLength(2);
  });

  it('discloses the rate limit in milliseconds, with discarded 0 as a real measurement', async () => {
    const { transport } = fakeTransport({ HEAD: { status: 200 } });
    const { clock, waits } = fakeClock();
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      // HEAD, so the undeclared-verb probe (GET only) does not fire and the
      // wait count is exactly "one per request after the first".
      operations: [
        { method: 'HEAD', pathTemplate: '/a', authDeclaration: 'NONE' },
        { method: 'HEAD', pathTemplate: '/b', authDeclaration: 'NONE' },
        { method: 'HEAD', pathTemplate: '/c', authDeclaration: 'NONE' },
      ],
      policy,
      clock,
      caps: { probeMinIntervalMs: 100 },
    });
    expect(waits).toEqual([100, 100]);
    expect(report.rateLimitWaitMs).toBe(200);
    const bite = report.caps.find((entry) => entry.cap === 'PROBE_RATE');
    expect(bite).toMatchObject({ limit: 100, bites: 2, discarded: 0 });
    expect(bite?.reason).toContain('200ms');
    expect(report.caveats.join(' ')).toContain('200ms was spent waiting');
  });

  describe('a 404 neither confirms nor refutes', () => {
    it('leaves the operation DECLARED and records what was seen', async () => {
      const { transport } = fakeTransport({ GET: { status: 404 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/gone', authDeclaration: 'NONE' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(report.verdicts[0]?.verification).toBe('DECLARED');
      expect(report.probes[0]?.findings).toEqual([
        { kind: 'DECLARED_BUT_NOT_ROUTED', status: 404 },
      ]);
      // and nothing anywhere says the operation is absent.
      expect(JSON.stringify(report)).not.toMatch(/does not exist|REFUTED|absent/i);
    });

    it('leaves `verbAllowed` null on a 404 — a dead path says nothing about verbs', async () => {
      const { transport } = fakeTransport({ GET: { status: 404 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/gone', authDeclaration: 'NONE' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(report.probes[0]?.fact.verbAllowed).toBeNull();
    });
  });

  it('does not CONFIRM an operation from a 5xx, and raises SERVER_FAULT', async () => {
    /*
     * A blanket 502 from a load balancer answers every path identically, so
     * taking it as proof of routing would confirm every operation in a document
     * against a backend that is simply down.
     */
    const { transport } = fakeTransport({ GET: { status: 502 } });
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
      policy,
      caps: { probeMinIntervalMs: 0 },
    });
    expect(report.verdicts[0]?.verification).toBe('DECLARED');
    expect(report.probes[0]?.findings).toContainEqual({ kind: 'SERVER_FAULT', status: 502 });
  });

  it('is NO_ANSWER when nothing answered, with status null and answered false', async () => {
    const { transport } = fakeTransport({ GET: { status: null, error: 'ETIMEDOUT' } });
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
      policy,
      caps: { probeMinIntervalMs: 0 },
    });
    expect(report.verdicts[0]?.verification).toBe('NO_ANSWER');
    expect(report.probes[0]?.fact).toMatchObject({ status: null, answered: false });
    expect(report.verdicts[0]?.detail).toContain('UNKNOWN, not absent');
    expect(report.caveats.join(' ')).toContain('unknown, not absent');
  });

  it('CONFIRMS on an answer that proves the path is routed', async () => {
    const { transport } = fakeTransport({ GET: { status: 200 } });
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'OPTIONAL' }],
      policy,
      caps: { probeMinIntervalMs: 0 },
    });
    expect(report.verdicts[0]).toMatchObject({ verification: 'CONFIRMED', notProbedReason: null });
    expect(report.probes[0]?.fact.answered).toBe(true);
  });

  describe('authentication IN FACT needs both halves of the evidence', () => {
    const target = {
      method: 'GET' as const,
      pathTemplate: '/admin',
      authDeclaration: 'REQUIRED' as const,
    };

    it('is null from one anonymous 401 and no credential', async () => {
      /*
       * THE LIE THIS PREVENTS: recording `true` from half the evidence is how
       * the document and the application come to agree on paper about an
       * operation that is broken for every caller.
       */
      const { transport, sent } = fakeTransport({ GET: { status: 401 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [target],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(sent).toHaveLength(1);
      expect(report.probes[0]?.fact.authRequiredInFact).toBeNull();
      expect(report.probes[0]?.fact.detail).toContain('undetermined');
      expect(report.caveats.join(' ')).toContain('undetermined rather than true');
    });

    it('is true only when the credentialled half was accepted', async () => {
      const { transport, sent } = fakeTransport({
        'GET /admin': { status: 401 },
      });
      let call = 0;
      const stateful: ApiProbeTransport = {
        send: async (request) => {
          call += 1;
          sent.push(request);
          return call === 1
            ? { status: 401, headers: {}, error: null }
            : { status: 200, headers: {}, error: null };
        },
      };
      void transport;
      const report = await probeApiOperations({
        transport: stateful,
        baseUrl: 'https://app.test',
        operations: [target],
        policy,
        credential: { headers: { authorization: 'Bearer x' }, label: 'the admin token' },
        caps: { probeMinIntervalMs: 0 },
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.headers.authorization).toBe('Bearer x');
      const authed = report.probes.find((probe) => probe.kind === 'DECLARED_AUTHENTICATED');
      expect(authed?.fact.authRequiredInFact).toBe(true);
      expect(authed?.fact.detail).toContain('the admin token');
      // The label is in the detail; the VALUE never is.
      expect(JSON.stringify(report)).not.toContain('Bearer x');
    });

    it('stays null when the credential was refused too — it may be refusing everybody', async () => {
      const { transport } = fakeTransport({ GET: { status: 403 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [target],
        policy,
        credential: { headers: { authorization: 'Bearer x' }, label: 'the admin token' },
        caps: { probeMinIntervalMs: 0 },
      });
      const authed = report.probes.find((probe) => probe.kind === 'DECLARED_AUTHENTICATED');
      expect(authed?.fact.authRequiredInFact).toBeNull();
      expect(authed?.fact.detail).toContain('refusing everybody');
    });
  });

  describe('the findings that are worth a meeting', () => {
    it('raises DECLARED_PUBLIC_BUT_REFUSED only where the document took a position', async () => {
      const { transport } = fakeTransport({ GET: { status: 401 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [
          { method: 'GET', pathTemplate: '/a', authDeclaration: 'NONE' },
          { method: 'GET', pathTemplate: '/b', authDeclaration: 'OPTIONAL' },
          // UNSTATED and NOT_READ: a 401 here proves nothing about the app.
          { method: 'GET', pathTemplate: '/c', authDeclaration: 'UNSTATED' },
          { method: 'GET', pathTemplate: '/d', authDeclaration: 'NOT_READ' },
        ],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      const raised = report.probes
        .filter((probe) =>
          probe.findings.some((finding) => finding.kind === 'DECLARED_PUBLIC_BUT_REFUSED'),
        )
        .map((probe) => probe.operationKey);
      expect(raised.sort()).toEqual(['GET /a', 'GET /b']);
    });

    it('raises DECLARED_PRIVATE_BUT_OPEN on an anonymous 2xx against a protected operation', async () => {
      const { transport } = fakeTransport({ GET: { status: 200 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/admin', authDeclaration: 'REQUIRED' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(report.probes[0]?.findings).toContainEqual({
        kind: 'DECLARED_PRIVATE_BUT_OPEN',
        status: 200,
      });
    });

    it('reads the Allow header on a 405 and reports the verbs the document omits', async () => {
      const { transport } = fakeTransport({
        GET: { status: 405, headers: { allow: 'POST, PUT , patch' } },
      });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(report.probes[0]?.findings).toContainEqual({
        kind: 'DECLARED_VERB_REFUSED',
        status: 405,
        allowed: ['POST', 'PUT', 'PATCH'],
      });
      expect(report.probes[0]?.fact.verbAllowed).toBe(false);
    });

    it('finds undocumented surface: a verb the document does not declare that answers', async () => {
      const { transport } = fakeTransport({
        'GET /orders': { status: 200 },
        'OPTIONS /orders': { status: 204 },
      });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      const undeclared = report.probes.find((probe) => probe.kind === 'UNDECLARED_VERB');
      expect(undeclared?.findings).toContainEqual({
        kind: 'UNDECLARED_VERB_ANSWERS',
        status: 204,
        method: 'OPTIONS',
      });
    });
  });

  describe('a bad-id probe is a second observation, or it is not issued', () => {
    it('does not issue the same request twice when no sample value exists', async () => {
      /*
       * `GET /orders/{id}` with no observed id can only carry the sentinel, so
       * the declared probe IS the bad-id probe. A second request to the same
       * URL would be two rows of evidence from one observation.
       */
      const { transport, sent } = fakeTransport({ GET: { status: 200 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [{ method: 'GET', pathTemplate: '/orders/{id}', authDeclaration: 'NONE' }],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      const declared = sent.filter(
        (request) => request.method === 'GET' && request.url.endsWith('/orders/0'),
      );
      expect(declared).toHaveLength(1);
      expect(report.probes.some((probe) => probe.kind === 'BAD_ID')).toBe(false);
      // The bad-id finding is attached to the probe that actually carried it.
      expect(report.probes[0]?.findings).toContainEqual({ kind: 'BAD_ID_ACCEPTED', status: 200 });
      expect(report.caveats.join(' ')).toContain('same request twice');
    });

    it('issues both when every parameter has a real observed value', async () => {
      const { transport, sent } = fakeTransport({
        'GET /orders/1001': { status: 200 },
        'GET /orders/0': { status: 500 },
      });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [
          {
            method: 'GET',
            pathTemplate: '/orders/{id}',
            authDeclaration: 'NONE',
            sampleValues: { id: '1001' },
          },
        ],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(sent.map((request) => new URL(request.url).pathname)).toContain('/orders/1001');
      const bad = report.probes.find((probe) => probe.kind === 'BAD_ID');
      expect(bad?.findings).toContainEqual({ kind: 'BAD_ID_FAULTED', status: 500 });
    });

    it('does not credit an auth wall with having rejected a bad id', async () => {
      // A 401 for every caller is not validation. Reporting it as "a bad id was
      // rejected" would credit the application with a check it never ran.
      const { transport } = fakeTransport({ GET: { status: 401 } });
      const report = await probeApiOperations({
        transport,
        baseUrl: 'https://app.test',
        operations: [
          {
            method: 'GET',
            pathTemplate: '/orders/{id}',
            authDeclaration: 'REQUIRED',
            sampleValues: { id: '1001' },
          },
        ],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      expect(report.probes.some((probe) => probe.kind === 'BAD_ID')).toBe(false);
    });

    it('fills `:name` templates as well as `{name}`', async () => {
      const { transport, sent } = fakeTransport({ GET: { status: 200 } });
      await probeApiOperations({
        transport,
        baseUrl: 'https://app.test/',
        operations: [
          {
            method: 'GET',
            pathTemplate: '/orders/:orderId',
            authDeclaration: 'NONE',
            sampleValues: { orderId: 'abc' },
          },
        ],
        policy,
        caps: { probeMinIntervalMs: 0 },
      });
      // And a trailing slash on the base URL does not produce `//orders`.
      expect(sent[0]?.url).toBe('https://app.test/orders/abc');
    });
  });

  it('writes nothing to the probe fact beyond the shared row shape', async () => {
    const { transport } = fakeTransport({ GET: { status: 200 } });
    const report = await probeApiOperations({
      transport,
      baseUrl: 'https://app.test',
      operations: [{ method: 'GET', pathTemplate: '/orders', authDeclaration: 'NONE' }],
      policy,
      caps: { probeMinIntervalMs: 0 },
    });
    expect(Object.keys(report.probes[0]?.fact ?? {}).sort()).toEqual([
      'answered',
      'authRequiredInFact',
      'detail',
      'status',
      'verbAllowed',
    ]);
    expect(report.probes[0]?.fact.detail.length).toBeGreaterThan(0);
  });

  describe('verificationAfterProbe — an observation may raise, never silently lower', () => {
    it('stores a confirmation whatever the row held', () => {
      for (const previous of [null, undefined, 'DECLARED', 'NO_ANSWER', 'NOT_PROBED'] as const) {
        expect(verificationAfterProbe(previous, 'CONFIRMED')).toBe('CONFIRMED');
      }
    });

    it('never downgrades a standing CONFIRMED', () => {
      /*
       * THE DEFECT THIS PREVENTS: a 404 or a 5xx yields the verdict DECLARED,
       * meaning "this probe did not confirm". Assigned straight onto the row it
       * would flicker confirmed operations back to declared every time a
       * staging gateway has a bad minute, and a column that flickers is a
       * column people stop believing.
       */
      for (const verdict of ['DECLARED', 'NO_ANSWER', 'NOT_PROBED'] as const) {
        expect(verificationAfterProbe('CONFIRMED', verdict)).toBe('CONFIRMED');
      }
    });

    it('records the verdict on a row nothing has ever confirmed', () => {
      expect(verificationAfterProbe('DECLARED', 'NO_ANSWER')).toBe('NO_ANSWER');
      expect(verificationAfterProbe(null, 'NOT_PROBED')).toBe('NOT_PROBED');
      expect(verificationAfterProbe('NO_ANSWER', 'DECLARED')).toBe('DECLARED');
    });
  });

  it('labels every probe kind', () => {
    for (const kind of API_PROBE_KINDS) {
      expect(API_PROBE_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

// ─── 9. The union and its write path ─────────────────────────────────────────

/**
 * The run-time half of the two-part guard. The compiler enforces
 * `API_PROBE_FINDING_KINDS` against the union; this enforces zod's own options
 * against that list — the half nothing in CI can see, and the half that eight
 * GateRule kinds shipped without, unsaveable, for two slices.
 */
function zodFindingKinds(): string[] {
  return apiProbeFindingSchema.options.map((option) => option.shape.kind.value as string);
}

describe('apiProbeFindingSchema ⇄ ApiProbeFinding parity', () => {
  it('the schema accepts exactly the union\'s kinds, no more and no fewer', () => {
    expect(zodFindingKinds().slice().sort()).toEqual([...API_PROBE_FINDING_KINDS].sort());
  });

  it('every kind actually round-trips through the write path', () => {
    const samples: ApiProbeFinding[] = [
      { kind: 'DECLARED_PUBLIC_BUT_REFUSED', status: 401 },
      { kind: 'DECLARED_PRIVATE_BUT_OPEN', status: 200 },
      { kind: 'DECLARED_BUT_NOT_ROUTED', status: 404 },
      { kind: 'DECLARED_VERB_REFUSED', status: 405, allowed: ['POST'] },
      { kind: 'UNDECLARED_VERB_ANSWERS', status: 204, method: 'OPTIONS' },
      { kind: 'BAD_ID_ACCEPTED', status: 200 },
      { kind: 'BAD_ID_FAULTED', status: 500 },
      { kind: 'SERVER_FAULT', status: 502 },
    ];
    expect(samples.map((sample) => sample.kind).sort()).toEqual(
      [...API_PROBE_FINDING_KINDS].sort(),
    );
    for (const sample of samples) {
      expect(apiProbeFindingSchema.parse(sample), sample.kind).toMatchObject({
        kind: sample.kind,
      });
    }
  });

  it('rejects a status that is not an HTTP status', () => {
    // `0` is the value a naive transport reports for "no answer", and it must
    // never reach a findings row — NO_ANSWER is the probe fact's job.
    expect(() => apiProbeFindingSchema.parse({ kind: 'SERVER_FAULT', status: 0 })).toThrow();
  });

  it('labels every finding kind', () => {
    for (const kind of API_PROBE_FINDING_KINDS) {
      expect(API_PROBE_FINDING_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});
