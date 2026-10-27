/**
 * FILE UPLOAD AND DOWNLOAD AS A FIRST-CLASS STEP.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `setInputFiles` appears NOWHERE in this runner, and nothing anywhere asserts a
 * downloaded file's name, its media type or its bytes. Upload and download are
 * in nearly every application QAAI will ever point at — an avatar, a CSV import,
 * a receipt, an export, a signed contract — and the product could neither put a
 * file in nor look at one coming out. Four consequences, every one of them a
 * green row today:
 *
 *   1. A FILE PICKER WAS A DEAD END. A crawl reaches `<input type="file">`,
 *      cannot drive it, and the whole flow behind it — import, parse, validate,
 *      report — is unreachable by any test.
 *   2. A DOWNLOAD WAS A CLICK. "The button worked" is what a click asserts. A
 *      handler that errors server-side and returns a 0-byte file, or an HTML
 *      error page wearing a `.pdf` name, satisfies every assertion short of
 *      looking at the bytes — and nothing looked at the bytes.
 *   3. THE REJECTION PATHS WERE UNTESTABLE. Wrong type, over the size limit,
 *      zero bytes, a name in another script: these are the branches an upload
 *      handler gets wrong, and there was no way to produce one.
 *   4. A FILE WHOSE BYTES COULD NOT BE READ WOULD HAVE PASSED. Which is the
 *      lie this module is most careful about — see {@link FileCheckVerdict}.
 *
 * ── UNVERIFIED IS NOT A PASS, AND IT IS NOT A FAILURE EITHER ────────────────
 *
 * Every check in this file returns one of THREE verdicts. A download whose
 * bytes could not be read establishes nothing about the application: the file
 * may be perfect and the capture may have failed. Reporting that as MET is the
 * "pass that means we did not check" the product cannot afford; reporting it as
 * UNMET blames the customer for our own missing capability. So it is UNVERIFIED,
 * it carries an `UnassertedReason` from the shared vocabulary, and the caller
 * decides — see {@link summariseChecks}.
 *
 * ── FIXTURES ARE GENERATED, NEVER COMMITTED ─────────────────────────────────
 *
 * Not one byte of test data is a binary in this repository. A committed fixture
 * is a file whose provenance nobody can state a year later: where did this PDF
 * come from, whose data is in it, is it redistributable. Every fixture here is
 * produced from the RUN SEED, so the same seed yields byte-identical content on
 * every machine, and the content is describable in one sentence.
 *
 * ── SECURITY, AND THE THREE RULES THAT ARE STRUCTURAL ───────────────────────
 *
 * An uploaded fixture is DATA. This module is written so that the three ways
 * that goes wrong are not available rather than merely discouraged:
 *
 *   · IT IS NEVER EXECUTED. {@link FileStagingSurface} has no method that runs
 *     anything, and {@link STAGED_FILE_MODE} is read/write for the owner with no
 *     executable bit anywhere. There is no code path from a fixture to a
 *     process, because the interface does not have one.
 *   · A FILENAME NEVER LEAVES ITS DIRECTORY. {@link safeSegment} refuses the
 *     syntax and {@link resolveWithin} refuses the resolved path, and BOTH run.
 *     One layer is how every traversal bypass in history has worked: the syntax
 *     check is fooled by an encoding the resolver then honours.
 *   · THE GENERATED SIZE IS BOUNDED. {@link MAX_GENERATED_FIXTURE_BYTES}, and a
 *     request past it is REFUSED rather than quietly shrunk — see the note on
 *     {@link generateFixture}, which is the subtlest honesty bug in this file.
 *
 * ── INJECTED SURFACES (rule 8) ──────────────────────────────────────────────
 *
 * There is no browser, no filesystem and no download event in a test here. The
 * staging directory, the file input, the download capture and the content parser
 * are all narrow injected interfaces defined in this file. Nothing imports
 * `playwright`, and every adapter is thin enough to read in one sitting.
 */

import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
/*
 * `unassertedReasonSchema` rather than the `UnassertedReason` type, and this is
 * not a style preference — it is lesson B of this round reproducing live.
 *
 * `packages/shared/src/test-type-decl.ts` declares `UNASSERTED_REASONS` and the
 * `UnassertedReason` type, and `packages/shared/src/index.ts` does NOT re-export
 * that module. So `import type { UnassertedReason } from '@qaai/shared'` is
 * TS2305 from this workspace — the package's front door is shut, while sibling
 * files inside it reach the module relatively and the `package-exports` ratchet
 * therefore reads it as connected.
 *
 * Deriving the type from the ZOD SCHEMA, which `./schemas.ts` declares and the
 * barrel does re-export, gets the SAME closed union out of the SAME single
 * source of truth. It compiles today, it keeps compiling after the two
 * `export *` lines land (they are named in this round's handover), and it cannot
 * drift — which a hand-written parallel list in this file would, exactly as the
 * provider catalogue's hand-written shape list drifted to 16 of 27.
 */
import { unassertedReasonSchema } from '@qaai/shared';
import { mulberry32 } from './determinism.js';

/** The shared vocabulary for "this was not asserted, and here is why". */
export type UnassertedReasonValue = z.infer<typeof unassertedReasonSchema>;

// ─── Caps, stated once ───────────────────────────────────────────────────────

/**
 * The byte ceiling on anything this module will generate.
 *
 * 8 MiB. A fixture is held in memory, written into a run workspace and handed to
 * a browser, so three copies exist at once; and the thing an upload test needs
 * is to cross a boundary, not to be large. The number is a budget somebody
 * chose, which is why it is a named constant with this sentence beside it rather
 * than an integer at a call site.
 *
 * It is a CAP, so when it bites it is reported as a count and a reason, never
 * applied quietly. See {@link generateFixture}.
 */
export const MAX_GENERATED_FIXTURE_BYTES = 8 * 1024 * 1024;

/**
 * The permission bits a staged fixture is written with: owner read/write.
 *
 * No executable bit for anyone, on purpose and as a constant so it is greppable.
 * Customer-supplied bytes sitting on a worker's disk with `+x` is one careless
 * `spawn` away from being code we ran, and the point of this constant is that
 * the mistake has to be made deliberately.
 */
export const STAGED_FILE_MODE = 0o600;

/**
 * The most bytes {@link readCapture} will pull off a download.
 *
 * 64 MiB, higher than the generation cap because a download's size is the
 * APPLICATION'S choice rather than ours — an export of a big table is a
 * legitimate thing to assert a ceiling on. When it bites, the capture is
 * UNVERIFIED with `CAP_BIT` and the number is in the sentence: a truncated read
 * compared against a `maxBytes` would report a runaway export as a pass.
 */
export const MAX_DOWNLOAD_READ_BYTES = 64 * 1024 * 1024;

// ─── Verdicts ────────────────────────────────────────────────────────────────

/**
 * What one file check concluded. THREE values, and the third is the file.
 *
 * MET and UNMET are claims about the application. UNVERIFIED is a claim about
 * US: the bytes could not be read, the parser is absent, a cap bit. It must
 * never be folded into either of the other two, and {@link summariseChecks}
 * keeps the three counts apart all the way out to the caller.
 */
export const FILE_CHECK_VERDICTS = ['MET', 'UNMET', 'UNVERIFIED'] as const;
export type FileCheckVerdict = (typeof FILE_CHECK_VERDICTS)[number];

/**
 * The compiler-enforced presence record this codebase pairs with every
 * vocabulary, with the run-time parity test in files.test.ts.
 */
export const FILE_CHECK_VERDICT_PRESENT: Record<FileCheckVerdict, true> = {
  MET: true,
  UNMET: true,
  UNVERIFIED: true,
};

