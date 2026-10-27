/**
 * Tests for the upload/download step surface.
 *
 * Grouped by the lie each group prevents rather than by function, because that
 * is what a reader of a failure needs: the name of the test says which false
 * claim just became possible again.
 *
 * No filesystem, no browser, no network. The staging surface, the file input and
 * the download capture are all recorders defined at the bottom of this file.
 */

import { describe, expect, it } from 'vitest';
import {
  FILE_CHECK_VERDICTS,
  FILE_CHECK_VERDICT_LIST,
  FILENAME_REFUSALS,
  FILENAME_REFUSAL_LIST,
  MAX_DOWNLOAD_READ_BYTES,
  MAX_FILENAME_LENGTH,
  MAX_GENERATED_FIXTURE_BYTES,
  PARSEABLE_MEDIA_TYPES,
  PARSEABLE_MEDIA_TYPE_LIST,
  STAGED_FILE_MODE,
  UNICODE_NAME_SCRIPTS,
  UNICODE_NAME_SCRIPT_LIST,
  UPLOAD_FIXTURE_KINDS,
  UPLOAD_FIXTURE_KIND_LIST,
  WRONG_TYPE_SHAPES,
  WRONG_TYPE_SHAPE_LIST,
  acceptanceIsMeaningful,
  checkContent,
  checkDownload,
  decodeUtf8,
  discloseHoles,
  fixtureBytes,
  fixtureText,
  generateFixture,
  leadingHex,
  matchesGlob,
  met,
  namedFixture,
  readCapture,
  resolveWithin,
  safeSegment,
  stageFixture,
  summariseChecks,
  unmet,
  unverified,
  uploadStaged,
} from './files.js';
import type {
  DownloadCapture,
  FileStagingSurface,
  FileUploadSurface,
  GeneratedFixture,
  StagedFile,
  UploadFixtureRequest,
} from './files.js';

const SEED = 20261026;

// ─── Recorders ───────────────────────────────────────────────────────────────

/**
 * A staging surface that keeps everything in memory.
 *
 * It records the filename it was ASKED for, so a test can prove the containment
 * check ran BEFORE the write rather than the adapter having sanitised it after.
 */
function recordingStaging(options: { failWrite?: boolean; readBack?: boolean } = {}): {
  surface: FileStagingSurface;
  written: Array<{ filename: string; bytes: Uint8Array }>;
} {
  const written: Array<{ filename: string; bytes: Uint8Array }> = [];
  const surface: FileStagingSurface = {
    write(filename, bytes) {
      if (options.failWrite) return Promise.reject(new Error('read-only filesystem'));
      written.push({ filename, bytes });
      return Promise.resolve({
        path: `/tmp/stage/${filename}`,
        filename,
        mediaType: 'application/octet-stream',
        byteLength: bytes.length,
      });
    },
    read(path) {
      if (options.readBack === false) return Promise.resolve(null);
      const hit = written.find((w) => `/tmp/stage/${w.filename}` === path);
      return Promise.resolve(hit?.bytes ?? null);
    },
  };
  return { surface, written };
}

function recordingUpload(options: { fail?: boolean } = {}): {
  surface: FileUploadSurface;
  calls: Array<{ selector: string; files: readonly StagedFile[] }>;
} {
  const calls: Array<{ selector: string; files: readonly StagedFile[] }> = [];
  const surface: FileUploadSurface = {
    setInputFiles(selector, files) {
      if (options.fail) return Promise.reject(new Error('no element matches that selector'));
      calls.push({ selector, files });
      return Promise.resolve();
    },
  };
  return { surface, calls };
}

/** A download capture. `bytes: null` is the "could not read" state, not empty. */
function capture(args: {
  filename?: string;
  mediaType?: string | null;
  bytes?: Uint8Array | null;
  throwOnRead?: boolean;
}): DownloadCapture {
  return {
    suggestedFilename: args.filename ?? 'invoice-9001.pdf',
    mediaType: args.mediaType === undefined ? 'application/pdf' : args.mediaType,
    readBytes() {
      if (args.throwOnRead) return Promise.reject(new Error('stream closed'));
      return Promise.resolve(args.bytes === undefined ? new Uint8Array([1, 2, 3]) : args.bytes);
    },
  };
}

