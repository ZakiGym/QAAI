/**
 * Editing a ticket that is already on the customer's board.
 *
 * `createIssue` has always been the only way out of this module, which is why
 * the re-file path could report nothing better than `providerBodyRefreshed:
 * false`: one ticket per cause was kept, and the ticket's body went on listing
 * the tests known at filing time. `updateIssue` closes that, and it carries a
 * request with a customer's personal access token on it — so the tests here are
 * mostly about what it refuses.
 *
 * What is being proven, in order of how expensive the bug would be:
 *
 *   1. THE HOST IS THE CONSTANT. A ticket's provider key is read back out of
 *      the database and interpolated into a path. If it could choose the host
 *      instead, a row an admin can edit would be able to point a request
 *      carrying the token at a server of their choosing.
 *   2. A 3xx IS AN ERROR, NOT A HOP. Following one re-sends the Authorization
 *      header to whatever Location names, which is precisely how a PAT walks
 *      out of the building.
 *   3. THE RIGHT METHOD, PER PROVIDER. A PATCH sent as a POST creates a second
 *      issue instead of editing the first — the forty-tickets defect, caused by
 *      the fix for it.
 *   4. A REFUSAL IS A REFUSAL. An empty patch, an unparseable key, a `success:
 *      false` inside a 200: each has to throw, because the caller turns "did
 *      not throw" into `providerBodyRefreshed: true` and tells the user their
 *      ticket was rewritten.
 *
 * `fetch` is stubbed globally; nothing here opens a socket.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueFilingError, updateIssue } from './issues.js';
import type { IssueTrackerConfig } from './issues.js';

const TOKEN = 'ghp_atokenthatmustneverappearanywhere';

interface Sent {
  url: string;
  method: string;
  redirect: string;
  headers: Record<string, string>;
  body: unknown;
  hasSignal: boolean;
}

let sent: Sent[] = [];

/** Answers every request with one canned response. */
function stubFetch(response: { status: number; body?: unknown }): void {
  vi.stubGlobal('fetch', async (url: string, init: Record<string, any>) => {
    sent.push({
      url: String(url),
      method: String(init.method),
      redirect: String(init.redirect),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
      hasSignal: Boolean(init.signal),
    });
    return {
      status: response.status,
      type: 'default',
      ok: response.status >= 200 && response.status < 300,
      text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
    } as unknown as Response;
  });
}

const github: IssueTrackerConfig = {
  kind: 'GITHUB',
  repo: 'acme/storefront',
  labels: [],
  keyVersion: 1,
};
const jira: IssueTrackerConfig = {
  kind: 'JIRA',
  site: 'https://acme.atlassian.net',
  projectKey: 'QA',
  issueType: 'Bug',
  email: 'bot@acme.test',
  keyVersion: 1,
};
const linear: IssueTrackerConfig = {
  kind: 'LINEAR',
  teamId: '11111111-2222-3333-4444-555555555555',
  labelIds: [],
  keyVersion: 1,
};

const patch = { title: 'A new title', body: 'A new body' };

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateIssue — GitHub', () => {
  it('PATCHes the pinned API host, with the number taken out of the stored key', async () => {
    stubFetch({ status: 200, body: { number: 12 } });

    await updateIssue(github, TOKEN, 'acme/storefront#12', patch);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.github.com/repos/acme/storefront/issues/12');
    // POST would CREATE a second issue instead of editing the first.
    expect(sent[0]!.method).toBe('PATCH');
    expect(sent[0]!.body).toEqual({ title: 'A new title', body: 'A new body' });
  });

  it('builds the path from the CONFIG repo, never from the stored key', async () => {
    /*
     * The key is a value read back out of the database. If the repo on it
     * decided where the request went, a row an admin can edit would choose the
     * destination of a request carrying the customer's token. Only the trailing
     * number is taken from it.
     */
    stubFetch({ status: 200, body: { number: 9 } });

    await updateIssue(github, TOKEN, 'attacker/evil#9', patch);

    expect(sent[0]!.url).toBe('https://api.github.com/repos/acme/storefront/issues/9');
  });

  it('never follows a redirect, and never waits forever', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await updateIssue(github, TOKEN, 'acme/storefront#1', patch);

    // Following a 3xx would re-send the Authorization header to whatever
    // Location named.
    expect(sent[0]!.redirect).toBe('manual');
    expect(sent[0]!.hasSignal).toBe(true);
  });

  it('treats a 3xx as a failure rather than a hop', async () => {
    stubFetch({ status: 302 });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', patch)).rejects.toThrow(
      /redirect/i,
    );
  });

  it('says the ticket is GONE on a 404, which is a different fix from a 404 on create', async () => {
    // On a create a 404 means the repo is wrong; on an edit it means the TICKET
    // has been deleted or moved, and the honest advice is "file a new one"
    // rather than "fix your integration".
    stubFetch({ status: 404 });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', patch)).rejects.toThrow(
      /no longer has that issue/,
    );
  });

  it('refuses a stored key it cannot read a number out of', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await expect(updateIssue(github, TOKEN, 'acme/storefront', patch)).rejects.toBeInstanceOf(
      IssueFilingError,
    );
    // And it refuses BEFORE sending anything.
    expect(sent).toEqual([]);
  });

  it('sends only the fields the patch names', async () => {
    stubFetch({ status: 200, body: { number: 1 } });

    await updateIssue(github, TOKEN, 'acme/storefront#1', { body: 'only the body' });

    expect(sent[0]!.body).toEqual({ body: 'only the body' });
  });
});

