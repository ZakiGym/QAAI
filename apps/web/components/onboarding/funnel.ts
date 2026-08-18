import {
  CREATABLE_TEST_TYPES,
  FRAMEWORKS_BY_LANGUAGE,
  LANGUAGES,
  MODEL_FREE_TEST_TYPES,
  NEW_TEST_TEMPLATES,
  TEST_TYPE_LABELS,
  UI_FRAMEWORKS,
  defaultFrameworkFor,
  isSupportedPair,
  needsContent,
  type Language,
  type ProjectDetection,
  type RepoFile,
  type TestType,
  type UiFramework,
} from '@qaai/shared';

/**
 * The first-run funnel's decisions, with no React in them.
 *
 * Everything here is a pure function of what the user picked or what their
 * folder contains, which is the only reason any of it is testable — the old
 * screen had all of this inline in a 585-line component and none of it was
 * covered by anything.
 *
 * The rule the whole module follows: never offer a choice the API will refuse,
 * and never claim a capability this deployment does not have. Both failures
 * were live on the screen this replaces.
 */

// ─── Step 1: where do your tests come from? ──────────────────────────────────

/**
 * The four honest answers. There is no fifth, and "I don't know" is not one of
 * them — every path below leads to a project that exists and a screen that does
 * something, which is what the old dead-end onboarding could not say.
 */
export type FunnelPath = 'codebase' | 'url' | 'import' | 'scratch';

export interface PathChoice {
  id: FunnelPath;
  label: string;
  /** One sentence, in the product's voice: what QAAI does with this. */
  body: string;
  /** The mono line under it — what it needs from you before it can start. */
  needs: string;
  /** True for the path this screen is built around. Exactly one. */
  headline?: boolean;
}

export const PATH_CHOICES: readonly PathChoice[] = [
  {
    id: 'codebase',
    label: 'I have an application codebase',
    body: 'Point QAAI at your repo and it reads the shape of it — languages, package managers, workspaces, whether a test runner is already set up — and configures itself to what it finds.',
    needs: 'a folder on this machine',
    headline: true,
  },
  {
    id: 'url',
    label: 'I have a running URL',
    body: 'The Explorer crawls it in a real browser, records every page, form and auth wall it meets, and proposes a plan of tests from what it saw.',
    needs: 'a staging or preview URL',
  },
  {
    id: 'import',
    label: 'I already have tests',
    body: 'Bring a Cypress, Selenium, WebdriverIO, TestCafe, Postman or Cucumber suite; QAAI detects the framework and converts it.',
    needs: 'your existing suite',
  },
  {
    id: 'scratch',
    label: 'Start from scratch',
    body: 'Skip the questions. QAAI creates the app and opens the editor on a starter test in the types you pick.',
    needs: 'nothing',
  },
];

// ─── Step 1a: reading a repo in the browser ──────────────────────────────────

/**
 * Directories nobody means to hand over.
 *
 * `node_modules` alone is tens of thousands of entries, and a repo listing that
 * includes it does not merely take longer — it wrecks the answer. Detection
 * counts source files by extension to rank languages, and one Python venv or
 * one vendored JS bundle silently outvotes the application it sits inside.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  'vendor',
  'coverage',
  '.terraform',
  'Pods',
]);

/**
 * Lockfiles. Deliberately skipped rather than read: a lockfile is the resolved
 * output of a manifest, it can be megabytes, and detection never looks inside
 * one — the package manager it implies is established by the file's NAME,
 * which survives in the listing without its contents.
 */
const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'Cargo.lock',
  'go.sum',
]);

/** Anything whose bytes are not text. Read as text these produce mojibake. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svgz|mp[34g]|mov|avi|webm|wav|flac|ogg|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|jar|war|ear|so|dylib|dll|exe|bin|dat|db|sqlite3?|pdf|docx?|xlsx?|pptx?|psd|sketch|fig|class|pyc|pyo|o|a|wasm|node|pack|idx)$/i;

/**
 * Caps for the READ — what this tab holds in memory to run detection locally.
 * A folder pick that freezes the page is a folder pick that failed. 40k paths
 * is a very large monorepo once the skips above have done their work; 4MB
 * covers every manifest in one.
 *
 * These are deliberately larger than what gets UPLOADED — see `uploadPayload`.
 */