export const FILE_CHECK_VERDICT_LIST = Object.keys(
  FILE_CHECK_VERDICT_PRESENT,
) as ReadonlyArray<FileCheckVerdict>;

/** One assertion about one file, with its verdict and a printable sentence. */
export interface FileCheck {
  /** Stable, so a report can group the same check across runs: `filename`, `magic`. */
  readonly name: string;
  readonly verdict: FileCheckVerdict;
  /** Printable verbatim. On UNVERIFIED it says what could not be done. */
  readonly detail: string;
  /** Required exactly when the verdict is UNVERIFIED, and null otherwise. */
  readonly reason: UnassertedReasonValue | null;
}

/** MET, with a sentence. */
export function met(name: string, detail: string): FileCheck {
  return { name, verdict: 'MET', detail, reason: null };
}

/** UNMET — a statement about the customer's application. */
export function unmet(name: string, detail: string): FileCheck {
  return { name, verdict: 'UNMET', detail, reason: null };
}

/**
 * UNVERIFIED — a statement about us, and the reason is REQUIRED by the signature.
 *
 * A positional required argument rather than an optional field, because an
 * UNVERIFIED with no reason is a row nobody can act on: the reader cannot tell a
 * missing parser from a cap from a bug in this file, and the three have three
 * different remedies.
 */
export function unverified(
  name: string,
  detail: string,
  reason: UnassertedReasonValue,
): FileCheck {
  return { name, verdict: 'UNVERIFIED', detail, reason };
}

export interface CheckSummary {
  readonly met: number;
  readonly unmet: number;
  readonly unverified: number;
  /**
   * Was anything at all actually established?
   *
   * The question a caller must ask before reporting a pass. `met > 0` is not
   * enough on its own for every type, but `met === 0` is always enough to know
   * that a PASS would mean "we did not check".
   */
  readonly provedSomething: boolean;
  /** The UNVERIFIED checks, so the caller can disclose each one by name. */
  readonly holes: readonly FileCheck[];
}

/**
 * Count the three verdicts, keeping them apart.
 *
 * Exported and tested directly: every plugin that uses this module decides
 * PASS / FAIL / SKIPPED off these numbers, so a bug here is a wrong verdict
 * everywhere at once.
 */
export function summariseChecks(checks: readonly FileCheck[]): CheckSummary {
  const holes = checks.filter((c) => c.verdict === 'UNVERIFIED');
  const metCount = checks.filter((c) => c.verdict === 'MET').length;
  return {
    met: metCount,
    unmet: checks.filter((c) => c.verdict === 'UNMET').length,
    unverified: holes.length,
    provedSomething: metCount > 0,
    holes,
  };
}

/**
 * The disclosure sentence for the checks that were not measured.
 *
 * Rule 12 requires a hole to be reported as a COUNT and a REASON. This produces
 * both, or the empty string when there is nothing to disclose — and the empty
 * string is deliberate: appending " 0 checks were not measured" to every passing
 * result trains a reader to stop reading the tail of the sentence.
 */
export function discloseHoles(summary: CheckSummary): string {
  if (summary.holes.length === 0) return '';
  const total = summary.met + summary.unmet + summary.unverified;
  const each = summary.holes.map((h) => `${h.name} (${h.reason}): ${h.detail}`).join(' | ');
  return `${summary.unverified} of ${total} check(s) were NOT verified — ${each}`;
}

// ─── Filename safety ────────────────────────────────────────────────────────

/**
 * Why a filename was refused.
 *
 * Each member names a real bypass rather than a category, because the remedy
 * differs: a producer that wrote `../` made a mistake, and a producer that wrote
 * a bidi override is reaching for a spoofing mechanism.
 */
export const FILENAME_REFUSALS = [
  /** Contains `/` or `\` — it is a path, not a name. */
  'PATH_SEPARATOR',
  /** `..` as the whole name or as a leading segment. */
  'PARENT_REFERENCE',
  /** Starts at a root, or carries a Windows drive letter. */
  'ABSOLUTE',
  /** A NUL or another C0 control character. */
  'CONTROL_CHARACTER',
  /** A Unicode bidi override or embedding control. See the note below. */
  'BIDI_OVERRIDE',
  /** Empty, or `.`, which names a directory rather than a file. */
  'NOT_A_NAME',
  /** Longer than {@link MAX_FILENAME_LENGTH}. */
  'TOO_LONG',
] as const;
export type FilenameRefusal = (typeof FILENAME_REFUSALS)[number];

const FILENAME_REFUSAL_PRESENT: Record<FilenameRefusal, true> = {
  PATH_SEPARATOR: true,
  PARENT_REFERENCE: true,
  ABSOLUTE: true,
  CONTROL_CHARACTER: true,
  BIDI_OVERRIDE: true,
  NOT_A_NAME: true,
  TOO_LONG: true,
};

export const FILENAME_REFUSAL_LIST = Object.keys(
  FILENAME_REFUSAL_PRESENT,
) as ReadonlyArray<FilenameRefusal>;

/**
 * 255 bytes is the limit on every filesystem this runs on, and a name at the
 * limit is a name that fails differently on each one.
 */
export const MAX_FILENAME_LENGTH = 200;

/**
 * Unicode bidirectional formatting characters.
 *
 * ── WHY THESE ARE REFUSED WHILE ARABIC AND CJK ARE WELCOME ──────────────────
 *
 * A filename in another script is an ordinary thing an application must handle,
 * and {@link UNICODE_NAME_SCRIPTS} exists precisely to produce one. A RIGHT-TO-
 * LEFT OVERRIDE (U+202E) is not that. It is the filename-spoofing mechanism:
 * `annexe` + U+202E + `txt.exe` renders as `annexeexe.txt` in almost every file
 * list, and the file is an executable.
 *
 * So this module will not STAGE one. Generating it would be building the attack
 * rather than testing the application's handling of a foreign name, and a QAAI
 * run must not be the thing that writes a spoofed filename onto a customer's
 * disk. An application's own sanitisation of these is worth testing; the honest
 * way is a dedicated security check that asserts the application rejects the
 * name, and it is named in this round's handover as unbuilt rather than
 * half-built here.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/;

/**
 * C0 controls and DEL. A NUL truncates a path in every C library ever linked.
 *
 * `no-control-regex` exists to catch a control character that reached a pattern
 * by accident. Here the control characters ARE the subject: this is the class
 * whose presence in a filename is refused, so the rule has nothing to warn
 * about and suppressing it is the honest answer rather than rewriting the range
 * into something the rule cannot see.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** `C:` or `c:` at the head, which `isAbsolute` does not catch on POSIX. */
const WINDOWS_DRIVE = /^[A-Za-z]:/;

export type SegmentVerdict =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly refusal: FilenameRefusal; readonly why: string };

/**
 * Is this string a single, safe filename?
 *
 * LAYER ONE OF TWO. It refuses the syntax; {@link resolveWithin} refuses the
 * resolved path, and the staging surface runs both. Either one alone is a
 * bypass waiting to be found: a syntax check cannot know what the resolver will
 * do with a name the platform spells differently, and a containment check on a
 * name containing a NUL is a containment check on a string the kernel will
 * truncate.
 *
 * The order of the tests is load-bearing. Controls and bidi are checked BEFORE
 * the separator tests, so a name carrying both is reported by the more specific
 * reason — a reader told "PATH_SEPARATOR" about `..%00/etc` would fix the slash
 * and ship the NUL.
 */