describe('updateIssue — Jira', () => {
  it('PUTs the issue on the validated site, keyed by its own key', async () => {
    stubFetch({ status: 204 });

    await updateIssue(jira, TOKEN, 'QA-12', patch);

    expect(sent[0]!.url).toBe('https://acme.atlassian.net/rest/api/2/issue/QA-12');
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.body).toEqual({
      fields: { summary: 'A new title', description: 'A new body' },
    });
  });

  it('accepts the 204 Jira actually answers with', async () => {
    // A successful Jira edit has no body. An implementation that insisted on
    // 200 would report every successful rewrite as a failure.
    stubFetch({ status: 204 });
    await expect(updateIssue(jira, TOKEN, 'QA-12', patch)).resolves.toBeUndefined();
  });

  it('refuses a key that is not a key, before sending anything', async () => {
    stubFetch({ status: 204 });

    await expect(
      updateIssue(jira, TOKEN, '../../../rest/api/2/myself', patch),
    ).rejects.toBeInstanceOf(IssueFilingError);
    expect(sent).toEqual([]);
  });
});

describe('updateIssue — Linear', () => {
  const ok = { data: { issueUpdate: { success: true, issue: { identifier: 'ENG-12' } } } };

  it('posts the update mutation to the pinned GraphQL host', async () => {
    stubFetch({ status: 200, body: ok });

    await updateIssue(linear, TOKEN, 'ENG-12', patch);

    expect(sent[0]!.url).toBe('https://api.linear.app/graphql');
    expect(sent[0]!.method).toBe('POST');
    const body = sent[0]!.body as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('issueUpdate');
    expect(body.variables.id).toBe('ENG-12');
    expect(body.variables.input).toEqual({ title: 'A new title', description: 'A new body' });
  });

  it('reads the failure Linear reports inside a 200', async () => {
    // GraphQL reports failure in a 200, so an unknown issue id looks exactly
    // like success until the errors array is read.
    stubFetch({ status: 200, body: { errors: [{ message: 'Entity not found' }] } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/Entity not found/);
  });

  it('refuses to call a `success: false` a success', async () => {
    /*
     * Linear's other way of saying no: a 200, no errors array, and
     * `success: false`. The caller turns "did not throw" into
     * `providerBodyRefreshed: true`, so swallowing this would tell a user their
     * ticket was rewritten when it was not.
     */
    stubFetch({ status: 200, body: { data: { issueUpdate: { success: false } } } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/did not confirm/);
  });

  it('redacts anything token-shaped out of a provider message', async () => {
    stubFetch({ status: 200, body: { errors: [{ message: `bad auth for ${TOKEN}` }] } });

    await expect(updateIssue(linear, TOKEN, 'ENG-12', patch)).rejects.toThrow(/\[redacted\]/);
  });
});

describe('updateIssue refuses an empty patch', () => {
  it('throws rather than issuing a no-op request', async () => {
    /*
     * A caller that believes it refreshed a ticket and sent nothing is the
     * caller that reports `providerBodyRefreshed: true` about a ticket it never
     * touched.
     */
    stubFetch({ status: 200, body: { number: 1 } });

    await expect(updateIssue(github, TOKEN, 'acme/storefront#1', {})).rejects.toThrow(
      /has to change the title, the body, or both/,
    );
    expect(sent).toEqual([]);
  });
});
