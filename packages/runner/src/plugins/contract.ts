/**
 * Contract testing (§4 CONTRACT) — Pact provider verification, OpenAPI and
 * AsyncAPI conformance, and event shapes over the wire.
 *
 * The one microservice practice teams ask for by name. A consumer declares what
 * it needs from a provider; the provider is verified against every consumer's
 * expectation, so an API change that would break a consumer is caught before
 * deploy instead of in production.
 *
 * Five modes. Two are synchronous, three are not:
 *
 *   pact      — replay every HTTP interaction in a consumer pact against the
 *               running provider and compare status, headers and body to what
 *               the consumer recorded. Matching rules are honoured, because
 *               exact value matching makes pacts unusably brittle: an `id` that
 *               is a new UUID on every request is not a contract violation.
 *
 *   openapi   — call the documented operations and check the live responses
 *               against the schema the document declares. Drift between the spec
 *               a team publishes and the API it ships is the same bug class,
 *               caught from the provider's side.
 *
 *   message   — the async half of Pact. A consumer's message pact declares the
 *               shape of an event it can handle; the provider is verified by
 *               getting it to produce that message — from its pact message
 *               endpoint, or straight off an SSE/WebSocket/webhook transport —
 *               and checking the shape with THE SAME matching rules. There is
 *               one matcher in this file and every mode goes through it.
 *
 *   events    — the same check without a pact file, for the far more common team
 *               that has an event stream and no broker: expected shapes are
 *               written inline, in pact's own vocabulary.
 *
 *   asyncapi  — the async equivalent of the openapi mode: validate the messages
 *               a provider actually emits against its declared channel schemas,
 *               with the same schema validator.
 *
 * Why not shell out to the Pact CLI: provider verification is a replay loop and
 * a matcher, and requiring a Ruby/JVM toolchain on every worker to run it would
 * make this feature unavailable exactly when a customer wants it. Doing it in
 * process also means each interaction can be reported as its own cockpit step,
 * with expected vs actual, rather than as one wall of CLI output.
 *
 * Results can be PUBLISHED back to a pact broker (`publish` on the pact and
 * message modes), which is what closes the loop for `can-i-deploy`. That request
 * carries a vault-held token to an operator-configured URL, so every rule about
 * where it may go lives in contract-broker.ts and is enforced before the token
 * is unsealed. Publishing is never the reason a contract test fails.
 *
 * Honest boundaries, all of them visible in the results rather than hidden:
 *   - The `pact` mode replays HTTP only; a pact's message interactions are
 *     reported as skipped steps naming the mode that verifies them.
 *   - OpenAPI/AsyncAPI documents in YAML need a YAML parser, which is not
 *     bundled; that case is SKIPPED with the install command, never FAILED.
 *   - An AsyncAPI payload declared in Avro or Protobuf is reported as not
 *     verified rather than passed.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { FIXTURE_PREFIX, contractTestSpecSchema, maskDeep, maskUrl } from '@qaai/shared';
import type {
  ContractTestSpec,
  ExecutableTest,
  NetworkEntry,
  OpenApiContractSpec,
  PactContractSpec,
  RunContext,
  RunnerPlugin,
  StepResult,
  StepStatus,
  TestExecution,
} from '@qaai/shared';
import {
  ASYNC_CONTRACT_KINDS,
  BODY_SNIPPET_LIMIT,
  ContractConfigError,
  MissingToolError,
  asyncApiMessages,
  asyncContractSpecSchema,
  brokerPublishSchema,
  collectMessages,
  isRecord,
  messageOf,
  pactMessages,
  requestPactMessage,
  resolveUrl,
  send,
  toNetworkEntry,
} from '../contract-events.js';
import type {
  AsyncApiContractSpec,
  AsyncContractSpec,
  BrokerPublishConfig,
  CollectedMessage,
  Collection,
  EventsContractSpec,
  MessageContractSpec,
  PactMessage,
} from '../contract-events.js';
import { publishVerification } from '../contract-broker.js';
import type { PublishOutcome, VerificationResult } from '../contract-broker.js';

/** Enough to fix the break; not so much that a step becomes a body dump. */
const MAX_PROBLEMS_PER_STEP = 12;

/** Guard for a self-referencing OpenAPI schema (`Node` with `children: Node[]`). */
const MAX_SCHEMA_DEPTH = 24;

/** Kept out of the literal so a missing YAML parser is a runtime skip, not a build error. */
const YAML_MODULE = 'yaml';

/** Short, safe rendering of a value for an expected/actual field. */
function preview(value: unknown, limit = 200): string {
  if (value === undefined) return '(absent)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function makeStep(
  index: number,
  title: string,
  status: StepStatus,
  durationMs: number,
  problem?: { message: string; expected?: string | null; actual?: string | null },
): StepResult {
  return {
    index,
    title,
    status,
    startedAt: new Date().toISOString(),
    durationMs,
    screenshotKey: null,
    error: problem
      ? {
          message: problem.message,
          stack: null,
          selector: null,
          expected: problem.expected ?? null,
          actual: problem.actual ?? null,
        }
      : null,
  };
}

/** Only the NAME of the secret is in the spec; the value comes from the vault. */
function authHeaders(
  spec: ContractTestSpec | AsyncContractSpec,
  ctx: RunContext,
): Record<string, string> {
  if (!spec.auth) return {};
  const token = ctx.secrets[spec.auth.secretName];
  if (token === undefined) {
    throw new ContractConfigError(
      `The secret ${spec.auth.secretName} is not set for this environment, so the provider could not be authenticated — the contract was not verified.`,
    );
  }
  return { [spec.auth.header]: spec.auth.valueTemplate.replaceAll('{token}', token) };
}

// ─── Loading the contract document ───────────────────────────────────────────

/** A spec-supplied path must stay inside the workspace. */
function safeWorkspacePath(ref: string): string {
  if (isAbsolute(ref)) {
    throw new ContractConfigError(`${ref} must be relative to the workspace`);
  }
  const workspace = resolve(process.cwd());
  const full = resolve(join(workspace, ref));
  if (full !== workspace && !full.startsWith(workspace + sep)) {
    throw new ContractConfigError(`${ref} escapes the workspace`);
  }
  return full;
}

/**
 * Read the document from wherever the spec points: a URL (broker, or the
 * provider's own `/openapi.json`), the run's fixtures, or the workspace.
 *
 * Fixtures come first for a local path, because a pact committed as test data
 * exists in every run's workspace whether or not the file was materialised yet.
 */
async function loadDocument(
  ref: string,
  what: string,
  ctx: RunContext,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  if (/^https?:\/\//i.test(ref)) {
    const sent = await send(
      ctx,
      ref,
      'GET',
      { accept: 'application/json, application/yaml;q=0.9, */*;q=0.1', ...headers },
      undefined,
      timeoutMs,
    );
    if (sent.transportError !== null) {
      throw new ContractConfigError(
        `Could not fetch the ${what} from ${maskUrl(ref)} — ${sent.transportError}`,
      );
    }
    if (sent.status === null || sent.status >= 400) {
      throw new ContractConfigError(
        `Fetching the ${what} from ${maskUrl(ref)} returned HTTP ${sent.status}.`,
      );
    }
    return sent.text;
  }

  const fixtures = ctx.fixtures ?? {};
  const fixtureKey =
    ref in fixtures
      ? ref
      : `${FIXTURE_PREFIX}${ref}` in fixtures
        ? `${FIXTURE_PREFIX}${ref}`
        : null;
  if (fixtureKey !== null) {
    const content = fixtures[fixtureKey];
    if (content !== undefined) return content;
  }

  try {
    return await readFile(safeWorkspacePath(ref), 'utf8');
  } catch (err) {
    if (err instanceof ContractConfigError) throw err;
    throw new ContractConfigError(
      `No ${what} at "${ref}". Point it at an http(s) URL, or commit the file as test data under ${FIXTURE_PREFIX} — the contract was not verified.`,
    );
  }
}

/**
 * JSON always; YAML only when a parser happens to be installed.
 *
 * A YAML OpenAPI document with no parser present is a configuration gap on this
 * worker, so it is reported as SKIPPED with the install command. Reporting it as
 * a failure would blame the customer's API for QAAI's missing dependency.
 */
async function parseDocument(text: string, what: string): Promise<unknown> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ContractConfigError(`The ${what} is not valid JSON — ${messageOf(err)}`);
    }
  }

  let parse: ((input: string) => unknown) | null = null;
  try {
    const mod: unknown = await import(YAML_MODULE);
    const candidate = isRecord(mod)
      ? ((mod.parse ?? (isRecord(mod.default) ? mod.default.parse : undefined)) as unknown)
      : undefined;
    if (typeof candidate === 'function') parse = candidate as (input: string) => unknown;
  } catch {
    parse = null;
  }

  if (parse === null) {
    throw new MissingToolError(
      `The ${what} is not JSON, and no YAML parser is installed on this worker. Install one (npm i yaml -w @qaai/runner) or point at the JSON form of the document — the contract was not verified.`,
    );
  }

  try {
    return parse(text);
  } catch (err) {
    throw new ContractConfigError(`The ${what} is not valid YAML — ${messageOf(err)}`);
  }
}

// ─── Pact: matching rules ────────────────────────────────────────────────────

interface Matcher {
  match?: string;
  regex?: string;
  min?: number;
  max?: number;
  value?: unknown;
}

interface BodyRule {
  /** `$.items[*].id` → `['items', '*', 'id']`, relative to the body root. */
  tokens: string[];
  matchers: Matcher[];
}

interface HeaderRule {
  /** Lower-cased header name. */
  name: string;
  matchers: Matcher[];
}

interface RuleSet {
  body: BodyRule[];
  header: HeaderRule[];
  status: Matcher[];
}