export function safeSegment(raw: string): SegmentVerdict {
  if (raw.length === 0) {
    return { ok: false, refusal: 'NOT_A_NAME', why: 'the filename is empty' };
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    return {
      ok: false,
      refusal: 'CONTROL_CHARACTER',
      why:
        'the filename contains a control character. A NUL truncates the path in every C library, ' +
        'so the name the kernel creates is not the name that was checked',
    };
  }
  if (BIDI_CONTROLS.test(raw)) {
    return {
      ok: false,
      refusal: 'BIDI_OVERRIDE',
      why:
        'the filename contains a Unicode bidi override or embedding control, which is the ' +
        'filename-spoofing mechanism rather than a foreign script. A non-Latin name is welcome — ' +
        'use one of UNICODE_NAME_SCRIPTS',
    };
  }
  if (raw.length > MAX_FILENAME_LENGTH) {
    return {
      ok: false,
      refusal: 'TOO_LONG',
      why: `the filename is ${raw.length} characters and the cap is ${MAX_FILENAME_LENGTH}`,
    };
  }
  if (raw === '.') {
    return { ok: false, refusal: 'NOT_A_NAME', why: '"." names a directory, not a file' };
  }
  if (raw === '..' || raw.startsWith('../') || raw.startsWith('..\\')) {
    return {
      ok: false,
      refusal: 'PARENT_REFERENCE',
      why: 'the filename starts at the parent directory, so it names a file outside the staging directory',
    };
  }
  if (raw.includes('/') || raw.includes('\\')) {
    return {
      ok: false,
      refusal: 'PATH_SEPARATOR',
      why:
        'the filename contains a path separator, so it is a path and not a name. A fixture is ' +
        'staged as one file in one directory',
    };
  }
  if (isAbsolute(raw) || WINDOWS_DRIVE.test(raw)) {
    return {
      ok: false,
      refusal: 'ABSOLUTE',
      why: 'the filename is an absolute path, which names a file outside the staging directory',
    };
  }
  return { ok: true, name: raw };
}

export type ContainmentVerdict =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly why: string };

/**
 * Resolve `name` inside `dir`, and refuse anything that lands outside it.
 *
 * LAYER TWO OF TWO, and it is the layer that is true regardless of what the
 * first one thought. The idiom is the one `plugins/cli.ts` already uses for a
 * workspace-relative cwd, deliberately and not by coincidence: two different
 * containment implementations in one package is how one of them comes to be the
 * weaker one, and a reader who has learned this shape should recognise it.
 *
 * `full !== root` is the case a bare `startsWith` misses, and it is not
 * theoretical: an empty-ish name can resolve to the directory ITSELF, and
 * writing bytes to a path that is a directory is a different failure from the
 * one the caller is being told about.
 */
export function resolveWithin(dir: string, name: string): ContainmentVerdict {
  const root = resolve(dir);
  const full = resolve(join(root, name));
  if (full === root) {
    return {
      ok: false,
      why: `"${name}" resolves to the staging directory itself rather than to a file inside it`,
    };
  }
  if (!full.startsWith(root + sep)) {
    return {
      ok: false,
      why:
        `"${name}" resolves outside the staging directory. A fixture is DATA and never leaves ` +
        'the directory it was staged in',
    };
  }
  return { ok: true, path: full };
}

// ─── Deterministic content ──────────────────────────────────────────────────

/**
 * FNV-1a, 32-bit. The same ten lines as `packages/shared/src/synthetic.ts` and
 * `packages/shared/src/browser-matrix.ts`, and restated for the reason those two
 * state: @qaai/runner may not reach into @qaai/shared's private modules, and a
 * hash is a definition rather than a behaviour, so two copies cannot disagree
 * about anything a test would catch.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic stream of bytes for a fixture.
 *
 * Keyed on the seed AND the fixture's own key, separated by a NUL, so two
 * fixtures in one run do not get identical content — which would make a test
 * that uploads two files and asserts they are distinguishable pass for the
 * wrong reason.
 *
 * `mulberry32` comes from `./determinism.ts`, which is this package's own
 * generator and already the one the harness seeds. Rule 10: no `Math.random`,
 * no `Date.now`, no ambient clock anywhere in this file.
 */
export function fixtureBytes(seed: number, key: string, byteLength: number): Uint8Array {
  const rng = mulberry32(fnv1a32(`${seed}\u0000${key}`));
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    out[i] = Math.floor(rng() * 256) & 0xff;
  }
  return out;
}

/**
 * Printable filler, for a fixture whose content a human may open.
 *
 * ── NO CREDENTIAL-SHAPED STRING, EVER (lesson E) ────────────────────────────
 *
 * The word list is deliberately dull and deliberately short. GitHub push
 * protection blocked a finished, green, fully-gated commit in an earlier round
 * over three INVENTED key-shaped strings in a test file whose own comment said
 * they were keyboard noise — a scanner cannot tell an invented live key from a
 * real one, and neither can a human skimming a diff. Random alphanumerics of
 * sufficient length are exactly the shape a scanner's entropy heuristic fires
 * on, so the filler here is WORDS, and the only hex this file emits is the
 * magic-number prefixes below, which are four bytes long and published.
 */
const FILLER_WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
] as const;

/** Deterministic printable text of at least `byteLength` bytes, trimmed exactly. */
export function fixtureText(seed: number, key: string, byteLength: number): string {
  const rng = mulberry32(fnv1a32(`${seed}\u0000text\u0000${key}`));
  let out = '';
  while (out.length < byteLength) {
    const pick = FILLER_WORDS[Math.floor(rng() * FILLER_WORDS.length)] ?? 'alpha';
    out += out.length === 0 ? pick : ` ${pick}`;
  }
  return out.slice(0, byteLength);
}

// ─── What a fixture is ──────────────────────────────────────────────────────

/**
 * The six upload cases, as a closed union.
 *
 * Exactly the list an upload handler has branches for, which is why it is six
 * members and not a boolean pair. Five are GENERATED from the seed; NAMED is the
 * customer's own fixture, read from `RunContext.fixtures`, and is the one case
 * where the bytes are not ours.
 */
export type UploadFixtureRequest =
  | {
      /** The customer's own committed fixture, by its key in `RunContext.fixtures`. */
      readonly kind: 'NAMED';
      readonly fixtureKey: string;
      readonly basename: string;
      readonly mediaType: string;
    }
  | {
      /** The happy path: a file of a given size and type. */
      readonly kind: 'GENERATED';
      readonly basename: string;
      readonly mediaType: string;
      readonly byteLength: number;
    }
  | {
      /** A file the handler is supposed to REJECT on type. */
      readonly kind: 'WRONG_TYPE';
      readonly basename: string;
      /** The type the NAME and the request claim. */
      readonly declaredMediaType: string;
      readonly shape: WrongTypeShape;
    }
  | {
      /** One byte past the application's own declared maximum. */
      readonly kind: 'OVER_LIMIT';
      readonly basename: string;
      readonly mediaType: string;
      /** The APPLICATION'S limit. Required: see {@link generateFixture}. */
      readonly limitBytes: number;
    }
  | {
      /** Zero bytes — accepted-and-broken is the commonest outcome here. */
      readonly kind: 'ZERO_BYTE';
      readonly basename: string;
      readonly mediaType: string;
    }
  | {
      /** A name in another script, which is an ordinary thing to have to handle. */
      readonly kind: 'UNICODE_NAME';
      readonly mediaType: string;
      readonly byteLength: number;
      readonly script: UnicodeNameScript;
      /** The extension to keep, so the type and the name still agree. */
      readonly extension: string;
    };