function ok(outcome: ReturnType<typeof generateFixture>): GeneratedFixture {
  if (!outcome.ok) throw new Error(`expected a fixture, got refusal: ${outcome.why}`);
  return outcome.fixture;
}

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('the closed unions carry both halves of their parity guard', () => {
  it.each([
    ['FILE_CHECK_VERDICTS', FILE_CHECK_VERDICTS, FILE_CHECK_VERDICT_LIST],
    ['FILENAME_REFUSALS', FILENAME_REFUSALS, FILENAME_REFUSAL_LIST],
    ['UPLOAD_FIXTURE_KINDS', UPLOAD_FIXTURE_KINDS, UPLOAD_FIXTURE_KIND_LIST],
    ['WRONG_TYPE_SHAPES', WRONG_TYPE_SHAPES, WRONG_TYPE_SHAPE_LIST],
    ['UNICODE_NAME_SCRIPTS', UNICODE_NAME_SCRIPTS, UNICODE_NAME_SCRIPT_LIST],
    ['PARSEABLE_MEDIA_TYPES', PARSEABLE_MEDIA_TYPES, PARSEABLE_MEDIA_TYPE_LIST],
  ])('%s matches its presence record at run time', (_name, union, list) => {
    expect([...list].sort()).toEqual([...union].sort());
  });

  it('stages files with no executable bit for anyone', () => {
    /*
     * A constant rather than a behaviour, asserted because it is the structural
     * half of "an uploaded fixture is never executed" and a careless 0o700 here
     * would be invisible in review.
     */
    expect(STAGED_FILE_MODE & 0o111).toBe(0);
    expect(STAGED_FILE_MODE).toBe(0o600);
  });
});

// ─── Filename safety: layer one ──────────────────────────────────────────────

describe('refuses a filename that would leave its directory', () => {
  it.each([
    ['../../etc/passwd', 'PARENT_REFERENCE'],
    ['..', 'PARENT_REFERENCE'],
    ['..\\..\\windows\\system32', 'PARENT_REFERENCE'],
    ['subdir/invoice.pdf', 'PATH_SEPARATOR'],
    ['subdir\\invoice.pdf', 'PATH_SEPARATOR'],
    ['/etc/passwd', 'PATH_SEPARATOR'],
    ['', 'NOT_A_NAME'],
    ['.', 'NOT_A_NAME'],
  ])('refuses %j as %s', (name, refusal) => {
    const verdict = safeSegment(name);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe(refusal);
  });

  it('refuses a NUL before it refuses the slash it is hiding behind', () => {
    /*
     * The ORDER of the checks, asserted. `..\u0000/etc` carries both a control
     * character and a separator; a reader told "PATH_SEPARATOR" fixes the slash
     * and ships the NUL, which the kernel then truncates the path at — so the
     * name that gets created is not the name that was checked.
     */
    const verdict = safeSegment('invoice\u0000.pdf/etc');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.refusal).toBe('CONTROL_CHARACTER');
  });

  it('refuses a bidi override while welcoming the same script without one', () => {
    // The distinction this file is careful about: a foreign script is an
    // ordinary name; a bidi override is the spoofing mechanism.
    const spoof = safeSegment('annexe‮txt.exe');
    expect(spoof.ok).toBe(false);
    if (!spoof.ok) expect(spoof.refusal).toBe('BIDI_OVERRIDE');

    expect(safeSegment('فاتورة.pdf').ok).toBe(true);
    expect(safeSegment('発票.pdf').ok).toBe(true);
    expect(safeSegment('relevé-de-compte.csv').ok).toBe(true);
  });

  it('refuses a Windows drive letter, which isAbsolute does not catch on POSIX', () => {
    const verdict = safeSegment('C:invoice.pdf');
    expect(verdict.ok).toBe(false);
    // Reported as ABSOLUTE rather than as a separator: there is no slash in it.
    if (!verdict.ok) expect(verdict.refusal).toBe('ABSOLUTE');
  });

  it('refuses an over-long name with the cap in the sentence', () => {
    const verdict = safeSegment(`${'a'.repeat(MAX_FILENAME_LENGTH + 1)}.pdf`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.refusal).toBe('TOO_LONG');
      expect(verdict.why).toContain(String(MAX_FILENAME_LENGTH));
    }
  });

  it('accepts an ordinary name', () => {
    const verdict = safeSegment('invoice-9001.pdf');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.name).toBe('invoice-9001.pdf');
  });
});

// ─── Filename safety: layer two ──────────────────────────────────────────────