/** `$.a.b[0]['c-d']` → `['a', 'b', '0', 'c-d']`. */
function pathTokens(path: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];
    if (char === '$' && i === 0) continue;
    if (char === '.') {
      flush();
      continue;
    }
    if (char === '[') {
      flush();
      const close = path.indexOf(']', i);
      if (close === -1) {
        current = path.slice(i + 1);
        break;
      }
      let inner = path.slice(i + 1, close).trim();
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        inner = inner.slice(1, -1);
      }
      if (inner.length > 0) tokens.push(inner);
      i = close;
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function jsonPath(tokens: string[]): string {
  return `$${tokens.map((t) => (/^\d+$/.test(t) ? `[${t}]` : `.${t}`)).join('')}`;
}

function matchersOf(definition: unknown): Matcher[] {
  if (!isRecord(definition)) return [];
  const nested = definition.matchers;
  if (Array.isArray(nested)) return nested.filter(isRecord) as Matcher[];
  return [definition as Matcher];
}

/**
 * Reads both pact matching-rule dialects.
 *
 * v2 is a flat map keyed by a full path (`"$.body.id": { "match": "type" }`);
 * v3 groups by category (`{ body: { "$.id": { matchers: [...] } } }`). Both are
 * in the wild — pact-js still writes v2 by default — so both are normalised
 * here rather than forcing the customer to regenerate their pacts.
 */
function collectRules(raw: unknown): RuleSet {
  const rules: RuleSet = { body: [], header: [], status: [] };
  if (!isRecord(raw)) return rules;

  for (const [key, value] of Object.entries(raw)) {
    // v2: the key is the whole path, starting at the response root.
    if (key.startsWith('$')) {
      const tokens = pathTokens(key);
      const [category, ...rest] = tokens;
      const matchers = matchersOf(value);
      if (matchers.length === 0) continue;
      if (category === 'body') rules.body.push({ tokens: rest, matchers });
      else if (category === 'headers' || category === 'header') {
        const name = rest[0];
        if (name !== undefined) rules.header.push({ name: name.toLowerCase(), matchers });
      } else if (category === 'status') rules.status.push(...matchers);
      continue;
    }

    // v3: `{ body: {...}, header: {...}, status: {...} }`.
    if (!isRecord(value)) continue;
    if (key === 'status') {
      rules.status.push(...matchersOf(value));
      continue;
    }
    if (key === 'header' || key === 'headers') {
      for (const [name, definition] of Object.entries(value)) {
        const clean = name.replace(/^\$\.?(headers?\.)?/i, '');
        rules.header.push({ name: clean.toLowerCase(), matchers: matchersOf(definition) });
      }
      continue;
    }
    if (key === 'body') {
      for (const [path, definition] of Object.entries(value)) {
        rules.body.push({ tokens: pathTokens(path), matchers: matchersOf(definition) });
      }
    }
  }

  return rules;
}

/** The most specific rule wins, exactly as pact's own weighting works. */
function ruleFor(rules: BodyRule[], tokens: string[]): Matcher[] | null {
  let best: { score: number; matchers: Matcher[] } | null = null;

  for (const rule of rules) {
    if (rule.tokens.length !== tokens.length) continue;
    let score = 0;
    let matches = true;
    for (let i = 0; i < tokens.length; i += 1) {
      const pattern = rule.tokens[i];
      const token = tokens[i];
      if (pattern === token) {
        score += 2;
        continue;
      }
      if (pattern === '*') {
        score += 1;
        continue;
      }
      matches = false;
      break;
    }
    if (!matches) continue;
    if (best === null || score > best.score) best = { score, matchers: rule.matchers };
  }

  return best?.matchers ?? null;
}

interface Mismatch {
  where: string;
  detail: string;
  expected: string;
  actual: string;
}

/** Matching modes: `exact` compares values, `type` compares shape. */
type MatchMode = 'exact' | 'type';

interface MatchOutcome {
  /** The matcher decided the value on its own; do not recurse. */
  terminal: boolean;
  mode: MatchMode;
  /** Minimum array length declared by an `eachLike`-style rule. */
  min?: number;
}

function applyMatchers(
  matchers: Matcher[],
  expected: unknown,
  actual: unknown,
  where: string,
  out: Mismatch[],
  unsupported: Set<string>,
): MatchOutcome {
  let mode: MatchMode = 'type';
  let min: number | undefined;

  const fail = (detail: string, want: string): void => {
    out.push({ where, detail, expected: want, actual: preview(actual) });
  };

  for (const matcher of matchers) {
    const kind = (
      matcher.match ?? (typeof matcher.regex === 'string' ? 'regex' : 'type')
    ).toLowerCase();

    switch (kind) {
      case 'equality':
        mode = 'exact';
        break;

      case 'type':
      case 'values':
        mode = 'type';
        if (typeof matcher.min === 'number') min = matcher.min;
        break;

      case 'min':
        mode = 'type';
        min = typeof matcher.min === 'number' ? matcher.min : min;
        break;

      case 'max':
        mode = 'type';
        break;

      case 'regex': {
        const source = matcher.regex;
        if (typeof source !== 'string') {
          unsupported.add('regex (no pattern given)');
          mode = 'type';
          break;
        }
        let compiled: RegExp;
        try {
          compiled = new RegExp(source);
        } catch {
          // A rule QAAI cannot compile is the pact's problem, and calling it a
          // provider failure would be a lie. Fall back to a type match.
          unsupported.add(`regex /${source}/ (not a valid pattern)`);
          mode = 'type';
          break;
        }
        const text =
          typeof actual === 'string' ? actual : (JSON.stringify(actual) ?? String(actual));
        if (!compiled.test(text)) {
          fail(`does not match /${source}/`, `matches /${source}/`);
        }
        return { terminal: true, mode };
      }

      case 'include': {
        const needle = String(matcher.value ?? expected ?? '');
        const text =
          typeof actual === 'string' ? actual : (JSON.stringify(actual) ?? String(actual));
        if (!text.includes(needle))
          fail(`does not contain ${preview(needle)}`, `contains ${preview(needle)}`);
        return { terminal: true, mode };
      }

      case 'number':
      case 'integer':
      case 'decimal': {
        const isNumber = typeof actual === 'number' && Number.isFinite(actual);
        const ok = isNumber && (kind !== 'integer' || Number.isInteger(actual as number));
        if (!ok) fail(`is not ${kind === 'integer' ? 'an integer' : `a ${kind}`}`, kind);
        return { terminal: true, mode };
      }

      case 'boolean':
        if (typeof actual !== 'boolean') fail('is not a boolean', 'boolean');
        return { terminal: true, mode };

      case 'null':
        if (actual !== null) fail('is not null', 'null');
        return { terminal: true, mode };

      case 'notempty': {
        const empty =
          actual === null ||
          actual === undefined ||
          (typeof actual === 'string' && actual.length === 0) ||
          (Array.isArray(actual) && actual.length === 0);
        if (empty) fail('is empty', 'a non-empty value');
        return { terminal: true, mode };
      }

      case 'date':
      case 'time':
      case 'datetime':
      case 'timestamp':
        // The format string is not verified — pact's date formats are Java's,
        // and half-implementing them would fail correct providers.
        if (typeof actual !== 'string') fail(`is not a ${kind} string`, `${kind} string`);
        return { terminal: true, mode };

      default:
        // An unknown matcher is treated as a type match and reported in the step
        // title, so a green result never quietly means "we ignored your rule".
        unsupported.add(kind);
        mode = 'type';
        break;
    }
  }

  return { terminal: false, mode, ...(min !== undefined ? { min } : {}) };
}

/**
 * Compare an actual response body to the consumer's expectation.
 *
 * Pact semantics, deliberately: a pact is a floor, not a ceiling. Keys the
 * provider adds are fine — the consumer never asked about them — but every key
 * the consumer recorded has to be there and has to match.
 */
function compareBody(
  expected: unknown,
  actual: unknown,
  tokens: string[],
  rules: BodyRule[],
  mode: MatchMode,
  out: Mismatch[],
  unsupported: Set<string>,
): void {
  if (out.length >= MAX_PROBLEMS_PER_STEP) return;

  const where = jsonPath(tokens);
  const matchers = ruleFor(rules, tokens);
  let effective = mode;
  let min: number | undefined;

  if (matchers !== null && matchers.length > 0) {
    const outcome = applyMatchers(matchers, expected, actual, where, out, unsupported);
    if (outcome.terminal) return;
    effective = outcome.mode;
    min = outcome.min;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push({
        where,
        detail: `is ${typeName(actual)}, expected an array`,
        expected: 'array',
        actual: typeName(actual),
      });
      return;
    }

    if (effective === 'type') {
      const required = min ?? (expected.length > 0 ? 1 : 0);
      if (actual.length < required) {
        out.push({
          where,
          detail: `has ${actual.length} items, the pact requires at least ${required}`,
          expected: `at least ${required} items`,
          actual: `${actual.length} items`,
        });
      }
      const template = expected[0];
      if (template !== undefined) {
        for (let i = 0; i < actual.length; i += 1) {
          compareBody(template, actual[i], [...tokens, String(i)], rules, 'type', out, unsupported);
        }
      }
      return;
    }

    if (actual.length !== expected.length) {
      out.push({
        where,
        detail: `has ${actual.length} items, expected ${expected.length}`,
        expected: `${expected.length} items`,
        actual: `${actual.length} items`,
      });
    }
    for (let i = 0; i < expected.length && i < actual.length; i += 1) {
      compareBody(
        expected[i],
        actual[i],
        [...tokens, String(i)],
        rules,
        effective,
        out,
        unsupported,
      );
    }
    return;
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      out.push({
        where,
        detail: `is ${typeName(actual)}, expected an object`,
        expected: 'object',
        actual: typeName(actual),
      });
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) {
        out.push({
          where: jsonPath([...tokens, key]),
          detail: 'is missing from the response',
          expected: preview(value),
          actual: '(absent)',
        });
        continue;
      }
      compareBody(value, actual[key], [...tokens, key], rules, effective, out, unsupported);
    }
    return;
  }

  if (effective === 'type') {
    if (typeName(expected) !== typeName(actual)) {
      out.push({
        where,
        detail: `is ${typeName(actual)}, expected ${typeName(expected)}`,
        expected: typeName(expected),
        actual: typeName(actual),
      });
    }
    return;
  }

  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push({
      where,
      detail: `is ${preview(actual)}, expected ${preview(expected)}`,
      expected: preview(expected),
      actual: preview(actual),
    });
  }
}