export const MAX_LISTED_FILES = 40_000;
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

/*
 * Caps for the UPLOAD — what the API will actually accept.
 *
 * Three separate limits sit between this function and a stored snapshot, and
 * the tightest one is not the route's:
 *
 *   - `express.json({ limit: '2mb' })`, which rejects the whole body with a
 *     413 before any route code runs;
 *   - the route's own MAX_FILES = 5000;
 *   - the route's own MAX_TOTAL_BYTES = 5MB, which the 2MB body limit makes
 *     unreachable anyway.
 *
 * So the budget below is the 2MB body limit minus room for JSON encoding: every
 * path is wrapped in `{"path":"…"}` and every content string is escaped, and a
 * payload measured in raw bytes that lands at 2.1MB encoded is a 413 the person
 * reads as "your repo is broken".
 *
 * Keeping these here rather than trimming server-side is the difference between
 * a funnel that works on a monorepo and one that fails at the last step. If the
 * route's limits move, these move with them — `funnel.test.ts` asserts the
 * relationship rather than the numbers.
 */
export const UPLOAD_MAX_FILES = 5_000;
/** Raw content bytes, before escaping. Leaves the rest of the 2MB for paths. */
export const UPLOAD_MAX_CONTENT_BYTES = 1_200_000;
/** Rough per-entry JSON overhead: braces, the two keys, quotes and a comma. */
const JSON_ENTRY_OVERHEAD = 24;
/** Stay clear of `express.json({ limit: '2mb' })` with room for the escaping. */
const UPLOAD_MAX_ENCODED_BYTES = 1_700_000;

/**
 * Trim a read result down to something the API will accept.
 *
 * Content first, paths second, and that order is the whole point: the files
 * with content are the manifests, and they are what detection actually reads.
 * A truncation that drops `package.json` to make room for 4,000 paths of
 * `src/components/**` produces a snapshot that knows the shape of the repo and
 * nothing about what it is built with.
 *
 * Returns what was dropped so the caller can say so. Silently sending less than
 * the person picked is how a half-analysed repo looks like a complete one.
 */
export function uploadPayload(files: readonly RepoFile[]): {
  files: RepoFile[];
  droppedFiles: number;
  droppedContent: number;
} {
  const withContent = files.filter((f) => f.content !== undefined);
  const pathsOnly = files.filter((f) => f.content === undefined);

  const out: RepoFile[] = [];
  let contentBytes = 0;
  let encoded = 0;
  let droppedContent = 0;

  for (const file of withContent) {
    const size = file.content?.length ?? 0;
    const cost = size + file.path.length + JSON_ENTRY_OVERHEAD;
    if (
      out.length >= UPLOAD_MAX_FILES ||
      contentBytes + size > UPLOAD_MAX_CONTENT_BYTES ||
      encoded + cost > UPLOAD_MAX_ENCODED_BYTES
    ) {
      // Kept as a path so detection reports it as an unreadable manifest —
      // the same honest outcome readRepo produces when it runs out of budget.
      if (out.length < UPLOAD_MAX_FILES) {
        out.push({ path: file.path });
        encoded += file.path.length + JSON_ENTRY_OVERHEAD;
      }
      droppedContent += 1;
      continue;
    }
    contentBytes += size;
    encoded += cost;
    out.push(file);
  }

  for (const file of pathsOnly) {
    const cost = file.path.length + JSON_ENTRY_OVERHEAD;
    if (out.length >= UPLOAD_MAX_FILES || encoded + cost > UPLOAD_MAX_ENCODED_BYTES) break;
    encoded += cost;
    out.push(file);
  }

  return {
    files: out,
    droppedFiles: files.length - out.length,
    droppedContent,
  };
}