export const UPLOAD_FIXTURE_KINDS = [
  'NAMED',
  'GENERATED',
  'WRONG_TYPE',
  'OVER_LIMIT',
  'ZERO_BYTE',
  'UNICODE_NAME',
] as const;
export type UploadFixtureKind = (typeof UPLOAD_FIXTURE_KINDS)[number];

const UPLOAD_FIXTURE_KIND_PRESENT: Record<UploadFixtureKind, true> = {
  NAMED: true,
  GENERATED: true,
  WRONG_TYPE: true,
  OVER_LIMIT: true,
  ZERO_BYTE: true,
  UNICODE_NAME: true,
};

export const UPLOAD_FIXTURE_KIND_LIST = Object.keys(
  UPLOAD_FIXTURE_KIND_PRESENT,
) as ReadonlyArray<UploadFixtureKind>;

/**
 * HOW a wrong-type fixture is wrong.
 *
 * ── NO EXECUTABLE PAYLOAD IS EVER GENERATED, AND THAT IS NOT CAUTION ────────
 *
 * The defect an upload-type test looks for is the handler trusting the name, or
 * trusting the client's declared type, instead of the bytes. Every member below
 * produces that mismatch with INERT filler. Not one of them contains a script, a
 * macro, a shell line, an ELF or PE header, or an EICAR string.
 *
 * Writing a real payload would be building the exploit instead of testing the
 * validation — and it would additionally mean QAAI uploads malware-shaped bytes
 * into a customer's storage bucket, where their own scanner quarantines it and
 * their security team gets paged by us. The mismatch is the whole assertion, so
 * the payload buys nothing it costs.
 */
export const WRONG_TYPE_SHAPES = [
  /** `.sh` / `.exe` name with filler inside: does the handler filter on extension? */
  'EXECUTABLE_EXTENSION',
  /** A `.png` name whose leading bytes are `%PDF`: does the handler sniff content? */
  'MISMATCHED_MAGIC',
  /** `invoice.pdf.sh` — the classic "check the first extension" bypass. */
  'DOUBLE_EXTENSION',
] as const;
export type WrongTypeShape = (typeof WRONG_TYPE_SHAPES)[number];

const WRONG_TYPE_SHAPE_PRESENT: Record<WrongTypeShape, true> = {
  EXECUTABLE_EXTENSION: true,
  MISMATCHED_MAGIC: true,
  DOUBLE_EXTENSION: true,
};

export const WRONG_TYPE_SHAPE_LIST = Object.keys(
  WRONG_TYPE_SHAPE_PRESENT,
) as ReadonlyArray<WrongTypeShape>;

/**
 * Scripts a unicode-named fixture can be named in.
 *
 * Ordinary names in ordinary scripts. No bidi controls — see {@link BIDI_CONTROLS}
 * for why that is a refusal rather than a seventh member here.
 */
export const UNICODE_NAME_SCRIPTS = [
  /** Arabic letters: a right-to-left name with no override character in it. */
  'ARABIC',
  /** Han characters. */
  'CJK',
  /** Latin with combining diacritics, which normalise differently per filesystem. */
  'COMBINING_DIACRITICS',
] as const;
export type UnicodeNameScript = (typeof UNICODE_NAME_SCRIPTS)[number];

const UNICODE_NAME_SCRIPT_PRESENT: Record<UnicodeNameScript, true> = {
  ARABIC: true,
  CJK: true,
  COMBINING_DIACRITICS: true,
};

export const UNICODE_NAME_SCRIPT_LIST = Object.keys(
  UNICODE_NAME_SCRIPT_PRESENT,
) as ReadonlyArray<UnicodeNameScript>;

/**
 * The base names, one per script. Fixed strings rather than generated ones: a
 * randomly assembled sequence of combining marks is not a name anybody can read
 * in a failure message, and the point is that the name is ORDINARY.
 *
 * `COMBINING_DIACRITICS` is decomposed on purpose (`e` + U+0301, not `é`). macOS
 * stores NFD and Linux stores what it is given, so a handler that compares the
 * uploaded name against the stored one byte-for-byte fails on exactly this
 * input — which is the defect the case exists to find.
 */
const UNICODE_BASENAMES: Record<UnicodeNameScript, string> = {
  ARABIC: 'فاتورة',
  CJK: '発票',
  COMBINING_DIACRITICS: 'relevé-de-compte',
};

/** The published leading bytes of the formats this module can claim to produce. */
const MAGIC_PREFIXES: Record<string, readonly number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'image/png': [0x89, 0x50, 0x4e, 0x47], // \x89PNG
};

/**
 * A fixture, generated and ready to stage.
 *
 * `structurallyValid` is the field that keeps this honest, and it is the one a
 * caller must read before interpreting a rejection — see below.
 */
export interface GeneratedFixture {
  readonly kind: UploadFixtureKind;
  /** The name to upload under. Already through {@link safeSegment}. */
  readonly filename: string;
  /** The media type the fixture CLAIMS. For WRONG_TYPE this is the lie under test. */
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
  /**
   * IS THIS A PARSEABLE FILE OF THE TYPE IT CLAIMS?
   *
   * FALSE for almost everything here, and saying so is the point. A generated
   * `application/pdf` fixture carries the published `%PDF` magic and filler
   * behind it: it is not a document any renderer will open. So an application
   * that genuinely PARSES its uploads will reject it — correctly — and a test
   * that read that rejection as a defect would be filing a bug against a
   * correct implementation, on the strength of a file QAAI made up.
   *
   * A caller asserting "the happy path works" must use a NAMED fixture, whose
   * bytes are the customer's own, or confine itself to assertions that survive
   * `structurallyValid: false` — the name reached the server, the size limit
   * applied, the type was rejected. {@link acceptanceIsMeaningful} is the
   * predicate, so the judgement is made once rather than per plugin.
   */
  readonly structurallyValid: boolean;
  /** One sentence describing the content's provenance, for the step title. */
  readonly provenance: string;
}

/**
 * Can "the application ACCEPTED this file" be read as a pass?
 *
 * Only when the bytes are genuinely a file of the declared type. Otherwise
 * acceptance is as likely to mean the handler does not validate as it is to mean
 * the happy path works, and the two are opposite findings.
 *
 * REJECTION is meaningful either way, which is the asymmetry worth stating: a
 * rejection of an over-limit or wrong-type fixture is exactly the assertion
 * those cases exist to make.
 */
export function acceptanceIsMeaningful(fixture: GeneratedFixture): boolean {
  return fixture.structurallyValid;
}

export type FixtureOutcome =
  | { readonly ok: true; readonly fixture: GeneratedFixture }
  /**
   * Refused, with a reason from the SHARED vocabulary rather than a local one,
   * so a plugin can put it straight into `notAsserted` without a mapping table.
   */
  | {
      readonly ok: false;
      readonly reason: UnassertedReasonValue;
      readonly why: string;
      /** The bytes that were asked for, when a cap is what refused it. */
      readonly requestedBytes: number | null;
    };

/**
 * Build one fixture, deterministically, from the run seed.
 *
 * ── THE SUBTLEST HONESTY BUG IN THIS FILE, AND WHY OVER_LIMIT REFUSES ───────
 *
 * An OVER_LIMIT fixture must be `limitBytes + 1` bytes. When that exceeds
 * {@link MAX_GENERATED_FIXTURE_BYTES} the obvious thing to do is generate as
 * much as the cap allows and carry on. That would be catastrophic, and quietly:
 *
 *   the file is now UNDER the application's limit → the application ACCEPTS it,
 *   correctly → the check asserted "an over-limit upload is rejected" → it was
 *   not rejected → QAAI FILES A DEFECT AGAINST A CORRECT IMPLEMENTATION.
 *
 * A silently shrunk fixture does not weaken the test, it INVERTS it, and the
 * resulting bug report is one a customer will spend an afternoon disproving. So
 * the cap REFUSES: `CAP_BIT`, with the requested byte count in the sentence, and
 * the caller records an unasserted hole. Rule 12 — a cap that bit is reported as
 * a count and a reason, never applied quietly.
 *
 * `seed` is an argument. Nothing in this file reads a clock or a global.
 */