/** `application/json; charset=utf-8` → `application/json`. */
function mediaType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function compareHeaders(
  expected: Record<string, unknown> | undefined,
  actual: Record<string, string>,
  rules: HeaderRule[],
  out: Mismatch[],
  unsupported: Set<string>,
): void {
  for (const [rawName, rawWant] of Object.entries(expected ?? {})) {
    const name = rawName.toLowerCase();
    const want = Array.isArray(rawWant) ? rawWant.join(', ') : String(rawWant);
    const got = actual[name];

    if (got === undefined) {
      out.push({
        where: `header ${rawName}`,
        detail: 'is missing from the response',
        expected: want,
        actual: '(absent)',
      });
      continue;
    }

    const matchers = rules.find((rule) => rule.name === name)?.matchers;
    if (matchers !== undefined && matchers.length > 0) {
      applyMatchers(matchers, want, got, `header ${rawName}`, out, unsupported);
      continue;
    }

    // Content-type parameters (charset, boundary) are not part of the contract:
    // failing a provider for adding `; charset=utf-8` is noise, not a finding.
    const same =
      name === 'content-type' ? mediaType(got) === mediaType(want) : got.trim() === want.trim();
    if (!same) {
      out.push({
        where: `header ${rawName}`,
        detail: `is ${preview(got)}, expected ${preview(want)}`,
        expected: want,
        actual: got,
      });
    }
  }
}

// ─── Pact: verification ──────────────────────────────────────────────────────

interface PactInteraction {
  description?: string;
  providerState?: string;
  provider_state?: string;
  providerStates?: Array<{ name?: string; params?: Record<string, unknown> }>;
  request?: {
    method?: string;
    path?: string;
    query?: unknown;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
    matchingRules?: unknown;
  };
}

function interactionStates(interaction: PactInteraction): Array<{
  name: string;
  params: Record<string, unknown>;
}> {
  if (Array.isArray(interaction.providerStates)) {
    return interaction.providerStates
      .filter(isRecord)
      .map((state) => ({
        name: typeof state.name === 'string' ? state.name : '',
        params: isRecord(state.params) ? state.params : {},
      }))
      .filter((state) => state.name.length > 0);
  }
  const single = interaction.providerState ?? interaction.provider_state;
  return typeof single === 'string' && single.length > 0 ? [{ name: single, params: {} }] : [];
}

function applyQuery(url: URL, query: unknown): void {
  if (typeof query === 'string') {
    if (query.length === 0) return;
    const parsed = new URLSearchParams(query.replace(/^\?/, ''));
    parsed.forEach((value, key) => url.searchParams.append(key, value));
    return;
  }
  if (!isRecord(query)) return;
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else if (value !== null && value !== undefined) url.searchParams.append(key, String(value));
  }
}

function stringHeaders(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * Put the provider into the state the interaction was recorded against.
 *
 * Structurally typed rather than taking `PactContractSpec`, because the message
 * mode drives the identical hook with the identical protocol.
 */
async function setUpState(
  ctx: RunContext,
  spec: { stateChangeUrl?: string; providerBaseUrl?: string; requestTimeoutSeconds: number },
  consumer: string,
  states: Array<{ name: string; params: Record<string, unknown> }>,
  headers: Record<string, string>,
): Promise<string | null> {
  if (spec.stateChangeUrl === undefined || states.length === 0) return null;
  const url = resolveUrl(spec.providerBaseUrl ?? ctx.baseUrl, spec.stateChangeUrl);

  for (const state of states) {
    const sent = await send(
      ctx,
      url,
      'POST',
      { ...headers, 'content-type': 'application/json' },
      JSON.stringify({ consumer, state: state.name, params: state.params, action: 'setup' }),
      spec.requestTimeoutSeconds * 1000,
    );
    if (sent.transportError !== null) {
      return `The provider-state hook at ${maskUrl(url)} could not be reached — ${sent.transportError}`;
    }
    if (sent.status === null || sent.status >= 400) {
      return `The provider-state hook returned HTTP ${sent.status} for "${state.name}", so the interaction was replayed against an unknown state.`;
    }
  }
  return null;
}

interface ModeResult {
  steps: StepResult[];
  network: NetworkEntry[];
  /** Set when nothing could be evaluated — becomes a SKIPPED test, not a failure. */
  notEvaluated: string | null;
  summary: string;
  /**
   * What a broker would be told, when the mode verified a pact. Absent for the
   * modes that have no pact behind them (openapi, events, asyncapi) — there is
   * no consumer to report a result for, so there is nothing to publish.
   */
  pact?: { consumerName: string; providerName: string; results: VerificationResult[] };
}

/**
 * Called the moment a step settles, so the cockpit's right pane fills in as the
 * interactions are replayed rather than all at once when the test ends.
 */
type EmitStep = (step: StepResult) => void;

async function verifyPact(
  ctx: RunContext,
  spec: PactContractSpec,
  common: Record<string, string>,
  emit: EmitStep,
): Promise<ModeResult> {
  const text = await loadDocument(
    spec.pactPath,
    'pact file',
    ctx,
    common,
    spec.requestTimeoutSeconds * 1000,
  );
  const document = await parseDocument(text, 'pact file');

  if (!isRecord(document)) {
    throw new ContractConfigError('The pact file did not contain a pact object.');
  }

  const consumerName =
    isRecord(document.consumer) && typeof document.consumer.name === 'string'
      ? document.consumer.name
      : 'consumer';
  const providerName =
    isRecord(document.provider) && typeof document.provider.name === 'string'
      ? document.provider.name
      : 'provider';

  if (spec.consumer !== undefined && spec.consumer !== consumerName) {
    return {
      steps: [],
      network: [],
      notEvaluated: `The pact is between ${consumerName} and ${providerName}, but the spec asked for consumer "${spec.consumer}".`,
      summary: '',
    };
  }

  const rawInteractions = Array.isArray(document.interactions) ? document.interactions : [];
  const messageCount = Array.isArray(document.messages) ? document.messages.length : 0;

  if (rawInteractions.length === 0) {
    return {
      steps: [],
      network: [],
      notEvaluated:
        messageCount > 0
          ? `This pact holds ${messageCount} message interaction(s) and no HTTP interaction. Set the spec's kind to "message" and give it a \`source\` — that mode verifies them against the same matching rules.`
          : 'The pact file declares no HTTP interactions.',
      summary: '',
    };
  }

  let only: RegExp | null = null;
  if (spec.only !== undefined) {
    try {
      only = new RegExp(spec.only, 'i');
    } catch {
      throw new ContractConfigError(`\`only\` is not a valid regular expression: ${spec.only}`);
    }
  }

  const baseUrl = spec.providerBaseUrl ?? ctx.baseUrl;
  const steps: StepResult[] = [];
  const network: NetworkEntry[] = [];
  const record = (step: StepResult): void => {
    steps.push(step);
    emit(step);
  };
  let failures = 0;
  let verified = 0;
  /** Step index → the pact's own description, which is what a broker records. */
  const descriptions = new Map<number, string>();

  for (const [index, raw] of rawInteractions.entries()) {
    const interaction = (isRecord(raw) ? raw : {}) as PactInteraction;
    const description = interaction.description ?? `interaction ${index + 1}`;
    descriptions.set(index, description);
    const method = (interaction.request?.method ?? 'GET').toUpperCase();
    const path = interaction.request?.path ?? '/';
    const states = interactionStates(interaction);
    const given = states.map((s) => s.name).join(', ');
    const title = `${method} ${path} — ${description}${given.length > 0 ? ` (given ${given})` : ''}`;

    if (ctx.signal.aborted) {
      record(makeStep(index, title, 'SKIPPED', 0));
      continue;
    }

    if (only !== null && !only.test(description) && !only.test(given)) {
      record(makeStep(index, title, 'SKIPPED', 0));
      continue;
    }

    const started = Date.now();
    const stateError = await setUpState(ctx, spec, consumerName, states, common);
    if (stateError !== null) {
      failures += 1;
      record(
        makeStep(index, title, 'FAILED', Date.now() - started, {
          message: stateError,
          expected: `provider state "${given}" set up`,
          actual: 'the state hook did not succeed',
        }),
      );
      continue;
    }

    const url = new URL(resolveUrl(baseUrl, path));
    applyQuery(url, interaction.request?.query);

    const requestHeaders = {
      ...common,
      ...stringHeaders(interaction.request?.headers),
    };
    let body: string | undefined;
    const rawBody = interaction.request?.body;
    if (rawBody !== undefined && rawBody !== null) {
      body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      if (
        !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type') &&
        typeof rawBody !== 'string'
      ) {
        requestHeaders['content-type'] = 'application/json';
      }
    }

    const sent = await send(
      ctx,
      url.toString(),
      method,
      requestHeaders,
      body,
      spec.requestTimeoutSeconds * 1000,
    );
    network.push(toNetworkEntry(method, url.toString(), sent));
    verified += 1;

    if (sent.transportError !== null) {
      failures += 1;
      record(
        makeStep(index, title, 'FAILED', sent.durationMs, {
          message: `The provider could not be reached: ${sent.transportError}`,
          expected: `HTTP ${interaction.response?.status ?? 200}`,
          actual: 'no response',
        }),
      );
      continue;
    }

    const rules = collectRules(interaction.response?.matchingRules);
    const mismatches: Mismatch[] = [];
    const unsupported = new Set<string>();

    const expectedStatus = interaction.response?.status;
    if (typeof expectedStatus === 'number' && expectedStatus !== sent.status) {
      // A status matcher (rare, but legal) can loosen this to a type match.
      const statusRuleKind = rules.status[0]?.match?.toLowerCase();
      if (statusRuleKind !== 'type') {
        mismatches.push({
          where: 'status',
          detail: `is ${sent.status}, expected ${expectedStatus}`,
          expected: `HTTP ${expectedStatus}`,
          actual: `HTTP ${sent.status}`,
        });
      }
    }

    compareHeaders(
      interaction.response?.headers,
      sent.headers,
      rules.header,
      mismatches,
      unsupported,
    );

    const expectedBody = interaction.response?.body;
    if (expectedBody !== undefined && expectedBody !== null) {
      if (typeof expectedBody === 'string') {
        if (sent.text !== expectedBody) {
          mismatches.push({
            where: '$',
            detail: 'body text differs',
            expected: preview(expectedBody),
            actual: preview(sent.text),
          });
        }
      } else {
        let actualBody: unknown;
        let parsed = true;
        try {
          actualBody = JSON.parse(sent.text) as unknown;
        } catch {
          parsed = false;
        }
        if (!parsed) {
          mismatches.push({
            where: '$',
            detail: 'the response was not valid JSON',
            expected: 'a JSON body',
            actual: preview(sent.text.slice(0, BODY_SNIPPET_LIMIT)),
          });
        } else {
          compareBody(expectedBody, actualBody, [], rules.body, 'exact', mismatches, unsupported);
        }
      }
    }

    const note =
      unsupported.size > 0
        ? ` — matcher${unsupported.size > 1 ? 's' : ''} not implemented, compared by type: ${[...unsupported].join(', ')}`
        : '';

    if (mismatches.length === 0) {
      record(makeStep(index, `${title}${note}`, 'PASSED', sent.durationMs));
      continue;
    }

    failures += 1;
    const first = mismatches[0];
    record(
      makeStep(index, `${title}${note}`, 'FAILED', sent.durationMs, {
        message: mismatches
          .slice(0, MAX_PROBLEMS_PER_STEP)
          .map((m) => `${m.where} ${m.detail}`)
          .join('; '),
        expected: first?.expected ?? null,
        actual: first?.actual ?? null,
      }),
    );
  }

  /*
   * A pact carrying BOTH HTTP interactions and messages gets a step per message
   * saying which mode verifies it. Dropping them silently would let a half-
   * verified pact report as fully green, which is the failure mode this whole
   * plugin exists to prevent.
   */
  for (const [offset, message] of pactMessages(document).entries()) {
    record(
      makeStep(rawInteractions.length + offset, `message: ${message.description}`, 'SKIPPED', 0, {
        message:
          'Not replayed by the "pact" mode, which verifies HTTP interactions. Set the spec\'s kind to "message" and give it a `source` to verify this one.',
      }),
    );
  }

  return {
    steps,
    network,
    notEvaluated:
      verified === 0
        ? `No interaction in the pact between ${consumerName} and ${providerName} was replayed.`
        : null,
    summary: `${consumerName} → ${providerName}: ${failures} of ${verified} interaction(s) broke`,
    pact: {
      consumerName,
      providerName,
      results: steps
        .filter((step) => step.status !== 'SKIPPED')
        .map((step) => ({
          interactionDescription: descriptions.get(step.index) ?? step.title,
          success: step.status === 'PASSED',
          ...(step.error?.message !== undefined && step.error.message.length > 0
            ? { exceptionMessage: step.error.message.slice(0, 1000) }
            : {}),
        })),
    },
  };
}

// ─── OpenAPI: schema checking ────────────────────────────────────────────────

const OPENAPI_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

interface SchemaCheck {
  document: unknown;
  problems: string[];
  /** Things this build did not verify, surfaced instead of silently passing. */
  notes: Set<string>;
}

function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = document;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isRecord(node)) node = node[key];
    else return undefined;
  }
  return node;
}

