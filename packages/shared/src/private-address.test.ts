/**
 * The address classifier, tested against the forms that get through naive checks.
 *
 * Every case here is a way of writing `127.0.0.1` or `169.254.169.254` that a
 * substring check, a `startsWith('10.')`, or a `net.isIP` gate would let past.
 * The assertions are against literals rather than against another call into the
 * same module, because a test that computes its expectation the same way the
 * code does will agree with any bug the code has.
 *
 * The DNS half uses an INJECTED resolver. A test that performs a real lookup is
 * a test that passes or fails depending on the machine's search domains and its
 * network, which for a security guard means it eventually gets skipped.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyAddress,
  classifyHost,
  classifyIpv4,
  classifyIpv6,
  expandIpv6,
  isPrivateNetworkName,
  normalizeHost,
  resolvesPublicly,
} from './private-address';
import type { LookupFn } from './private-address';

describe('classifyIpv4', () => {
  it('names the cloud metadata service as link-local', () => {
    expect(classifyIpv4('169.254.169.254')).toBe('link-local');
  });

  it('classifies the ranges that are not the internet', () => {
    expect(classifyIpv4('127.0.0.1')).toBe('loopback');
    expect(classifyIpv4('10.1.2.3')).toBe('private');
    expect(classifyIpv4('172.16.0.1')).toBe('private');
    expect(classifyIpv4('172.31.255.254')).toBe('private');
    expect(classifyIpv4('192.168.1.1')).toBe('private');
    expect(classifyIpv4('100.64.0.1')).toBe('private');
    expect(classifyIpv4('0.0.0.0')).toBe('unspecified');
    expect(classifyIpv4('224.0.0.1')).toBe('multicast');
    expect(classifyIpv4('255.255.255.255')).toBe('reserved');
    expect(classifyIpv4('198.18.0.1')).toBe('reserved');
  });

  it('does not over-reach into the neighbouring public ranges', () => {
    // An off-by-one here refuses a legitimate destination forever, which is the
    // other way this function can be wrong.
    expect(classifyIpv4('172.15.255.255')).toBe('public');
    expect(classifyIpv4('172.32.0.1')).toBe('public');
    expect(classifyIpv4('100.63.255.255')).toBe('public');
    expect(classifyIpv4('100.128.0.1')).toBe('public');
    expect(classifyIpv4('8.8.8.8')).toBe('public');
    expect(classifyIpv4('169.253.0.1')).toBe('public');
  });

  it('refuses an ambiguous literal rather than picking a reading', () => {
    expect(classifyIpv4('0177.0.0.1')).toBe('unparseable');
    expect(classifyIpv4('010.0.0.1')).toBe('unparseable');
    expect(classifyIpv4('1.2.3')).toBe('unparseable');
    expect(classifyIpv4('1.2.3.4.5')).toBe('unparseable');
    expect(classifyIpv4('256.1.1.1')).toBe('unparseable');
    expect(classifyIpv4('0x7f.0.0.1')).toBe('unparseable');
  });
});

describe('classifyIpv6', () => {
  it('unwraps every encoding of the metadata address', () => {
    expect(classifyIpv6('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyIpv6('2002:a9fe:a9fe::')).toBe('link-local');
    expect(classifyIpv6('64:ff9b::a9fe:a9fe')).toBe('link-local');
    // EC2's IPv6 metadata endpoint is in the unique-local range.
    expect(classifyIpv6('fd00:ec2::254')).toBe('private');
  });

  it('classifies the rest of the non-public space', () => {
    expect(classifyIpv6('::1')).toBe('loopback');
    expect(classifyIpv6('::')).toBe('unspecified');
    expect(classifyIpv6('fe80::1')).toBe('link-local');
    expect(classifyIpv6('fc00::1')).toBe('private');
    expect(classifyIpv6('fec0::1')).toBe('private');
    expect(classifyIpv6('ff02::1')).toBe('multicast');
    expect(classifyIpv6('2001:db8::1')).toBe('reserved');
    expect(classifyIpv6('::ffff:127.0.0.1')).toBe('loopback');
  });

  it('leaves a real public address alone', () => {
    expect(classifyIpv6('2606:4700:4700::1111')).toBe('public');
  });

  it('refuses a zone index and anything malformed', () => {
    expect(classifyIpv6('fe80::1%eth0')).toBe('unparseable');
    expect(classifyIpv6('1::2::3')).toBe('unparseable');
    expect(classifyIpv6('gggg::1')).toBe('unparseable');
  });

  it('expands the forms the classifier depends on', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  });

  it('routes a literal to the right classifier', () => {
    expect(classifyAddress('169.254.169.254')).toBe('link-local');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('example.com')).toBe('unparseable');
  });
});

describe('normalizeHost and the internal-name list', () => {
  it('strips the trailing dot before anything is matched', () => {
    // `localhost.` resolves to exactly the same address, and every pattern in
    // the module is anchored — one character would otherwise defeat all of them.
    expect(normalizeHost('LocalHost.')).toBe('localhost');
    expect(isPrivateNetworkName(normalizeHost('localhost.'))).toBe(true);
  });

  it('covers the names that resolve inside a cluster', () => {
    expect(isPrivateNetworkName('kubernetes.default.svc')).toBe(true);
    expect(isPrivateNetworkName('db.cluster.local')).toBe(true);
    expect(isPrivateNetworkName('metadata.google.internal')).toBe(true);
    expect(isPrivateNetworkName('redis')).toBe(true);
    expect(isPrivateNetworkName('api.example.com')).toBe(false);
  });
});

describe('classifyHost', () => {
  it('reads an unambiguous literal as an address and never as a name', () => {
    expect(classifyHost('169.254.169.254')).toEqual({
      kind: 'address',
      class: 'link-local',
      host: '169.254.169.254',
    });
    expect(classifyHost('[::1]')).toEqual({ kind: 'address', class: 'loopback', host: '[::1]' });
    expect(classifyHost('[::ffff:169.254.169.254]').kind).toBe('address');
  });

  it('refuses every alternate encoding of loopback instead of calling it a name', () => {
    // This is the case the whole `ambiguous` member exists for. If any of these
    // came back `{kind:'name'}` a caller would hand it to a resolver, and a
    // resolver that honours octal answers 127.0.0.1.
    for (const host of ['0177.0.0.1', '2130706433', '127.1', '0x7f.0.0.1', '010.0.0.1']) {
      const verdict = classifyHost(host);
      expect([host, verdict.kind]).toEqual([host, 'ambiguous']);
    }
  });

  it('reads an ordinary name as a name, and flags the internal ones', () => {
    expect(classifyHost('api.example.com')).toEqual({
      kind: 'name',
      host: 'api.example.com',
      internal: false,
    });
    expect(classifyHost('localhost')).toEqual({ kind: 'name', host: 'localhost', internal: true });
    // A name whose first label is numeric is still a name.
    expect(classifyHost('1and1.example.com').kind).toBe('name');
  });

  it('refuses a host with characters the resolver and the parser would read differently', () => {
    expect(classifyHost('exa mple.com').kind).toBe('ambiguous');
    expect(classifyHost('a..b.com').kind).toBe('ambiguous');
    expect(classifyHost('').kind).toBe('ambiguous');
  });
});

describe('resolvesPublicly', () => {
  const never: LookupFn = async () => {
    throw new Error('the resolver must not be consulted for this host');
  };

  it('refuses a name that resolves into a private range', async () => {
    // The case a static check cannot catch: an ordinary-looking public name
    // whose A record points at the metadata service.
    const lookup: LookupFn = async () => [{ address: '169.254.169.254' }];
    const verdict = await resolvesPublicly('metadata.attacker.example', lookup);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('169.254.169.254');
    expect(verdict.reason).toContain('link-local');
  });

  it('refuses a record set that mixes one routable address with a private one', async () => {
    // EVERY address, not the first and not any: a mixed record set is not a
    // misconfiguration, it is the attack written down.
    const lookup: LookupFn = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    const verdict = await resolvesPublicly('split.example.com', lookup);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('10.0.0.5');
  });

  it('refuses an empty answer', async () => {
    const verdict = await resolvesPublicly('void.example.com', async () => []);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no addresses');
  });

  it('refuses a lookup that fails, rather than treating it as absence of evidence', async () => {
    const verdict = await resolvesPublicly('nx.example.com', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('could not be resolved');
  });

  it('refuses a lookup that hangs', async () => {
    const verdict = await resolvesPublicly(
      'slow.example.com',
      () => new Promise(() => {}),
      10,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('could not be resolved');
  });

  it('never consults the resolver for a literal or an ambiguous host', async () => {
    // Asking a resolver about `0177.0.0.1` is how the octal form gets a second
    // chance at being interpreted, so the literal paths must short-circuit.
    expect((await resolvesPublicly('169.254.169.254', never)).ok).toBe(false);
    expect((await resolvesPublicly('0177.0.0.1', never)).ok).toBe(false);
    expect((await resolvesPublicly('localhost', never)).ok).toBe(false);
    expect((await resolvesPublicly('8.8.8.8', never)).ok).toBe(true);
  });

  it('admits a name whose every address is public', async () => {
    const verdict = await resolvesPublicly('api.example.com', async () => [
      { address: '93.184.216.34' },
      { address: '2606:4700:4700::1111' },
    ]);
    expect(verdict.ok).toBe(true);
    expect(verdict.addresses).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
  });
});