export function generateFixture(request: UploadFixtureRequest, seed: number): FixtureOutcome {
  const key = fixtureKeyFor(request);

  if (request.kind === 'NAMED') {
    /*
     * NAMED carries no bytes of ours. The caller resolves it from
     * `RunContext.fixtures` and calls `namedFixture` below, which is a separate
     * function rather than a branch here because the failure modes are
     * different: a missing key is the customer's typo, and everything in this
     * function is arithmetic.
     */
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why:
        'a NAMED fixture is the customer\'s own file and is not generated. Resolve it from ' +
        'RunContext.fixtures and call namedFixture() — this is a caller bug, not a capability gap',
      requestedBytes: null,
    };
  }

  const name =
    request.kind === 'UNICODE_NAME'
      ? `${UNICODE_BASENAMES[request.script]}${request.extension}`
      : request.kind === 'WRONG_TYPE'
        ? wrongTypeFilename(request.basename, request.shape)
        : request.basename;

  const segment = safeSegment(name);
  if (!segment.ok) {
    return {
      ok: false,
      /*
       * NOT_IMPLEMENTED rather than CAPABILITY_ABSENT: a refused filename is a
       * producer that wrote something this module will not stage, which is our
       * side of the line. CAPABILITY_ABSENT would send the reader to install
       * something.
       */
      reason: 'NOT_IMPLEMENTED',
      why: `the fixture filename was refused (${segment.refusal}): ${segment.why}`,
      requestedBytes: null,
    };
  }

  const requested = requestedByteLength(request);
  if (requested > MAX_GENERATED_FIXTURE_BYTES) {
    return {
      ok: false,
      reason: 'CAP_BIT',
      why:
        `this fixture needs ${requested} bytes and QAAI's generation cap is ` +
        `${MAX_GENERATED_FIXTURE_BYTES} bytes, so it was NOT generated. Nothing is asserted. ` +
        (request.kind === 'OVER_LIMIT'
          ? 'A smaller file was deliberately NOT substituted: it would be under your limit, your ' +
            'application would accept it correctly, and this check would have reported your ' +
            'correct behaviour as a defect.'
          : 'A truncated file would be a different test from the one that was asked for.'),
      requestedBytes: requested,
    };
  }

  const fixture = buildFixture(request, segment.name, requested, seed, key);
  if (fixture === null) {
    const minimum = TEXTUAL_MINIMUM_BYTES[textualMediaTypeOf(request) ?? ''] ?? 0;
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why:
        `a valid ${textualMediaTypeOf(request) ?? 'file'} cannot be ${requested} bytes long — the ` +
        `smallest one that still parses is ${minimum} bytes. It was NOT produced by truncating a ` +
        'larger document: a cut-off JSON or CSV would be unparseable while claiming to be valid, ' +
        'and your application rejecting it would then have been reported as a defect',
      requestedBytes: requested,
    };
  }
  return { ok: true, fixture };
}

/** The media type a request declares, when it is one of the textual three. */
function textualMediaTypeOf(
  request: Exclude<UploadFixtureRequest, { kind: 'NAMED' }>,
): string | null {
  if (request.kind === 'WRONG_TYPE') return null;
  return textualMediaType(request.mediaType) ? request.mediaType : null;
}

/** The stable key a fixture's content is derived from. Same request ⇒ same bytes. */
function fixtureKeyFor(request: UploadFixtureRequest): string {
  switch (request.kind) {
    case 'NAMED':
      return `NAMED:${request.fixtureKey}`;
    case 'GENERATED':
      return `GENERATED:${request.basename}:${request.mediaType}:${request.byteLength}`;
    case 'WRONG_TYPE':
      return `WRONG_TYPE:${request.basename}:${request.shape}`;
    case 'OVER_LIMIT':
      return `OVER_LIMIT:${request.basename}:${request.limitBytes}`;
    case 'ZERO_BYTE':
      return `ZERO_BYTE:${request.basename}`;
    case 'UNICODE_NAME':
      return `UNICODE_NAME:${request.script}:${request.extension}:${request.byteLength}`;
  }
}

/** How many bytes this request needs. The OVER_LIMIT arm is the one that matters. */
function requestedByteLength(request: Exclude<UploadFixtureRequest, { kind: 'NAMED' }>): number {
  switch (request.kind) {
    case 'GENERATED':
      return request.byteLength;
    case 'WRONG_TYPE':
      // Small on purpose: the assertion is about the type, not the size, and a
      // large wrong-type fixture pays for bytes nothing looks at.
      return 512;
    case 'OVER_LIMIT':
      // The +1 IS the test. See the cap note on `generateFixture`.
      return request.limitBytes + 1;
    case 'ZERO_BYTE':
      return 0;
    case 'UNICODE_NAME':
      return request.byteLength;
  }
}

function wrongTypeFilename(basename: string, shape: WrongTypeShape): string {
  switch (shape) {
    case 'EXECUTABLE_EXTENSION':
      return `${basename}.sh`;
    case 'DOUBLE_EXTENSION':
      return `${basename}.pdf.sh`;
    case 'MISMATCHED_MAGIC':
      return `${basename}.png`;
  }
}

function buildFixture(
  request: Exclude<UploadFixtureRequest, { kind: 'NAMED' }>,
  filename: string,
  byteLength: number,
  seed: number,
  key: string,
): GeneratedFixture | null {
  if (request.kind === 'ZERO_BYTE') {
    return {
      kind: 'ZERO_BYTE',
      filename,
      declaredMediaType: request.mediaType,
      bytes: new Uint8Array(0),
      /*
       * FALSE, and not because the generator fell short: a zero-byte file is not
       * a valid file of any type, which is the entire point of the case. An
       * application that accepts it has a defect; an application that rejects it
       * is right. `acceptanceIsMeaningful` returning false here is correct and
       * the caller asserts REJECTION.
       */
      structurallyValid: false,
      provenance: 'zero bytes, generated',
    };
  }

  if (request.kind === 'WRONG_TYPE') {
    const bytes =
      request.shape === 'MISMATCHED_MAGIC'
        ? withMagic('application/pdf', fixtureBytes(seed, key, byteLength))
        : fixtureBytes(seed, key, byteLength);
    return {
      kind: 'WRONG_TYPE',
      filename,
      declaredMediaType: request.declaredMediaType,
      bytes,
      structurallyValid: false,
      provenance:
        request.shape === 'MISMATCHED_MAGIC'
          ? `${byteLength} inert bytes behind a %PDF magic number, named .png — a content-sniffing probe`
          : `${byteLength} inert bytes named "${filename}" — an extension-filter probe. No ` +
            'executable payload is generated, ever',
    };
  }

  const mediaType = request.mediaType;
  const bytes = textualMediaType(mediaType)
    ? textualBytes(mediaType, byteLength, seed, key)
    : withMagic(mediaType, fixtureBytes(seed, key, byteLength));

  /*
   * A textual type whose envelope will not fit in the requested size cannot be
   * produced as a VALID file of that type, and `textualBytes` returns null
   * rather than truncating. See its own note: the truncation bug it replaces
   * shipped `structurallyValid: true` beside invalid JSON, which is precisely
   * the claim this field exists to make trustworthy.
   */
  if (bytes === null) {
    return null;
  }

  return {
    kind: request.kind,
    filename,
    declaredMediaType: mediaType,
    bytes,
    /*
     * Textual types ARE structurally valid: a CSV of filler words is a real CSV
     * and a text/plain of words is a real text file, so acceptance means
     * something. A binary type with a magic prefix and noise behind it is not a
     * real file of that type, and `structurallyValid: false` says so rather than
     * letting a caller read acceptance as the happy path working.
     */
    structurallyValid: textualMediaType(mediaType),
    provenance: `${byteLength} bytes of ${
      textualMediaType(mediaType)
        ? 'deterministic filler text'
        : `noise behind the published ${mediaType} magic number (NOT a parseable ${mediaType})`
    }, from seed ${seed}`,
  };
}