function deref(document: unknown, node: unknown): { schema: unknown; unresolved: string | null } {
  let current = node;
  for (let hops = 0; hops < 20; hops += 1) {
    if (!isRecord(current) || typeof current.$ref !== 'string')
      return { schema: current, unresolved: null };
    const target = resolvePointer(document, current.$ref);
    if (target === undefined) return { schema: null, unresolved: current.$ref };
    current = target;
  }
  return { schema: null, unresolved: 'a $ref chain more than 20 deep' };
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * Validate a value against an OpenAPI Schema Object.
 *
 * A deliberate subset — type, required, properties, items, enum/const, the
 * bounds keywords, `nullable`, and the composition keywords — resolved against
 * the document's own `$ref`s. `format` is NOT enforced: formats are open-ended
 * and annotation-only in JSON Schema, and failing a provider for a `format`
 * this validator happens to disagree about would be a false accusation.
 * Anything skipped is reported in the step rather than passed over.
 */
function validateSchema(
  check: SchemaCheck,
  rawSchema: unknown,
  value: unknown,
  path: string,
  depth: number,
): void {
  if (check.problems.length >= MAX_PROBLEMS_PER_STEP) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    check.notes.add('a schema nested deeper than this validator walks');
    return;
  }

  const { schema, unresolved } = deref(check.document, rawSchema);
  if (unresolved !== null) {
    check.notes.add(`the unresolved reference ${unresolved}`);
    return;
  }
  if (!isRecord(schema)) return;

  const fail = (detail: string): void => {
    if (check.problems.length < MAX_PROBLEMS_PER_STEP) check.problems.push(`${path} ${detail}`);
  };

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateSchema(check, sub, value, path, depth + 1);
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[key];
    if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
    const passed = alternatives.some((alternative) => {
      const scratch: SchemaCheck = { document: check.document, problems: [], notes: new Set() };
      validateSchema(scratch, alternative, value, path, depth + 1);
      return scratch.problems.length === 0;
    });
    if (!passed) fail(`matches none of the ${alternatives.length} ${key} alternatives`);
  }

  const nullable = schema.nullable === true;
  const declared = schema.type;
  const types = Array.isArray(declared)
    ? declared.filter((t): t is string => typeof t === 'string')
    : typeof declared === 'string'
      ? [declared]
      : [];

  if (value === null && (nullable || types.includes('null'))) return;

  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    fail(`is ${typeName(value)}, the document declares ${types.join(' | ')}`);
    return;
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))
  ) {
    fail(`is ${preview(value)}, not one of ${preview(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    fail(`is ${preview(value)}, the document declares the constant ${preview(schema.const)}`);
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value))
        fail(`is missing the required property "${key}"`);
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(properties)) {
      if (key in value) validateSchema(check, sub, value[key], `${path}.${key}`, depth + 1);
    }

    // Only when the document explicitly closes the object. An undocumented
    // field is normal API evolution unless the provider said it would not add one.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) fail(`has the undocumented property "${key}"`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const [key, sub] of Object.entries(value)) {
        if (!(key in properties))
          validateSchema(check, schema.additionalProperties, sub, `${path}.${key}`, depth + 1);
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      fail(`has ${value.length} items, the minimum is ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      fail(`has ${value.length} items, the maximum is ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length && check.problems.length < MAX_PROBLEMS_PER_STEP; i += 1) {
        validateSchema(check, schema.items, value[i], `${path}[${i}]`, depth + 1);
      }
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(`is ${value.length} characters, the minimum is ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      fail(`is ${value.length} characters, the maximum is ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) fail(`does not match /${schema.pattern}/`);
      } catch {
        check.notes.add(`the pattern /${schema.pattern}/, which is not a valid regular expression`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      fail(`is ${value}, the minimum is ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      fail(`is ${value}, the maximum is ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      fail(`is ${value}, which is not above ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      fail(`is ${value}, which is not below ${schema.exclusiveMaximum}`);
    }
  }
}

/** `200` wins over `2XX`, which wins over `default` — the document's own precedence. */
function pickResponse(
  responses: Record<string, unknown>,
  status: number,
): { key: string; response: unknown } | null {
  const exact = responses[String(status)];
  if (exact !== undefined) return { key: String(status), response: exact };

  const range = `${Math.floor(status / 100)}XX`;
  const ranged = responses[range] ?? responses[range.toLowerCase()];
  if (ranged !== undefined) return { key: range, response: ranged };

  const fallback = responses.default;
  if (fallback !== undefined) return { key: 'default', response: fallback };

  return null;
}

/** The JSON media type the response declares, if it declares one. */
function jsonContentKey(content: Record<string, unknown>): string | null {
  for (const key of Object.keys(content)) {
    const type = mediaType(key);
    if (type === 'application/json' || type.endsWith('+json')) return key;
  }
  return null;
}

/** An example the document itself provides, so a check needs no hand-written data. */
function exampleFor(parameter: Record<string, unknown>): string | null {
  const direct = parameter.example;
  if (typeof direct === 'string' || typeof direct === 'number' || typeof direct === 'boolean') {
    return String(direct);
  }
  if (isRecord(parameter.examples)) {
    for (const value of Object.values(parameter.examples)) {
      if (isRecord(value) && (typeof value.value === 'string' || typeof value.value === 'number')) {
        return String(value.value);
      }
    }
  }
  const schema = isRecord(parameter.schema) ? parameter.schema : null;
  if (schema !== null) {
    for (const key of ['example', 'default'] as const) {
      const candidate = schema[key];
      if (
        typeof candidate === 'string' ||
        typeof candidate === 'number' ||
        typeof candidate === 'boolean'
      ) {
        return String(candidate);
      }
    }
    if (Array.isArray(schema.enum)) {
      const first = schema.enum[0];
      if (typeof first === 'string' || typeof first === 'number') return String(first);
    }
  }
  return null;
}

/**
 * The path prefix the document declares (`servers[0]`, or Swagger 2.0's
 * `basePath`), applied on top of the environment's base URL — but only when the
 * base URL does not already carry it, so `https://staging.example.com` and
 * `https://staging.example.com/v1` both end up hitting `/v1/pets` exactly once.
 */
function documentBasePath(document: Record<string, unknown>): string {
  if (typeof document.basePath === 'string') return document.basePath;
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = servers.find(isRecord);
  const url = first !== undefined && typeof first.url === 'string' ? first.url : '';
  if (url.length === 0 || url.includes('{')) return '';
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  }
  return url;
}

function effectiveBaseUrl(providerBaseUrl: string, document: Record<string, unknown>): string {
  const basePath = documentBasePath(document).replace(/\/+$/, '');
  if (basePath.length === 0 || basePath === '/') return providerBaseUrl;
  try {
    const current = new URL(providerBaseUrl).pathname.replace(/\/+$/, '');
    if (current.endsWith(basePath)) return providerBaseUrl;
  } catch {
    return providerBaseUrl;
  }
  return resolveUrl(providerBaseUrl, basePath);
}

async function checkOpenApi(
  ctx: RunContext,
  spec: OpenApiContractSpec,
  common: Record<string, string>,
  emit: EmitStep,
): Promise<ModeResult> {
  const text = await loadDocument(
    spec.specPath,
    'OpenAPI document',
    ctx,
    common,
    spec.requestTimeoutSeconds * 1000,
  );
  const document = await parseDocument(text, 'OpenAPI document');

  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new ContractConfigError('The OpenAPI document has no `paths` object.');
  }

  const wanted = spec.operations.map((entry) => entry.trim().toLowerCase());
  const baseUrl = effectiveBaseUrl(spec.providerBaseUrl ?? ctx.baseUrl, document);
  const steps: StepResult[] = [];
  const network: NetworkEntry[] = [];
  const record = (step: StepResult): void => {
    steps.push(step);
    emit(step);
  };
  let index = 0;
  let failures = 0;
  let checked = 0;

  for (const [template, rawItem] of Object.entries(document.paths)) {
    const { schema: item } = deref(document, rawItem);
    if (!isRecord(item)) continue;

    const sharedParameters = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of OPENAPI_METHODS) {
      const { schema: rawOperation } = deref(document, item[method]);
      if (!isRecord(rawOperation)) continue;

      const upper = method.toUpperCase();
      const operationId =
        typeof rawOperation.operationId === 'string' ? rawOperation.operationId : '';
      const selected =
        wanted.length > 0
          ? wanted.includes(`${upper} ${template}`.toLowerCase()) ||
            wanted.includes(template.toLowerCase()) ||
            (operationId.length > 0 && wanted.includes(operationId.toLowerCase()))
          : spec.methods.includes(upper);
      if (!selected) continue;

      const title = `${upper} ${template}${operationId.length > 0 ? ` — ${operationId}` : ''}`;
      const stepIndex = index;
      index += 1;

      if (ctx.signal.aborted) {
        record(makeStep(stepIndex, title, 'SKIPPED', 0));
        continue;
      }

      const parameters = [
        ...sharedParameters,
        ...(Array.isArray(rawOperation.parameters) ? rawOperation.parameters : []),
      ]
        .map((parameter) => deref(document, parameter).schema)
        .filter(isRecord);

      // Fill the templated segments, preferring the spec's values and falling
      // back to whatever example the document itself provides.
      const missing: string[] = [];
      const path = template.replace(/\{([^}]+)\}/g, (whole, name: string) => {
        const supplied = spec.pathParams[name];
        if (supplied !== undefined) return encodeURIComponent(supplied);
        const declared = parameters.find((p) => p.name === name && p.in === 'path');
        const example = declared !== undefined ? exampleFor(declared) : null;
        if (example !== null) return encodeURIComponent(example);
        missing.push(name);
        return whole;
      });

      if (missing.length > 0) {
        record(
          makeStep(stepIndex, title, 'SKIPPED', 0, {
            message: `Not called: no value for the path parameter ${missing.map((n) => `"${n}"`).join(', ')}. Set it in the spec's pathParams, or give the parameter an example in the document.`,
          }),
        );
        continue;
      }

      const url = new URL(resolveUrl(baseUrl, path));
      for (const [key, value] of Object.entries(spec.query)) url.searchParams.set(key, value);

      const missingQuery: string[] = [];
      for (const parameter of parameters) {
        if (parameter.in !== 'query' || parameter.required !== true) continue;
        const name = typeof parameter.name === 'string' ? parameter.name : '';
        if (name.length === 0 || url.searchParams.has(name)) continue;
        const example = exampleFor(parameter);
        if (example === null) missingQuery.push(name);
        else url.searchParams.set(name, example);
      }
      if (missingQuery.length > 0) {
        record(
          makeStep(stepIndex, title, 'SKIPPED', 0, {
            message: `Not called: the required query parameter ${missingQuery.map((n) => `"${n}"`).join(', ')} has no value. Set it in the spec's \`query\`, or give it an example in the document.`,
          }),
        );
        continue;
      }

      const headers: Record<string, string> = { accept: 'application/json', ...common };
      let body: string | undefined;
      const supplied = spec.bodies[`${upper} ${template}`] ?? spec.bodies[`${upper} ${path}`];
      const { schema: requestBody } = deref(document, rawOperation.requestBody);
      if (supplied !== undefined) {
        body = typeof supplied === 'string' ? supplied : JSON.stringify(supplied);
        headers['content-type'] ??= 'application/json';
      } else if (isRecord(requestBody) && requestBody.required === true) {
        record(
          makeStep(stepIndex, title, 'SKIPPED', 0, {
            message: `Not called: the operation requires a request body. Provide one under \`bodies\` keyed by "${upper} ${template}".`,
          }),
        );
        continue;
      }

      const sent = await send(
        ctx,
        url.toString(),
        upper,
        headers,
        body,
        spec.requestTimeoutSeconds * 1000,
      );
      network.push(toNetworkEntry(upper, url.toString(), sent));
      checked += 1;

      if (sent.transportError !== null) {
        failures += 1;
        record(
          makeStep(stepIndex, title, 'FAILED', sent.durationMs, {
            message: `The provider could not be reached: ${sent.transportError}`,
            expected: 'a documented response',
            actual: 'no response',
          }),
        );
        continue;
      }

      const responses = isRecord(rawOperation.responses) ? rawOperation.responses : {};
      const status = sent.status ?? 0;
      const picked = pickResponse(responses, status);

      if (picked === null) {
        failures += 1;
        const documented = Object.keys(responses).join(', ') || 'none';
        record(
          makeStep(stepIndex, title, 'FAILED', sent.durationMs, {
            message: `Responded ${status}, which the document does not declare. Documented responses: ${documented}.`,
            expected: `one of ${documented}`,
            actual: `HTTP ${status}`,
          }),
        );
        continue;
      }

      const { schema: responseObject } = deref(document, picked.response);
      const check: SchemaCheck = { document, problems: [], notes: new Set() };

      if (isRecord(responseObject)) {
        // Required response headers.
        const declaredHeaders = isRecord(responseObject.headers) ? responseObject.headers : {};
        for (const [name, rawHeader] of Object.entries(declaredHeaders)) {
          const { schema: header } = deref(document, rawHeader);
          if (!isRecord(header) || header.required !== true) continue;
          if (sent.headers[name.toLowerCase()] === undefined) {
            check.problems.push(`the required response header "${name}" is missing`);
          }
        }

        const content = isRecord(responseObject.content) ? responseObject.content : null;
        const jsonKey = content !== null ? jsonContentKey(content) : null;
        const actualType = mediaType(sent.headers['content-type'] ?? '');

        if (content !== null && Object.keys(content).length > 0 && sent.text.length > 0) {
          const declaredTypes = Object.keys(content).map(mediaType);
          if (
            !declaredTypes.includes(actualType) &&
            !declaredTypes.includes('*/*') &&
            !(actualType.endsWith('+json') && declaredTypes.includes('application/json'))
          ) {
            check.problems.push(
              `responded with ${actualType || 'no content type'}; the document declares ${declaredTypes.join(', ')}`,
            );
          }
        }

        // Swagger 2.0 keeps the schema on the response itself.
        const schema =
          jsonKey !== null && content !== null && isRecord(content[jsonKey])
            ? (content[jsonKey] as Record<string, unknown>).schema
            : responseObject.schema;

        if (schema !== undefined && sent.text.length > 0) {
          let parsedBody: unknown;
          let parsed = true;
          try {
            parsedBody = JSON.parse(sent.text) as unknown;
          } catch {
            parsed = false;
          }
          if (!parsed) {
            check.problems.push(
              'the response body is not valid JSON, but the document declares a JSON schema',
            );
          } else {
            validateSchema(check, schema, parsedBody, '$', 0);
          }
        }
      }

      const note = check.notes.size > 0 ? ` — not verified: ${[...check.notes].join('; ')}` : '';
      const statusLabel = `${status} matched ${picked.key}`;

      if (check.problems.length === 0) {
        record(makeStep(stepIndex, `${title} → ${statusLabel}${note}`, 'PASSED', sent.durationMs));
        continue;
      }

      failures += 1;
      record(
        makeStep(stepIndex, `${title} → ${statusLabel}${note}`, 'FAILED', sent.durationMs, {
          message: check.problems.join('; '),
          expected: `a response conforming to the ${picked.key} schema`,
          actual: check.problems[0] ?? 'the response did not conform',
        }),
      );
    }
  }

  return {
    steps,
    network,
    notEvaluated:
      checked === 0
        ? wanted.length > 0
          ? `None of the requested operations (${spec.operations.join(', ')}) are in the document, or none could be called.`
          : `The document declares no ${spec.methods.join('/')} operation that could be called.`
        : null,
    summary: `${failures} of ${checked} documented operation(s) did not conform`,
  };
}

