/**
 * Tests for the install screen's preview.
 *
 * The web app has no jsdom, so the screen's judgement was pulled out into a
 * pure module and this is where it is checked. What is worth proving:
 *
 *   1. The preview NEVER claims the signature is good. That is the one thing
 *      this code could get wrong that would actually hurt somebody — a panel
 *      that reads as verification while verifying nothing. It is asserted
 *      structurally (`signatureChecked` is a false literal, so a future edit
 *      that sets it true does not compile) and behaviourally.
 *   2. A capability the manifest asks for is never dropped silently. A name
 *      this build has no copy for comes back in `unrecognised`, because a row
 *      omitted from the list is a permission granted without being shown.
 *   3. Every objection the server can raise before the signature check is
 *      mirrored here, so the person fixes it while still looking at the
 *      document rather than after a failed POST.
 *   4. The digest field compares against the SIGNED digest — the check that
 *      catches a swapped download, and the one the reader can act on.
 */

import { describe, expect, it } from 'vitest';
import { blockingReason, parseSignedDocument, previewInstall } from './preview';
import type { PluginRegistry } from './types';

const CAPABILITIES: PluginRegistry['capabilities'] = [
  { name: 'network', label: 'Network', grants: 'g', bounded: 'b', governed: false },
  { name: 'page', label: 'The page under test', grants: 'g', bounded: 'b', governed: false },
  { name: 'secrets', label: 'Project secrets', grants: 'g', bounded: 'b', governed: true },
];

const SIGNED_SHA = 'a'.repeat(64);

function registry(over: Partial<PluginRegistry> = {}): PluginRegistry {
  return {
    plan: { label: 'Business', allowsGovernedCapabilities: true },
    protocol: { speaks: 1, oldest: 1 },
    manifestSchema: 'qaai.plugin/1',
    reservedNames: ['e2e', 'accessibility', 'external'],
    capabilities: CAPABILITIES,
    publishers: [
      {
        id: 'pub_1',
        publisherId: 'acme',
        displayName: 'Acme Inc',
        fingerprint: '1111-2222-3333-4444-5555-6666-7777-8888',
        revokedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        pluginCount: 0,
      },
    ],
    plugins: [],
    projects: [{ id: 'proj_1', name: 'Storefront' }],
    ...over,
  };
}

function doc(manifest: Record<string, unknown> = {}): string {
  return JSON.stringify({
    manifest: {
      schema: 'qaai.plugin/1',
      name: 'acme-lighthouse',
      version: '1.4.2',
      publisher: 'acme',
      displayName: 'Acme Lighthouse',
      description: 'Runs Lighthouse.',
      protocol: 1,
      capabilities: ['network', 'page'],
      code: { sha256: SIGNED_SHA, bytes: 2048, entry: 'dist/index.js' },
      ...manifest,
    },
    signature: { algorithm: 'ed25519', value: 'c2lnbmF0dXJl' },
  });
}

describe('parseSignedDocument', () => {
  it('refuses text that is not JSON', () => {
    expect(parseSignedDocument('not json')).toEqual({ error: expect.stringContaining('valid JSON') });
  });

  it('refuses a manifest with no signature, rather than previewing it', () => {
    const unsigned = JSON.stringify({ manifest: JSON.parse(doc()).manifest });
    const result = parseSignedDocument(unsigned);
    expect('error' in result && result.error).toContain('signature');
  });

  it('names the fields it could not find', () => {
    const result = parseSignedDocument(
      JSON.stringify({ manifest: { name: 'x' }, signature: { algorithm: 'ed25519', value: 'a' } }),
    );
    expect('error' in result && result.error).toContain('version');
    expect('error' in result && result.error).toContain('code.sha256');
  });
});