/** Types whose generated content is genuinely a file of that type. */
function textualMediaType(mediaType: string): boolean {
  return (
    mediaType === 'text/plain' ||
    mediaType === 'text/csv' ||
    mediaType === 'application/json'
  );
}

/**
 * The smallest file of each textual type that still PARSES as that type.
 *
 * `{"filler":""}` is 13 bytes and is valid JSON; `column_a,column_b\n\n` is 19
 * and is a valid CSV with one empty row; a text/plain file of 0 bytes is a valid
 * text file. Below these the envelope does not fit, and there is no such thing
 * as a 5-byte JSON document.
 */
const TEXTUAL_MINIMUM_BYTES: Record<string, number> = {
  'text/plain': 0,
  'application/json': 13,
  'text/csv': 19,
};

/**
 * Exact-length textual content that genuinely parses as the type it claims, or
 * `null` when the requested size cannot hold a valid file of that type.
 *
 * ── THE BUG THIS REPLACES, CAUGHT BY THIS FILE'S OWN TESTS ──────────────────
 *
 * The first version built the document and then did `body.slice(0, byteLength)`
 * to hit the requested size. For `application/json` at 120 bytes that cut the
 * JSON in the middle of a string literal — so the fixture was unparseable while
 * `structurallyValid` said TRUE. That is the exact lie the field exists to
 * prevent, in the function that produces the field: a caller would have read
 * the application's REJECTION of a malformed document as a defect.
 *
 * So the filler is sized to the budget that is left after the envelope, rather
 * than the document being cut to fit. Nothing is truncated, and a size too small
 * for the envelope is refused with the minimum named.
 */
function textualBytes(
  mediaType: string,
  byteLength: number,
  seed: number,
  key: string,
): Uint8Array | null {
  const minimum = TEXTUAL_MINIMUM_BYTES[mediaType];
  if (minimum === undefined || byteLength < minimum) return null;

  const fillerLength = byteLength - minimum;
  /*
   * The filler is words and spaces only (see FILLER_WORDS), so it can carry no
   * `"`, no `\`, no `,` and no newline — which is what makes it safe to drop
   * straight inside a JSON string literal and a CSV field with no escaping.
   */
  const filler = fixtureText(seed, key, fillerLength);
  const text =
    mediaType === 'application/json'
      ? `{"filler":"${filler}"}`
      : mediaType === 'text/csv'
        ? `column_a,column_b\n${filler}\n`
        : filler;

  const bytes = new TextEncoder().encode(text);
  /*
   * The invariant, asserted rather than assumed. Everything above is ASCII so
   * characters and bytes agree, and this never fires — but a future filler with
   * a multibyte character would make the length wrong, and slicing to fix it
   * would cut a code point in half and leave invalid UTF-8 behind a
   * `structurallyValid: true`. Refusing is the only safe answer.
   */
  if (bytes.length !== byteLength) return null;
  return bytes;
}

/** Prepend a published magic number, when one is known for this type. */
function withMagic(mediaType: string, body: Uint8Array): Uint8Array {
  const magic = MAGIC_PREFIXES[mediaType];
  if (!magic || body.length < magic.length) return body;
  const out = new Uint8Array(body);
  for (let i = 0; i < magic.length; i += 1) out[i] = magic[i] ?? 0;
  return out;
}

/**
 * Wrap the customer's OWN fixture bytes as a fixture.
 *
 * `structurallyValid: true`, and this is the only place in the file that claims
 * it about bytes it did not generate — correctly, because these are the
 * customer's committed test data and acceptance of them IS the happy path.
 *
 * A missing key is a refusal rather than an empty file: staging zero bytes under
 * the name of a fixture the customer thought they supplied would turn their typo
 * into a defect report about their upload handler.
 */
export function namedFixture(
  fixtureKey: string,
  basename: string,
  mediaType: string,
  fixtures: Readonly<Record<string, string>> | undefined,
): FixtureOutcome {
  const segment = safeSegment(basename);
  if (!segment.ok) {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why: `the fixture filename was refused (${segment.refusal}): ${segment.why}`,
      requestedBytes: null,
    };
  }
  const content = fixtures?.[fixtureKey];
  if (content === undefined) {
    return {
      ok: false,
      reason: 'REQUIRES_PROVISIONED_SANDBOX',
      why:
        `no fixture named "${fixtureKey}" was written into this run's workspace, so there are no ` +
        'bytes to upload. Nothing is asserted — an empty file was deliberately NOT substituted, ' +
        'because a zero-byte upload under this name would test your handler against our mistake',
      requestedBytes: null,
    };
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MAX_GENERATED_FIXTURE_BYTES) {
    return {
      ok: false,
      reason: 'CAP_BIT',
      why:
        `fixture "${fixtureKey}" is ${bytes.length} bytes and the staging cap is ` +
        `${MAX_GENERATED_FIXTURE_BYTES}. It was not staged and nothing is asserted`,
      requestedBytes: bytes.length,
    };
  }
  return {
    ok: true,
    fixture: {
      kind: 'NAMED',
      filename: segment.name,
      declaredMediaType: mediaType,
      bytes,
      structurallyValid: true,
      provenance: `the customer's own fixture "${fixtureKey}" (${bytes.length} bytes)`,
    },
  };
}

// ─── The injected surfaces ──────────────────────────────────────────────────