// ─── Async: one message against one expectation ──────────────────────────────

/**
 * What a consumer needs from one message, in the vocabulary a pact already uses.
 *
 * A pact message, an inline `events` expectation and (via its payload schema) an
 * AsyncAPI message all reduce to this, which is the point: the transport decides
 * how a message is obtained, never how it is judged.
 */
interface ShapeExpectation {
  /** The body the consumer declared. `undefined` asserts only that it arrived. */
  contents: unknown;
  /** Pact matching rules, either dialect. */
  matchingRules: unknown;
  /** Expected transport/message metadata: a topic, an SSE id, a webhook header. */
  metadata: Record<string, string>;
}

interface ShapeVerdict {
  mismatches: Mismatch[];
  unsupported: Set<string>;
}

/**
 * Compare message metadata to what the consumer declared.
 *
 * Uses the same `applyMatchers` engine as the body and the headers so a
 * `match: "regex"` on `metadata.topic` behaves exactly as it does everywhere
 * else; only the labels differ, because "header X is missing" is the wrong
 * sentence for a queue message.
 */
function compareMetadata(
  expected: Record<string, string>,
  actual: Record<string, string>,
  rules: HeaderRule[],
  out: Mismatch[],
  unsupported: Set<string>,
): void {
  for (const [name, want] of Object.entries(expected)) {
    const got = actual[name] ?? actual[name.toLowerCase()];
    if (got === undefined) {
      out.push({
        where: `metadata ${name}`,
        detail: 'is missing from the message',
        expected: want,
        actual: '(absent)',
      });
      continue;
    }
    const matchers = rules.find((rule) => rule.name === name.toLowerCase())?.matchers;
    if (matchers !== undefined && matchers.length > 0) {
      applyMatchers(matchers, want, got, `metadata ${name}`, out, unsupported);
      continue;
    }
    // Content types carry parameters (`; charset=utf-8`) that are not contract.
    const same =
      name.toLowerCase() === 'contenttype' || name.toLowerCase() === 'content-type'
        ? mediaType(got) === mediaType(want)
        : got.trim() === want.trim();
    if (!same) {
      out.push({
        where: `metadata ${name}`,
        detail: `is ${preview(got)}, expected ${preview(want)}`,
        expected: want,
        actual: got,
      });
    }
  }
}