/** True when this path should appear in the listing detection sees at all. */
export function shouldList(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (!base || base.startsWith('.DS_Store')) return false;
  // Every directory on the way down, not just the top one: a skipped folder
  // nested three levels deep is the same folder.
  if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) return false;
  if (SKIP_DIRS.has(base)) return false;
  if (LOCKFILES.has(base)) return false;
  if (BINARY_EXT.test(base)) return false;
  return true;
}

/**
 * Whether this file's bytes have to be read, or whether its path is enough.
 *
 * The answer is detection's, not ours — `needsContent` lives beside the regex
 * that decides it. Guessing here has a specific failure mode: a manifest handed
 * over without its content is recorded as UNREADABLE, so a caller that under-
 * reads makes detection warn about files the browser was holding all along.
 */
export const shouldRead = needsContent;

export interface RepoPick {
  path: string;
  file: File;
}

export interface RepoReadResult {
  /** What detection is given: every kept path, contents only where needed. */
  files: RepoFile[];
  /** How many entries the pick contained before the skips. */
  seen: number;
  /** How many files were actually opened and read as text. */
  read: number;
  /** True when MAX_LISTED_FILES cut the listing short — said, never hidden. */
  truncated: boolean;
}

/**
 * Turn a folder pick into detection's input.
 *
 * Manifests are read first and separately, before the cap is applied to
 * anything else. That ordering is load-bearing: a 40k-file monorepo whose
 * `package.json` fell off the end of an alphabetical truncation is a repo
 * detection reports as having no package manager and no dependencies.
 */
export async function readRepo(
  picked: readonly RepoPick[],
  readText: (file: File) => Promise<string> = defaultReadText,
): Promise<RepoReadResult> {
  const kept = picked.filter((entry) => shouldList(entry.path));
  const truncated = kept.length > MAX_LISTED_FILES;

  const manifests = kept.filter((entry) => shouldRead(entry.path));
  const listing = kept.filter((entry) => !shouldRead(entry.path)).slice(0, MAX_LISTED_FILES);

  const files: RepoFile[] = [];
  let bytes = 0;
  let read = 0;

  for (const entry of manifests) {
    if (bytes + entry.file.size > MAX_CONTENT_BYTES) {
      // Listed without content, which detection reports as an unreadable
      // manifest — the honest outcome, and better than a silent omission.
      files.push({ path: entry.path });
      continue;
    }
    bytes += entry.file.size;
    read += 1;
    files.push({ path: entry.path, content: await readText(entry.file) });
  }

  for (const entry of listing) files.push({ path: entry.path });

  return { files, seen: picked.length, read, truncated };
}