/** A fixture after it has been written somewhere a file input can reach it. */
export interface StagedFile {
  readonly path: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/**
 * The staging directory, as this module needs it.
 *
 * TWO METHODS, AND NEITHER OF THEM RUNS ANYTHING. That is the structural half of
 * "an uploaded fixture is never executed": there is no `exec`, no `spawn` and no
 * `chmod` on this interface, so no caller can reach one through it. An adapter
 * writes with {@link STAGED_FILE_MODE} and the interface gives it no way to say
 * otherwise.
 */
export interface FileStagingSurface {
  /**
   * Write `bytes` into the staging directory under `filename`.
   *
   * The adapter is expected to run {@link safeSegment} and {@link resolveWithin}
   * again — {@link stageFixture} below does both before calling, and the adapter
   * doing it too is deliberate belt-and-braces on the one operation in this file
   * that touches a real filesystem.
   */
  write(filename: string, bytes: Uint8Array): Promise<StagedFile>;
  /**
   * Read a file back. `null` means COULD NOT READ, and every caller turns that
   * into UNVERIFIED rather than into an empty buffer.
   */
  read(path: string): Promise<Uint8Array | null>;
}

/**
 * The file input, as this module needs it.
 *
 * ONE METHOD, named after the Playwright call that appears nowhere in this
 * runner today. A narrow interface rather than a `Page`: nothing in this file
 * imports playwright, the logic is tested against a recorder, and the real
 * adapter is one line.
 */
export interface FileUploadSurface {
  /**
   * Set the input's files. Rejects when the selector does not resolve, which is
   * a statement about the application and not about us.
   */
  setInputFiles(selector: string, files: readonly StagedFile[]): Promise<void>;
}

/** A download, as the browser hands it over. */
export interface DownloadCapture {
  /** The name the server or the `download` attribute suggested. */
  readonly suggestedFilename: string;
  /** The declared media type, or `null` when the transport did not say. */
  readonly mediaType: string | null;
  /**
   * The bytes. `null` means THE BYTES COULD NOT BE READ — the stream failed, the
   * file was cleaned up, the cap bit. Never an empty buffer for that: a 0-byte
   * download is a real and important result, and conflating the two would hide
   * the single commonest download defect behind our own read failure.
   */
  readBytes(): Promise<Uint8Array | null>;
}

/** The download side of a browser context, as this module needs it. */
export interface FileDownloadSurface {
  /**
   * Do the thing that produces a download, and hand back the capture.
   *
   * `null` means NO DOWNLOAD HAPPENED, which is a failure of the application and
   * is reported as UNMET — distinct from a capture whose bytes could not be
   * read, which is UNVERIFIED.
   */
  triggerDownload(action: { readonly path: string }): Promise<DownloadCapture | null>;
}

// ─── Staging ────────────────────────────────────────────────────────────────

export type StageOutcome =
  | { readonly ok: true; readonly staged: StagedFile; readonly fixture: GeneratedFixture }
  | { readonly ok: false; readonly reason: UnassertedReasonValue; readonly why: string };

/**
 * Stage a fixture into a directory, with both safety layers applied.
 *
 * The containment check runs against the directory the STAGING SURFACE will use,
 * passed in, because a check against a directory nobody writes to is theatre.
 */
export async function stageFixture(
  fixture: GeneratedFixture,
  stagingDir: string,
  surface: FileStagingSurface,
): Promise<StageOutcome> {
  const segment = safeSegment(fixture.filename);
  if (!segment.ok) {
    return {
      ok: false,
      reason: 'NOT_IMPLEMENTED',
      why: `refused to stage "${fixture.filename}" (${segment.refusal}): ${segment.why}`,
    };
  }
  const contained = resolveWithin(stagingDir, segment.name);
  if (!contained.ok) {
    return { ok: false, reason: 'NOT_IMPLEMENTED', why: `refused to stage: ${contained.why}` };
  }
  try {
    const staged = await surface.write(segment.name, fixture.bytes);
    return { ok: true, staged, fixture };
  } catch (err) {
    return {
      ok: false,
      reason: 'CAPABILITY_ABSENT',
      why: `the staging directory could not be written: ${errorText(err)}`,
    };
  }
}

/**
 * Upload one staged fixture through a file input, and report what happened.
 *
 * No assertion about the OUTCOME is made here, deliberately: whether the
 * application should have accepted or rejected this file is the calling test's
 * business, and it depends on {@link acceptanceIsMeaningful}. This reports only
 * whether the file reached the input.
 */
export async function uploadStaged(
  staged: StagedFile,
  selector: string,
  surface: FileUploadSurface,
): Promise<FileCheck> {
  try {
    await surface.setInputFiles(selector, [staged]);
    return met(
      'upload',
      `set "${staged.filename}" (${staged.byteLength} bytes, ${staged.mediaType}) on ${selector}`,
    );
  } catch (err) {
    return unmet(
      'upload',
      `could not set files on "${selector}": ${errorText(err)}. The input may not exist, may be ` +
        'hidden, or may not be a file input',
    );
  }
}

// ─── Download assertions ────────────────────────────────────────────────────

/** What a download is expected to be. Every field optional; absent = not asserted. */
export interface DownloadExpectation {
  /** A glob (`invoice-*.pdf`) or an exact name. */
  readonly filenamePattern?: string;
  readonly mediaType?: string;
  readonly minBytes?: number;
  readonly maxBytes?: number;
  /** Published leading bytes as lowercase hex, no `0x`. `25504446` is `%PDF`. */
  readonly magicHex?: string;
  /** Strings the parsed content must contain. Needs a parseable format. */
  readonly contains?: readonly string[];
}

/**
 * Match a filename against a glob.
 *
 * `*` and `?` only, and every other character is literal — which means the regex
 * is built by ESCAPING the pattern and then un-escaping those two, never by
 * interpolating the pattern into a regex. A pattern is producer-supplied data,
 * and `invoice-(.*)+$` interpolated raw is a catastrophic-backtracking denial of
 * service against our own worker.
 */
export function matchesGlob(filename: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\\\*/g, '[^/\\\\]*').replace(/\\\?/g, '[^/\\\\]');
  return new RegExp(`^${expanded}$`).test(filename);
}