/** Judge one message. The single matcher in this file, reached from every mode. */
function checkShape(expectation: ShapeExpectation, message: CollectedMessage): ShapeVerdict {
  const rules = collectRules(expectation.matchingRules);
  const mismatches: Mismatch[] = [];
  const unsupported = new Set<string>();

  compareMetadata(expectation.metadata, message.metadata, rules.header, mismatches, unsupported);

  const expected = expectation.contents;
  if (expected === undefined || expected === null) return { mismatches, unsupported };

  if (typeof expected === 'string') {
    if (message.text !== expected) {
      mismatches.push({
        where: '$',
        detail: 'payload text differs',
        expected: preview(expected),
        actual: preview(message.text),
      });
    }
    return { mismatches, unsupported };
  }

  let actual: unknown;
  try {
    actual = JSON.parse(message.text) as unknown;
  } catch {
    mismatches.push({
      where: '$',
      detail: 'the payload was not valid JSON',
      expected: 'a JSON payload',
      actual: preview(message.text.slice(0, BODY_SNIPPET_LIMIT)),
    });
    return { mismatches, unsupported };
  }

  compareBody(expected, actual, [], rules.body, 'exact', mismatches, unsupported);
  return { mismatches, unsupported };
}

/** The candidate that came closest, so a failure shows the real diff. */
function bestCandidate(
  expectation: ShapeExpectation,
  candidates: CollectedMessage[],
): { message: CollectedMessage; verdict: ShapeVerdict } | null {
  let best: { message: CollectedMessage; verdict: ShapeVerdict } | null = null;
  for (const message of candidates) {
    const verdict = checkShape(expectation, message);
    if (verdict.mismatches.length === 0) return { message, verdict };
    if (best === null || verdict.mismatches.length < best.verdict.mismatches.length) {
      best = { message, verdict };
    }
  }
  return best;
}

/** The `— matchers not implemented` suffix, identical to the HTTP mode's. */
function unsupportedNote(unsupported: Set<string>): string {
  if (unsupported.size === 0) return '';
  return ` — matcher${unsupported.size > 1 ? 's' : ''} not implemented, compared by type: ${[...unsupported].join(', ')}`;
}

function mismatchProblem(mismatches: Mismatch[]): {
  message: string;
  expected: string | null;
  actual: string | null;
} {
  const first = mismatches[0];
  return {
    message: mismatches
      .slice(0, MAX_PROBLEMS_PER_STEP)
      .map((m) => `${m.where} ${m.detail}`)
      .join('; '),
    expected: first?.expected ?? null,
    actual: first?.actual ?? null,
  };
}