function defaultReadText(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    // An unreadable file is a gap in the input, and detection already has a
    // vocabulary for that — empty content, not a rejected promise that would
    // take the whole folder down with it.
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

// ─── Step 2: language and framework ──────────────────────────────────────────

export interface StackSuggestion {
  language: Language;
  framework: UiFramework;
  /**
   * Why this was pre-selected, in detection's own words: "detected from
   * package.json". Shown next to the dropdown, because a pre-filled field with
   * no explanation is indistinguishable from a default nobody chose.
   */
  why: string;
}

/**
 * Pre-select the stack from what the repo said.
 *
 * Two sources, in this order. A ranked RUNNER candidate is the stronger claim —
 * it means a test tool is configured, and its evidence is a config file rather
 * than a file count. Falling back to the dominant LANGUAGE is weaker but still
 * a fact about the repo, and the `why` says which of the two this was.
 *
 * Returns null rather than guessing when detection found nothing the generator
 * can emit for: a Rust repo gets an empty suggestion and the dropdown's own
 * default, not TypeScript with a confident sentence under it.
 */
export function suggestStack(detection: ProjectDetection): StackSuggestion | null {
  for (const candidate of detection.candidates) {
    if (!candidate.generatorLanguage) continue;
    const language = candidate.generatorLanguage;
    const evidence = candidate.evidence[0];
    const framework = frameworkForRunner(candidate.runner, language);
    return {
      language,
      framework,
      why: evidence
        ? `${candidate.label} in ${candidate.root === '.' ? 'the repo root' : candidate.root} — ${evidence.detail}`
        : `${candidate.label} in ${candidate.root === '.' ? 'the repo root' : candidate.root}`,
    };
  }

  for (const observed of detection.languages) {
    // `supportedByGenerator` is detection's own answer, but it is a boolean and
    // `DetectedLanguage` is the wider set (it can say RUST). The membership
    // check is what narrows the type honestly, rather than a cast that would
    // compile just as happily for a language the generator cannot emit.
    if (!observed.supportedByGenerator) continue;
    const language = asGeneratorLanguage(observed.language);
    if (!language) continue;
    const evidence = observed.evidence[0];
    return {
      language,
      framework: defaultFrameworkFor(language),
      why: evidence ? evidence.detail : `${observed.fileCount} source files`,
    };
  }

  return null;
}

/** Narrow a DetectedLanguage to one the generator can actually emit. */
function asGeneratorLanguage(language: string): Language | null {
  return (LANGUAGES as readonly string[]).includes(language) ? (language as Language) : null;
}

/**
 * The runner detection named, IF the generator can emit it for this language.
 *
 * A repo running Cypress under TypeScript should arrive with Cypress selected;
 * a repo running pytest should not arrive with "pytest" selected, because this
 * dropdown holds UI frameworks and pytest is not one. Most catalogue ids ARE
 * the framework's name in lower case (`playwright`, `cypress`, `webdriverio`),
 * so the match is cheap; everything else — `go-test`, `junit5-maven` — falls to
 * the language's default rather than to an option the pair rule would reject.
 */
function frameworkForRunner(runner: string, language: Language): UiFramework {
  const guess = runner.toUpperCase().replace(/[^A-Z]/g, '');
  return (UI_FRAMEWORKS as readonly string[]).includes(guess) &&
    isSupportedPair(language, guess as UiFramework)
    ? (guess as UiFramework)
    : defaultFrameworkFor(language);
}

/** The frameworks the dropdown may offer for a language. Never a rejected pair. */
export function frameworksFor(language: Language): readonly UiFramework[] {
  return FRAMEWORKS_BY_LANGUAGE[language];
}

/**
 * Keep a chosen framework across a language change, or fall back.
 *
 * Switching TypeScript → Ruby with Playwright selected has to move the
 * framework too; leaving it produces a form whose submit the API rejects, which
 * is exactly the bug the old screen shipped with Selenium.
 */
export function reconcileFramework(language: Language, framework: UiFramework): UiFramework {
  return isSupportedPair(language, framework) ? framework : defaultFrameworkFor(language);
}

// ─── Step 3: which test types ────────────────────────────────────────────────

/**
 * Ticked on arrival: the fast one that says the app is up, and the one that
 * walks a real journey. Both are code-mode types, so both are honest about
 * needing a model to be WRITTEN from a plan — which the step says out loud.
 */
export const DEFAULT_TEST_TYPES: readonly TestType[] = ['SMOKE', 'E2E'];

export interface TestTypeChoice {
  type: TestType;
  label: string;
  /** The template's own one-liner — what it does and what it needs. */
  hint: string;
  /**
   * True when QAAI can write this type from a crawl with no model. The six that
   * can are spec-driven types whose required fields a crawl actually supplies;
   * everything else needs ANTHROPIC_API_KEY before a plan turns into a file.
   */
  modelFree: boolean;
}

/** Every type the editor can mint, with the two facts the step has to state. */
export function testTypeChoices(): TestTypeChoice[] {
  const modelFree = new Set<string>(MODEL_FREE_TEST_TYPES);
  return CREATABLE_TEST_TYPES.map((type) => ({
    type,
    label: TEST_TYPE_LABELS[type],
    hint: NEW_TEST_TEMPLATES[type]?.hint ?? '',
    modelFree: modelFree.has(type),
  }));
}

/**
 * Split a selection into what this deployment can produce now and what waits
 * on a key. Step 4 reports both counts rather than one number that is only
 * true when a key is set.
 */
export function splitByModelNeed(selected: readonly TestType[]): {
  modelFree: TestType[];
  needsModel: TestType[];
} {
  const free = new Set<string>(MODEL_FREE_TEST_TYPES);
  return {
    modelFree: selected.filter((type) => free.has(type)),
    needsModel: selected.filter((type) => !free.has(type)),
  };
}

// ─── Naming ──────────────────────────────────────────────────────────────────

/**
 * A project name from what was dropped: the top folder, de-slugged.
 *
 * Only a segment that is a directory — one with no dot in it — because the
 * first entry of a flat multi-file pick is a filename, and "index.ts" is not
 * anybody's app name.
 */
export function nameFromPaths(paths: readonly string[]): string | null {
  for (const path of paths) {
    const top = path.split('/')[0];
    if (top && !top.includes('.')) return top.replace(/[-_]+/g, ' ').trim() || null;
  }
  return null;
}

// ─── Finishing: the round trips each path actually needs ─────────────────────

/**
 * The API client, injected rather than imported.
 *
 * `provision` below is the only part of the funnel that talks to the server,
 * and it is also the part whose bugs are invisible to a screen test — a request
 * that is never sent renders exactly like one that was. Taking the client as an
 * argument is what lets a unit test assert on the calls themselves.
 */
export type ApiClient = <T>(path: string, init?: RequestInit) => Promise<T>;

/** A test the funnel wrote, as the API hands it back. */
export interface ProvisionedTest {
  id: string;
  name: string;
  filePath: string;
  type: TestType;
}

export interface ProvisionInput {
  path: FunnelPath;
  name: string;
  language: Language;
  framework: UiFramework;
  /** Blank on every path but `url`, where the step will not let it be. */
  baseUrl: string;
  envKind: string;
  types: readonly TestType[];
  /** The repo read in this tab, on the `codebase` path only. */
  files: readonly RepoFile[] | null;
}

export interface ProvisionHooks<P> {
  api: ApiClient;
  /** Names the round trip in flight, so the button says what it is doing. */
  onBusy: (label: string) => void;
  /**
   * Raised the moment the project row exists — before the rest of the path
   * runs, and therefore before it can fail. The stepper stops offering a jump
   * back once this fires, because the earlier steps describe decisions that
   * have already been acted on.
   */
  onProject: (project: P) => void;
}

export interface ProvisionResult<P> {
  project: P;
  /** Null when no URL was given, which is every path but `url`. */
  environmentId: string | null;
  createdTests: ProvisionedTest[];
  /** Worth saying, but not a failure — currently only the upload trim. */
  notice: string | null;
  /** Where the funnel goes when this returns. */
  next: 'result' | 'import';
}

/**
 * Do what the chosen path promised, in order, each round trip named.
 *
 * The old screen ran up to three requests behind a single unlabelled press: no
 * busy state, nothing to stop a second click, and a failure halfway through
 * left a project with no environment and no way to tell. Every step below names
 * itself through `onBusy`, and the caller disables the button while it is set.
 *
 * Anything that throws here is the FUNNEL's failure and is reported on the
 * funnel's own step. That distinction is the whole reason the crawl is started
 * from this function: see the `url` branch.
 */
export async function provision<P extends { id: string }>(
  { api, onBusy, onProject }: ProvisionHooks<P>,
  input: ProvisionInput,
): Promise<ProvisionResult<P>> {
  onBusy('Creating the app…');
  const { project } = await api<{ project: P }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name.trim(),
      primaryLanguage: input.language,
      primaryFramework: input.framework,
    }),
  });
  onProject(project);

  // An environment is what a run needs; the URL is optional on every path
  // except the crawl, so this is conditional rather than assumed.
  let environmentId: string | null = null;
  const baseUrl = input.baseUrl.trim();
  if (baseUrl) {
    onBusy('Adding the environment…');
    const { environment } = await api<{ environment: { id: string } }>(
      `/projects/${project.id}/environments`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: input.envKind.toLowerCase(),
          kind: input.envKind,
          baseUrl,
        }),
      },
    );
    environmentId = environment.id;
  }

  let notice: string | null = null;
  let createdTests: ProvisionedTest[] = [];

  if (input.path === 'url') {
    /*
     * Ask for the crawl. This is the half that went missing.
     *
     * The environment was still being created and its id thrown away, and the
     * result step mounted CrawlPanel — which only ever WATCHES: an EventSource,
     * a plan poll, and an opening log line ("Crawling …") that the client
     * writes itself. So the screen was indistinguishable from a working crawl
     * for five minutes and then told the person "the crawl did not finish — is
     * the worker running?", blaming infrastructure that was idle because
     * nothing had ever been enqueued. The user lost the entire point of the
     * path they picked. Producer and consumer only work as a pair; do not
     * remove one and leave the other rendering.
     */
    if (!environmentId) {
      // Unreachable through the UI — the stack step will not release the `url`
      // path without a URL — but a crawl with nothing to crawl must say so
      // here rather than reach the result step and be waited on.
      throw new Error('No environment was created, so there is nothing for the Explorer to crawl.');
    }
    onBusy('Starting the crawl…');
    await api(`/projects/${project.id}/explore`, {
      method: 'POST',
      body: JSON.stringify({ environmentId, maxPages: 25, maxDepth: 3 }),
    });
  }

  if (input.path === 'codebase' && input.files) {
    /*
     * The repo goes up as paths plus the contents of the files detection
     * actually reads — readRepo already made that split in the browser, so a
     * monorepo does not become a 200MB POST.
     *
     * Trimmed to what the API accepts before it is sent. The read is generous
     * because it happens in this tab; the upload is not, because `express.json`
     * rejects a 2MB body outright and the person would meet that as an
     * unexplained failure at the last step of the funnel.
     */
    onBusy('Reading your codebase…');
    const payload = uploadPayload(input.files);
    await api(`/projects/${project.id}/source`, {
      method: 'POST',
      body: JSON.stringify({ files: payload.files }),
    });
    if (payload.droppedFiles > 0) {
      notice =
        `Sent ${payload.files.length.toLocaleString()} of ${input.files.length.toLocaleString()} ` +
        'files — the rest were over the upload limit.';
    }

    onBusy('Proposing scenarios…');
    await api(`/projects/${project.id}/analyze-source`, {
      method: 'POST',
      body: JSON.stringify({ autoApprove: false }),
    });
  }

  if (input.path === 'scratch') {
    /*
     * A starter file per chosen type, from the same templates the editor's
     * new-test dialog uses — so "start from scratch" opens on something that
     * runs, not an empty tree. The templates are validated against their runner
     * plugins by a test in packages/shared.
     */
    onBusy('Writing the starter tests…');
    const made: ProvisionedTest[] = [];
    for (const type of input.types) {
      const template = NEW_TEST_TEMPLATES[type];
      if (!template) continue;
      const slug = `starter-${type.toLowerCase().replace(/_/g, '-')}`;
      const { test } = await api<{ test: ProvisionedTest }>(`/projects/${project.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name: `Starter ${type.toLowerCase().replace(/_/g, ' ')} test`,
          type,
          feature: 'Hand-written',
          priority: 'NICE_TO_HAVE',
          filePath: `hand-written/${slug}${template.fileSuffix}`,
          code: template.code,
          // Spec-driven types carry a spec their plugin validates; the editor's
          // create dialog sends it the same conditional way.
          ...(template.spec !== undefined ? { spec: template.spec } : {}),
        }),
      });
      made.push(test);
    }
    createdTests = made;
  }

  return {
    project,
    environmentId,
    createdTests,
    notice,
    // The import screen owns its own upload and conversion; this funnel's job
    // was the project and the stack it converts into.
    next: input.path === 'import' ? 'import' : 'result',
  };
}