/** Lowercase hex of the first `byteCount` bytes. */
export function leadingHex(bytes: Uint8Array, byteCount: number): string {
  let out = '';
  for (let i = 0; i < Math.min(byteCount, bytes.length); i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Formats whose CONTENT this module can genuinely assert on, with no parser
 * installed and no guessing.
 *
 * Three, and the list is short because it is honest. UTF-8 text, CSV and JSON
 * are parseable here with certainty. A PDF's text layer is NOT — it needs a
 * parser this image does not carry — so it is not on this list and the DOCUMENT
 * plugin takes an injected extractor for it and reports UNAVAILABLE without one.
 * A format absent from this list is reported `CAPABILITY_ABSENT`, never guessed
 * at by scanning for ASCII runs: a substring found in the compressed stream of a
 * PDF is a coincidence, and asserting on it is a pass that means nothing.
 */
export const PARSEABLE_MEDIA_TYPES = ['text/plain', 'text/csv', 'application/json'] as const;
export type ParseableMediaType = (typeof PARSEABLE_MEDIA_TYPES)[number];

const PARSEABLE_MEDIA_TYPE_PRESENT: Record<ParseableMediaType, true> = {
  'text/plain': true,
  'text/csv': true,
  'application/json': true,
};

export const PARSEABLE_MEDIA_TYPE_LIST = Object.keys(
  PARSEABLE_MEDIA_TYPE_PRESENT,
) as ReadonlyArray<ParseableMediaType>;

/** Is this media type one whose text we can read with certainty? */
export function isParseable(mediaType: string | null): mediaType is ParseableMediaType {
  return (
    mediaType !== null && (PARSEABLE_MEDIA_TYPE_LIST as readonly string[]).includes(mediaType)
  );
}

/**
 * Decode bytes as UTF-8, or `null` when they are not valid UTF-8.
 *
 * `fatal: true` is the whole point. The default replaces every undecodable byte
 * with U+FFFD, so a PDF decodes "successfully" into mojibake, a `contains`
 * assertion then searches that mojibake, and the result is a confident verdict
 * about a string that was never in the file.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Read a capture's bytes, with the cap applied and disclosed.
 *
 * Returns the three states a read has, and they are three rather than two for
 * the reason the whole file exists: `null` bytes is UNVERIFIED, and an empty
 * array is a real zero-byte download.
 */
export async function readCapture(
  capture: DownloadCapture,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: UnassertedReasonValue; readonly why: string }
> {
  let bytes: Uint8Array | null;
  try {
    bytes = await capture.readBytes();
  } catch (err) {
    return {
      ok: false,
      reason: 'CAPABILITY_ABSENT',
      why: `the download's bytes could not be read: ${errorText(err)}`,
    };
  }
  if (bytes === null) {
    return {
      ok: false,
      reason: 'CAPABILITY_ABSENT',
      why:
        'the download was captured and its bytes could not be read, so nothing about its content ' +
        'is asserted. This is NOT a zero-byte file — that would be a finding',
    };
  }
  if (bytes.length > MAX_DOWNLOAD_READ_BYTES) {
    return {
      ok: false,
      reason: 'CAP_BIT',
      why:
        `the download is ${bytes.length} bytes and QAAI's read cap is ${MAX_DOWNLOAD_READ_BYTES}. ` +
        'It was not inspected and nothing about its content is asserted. A truncated read compared ' +
        'against a size ceiling would report a runaway export as a pass',
    };
  }
  return { ok: true, bytes };
}

/**
 * Assert everything the expectation names about a captured download.
 *
 * Returns one {@link FileCheck} per field that was NAMED. A field the
 * expectation does not carry produces no check at all rather than a passing one,
 * because a list of passes for assertions nobody made is how a result comes to
 * look thoroughly verified.
 *
 * The bytes are read ONCE and the content checks share them, so a cap or a read
 * failure disables exactly the checks that needed bytes and leaves the filename
 * and media-type checks — which do not — intact and asserted.
 */
export async function checkDownload(
  capture: DownloadCapture,
  expectation: DownloadExpectation,
): Promise<FileCheck[]> {
  const checks: FileCheck[] = [];

  if (expectation.filenamePattern !== undefined) {
    const pattern = expectation.filenamePattern;
    checks.push(
      matchesGlob(capture.suggestedFilename, pattern)
        ? met('filename', `"${capture.suggestedFilename}" matches ${pattern}`)
        : unmet('filename', `expected a name matching ${pattern}, got "${capture.suggestedFilename}"`),
    );
  }

  if (expectation.mediaType !== undefined) {
    const want = expectation.mediaType;
    if (capture.mediaType === null) {
      checks.push(
        unverified(
          'mediaType',
          `expected ${want} and the transport declared no content type, so nothing is asserted ` +
            'about it. An absent declaration is not a mismatch',
          'CAPABILITY_ABSENT',
        ),
      );
    } else {
      // Compare the type without parameters: `text/csv; charset=utf-8` is a
      // text/csv, and failing it would be failing a correct server over a
      // charset nobody asserted.
      const got = capture.mediaType.split(';')[0]?.trim() ?? capture.mediaType;
      checks.push(
        got === want
          ? met('mediaType', `declared ${got}`)
          : unmet('mediaType', `expected ${want}, the server declared ${capture.mediaType}`),
      );
    }
  }

  const needsBytes =
    expectation.minBytes !== undefined ||
    expectation.maxBytes !== undefined ||
    expectation.magicHex !== undefined ||
    (expectation.contains !== undefined && expectation.contains.length > 0);
  if (!needsBytes) return checks;

  const read = await readCapture(capture);
  if (!read.ok) {
    // ONE unverified check per assertion that needed bytes, named individually.
    // A single "content" hole would under-report: a reader counting holes needs
    // to know that the size floor AND the magic number AND the text all went
    // unasserted, because each is a separate thing nobody checked.
    if (expectation.minBytes !== undefined || expectation.maxBytes !== undefined) {
      checks.push(unverified('size', read.why, read.reason));
    }
    if (expectation.magicHex !== undefined) {
      checks.push(unverified('magic', read.why, read.reason));
    }
    if (expectation.contains !== undefined && expectation.contains.length > 0) {
      checks.push(unverified('content', read.why, read.reason));
    }
    return checks;
  }

  const bytes = read.bytes;

  if (expectation.minBytes !== undefined || expectation.maxBytes !== undefined) {
    const min = expectation.minBytes;
    const max = expectation.maxBytes;
    const belowFloor = min !== undefined && bytes.length < min;
    const aboveCeiling = max !== undefined && bytes.length > max;
    checks.push(
      belowFloor || aboveCeiling
        ? unmet(
            'size',
            `the file is ${bytes.length} bytes, outside the expected range ` +
              `${min ?? 'any'}..${max ?? 'any'}` +
              (bytes.length === 0
                ? '. A zero-byte download is a handler that errored and still returned 200'
                : ''),
          )
        : met('size', `${bytes.length} bytes, within ${min ?? 'any'}..${max ?? 'any'}`),
    );
  }

  if (expectation.magicHex !== undefined) {
    const want = expectation.magicHex.toLowerCase();
    const got = leadingHex(bytes, Math.ceil(want.length / 2));
    checks.push(
      got === want
        ? met('magic', `leading bytes are ${got}`)
        : unmet(
            'magic',
            `expected leading bytes ${want}, got ${got || '(the file is empty)'}. This is the ` +
              'assertion that separates a real document from an HTML error page wearing its name',
          ),
    );
  }

  const contains = expectation.contains;
  if (contains !== undefined && contains.length > 0) {
    checks.push(...checkContent(bytes, capture.mediaType, contains));
  }

  return checks;
}

/**
 * Assert the parsed CONTENT of a download.
 *
 * Split out and exported because it is where the two refusals live, and both of
 * them are a pass this product would otherwise have shipped:
 *
 *   · AN UNPARSEABLE FORMAT IS UNVERIFIED, not searched. Scanning a PDF's raw
 *     bytes for "Total: 42.00" finds it only if the stream happens to be
 *     uncompressed, so the check passes on some PDFs and fails on others for
 *     reasons that have nothing to do with the document being right.
 *   · BYTES THAT ARE NOT VALID UTF-8 ARE UNVERIFIED, not replacement-charactered
 *     into a string and searched. See {@link decodeUtf8}.
 *
 * The decoded text is the CUSTOMER'S DOCUMENT and is DATA (rule 11). It is
 * searched for the expected strings and never interpreted; the only thing that
 * ever leaves here is which of the caller's own expected strings were present.
 * The document's own text is NOT echoed into a failure message, because a
 * statement, an invoice or a contract is exactly the kind of file that carries
 * someone's personal data.
 */
export function checkContent(
  bytes: Uint8Array,
  mediaType: string | null,
  contains: readonly string[],
): FileCheck[] {
  const bare = mediaType === null ? null : (mediaType.split(';')[0]?.trim() ?? mediaType);
  if (!isParseable(bare)) {
    return [
      unverified(
        'content',
        `the content type is ${bare ?? 'undeclared'}, which QAAI cannot parse here, so the ` +
          `${contains.length} expected string(s) were NOT searched for. Parseable without a ` +
          `parser: ${PARSEABLE_MEDIA_TYPE_LIST.join(', ')}. Scanning the raw bytes instead would ` +
          'pass or fail on whether the format happened to compress, not on whether the document ' +
          'is right',
        'CAPABILITY_ABSENT',
      ),
    ];
  }

  const text = decodeUtf8(bytes);
  if (text === null) {
    return [
      unverified(
        'content',
        `the file declares ${bare} and is not valid UTF-8, so its text was NOT searched. ` +
          'Decoding it lossily would have produced a confident verdict about a string that was ' +
          'never in the file',
        'CAPABILITY_ABSENT',
      ),
    ];
  }

  const missing = contains.filter((needle) => !text.includes(needle));
  return [
    missing.length === 0
      ? met('content', `all ${contains.length} expected string(s) are present`)
      : unmet(
          'content',
          `${missing.length} of ${contains.length} expected string(s) are absent: ` +
            `${missing.map((m) => JSON.stringify(m)).join(', ')}. The document's own text is not ` +
            'quoted here — it is the customer\'s data',
        ),
  ];
}

/** An error's message, without a stack and without throwing on a non-Error. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