/** Names a stream carries in-band, for matching a pact message to what arrived. */
function topicOf(metadata: Record<string, string>): string | null {
  for (const key of ['topic', 'destination', 'channel', 'kafka_topic', 'routingKey', 'subject']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** One line describing the window, so a failure says what DID arrive. */
function describeArrivals(messages: CollectedMessage[]): string {
  if (messages.length === 0) return 'nothing arrived';
  const names = [...new Set(messages.map((m) => m.name || '(unnamed)'))].slice(0, 10);
  return `${messages.length} message(s) arrived: ${names.join(', ')}`;
}

// ─── Async: message pacts ────────────────────────────────────────────────────

/**
 * Verify a consumer's message pact against the provider.
 *
 * Two ways to get the provider to produce the message, and both are legitimate:
 *
 *   `source.transport: "http"` is Pact's own message-provider protocol — QAAI
 *   asks for one message by description and the provider hands it back. That is
 *   the faithful implementation, and it needs the provider to have built the
 *   shim.
 *
 *   The streaming transports read the message off the wire instead. Most
 *   providers never built the shim, and refusing to verify them would mean the
 *   async half of Pact stays theoretical for exactly the teams that asked for
 *   it. The judgement is identical either way — same matching rules, same
 *   matcher — so the transport changes what is observed, never the verdict.
 */
async function verifyMessagePact(
  ctx: RunContext,
  spec: MessageContractSpec,
  common: Record<string, string>,
  emit: EmitStep,
): Promise<ModeResult> {
  const timeoutMs = spec.requestTimeoutSeconds * 1000;
  const text = await loadDocument(spec.pactPath, 'pact file', ctx, common, timeoutMs);
  const document = await parseDocument(text, 'pact file');

  if (!isRecord(document)) {
    throw new ContractConfigError('The pact file did not contain a pact object.');
  }

  const consumerName =
    isRecord(document.consumer) && typeof document.consumer.name === 'string'
      ? document.consumer.name
      : 'consumer';
  const providerName =
    isRecord(document.provider) && typeof document.provider.name === 'string'
      ? document.provider.name
      : 'provider';

  if (spec.consumer !== undefined && spec.consumer !== consumerName) {
    return {
      steps: [],
      network: [],
      notEvaluated: `The pact is between ${consumerName} and ${providerName}, but the spec asked for consumer "${spec.consumer}".`,
      summary: '',
    };
  }

  let only: RegExp | null = null;
  if (spec.only !== undefined) {
    try {
      only = new RegExp(spec.only, 'i');
    } catch {
      throw new ContractConfigError(`\`only\` is not a valid regular expression: ${spec.only}`);
    }
  }

  const all = pactMessages(document);
  if (all.length === 0) {
    const httpCount = Array.isArray(document.interactions) ? document.interactions.length : 0;
    return {
      steps: [],
      network: [],
      notEvaluated:
        httpCount > 0
          ? `This pact declares ${httpCount} HTTP interaction(s) and no message. Set the spec's kind to "pact" to replay them.`
          : 'The pact file declares no message interactions.',
      summary: '',
    };
  }

  const baseUrl = spec.providerBaseUrl ?? ctx.baseUrl;
  const steps: StepResult[] = [];
  const network: NetworkEntry[] = [];
  const results: VerificationResult[] = [];
  const record = (step: StepResult): void => {
    steps.push(step);
    emit(step);
  };
  let index = 0;
  let failures = 0;
  let verified = 0;

  const selected = all.filter(
    (message) =>
      only === null ||
      only.test(message.description) ||
      only.test(message.states.map((s) => s.name).join(', ')),
  );
  // A message `only` filtered out still gets a step, so "verified 1 of 4" is
  // visible in the cockpit rather than looking like a pact with one message.
  const wanted = new Set(selected);
  for (const message of all) {
    if (!wanted.has(message)) {
      record(makeStep(index, `message: ${message.description}`, 'SKIPPED', 0));
      index += 1;
    }
  }

  const titleOf = (message: PactMessage): string => {
    const given = message.states.map((s) => s.name).join(', ');
    const topic = topicOf(message.metadata);
    return `message: ${message.description}${topic !== null ? ` on ${topic}` : ''}${given.length > 0 ? ` (given ${given})` : ''}`;
  };

  const judge = (message: PactMessage, candidate: CollectedMessage, began: number): void => {
    verified += 1;
    const verdict = checkShape(
      {
        contents: message.contents,
        matchingRules: message.matchingRules,
        metadata: message.metadata,
      },
      candidate,
    );
    const title = `${titleOf(message)}${unsupportedNote(verdict.unsupported)}`;
    if (verdict.mismatches.length === 0) {
      record(makeStep(index, title, 'PASSED', Date.now() - began));
      results.push({ interactionDescription: message.description, success: true });
      index += 1;
      return;
    }
    failures += 1;
    const problem = mismatchProblem(verdict.mismatches);
    record(makeStep(index, title, 'FAILED', Date.now() - began, problem));
    results.push({
      interactionDescription: message.description,
      success: false,
      exceptionMessage: problem.message.slice(0, 1000),
    });
    index += 1;
  };

  const fail = (message: PactMessage, detail: string, began: number, actual: string): void => {
    verified += 1;
    failures += 1;
    record(
      makeStep(index, titleOf(message), 'FAILED', Date.now() - began, {
        message: detail,
        expected: `a message matching "${message.description}"`,
        actual,
      }),
    );
    results.push({
      interactionDescription: message.description,
      success: false,
      exceptionMessage: detail.slice(0, 1000),
    });
    index += 1;
  };

  if (spec.source.transport === 'http') {
    for (const message of selected) {
      if (ctx.signal.aborted) {
        record(makeStep(index, titleOf(message), 'SKIPPED', 0));
        index += 1;
        continue;
      }
      const began = Date.now();
      const stateError = await setUpState(ctx, spec, consumerName, message.states, common);
      if (stateError !== null) {
        fail(message, stateError, began, 'the state hook did not succeed');
        continue;
      }
      const produced = await requestPactMessage(
        ctx,
        spec.source,
        baseUrl,
        common,
        message.description,
        message.states,
        timeoutMs,
      );
      network.push(produced.network);
      if (produced.message === null) {
        fail(message, produced.problem ?? 'no message was produced', began, 'no message');
        continue;
      }
      judge(message, produced.message, began);
    }
  } else {
    /*
     * A stream cannot be re-driven per message, so every provider state is set
     * up BEFORE the window opens — the events have to fire after the provider is
     * in the right state, not after we started asking.
     */
    const began = Date.now();
    const states = selected.flatMap((message) => message.states);
    const stateError = await setUpState(ctx, spec, consumerName, states, common);
    if (stateError !== null) {
      for (const message of selected)
        fail(message, stateError, began, 'the state hook did not succeed');
      return {
        steps,
        network,
        notEvaluated: null,
        summary: `${consumerName} → ${providerName}: ${failures} of ${verified} message(s) broke`,
        pact: { consumerName, providerName, results },
      };
    }

    const collection = await collectMessages(ctx, spec.source, baseUrl, common);
    network.push(...collection.network);
    if (collection.transportError !== null) {
      for (const message of selected) {
        fail(
          message,
          `The provider's ${spec.source.transport} transport failed: ${collection.transportError}`,
          began,
          'no message',
        );
      }
    } else {
      for (const message of selected) {
        const topic = topicOf(message.metadata);
        const candidates =
          topic === null
            ? collection.messages
            : collection.messages.filter((candidate) => candidate.name === topic);
        const best = bestCandidate(
          {
            contents: message.contents,
            matchingRules: message.matchingRules,
            metadata: message.metadata,
          },
          candidates,
        );
        if (best === null) {
          fail(
            message,
            `No message${topic !== null ? ` on ${topic}` : ''} arrived on ${collection.target} within ${spec.source.listenSeconds}s. ${describeArrivals(collection.messages)}.`,
            began,
            describeArrivals(collection.messages),
          );
          continue;
        }
        judge(message, best.message, began);
      }
    }
  }

  return {
    steps,
    network,
    notEvaluated:
      verified === 0
        ? `No message in the pact between ${consumerName} and ${providerName} was verified.`
        : null,
    summary: `${consumerName} → ${providerName}: ${failures} of ${verified} message(s) broke`,
    pact: { consumerName, providerName, results },
  };
}

// ─── Async: event shapes declared inline ─────────────────────────────────────

/** The "what was listened to" step every streaming mode opens with. */
function listenStep(
  index: number,
  spec: { source: { transport: string } },
  collection: Collection,
): StepResult {
  const title = `Listen on ${collection.target} (${spec.source.transport})${collection.notes.length > 0 ? ` — ${collection.notes.join('; ')}` : ''}`;
  if (collection.transportError !== null) {
    return makeStep(index, title, 'FAILED', collection.durationMs, {
      message: `The event transport could not be used: ${collection.transportError}`,
      expected: 'an open stream',
      actual: 'no stream',
    });
  }
  return makeStep(
    index,
    `${title} — ${describeArrivals(collection.messages)}`,
    'PASSED',
    collection.durationMs,
  );
}

/**
 * Check the events a provider emits against shapes declared in the spec.
 *
 * The expectations are written the way a pact writes them (a body plus matching
 * rules) and judged by the same matcher, so a team can start here and move to a
 * real message pact later without their assertions changing meaning.
 */
async function checkEventShapes(
  ctx: RunContext,
  spec: EventsContractSpec,
  common: Record<string, string>,
  emit: EmitStep,
): Promise<ModeResult> {
  const baseUrl = spec.providerBaseUrl ?? ctx.baseUrl;
  const steps: StepResult[] = [];
  const record = (step: StepResult): void => {
    steps.push(step);
    emit(step);
  };

  const collection = await collectMessages(ctx, spec.source, baseUrl, common);
  record(listenStep(0, spec, collection));

  if (collection.transportError !== null) {
    for (const [offset, expectation] of spec.expect.entries()) {
      record(
        makeStep(
          offset + 1,
          expectation.name ?? expectation.event ?? `event ${offset + 1}`,
          'SKIPPED',
          0,
        ),
      );
    }
    return {
      steps,
      network: collection.network,
      notEvaluated: null,
      summary: `the ${spec.source.transport} transport failed before any event could be checked`,
    };
  }

  let failures = 0;
  for (const [offset, expectation] of spec.expect.entries()) {
    const index = offset + 1;
    const label = expectation.name ?? expectation.event ?? `event ${index}`;
    const shape: ShapeExpectation = {
      contents: expectation.contents,
      matchingRules: expectation.matchingRules,
      metadata: expectation.metadata,
    };
    const candidates =
      expectation.event === undefined
        ? collection.messages
        : collection.messages.filter((message) => message.name === expectation.event);

    const matched = candidates.filter(
      (message) => checkShape(shape, message).mismatches.length === 0,
    );
    if (matched.length >= expectation.min) {
      record(
        makeStep(
          index,
          `${label} — ${matched.length} matching message(s)`,
          'PASSED',
          collection.durationMs,
        ),
      );
      continue;
    }

    failures += 1;
    const best = bestCandidate(shape, candidates);
    if (best === null) {
      record(
        makeStep(index, label, 'FAILED', collection.durationMs, {
          message: `No event${expectation.event !== undefined ? ` named "${expectation.event}"` : ''} arrived on ${collection.target} within ${spec.source.listenSeconds}s. ${describeArrivals(collection.messages)}.`,
          expected: expectation.event ?? 'a matching event',
          actual: describeArrivals(collection.messages),
        }),
      );
      continue;
    }
    const problem = mismatchProblem(best.verdict.mismatches);
    record(
      makeStep(
        index,
        `${label}${unsupportedNote(best.verdict.unsupported)}`,
        'FAILED',
        collection.durationMs,
        matched.length > 0
          ? {
              message: `only ${matched.length} of the ${expectation.min} required matching message(s) arrived; the closest other one: ${problem.message}`,
              expected: `${expectation.min} matching message(s)`,
              actual: `${matched.length}`,
            }
          : problem,
      ),
    );
  }

  return {
    steps,
    network: collection.network,
    notEvaluated: null,
    summary: `${failures} of ${spec.expect.length} expected event(s) did not arrive as declared`,
  };
}

// ─── Async: AsyncAPI ─────────────────────────────────────────────────────────

/**
 * Validate what a provider emits against the channels its AsyncAPI document
 * declares — the async equivalent of the openapi mode, down to using the same
 * schema validator, so `type: integer` means the same thing on a queue as it
 * does on a REST response.
 */
async function checkAsyncApi(
  ctx: RunContext,
  spec: AsyncApiContractSpec,
  common: Record<string, string>,
  emit: EmitStep,
): Promise<ModeResult> {
  const text = await loadDocument(
    spec.specPath,
    'AsyncAPI document',
    ctx,
    common,
    spec.requestTimeoutSeconds * 1000,
  );
  const document = await parseDocument(text, 'AsyncAPI document');
  if (!isRecord(document) || !isRecord(document.channels)) {
    throw new ContractConfigError('The AsyncAPI document has no `channels` object.');
  }

  const declared = asyncApiMessages(document, (node) => deref(document, node).schema);
  if (declared.messages.length === 0) {
    throw new ContractConfigError(
      'The AsyncAPI document declares no messages on any channel, so there was nothing to verify.',
    );
  }

  const wanted = spec.channels.map((channel) => channel.trim().toLowerCase());
  const baseUrl = spec.providerBaseUrl ?? ctx.baseUrl;
  const steps: StepResult[] = [];
  const record = (step: StepResult): void => {
    steps.push(step);
    emit(step);
  };

  const collection = await collectMessages(ctx, spec.source, baseUrl, common);
  record(listenStep(0, spec, collection));

  if (collection.transportError !== null) {
    return {
      steps,
      network: collection.network,
      notEvaluated: null,
      summary: `the ${spec.source.transport} transport failed before any message could be validated`,
    };
  }

  if (collection.messages.length === 0) {
    return {
      steps,
      network: collection.network,
      notEvaluated: spec.requireMessages
        ? `No message arrived on ${collection.target} within ${spec.source.listenSeconds}s, so no channel could be validated. Raise \`source.listenSeconds\`, or set \`requireMessages: false\` if an empty window is acceptable.`
        : null,
      summary: 'no message arrived',
    };
  }

  let index = 1;
  let failures = 0;
  let checked = 0;

  for (const message of collection.messages) {
    const label = `${message.name || '(unnamed)'} #${message.index + 1}`;
    const matches = declared.messages.filter(
      (candidate) => candidate.channel === message.name || candidate.name === message.name,
    );

    if (wanted.length > 0) {
      const inScope = matches.some(
        (candidate) =>
          wanted.includes(candidate.channel.toLowerCase()) ||
          wanted.includes(candidate.name.toLowerCase()),
      );
      if (!inScope) {
        record(makeStep(index, label, 'SKIPPED', 0));
        index += 1;
        continue;
      }
    }

    if (matches.length === 0) {
      if (spec.allowUndeclaredChannels) {
        record(
          makeStep(
            index,
            `${label} — not declared, and undeclared channels are allowed`,
            'SKIPPED',
            0,
          ),
        );
        index += 1;
        continue;
      }
      failures += 1;
      checked += 1;
      const channels = [...new Set(declared.messages.map((m) => m.channel))]
        .slice(0, 20)
        .join(', ');
      record(
        makeStep(index, label, 'FAILED', 0, {
          message: `The provider emitted on "${message.name || '(unnamed)'}", which the document does not declare. Declared channels: ${channels}.`,
          expected: `one of ${channels}`,
          actual: message.name || '(unnamed)',
        }),
      );
      index += 1;
      continue;
    }

    const unverifiable = matches.find((candidate) => candidate.unverifiableFormat !== null);
    if (unverifiable !== undefined) {
      record(
        makeStep(index, label, 'SKIPPED', 0, {
          message: `Not validated: ${unverifiable.channel} declares its payload as ${unverifiable.unverifiableFormat}, which is not JSON Schema. QAAI validates JSON Schema payloads.`,
        }),
      );
      index += 1;
      continue;
    }

    checked += 1;
    let payload: unknown;
    let parsed = true;
    try {
      payload = JSON.parse(message.text) as unknown;
    } catch {
      parsed = false;
    }

    if (!parsed) {
      failures += 1;
      record(
        makeStep(index, label, 'FAILED', 0, {
          message: 'the payload is not valid JSON, but the document declares a JSON Schema payload',
          expected: 'a JSON payload',
          actual: preview(message.text.slice(0, BODY_SNIPPET_LIMIT)),
        }),
      );
      index += 1;
      continue;
    }

    /*
     * A channel may declare several messages (`oneOf`, or 3.x's message map).
     * The payload conforms if ANY of them accepts it — that is what the document
     * means — so every alternative is tried and only the closest failure is
     * reported.
     */
    let best: SchemaCheck | null = null;
    let conformed = false;
    for (const candidate of matches) {
      if (candidate.payloadSchema === undefined) {
        conformed = true;
        break;
      }
      const check: SchemaCheck = { document, problems: [], notes: new Set() };
      validateSchema(check, candidate.payloadSchema, payload, '$', 0);
      if (check.problems.length === 0) {
        conformed = true;
        best = check;
        break;
      }
      if (best === null || check.problems.length < best.problems.length) best = check;
    }

    const note =
      best !== null && best.notes.size > 0 ? ` — not verified: ${[...best.notes].join('; ')}` : '';
    if (conformed) {
      record(makeStep(index, `${label}${note}`, 'PASSED', 0));
      index += 1;
      continue;
    }

    failures += 1;
    const problems = best?.problems ?? ['the payload did not conform'];
    record(
      makeStep(index, `${label}${note}`, 'FAILED', 0, {
        message: problems.join('; '),
        expected: `a payload conforming to the ${matches[0]?.channel ?? message.name} schema`,
        actual: problems[0] ?? 'the payload did not conform',
      }),
    );
    index += 1;
  }

  for (const note of declared.notes) {
    record(makeStep(index, `Not verified: ${note}`, 'SKIPPED', 0));
    index += 1;
  }

  return {
    steps,
    network: collection.network,
    notEvaluated:
      checked === 0
        ? `None of the ${collection.messages.length} message(s) that arrived matched a requested channel (${spec.channels.join(', ')}).`
        : null,
    summary: `${failures} of ${checked} message(s) did not conform to the AsyncAPI document`,
  };
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const KIND_HELP: Record<string, string> = {
  pact: "replay a consumer pact's HTTP interactions against the provider",
  openapi: 'check live responses against the OpenAPI document',
  message: 'verify a consumer message pact against the events the provider produces',
  events: 'check the events a provider emits against shapes declared in the spec',
  asyncapi: 'validate emitted messages against the AsyncAPI channel schemas',
};

function issueSentence(
  test: ExecutableTest,
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
): Error {
  const issues = error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return new Error(`Contract test "${test.name}" has an invalid spec — ${issues}`);
}

/**
 * The synchronous kinds are validated by the schema in @qaai/shared; the async
 * kinds by the one in contract-events.ts. They are separate because nothing
 * outside this plugin reads a contract spec, and keeping the async shapes next
 * to the transports they describe means adding a transport touches one package.
 */
function parseSpec(test: ExecutableTest): ContractTestSpec | AsyncContractSpec {
  const kind = isRecord(test.spec) ? test.spec.kind : undefined;

  if (typeof kind === 'string' && (ASYNC_CONTRACT_KINDS as readonly string[]).includes(kind)) {
    const parsed = asyncContractSpecSchema.safeParse(test.spec);
    if (!parsed.success) throw issueSentence(test, parsed.error);
    return parsed.data;
  }

  if (kind !== 'pact' && kind !== 'openapi') {
    const options = Object.entries(KIND_HELP)
      .map(([name, help]) => `"${name}" (${help})`)
      .join(', ');
    throw new Error(
      `Contract test "${test.name}" has an invalid spec — kind: set it to one of ${options}.`,
    );
  }

  const parsed = contractTestSpecSchema.safeParse(test.spec);
  if (!parsed.success) throw issueSentence(test, parsed.error);
  return parsed.data;
}

/**
 * The broker configuration for this test, if it has one.
 *
 * `publish` is read off the RAW spec for the `pact` kind: its schema lives in
 * @qaai/shared, does not declare the block, and strips it. Reading it here keeps
 * every broker field in one definition (`brokerPublishSchema`) and lets both
 * pact modes publish. A block that does not parse is REPORTED, never dropped —
 * silently ignoring it would mean a team believes their broker is being updated
 * when it is not.
 */
function publishConfigFor(
  test: ExecutableTest,
  spec: ContractTestSpec | AsyncContractSpec,
): { config: BrokerPublishConfig | null; problem: string | null } {
  if (spec.kind === 'message') return { config: spec.publish ?? null, problem: null };

  const raw = isRecord(test.spec) ? test.spec.publish : undefined;
  if (raw === undefined || raw === null) return { config: null, problem: null };

  if (spec.kind !== 'pact') {
    return {
      config: null,
      problem: `Verification results were not published: a broker only records results for a pact, and this spec's kind is "${spec.kind}".`,
    };
  }

  const parsed = brokerPublishSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      config: null,
      problem: `Verification results were not published — \`publish\` is invalid: ${issues}`,
    };
  }
  return { config: parsed.data, problem: null };
}

export const contractPlugin: RunnerPlugin = {
  type: 'CONTRACT',

  validate(test: ExecutableTest): void {
    parseSpec(test);
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const startedAt = Date.now();
    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };

    const finish = (
      status: TestExecution['status'],
      steps: StepResult[],
      network: NetworkEntry[],
      errorMessage: string | null,
    ): TestExecution => ({
      ...base,
      status,
      durationMs: Date.now() - startedAt,
      steps,
      // Masked here rather than at write time: a broker URL or a replayed
      // request routinely carries a token that came out of the vault.
      network: maskDeep(network, Object.values(ctx.secrets)),
      errorMessage,
    });

    try {
      const spec = parseSpec(test);
      const common = { ...authHeaders(spec, ctx), ...spec.headers };

      const emit: EmitStep = (step) =>
        ctx.logger.step({
          testId: test.id,
          index: step.index,
          title: step.title,
          status: step.status,
        });

      const result =
        spec.kind === 'pact'
          ? await verifyPact(ctx, spec, common, emit)
          : spec.kind === 'openapi'
            ? await checkOpenApi(ctx, spec, common, emit)
            : spec.kind === 'message'
              ? await verifyMessagePact(ctx, spec, common, emit)
              : spec.kind === 'events'
                ? await checkEventShapes(ctx, spec, common, emit)
                : await checkAsyncApi(ctx, spec, common, emit);

      if (result.notEvaluated !== null) {
        // Nothing was verified, so there is no result to publish: telling a
        // broker "verification passed" because there was nothing to check is
        // exactly the lie `can-i-deploy` must never be told.
        return finish('SKIPPED', result.steps, result.network, result.notEvaluated);
      }

      const failed = result.steps.filter((step) => step.status === 'FAILED');

      /*
       * Publish AFTER the verdict is decided and regardless of what it was — a
       * broker that only ever hears about passes cannot stop a bad deploy. The
       * step it appends is PASSED or SKIPPED and never FAILED, so a broker
       * problem cannot turn a conforming provider red.
       */
      const steps = [...result.steps];
      const network = [...result.network];
      const publish = publishConfigFor(test, spec);
      const recordPublish = (step: StepResult): void => {
        steps.push(step);
        emit(step);
      };
      if (publish.problem !== null) {
        recordPublish(
          makeStep(steps.length, 'Publish verification results', 'SKIPPED', 0, {
            message: publish.problem,
          }),
        );
      } else if (publish.config !== null) {
        /*
         * The try is the rule, not belt-and-braces: `publishVerification`
         * returns a skip for every failure it knows about, and if it ever threw
         * one it did not, the catch below would turn a verified provider into
         * "the contract test could not complete" — a reporting problem losing a
         * result, which is the one thing this plugin may never do.
         */
        let outcome: PublishOutcome;
        try {
          outcome =
            result.pact === undefined
              ? {
                  status: 'SKIPPED',
                  detail:
                    'Verification results were not published: this mode has no pact behind it, so there is no consumer to record a result for.',
                  durationMs: 0,
                  network: null,
                }
              : await publishVerification(ctx, publish.config, {
                  consumerName: result.pact.consumerName,
                  providerName: result.pact.providerName,
                  success: failed.length === 0,
                  results: result.pact.results,
                });
        } catch (err) {
          outcome = {
            status: 'SKIPPED',
            detail: `Verification results were not published: ${messageOf(err)}. The provider's conformance is unaffected.`,
            durationMs: 0,
            network: null,
          };
        }
        if (outcome.network !== null) network.push(outcome.network);
        recordPublish(
          makeStep(
            steps.length,
            `Publish verification results${outcome.status === 'PUBLISHED' ? ` — ${outcome.detail}` : ''}`,
            outcome.status === 'PUBLISHED' ? 'PASSED' : 'SKIPPED',
            outcome.durationMs,
            outcome.status === 'PUBLISHED' ? undefined : { message: outcome.detail },
          ),
        );
      }

      if (failed.length === 0) {
        return finish('PASSED', steps, network, null);
      }

      return finish(
        'FAILED',
        steps,
        network,
        `${result.summary}. First: ${failed[0]?.error?.message ?? ''}`.slice(0, 2000),
      );
    } catch (err) {
      // A configuration gap or a missing dependency is never the application's
      // fault, so it is reported as "not evaluated" rather than as a break.
      if (err instanceof ContractConfigError || err instanceof MissingToolError) {
        return finish('SKIPPED', [], [], err.message);
      }
      // Anything else still has to produce a result: a reporting problem must
      // not lose the run.
      return finish('FAILED', [], [], `The contract test could not complete: ${messageOf(err)}`);
    }
  },
};