describe('refuses a resolved path outside the staging directory', () => {
  it('refuses an escape even when the syntax layer is bypassed entirely', () => {
    /*
     * The reason there are two layers. This calls `resolveWithin` DIRECTLY with
     * a name `safeSegment` would have refused, which is exactly what a future
     * encoding bypass looks like from here: the syntax check said yes and the
     * resolver still has to say no.
     */
    const verdict = resolveWithin('/tmp/stage', '../../etc/passwd');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('outside the staging directory');
  });

  it('refuses a name that resolves to the directory itself', () => {
    // The case a bare `startsWith(root + sep)` misses: writing bytes to a path
    // that IS a directory fails for a reason nobody was told about.
    const verdict = resolveWithin('/tmp/stage', '.');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('the staging directory itself');
  });

  it('refuses a sibling directory that merely shares a prefix', () => {
    // `/tmp/stage-evil` starts with `/tmp/stage` and is not inside it. This is
    // the off-by-one a `startsWith(root)` without the separator gets wrong.
    const verdict = resolveWithin('/tmp/stage', '../stage-evil/x');
    expect(verdict.ok).toBe(false);
  });

  it('accepts a plain name and returns the contained path', () => {
    const verdict = resolveWithin('/tmp/stage', 'invoice.pdf');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.path).toBe('/tmp/stage/invoice.pdf');
  });

  it('refuses to stage a traversal name, and writes nothing at all', async () => {
    // End to end through `stageFixture`: the refusal must happen BEFORE the
    // surface is touched, so the recorder stays empty.
    const { surface, written } = recordingStaging();
    const outcome = await stageFixture(
      {
        kind: 'GENERATED',
        filename: '../../etc/passwd',
        declaredMediaType: 'text/plain',
        bytes: new Uint8Array([1]),
        structurallyValid: false,
        provenance: 'hand-built for this test',
      },
      '/tmp/stage',
      surface,
    );
    expect(outcome.ok).toBe(false);
    expect(written).toHaveLength(0);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('generates the same fixture for the same seed and a different one for a different seed', () => {
  const request: UploadFixtureRequest = {
    kind: 'GENERATED',
    basename: 'avatar.png',
    mediaType: 'image/png',
    byteLength: 256,
  };

  it('is byte-identical for the same seed', () => {
    const a = ok(generateFixture(request, SEED));
    const b = ok(generateFixture(request, SEED));
    expect([...a.bytes]).toEqual([...b.bytes]);
    expect(a.filename).toBe(b.filename);
  });

  it('differs for a different seed', () => {
    const a = ok(generateFixture(request, SEED));
    const b = ok(generateFixture(request, SEED + 1));
    expect([...a.bytes]).not.toEqual([...b.bytes]);
  });

  it('gives two fixtures in one run different content', () => {
    /*
     * The key is mixed into the hash alongside the seed. Without that, a test
     * that uploads two files and asserts the server kept them apart would pass
     * because both files were identical — the wrong reason.
     */
    const a = ok(generateFixture(request, SEED));
    const b = ok(
      generateFixture({ ...request, basename: 'banner.png' }, SEED),
    );
    expect([...a.bytes]).not.toEqual([...b.bytes]);
  });

  it('derives bytes and text from the seed with no ambient clock', () => {
    expect([...fixtureBytes(SEED, 'k', 8)]).toEqual([...fixtureBytes(SEED, 'k', 8)]);
    expect(fixtureText(SEED, 'k', 40)).toBe(fixtureText(SEED, 'k', 40));
    expect(fixtureText(SEED, 'k', 40)).toHaveLength(40);
  });

  it('emits no credential-shaped filler', () => {
    /*
     * Lesson E of this round. A scanner cannot tell an invented live key from a
     * real one, so the filler is WORDS: this asserts the text carries no long
     * high-entropy alphanumeric run, which is the shape an entropy heuristic
     * fires on.
     */
    const text = fixtureText(SEED, 'anything', 4000);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});

// ─── The six upload cases ────────────────────────────────────────────────────

describe('produces the six cases an upload handler has branches for', () => {
  it('produces a zero-byte file that is not claimed to be valid', () => {
    const fixture = ok(
      generateFixture({ kind: 'ZERO_BYTE', basename: 'empty.pdf', mediaType: 'application/pdf' }, SEED),
    );
    expect(fixture.bytes).toHaveLength(0);
    // The important half: zero bytes is not a valid file of any type, so
    // acceptance of it is a finding and the caller must assert rejection.
    expect(acceptanceIsMeaningful(fixture)).toBe(false);
  });

  it('names a unicode fixture in the script asked for, keeping the extension', () => {
    const fixture = ok(
      generateFixture(
        { kind: 'UNICODE_NAME', mediaType: 'text/csv', byteLength: 64, script: 'ARABIC', extension: '.csv' },
        SEED,
      ),
    );
    expect(fixture.filename).toBe('فاتورة.csv');
  });

  it('decomposes the combining-diacritics name rather than precomposing it', () => {
    /*
     * NFD on purpose. macOS stores decomposed and Linux stores what it is given,
     * so a handler comparing the uploaded name against the stored one
     * byte-for-byte fails on exactly this input — which is the defect the case
     * exists to find, and a precomposed `é` would not provoke it.
     */
    const fixture = ok(
      generateFixture(
        {
          kind: 'UNICODE_NAME',
          mediaType: 'text/csv',
          byteLength: 64,
          script: 'COMBINING_DIACRITICS',
          extension: '.csv',
        },
        SEED,
      ),
    );
    expect(fixture.filename).toContain('́');
    expect(fixture.filename).not.toContain('é');
  });

  it.each([
    ['EXECUTABLE_EXTENSION', '.sh'],
    ['DOUBLE_EXTENSION', '.pdf.sh'],
    ['MISMATCHED_MAGIC', '.png'],
  ] as const)('shapes a wrong-type fixture as %s', (shape, suffix) => {
    const fixture = ok(
      generateFixture(
        { kind: 'WRONG_TYPE', basename: 'payroll', declaredMediaType: 'image/png', shape },
        SEED,
      ),
    );
    expect(fixture.filename.endsWith(suffix)).toBe(true);
    expect(acceptanceIsMeaningful(fixture)).toBe(false);
  });

  it('gives the mismatched-magic case PDF leading bytes behind a .png name', () => {
    // The content-sniffing probe: the name and the declared type say PNG, the
    // bytes say PDF. A handler that trusts either of the first two is wrong.
    const fixture = ok(
      generateFixture(
        {
          kind: 'WRONG_TYPE',
          basename: 'payroll',
          declaredMediaType: 'image/png',
          shape: 'MISMATCHED_MAGIC',
        },
        SEED,
      ),
    );
    expect(leadingHex(fixture.bytes, 4)).toBe('25504446');
  });

  it('generates no executable payload for any wrong-type shape', () => {
    /*
     * The rule stated as a test. Not one shape produces a script, a shell line,
     * an ELF or PE header, or an EICAR string — the mismatch is the whole
     * assertion, and a real payload would mean QAAI uploads malware-shaped bytes
     * into a customer's bucket and their security team gets paged by us.
     */
    for (const shape of WRONG_TYPE_SHAPES) {
      const fixture = ok(
        generateFixture(
          { kind: 'WRONG_TYPE', basename: 'payroll', declaredMediaType: 'image/png', shape },
          SEED,
        ),
      );
      const asText = Buffer.from(fixture.bytes).toString('latin1');
      expect(asText).not.toContain('#!/');
      expect(asText).not.toContain('<script');
      expect(asText).not.toContain('\u007FELF');
      expect(asText).not.toContain('EICAR');
      expect(asText.slice(0, 2)).not.toBe('MZ');
    }
  });

  it('makes a textual fixture genuinely parse as the type it claims', () => {
    // `structurallyValid` is TRUE only here, and it has to be earned: the bytes
    // must actually parse, or acceptance means nothing.
    const json = ok(
      generateFixture(
        { kind: 'GENERATED', basename: 'rows.json', mediaType: 'application/json', byteLength: 120 },
        SEED,
      ),
    );
    expect(json.structurallyValid).toBe(true);
    expect(() => JSON.parse(new TextDecoder().decode(json.bytes))).not.toThrow();

    const csv = ok(
      generateFixture(
        { kind: 'GENERATED', basename: 'rows.csv', mediaType: 'text/csv', byteLength: 120 },
        SEED,
      ),
    );
    expect(csv.structurallyValid).toBe(true);
    expect(new TextDecoder().decode(csv.bytes).split('\n')[0]).toBe('column_a,column_b');
  });

  it('never truncates a textual document to hit a size, at any size', () => {
    /*
     * THE BUG THIS FILE'S OWN TESTS CAUGHT. The first implementation built the
     * document and then sliced it to the requested length, which cut JSON in the
     * middle of a string literal — so the fixture was unparseable while
     * `structurallyValid` said TRUE, and a caller would have read the
     * application's correct rejection of a malformed document as a defect.
     *
     * Swept across a range of sizes rather than asserted at one, because the
     * original bug was invisible at the sizes that happened to be tested.
     */
    for (const byteLength of [13, 14, 20, 64, 120, 121, 500]) {
      const json = ok(
        generateFixture(
          { kind: 'GENERATED', basename: 'rows.json', mediaType: 'application/json', byteLength },
          SEED,
        ),
      );
      expect(json.bytes).toHaveLength(byteLength);
      expect(json.structurallyValid).toBe(true);
      expect(() => JSON.parse(new TextDecoder().decode(json.bytes))).not.toThrow();
    }
    for (const byteLength of [19, 20, 120, 501]) {
      const csv = ok(
        generateFixture(
          { kind: 'GENERATED', basename: 'rows.csv', mediaType: 'text/csv', byteLength },
          SEED,
        ),
      );
      expect(csv.bytes).toHaveLength(byteLength);
      const lines = new TextDecoder().decode(csv.bytes).split('\n');
      expect(lines[0]).toBe('column_a,column_b');
      // One header, one row, one trailing empty from the final newline.
      expect(lines).toHaveLength(3);
    }
  });

  it('refuses a size too small to hold a valid document of that type', () => {
    // There is no such thing as a 5-byte JSON document, and the refusal says so
    // with the minimum named rather than producing 5 bytes of something else.
    const outcome = generateFixture(
      { kind: 'GENERATED', basename: 'tiny.json', mediaType: 'application/json', byteLength: 5 },
      SEED,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.why).toContain('13 bytes');
      expect(outcome.why).toContain('NOT produced by truncating');
    }
  });

  it('refuses to claim a generated binary is a parseable file of its type', () => {
    /*
     * The honesty field. A `%PDF` magic number with noise behind it is not a
     * document any renderer opens, so an application that genuinely parses its
     * uploads will reject it — correctly. A caller reading acceptance as the
     * happy path working would be filing a bug against a correct implementation
     * on the strength of a file QAAI made up.
     */
    const pdf = ok(
      generateFixture(
        { kind: 'GENERATED', basename: 'invoice.pdf', mediaType: 'application/pdf', byteLength: 2048 },
        SEED,
      ),
    );
    expect(pdf.structurallyValid).toBe(false);
    expect(acceptanceIsMeaningful(pdf)).toBe(false);
    expect(pdf.provenance).toContain('NOT a parseable');
  });
});

// ─── The cap that must refuse rather than shrink ─────────────────────────────

describe('refuses an over-limit fixture it cannot generate instead of shrinking it', () => {
  it('generates exactly one byte past the application limit', () => {
    const fixture = ok(
      generateFixture(
        { kind: 'OVER_LIMIT', basename: 'big.csv', mediaType: 'text/csv', limitBytes: 1024 },
        SEED,
      ),
    );
    expect(fixture.bytes).toHaveLength(1025);
  });

  it('refuses when the limit is past our cap, and says so as a count and a reason', () => {
    /*
     * THE SUBTLEST HONESTY BUG IN THE FILE. A silently shrunk fixture is UNDER
     * the application's limit, so the application accepts it — correctly — the
     * check asserted "an over-limit upload is rejected", it was not rejected,
     * and QAAI files a defect against a correct implementation. The cap must
     * refuse. Rule 12: reported as a count AND a reason.
     */
    const outcome = generateFixture(
      {
        kind: 'OVER_LIMIT',
        basename: 'huge.csv',
        mediaType: 'text/csv',
        limitBytes: MAX_GENERATED_FIXTURE_BYTES + 5_000,
      },
      SEED,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('CAP_BIT');
      expect(outcome.requestedBytes).toBe(MAX_GENERATED_FIXTURE_BYTES + 5_001);
      expect(outcome.why).toContain(String(MAX_GENERATED_FIXTURE_BYTES));
      // The sentence must name the inversion, because that is what stops the
      // next person "fixing" this by clamping.
      expect(outcome.why).toContain('deliberately NOT substituted');
      expect(outcome.why).toContain('as a defect');
    }
  });

  it('refuses an ordinary generated fixture past the cap too', () => {
    const outcome = generateFixture(
      {
        kind: 'GENERATED',
        basename: 'huge.bin',
        mediaType: 'application/octet-stream',
        byteLength: MAX_GENERATED_FIXTURE_BYTES + 1,
      },
      SEED,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('CAP_BIT');
  });

  it('refuses a generated fixture whose name would escape, with a reason not a throw', () => {
    const outcome = generateFixture(
      { kind: 'GENERATED', basename: '../escape.csv', mediaType: 'text/csv', byteLength: 10 },
      SEED,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.why).toContain('PARENT_REFERENCE');
  });
});

// ─── The customer's own fixture ──────────────────────────────────────────────

describe("uses the customer's own fixture rather than inventing one", () => {
  it('wraps a supplied fixture and claims it IS structurally valid', () => {
    const outcome = namedFixture('fixtures/members.csv', 'members.csv', 'text/csv', {
      'fixtures/members.csv': 'name,email\nAda,ada@example.test\n',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.fixture.structurallyValid).toBe(true);
      expect(acceptanceIsMeaningful(outcome.fixture)).toBe(true);
      expect(outcome.fixture.provenance).toContain("customer's own fixture");
    }
  });

  it('refuses a missing key rather than uploading zero bytes under its name', () => {
    /*
     * Substituting an empty file would turn the customer's typo into a defect
     * report about their upload handler — a null that became a zero, in the one
     * place it is most expensive.
     */
    const outcome = namedFixture('fixtures/absent.csv', 'absent.csv', 'text/csv', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('REQUIRES_PROVISIONED_SANDBOX');
      expect(outcome.why).toContain('deliberately NOT substituted');
    }
  });

  it('refuses a named fixture through generateFixture, naming it a caller bug', () => {
    // NAMED carries no bytes of ours, so routing it here is a caller mistake
    // and is reported as one rather than as a capability gap.
    const outcome = generateFixture(
      { kind: 'NAMED', fixtureKey: 'k', basename: 'k.csv', mediaType: 'text/csv' },
      SEED,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('NOT_IMPLEMENTED');
  });
});

// ─── setInputFiles, the call that appeared nowhere ───────────────────────────

describe('drives a file input', () => {
  it('stages then sets the file on the input', async () => {
    const staging = recordingStaging();
    const upload = recordingUpload();
    const fixture = ok(
      generateFixture(
        { kind: 'GENERATED', basename: 'rows.csv', mediaType: 'text/csv', byteLength: 64 },
        SEED,
      ),
    );
    const staged = await stageFixture(fixture, '/tmp/stage', staging.surface);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    const check = await uploadStaged(staged.staged, '#file', upload.surface);
    expect(check.verdict).toBe('MET');
    expect(upload.calls).toHaveLength(1);
    expect(upload.calls[0]?.selector).toBe('#file');
    expect(upload.calls[0]?.files[0]?.filename).toBe('rows.csv');
  });

  it('reports a selector that does not resolve as UNMET, not UNVERIFIED', async () => {
    // An input that is not there is a statement about the application.
    const upload = recordingUpload({ fail: true });
    const check = await uploadStaged(
      { path: '/tmp/stage/x.csv', filename: 'x.csv', mediaType: 'text/csv', byteLength: 1 },
      '#missing',
      upload.surface,
    );
    expect(check.verdict).toBe('UNMET');
    expect(check.detail).toContain('#missing');
  });

  it('reports a staging failure as UNVERIFIED with CAPABILITY_ABSENT', async () => {
    // A filesystem we could not write to says nothing about the customer's app.
    const staging = recordingStaging({ failWrite: true });
    const fixture = ok(
      generateFixture(
        { kind: 'GENERATED', basename: 'rows.csv', mediaType: 'text/csv', byteLength: 64 },
        SEED,
      ),
    );
    const outcome = await stageFixture(fixture, '/tmp/stage', staging.surface);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('CAPABILITY_ABSENT');
  });
});

// ─── Download assertions ─────────────────────────────────────────────────────

describe('asserts a downloaded file rather than the click that produced it', () => {
  it('asserts the filename against a glob', async () => {
    const checks = await checkDownload(capture({ filename: 'invoice-9001.pdf' }), {
      filenamePattern: 'invoice-*.pdf',
    });
    expect(checks.map((c) => c.verdict)).toEqual(['MET']);
  });

  it('treats a glob as a glob and never as a regex', async () => {
    /*
     * A pattern is producer-supplied data. Interpolated raw into a RegExp,
     * `invoice-(.*)+$` is catastrophic backtracking against our own worker; and
     * `.` would match any character, so `invoice-1x2.pdf` would satisfy
     * `invoice-1.2.pdf`.
     */
    expect(matchesGlob('invoice-1x2.pdf', 'invoice-1.2.pdf')).toBe(false);
    expect(matchesGlob('invoice-1.2.pdf', 'invoice-1.2.pdf')).toBe(true);
    expect(matchesGlob('a/b.pdf', '*.pdf')).toBe(false);
    expect(matchesGlob('anything', 'invoice-(.*)+$')).toBe(false);
  });

  it('reports a zero-byte download as UNMET and names the cause', async () => {
    // The commonest download defect there is: a handler that errored and still
    // returned 200.
    const checks = await checkDownload(capture({ bytes: new Uint8Array(0) }), { minBytes: 1 });
    expect(checks[0]?.verdict).toBe('UNMET');
    expect(checks[0]?.detail).toContain('errored and still returned 200');
  });

  it('catches an HTML error page wearing a .pdf name', async () => {
    /*
     * The assertion the whole type exists for. The name matches, the size is
     * plausible, and the leading bytes are `<!DOCTYPE` rather than `%PDF`.
     */
    const html = new TextEncoder().encode('<!DOCTYPE html><title>500</title>');
    const checks = await checkDownload(
      capture({ filename: 'invoice-9001.pdf', bytes: html }),
      { filenamePattern: 'invoice-*.pdf', minBytes: 10, magicHex: '25504446' },
    );
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('filename')?.verdict).toBe('MET');
    expect(byName.get('size')?.verdict).toBe('MET');
    expect(byName.get('magic')?.verdict).toBe('UNMET');
  });

  it('ignores content-type parameters rather than failing a correct server', async () => {
    const checks = await checkDownload(
      capture({ mediaType: 'text/csv; charset=utf-8' }),
      { mediaType: 'text/csv' },
    );
    expect(checks[0]?.verdict).toBe('MET');
  });

  it('reports an undeclared content type as UNVERIFIED, not as a mismatch', async () => {
    // An absent declaration is not a wrong declaration.
    const checks = await checkDownload(capture({ mediaType: null }), { mediaType: 'text/csv' });
    expect(checks[0]?.verdict).toBe('UNVERIFIED');
    expect(checks[0]?.reason).toBe('CAPABILITY_ABSENT');
  });

  it('asserts nothing it was not asked to assert', async () => {
    // An expectation with no fields produces no checks at all — not a list of
    // passes for assertions nobody made.
    expect(await checkDownload(capture({}), {})).toEqual([]);
  });

  it('reports no download at all as distinct from an unreadable one', async () => {
    /*
     * The two failure modes the download surface keeps apart. `triggerDownload`
     * returning null is the application's fault; a capture whose bytes will not
     * read is ours. Proven here at the `readCapture` level, which is where the
     * distinction is made.
     */
    const unreadable = await readCapture(capture({ bytes: null }));
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) {
      expect(unreadable.reason).toBe('CAPABILITY_ABSENT');
      expect(unreadable.why).toContain('NOT a zero-byte file');
    }
  });

  it('reports a throwing read as UNVERIFIED rather than letting it escape', async () => {
    const thrown = await readCapture(capture({ throwOnRead: true }));
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) expect(thrown.why).toContain('stream closed');
  });

  it('refuses to inspect a download past the read cap, and discloses it', async () => {
    /*
     * A truncated read compared against a `maxBytes` would report a runaway
     * export as a pass, which is the cap silently inverting an assertion — the
     * same shape as the OVER_LIMIT case above.
     */
    const big = new Uint8Array(MAX_DOWNLOAD_READ_BYTES + 1);
    const outcome = await readCapture(capture({ bytes: big }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('CAP_BIT');
      expect(outcome.why).toContain(String(MAX_DOWNLOAD_READ_BYTES));
    }
  });

  it('names every byte-dependent assertion that went unasserted, one by one', async () => {
    /*
     * Not one merged "content" hole. A reader counting holes has to know the
     * size floor AND the magic number AND the text each went unchecked, because
     * each is a separate thing nobody looked at.
     */
    const checks = await checkDownload(capture({ bytes: null }), {
      filenamePattern: 'invoice-*.pdf',
      minBytes: 100,
      magicHex: '25504446',
      contains: ['Total'],
    });
    const byName = new Map(checks.map((c) => [c.name, c.verdict]));
    expect(byName.get('filename')).toBe('MET');
    expect(byName.get('size')).toBe('UNVERIFIED');
    expect(byName.get('magic')).toBe('UNVERIFIED');
    expect(byName.get('content')).toBe('UNVERIFIED');
  });
});

// ─── Content, and the two refusals ───────────────────────────────────────────

describe('asserts content only for a format it can genuinely parse', () => {
  it('finds the expected strings in a CSV', () => {
    const bytes = new TextEncoder().encode('name,total\nAda,42.00\n');
    const checks = checkContent(bytes, 'text/csv', ['Ada', '42.00']);
    expect(checks[0]?.verdict).toBe('MET');
  });

  it('reports which expected strings were absent', () => {
    const bytes = new TextEncoder().encode('name,total\nAda,41.00\n');
    const checks = checkContent(bytes, 'text/csv', ['42.00']);
    expect(checks[0]?.verdict).toBe('UNMET');
    expect(checks[0]?.detail).toContain('42.00');
  });

  it("never quotes the document's own text back into a failure", () => {
    /*
     * A statement, an invoice or a contract is exactly the kind of file that
     * carries somebody's personal data, so the failure names the CALLER'S
     * expected strings and nothing else out of the document.
     */
    const bytes = new TextEncoder().encode('Patient,Diagnosis\nAda Lovelace,confidential\n');
    const checks = checkContent(bytes, 'text/csv', ['42.00']);
    expect(checks[0]?.detail).not.toContain('Ada Lovelace');
    expect(checks[0]?.detail).not.toContain('confidential');
  });

  it('refuses to scan a PDF for a string instead of parsing it', () => {
    /*
     * Scanning raw bytes passes or fails on whether the format happened to
     * compress, not on whether the document is right. UNVERIFIED with
     * CAPABILITY_ABSENT, and the remedy named.
     */
    const bytes = new TextEncoder().encode('%PDF-1.4 Total: 42.00');
    const checks = checkContent(bytes, 'application/pdf', ['Total: 42.00']);
    expect(checks[0]?.verdict).toBe('UNVERIFIED');
    expect(checks[0]?.reason).toBe('CAPABILITY_ABSENT');
  });

  it('refuses to decode non-UTF-8 bytes lossily', () => {
    /*
     * The default TextDecoder replaces undecodable bytes with U+FFFD, so the
     * file "decodes" into mojibake and a `contains` assertion then produces a
     * confident verdict about a string that was never in it.
     */
    const bytes = new Uint8Array([0xff, 0xfe, 0xff, 0xfe]);
    expect(decodeUtf8(bytes)).toBeNull();
    const checks = checkContent(bytes, 'text/csv', ['anything']);
    expect(checks[0]?.verdict).toBe('UNVERIFIED');
  });

  it('reports an undeclared type as unparseable rather than assuming text', () => {
    const checks = checkContent(new TextEncoder().encode('hello'), null, ['hello']);
    expect(checks[0]?.verdict).toBe('UNVERIFIED');
  });
});

// ─── Summary and disclosure ──────────────────────────────────────────────────

describe('keeps the three verdicts apart all the way out', () => {
  it('counts them separately and never folds UNVERIFIED into either', () => {
    const summary = summariseChecks([
      met('a', 'ok'),
      unmet('b', 'bad'),
      unverified('c', 'no parser', 'CAPABILITY_ABSENT'),
      unverified('d', 'cap bit', 'CAP_BIT'),
    ]);
    expect(summary).toMatchObject({ met: 1, unmet: 1, unverified: 2, provedSomething: true });
    expect(summary.holes.map((h) => h.name)).toEqual(['c', 'd']);
  });

  it('says nothing was proved when every check was unverified', () => {
    // The predicate a caller must consult before reporting a pass.
    const summary = summariseChecks([unverified('a', 'x', 'NOT_IMPLEMENTED')]);
    expect(summary.provedSomething).toBe(false);
  });

  it('discloses holes as a count and a reason', () => {
    const text = discloseHoles(
      summariseChecks([met('a', 'ok'), unverified('c', 'no parser', 'CAPABILITY_ABSENT')]),
    );
    expect(text).toContain('1 of 2');
    expect(text).toContain('CAPABILITY_ABSENT');
  });

  it('says nothing at all when there is nothing to disclose', () => {
    // Appending " 0 checks were not measured" to every pass trains a reader to
    // stop reading the tail of the sentence.
    expect(discloseHoles(summariseChecks([met('a', 'ok')]))).toBe('');
  });

  it('requires a reason on every unverified check by signature', () => {
    // Not an optional field: an UNVERIFIED with no reason is a row nobody can
    // act on, and the three reasons have three different remedies.
    expect(unverified('a', 'x', 'CAP_BIT').reason).toBe('CAP_BIT');
    expect(met('a', 'x').reason).toBeNull();
    expect(unmet('a', 'x').reason).toBeNull();
  });
});