describe('previewInstall', () => {
  it('says nothing at all until something is pasted', () => {
    expect(previewInstall('   ', '', registry())).toEqual({ state: 'empty' });
  });

  it('never reports the signature as checked', () => {
    const preview = previewInstall(doc(), SIGNED_SHA, registry());
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') return;
    // A literal `false`, so a later edit that flips it is a type error and not
    // a quiet change of what this screen claims.
    expect(preview.signatureChecked).toBe(false);
  });

  it('accepts a clean document with nothing to warn about', () => {
    const preview = previewInstall(doc(), SIGNED_SHA, registry());
    expect(preview.state).toBe('ready');
    if (preview.state !== 'ready') return;
    expect(preview.objections).toEqual([]);
    expect(preview.grants.map((g) => g.info.name)).toEqual(['network', 'page']);
    expect(blockingReason(preview, SIGNED_SHA)).toBeNull();
  });

  it('surfaces a capability it has no copy for instead of dropping the row', () => {
    const preview = previewInstall(doc({ capabilities: ['network', 'quantum'] }), SIGNED_SHA, registry());
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.grants.map((g) => g.info.name)).toEqual(['network']);
    expect(preview.unrecognised).toEqual(['quantum']);
  });

  it('objects to a publisher this org does not trust', () => {
    const preview = previewInstall(doc({ publisher: 'zenith' }), SIGNED_SHA, registry());
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections.map((o) => o.kind)).toContain('unknown-publisher');
    expect(blockingReason(preview, SIGNED_SHA)).toContain('zenith');
  });

  it('objects to a revoked key', () => {
    const reg = registry();
    reg.publishers[0]!.revokedAt = '2026-08-10T00:00:00.000Z';
    const preview = previewInstall(doc(), SIGNED_SHA, reg);
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections.map((o) => o.kind)).toEqual(['publisher-revoked']);
  });

  it('objects to a protocol in either direction', () => {
    const newer = previewInstall(doc({ protocol: 2 }), SIGNED_SHA, registry());
    if (newer.state !== 'ready') throw new Error('expected ready');
    expect(newer.objections[0]).toMatchObject({ kind: 'protocol', blocking: true });
    expect(newer.objections[0]!.message).toContain('protocol 2');

    const older = previewInstall(doc({ protocol: 0 }), SIGNED_SHA, registry({ protocol: { speaks: 2, oldest: 1 } }));
    if (older.state !== 'ready') throw new Error('expected ready');
    expect(older.objections[0]!.kind).toBe('protocol');
  });

  it('objects to a name a first-party plugin owns, using the served list', () => {
    const preview = previewInstall(doc({ name: 'accessibility' }), SIGNED_SHA, registry());
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections.map((o) => o.kind)).toContain('reserved-name');
  });

  it('objects to a name already installed, naming the version there', () => {
    const reg = registry({
      plugins: [
        {
          id: 'plg_1',
          name: 'acme-lighthouse',
          version: '1.0.0',
          publisher: 'acme',
          displayName: 'Acme Lighthouse',
          description: '',
          homepage: null,
          protocol: 1,
          capabilities: [],
          governedCapabilities: [],
          codeSha256: SIGNED_SHA,
          codeEntry: 'dist/index.js',
          codeBytes: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          publisherRevoked: false,
          projects: {},
        },
      ],
    });
    const preview = previewInstall(doc(), SIGNED_SHA, reg);
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections.find((o) => o.kind === 'already-installed')?.message).toContain('1.0.0');
  });

  it('catches a download that is not the file that was signed', () => {
    const preview = previewInstall(doc(), 'b'.repeat(64), registry());
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections.map((o) => o.kind)).toContain('digest-mismatch');
  });

  it('does not treat an empty digest field as a mismatch', () => {
    const preview = previewInstall(doc(), '', registry());
    if (preview.state !== 'ready') throw new Error('expected ready');
    expect(preview.objections).toEqual([]);
    // It is still not installable — but the reason is "type the digest", not
    // "this is the wrong file".
    expect(blockingReason(preview, '')).toContain('SHA-256');
  });

  it('flags a governed capability the plan cannot grant, on the row and in the objection', () => {
    const reg = registry({ plan: { label: 'Free', allowsGovernedCapabilities: false } });
    const preview = previewInstall(doc({ capabilities: ['page', 'secrets'] }), SIGNED_SHA, reg);
    if (preview.state !== 'ready') throw new Error('expected ready');

    expect(preview.grants.map((g) => [g.info.name, g.beyondPlan])).toEqual([
      ['page', false],
      ['secrets', true],
    ]);
    expect(preview.objections.find((o) => o.kind === 'plan')?.message).toContain('Free');
  });
});
