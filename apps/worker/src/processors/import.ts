/**
 * Import processor (§7) — reads an uploaded suite and decides what to do with it.
 *
 * ── WHAT THIS PROCESSOR USED TO DO, AND WHY IT WAS THE ROUND'S OWN DEFECT ───
 *
 * It called `convertSuiteWithLlm` directly, with no `targetEcosystem`. So:
 *
 *   · `planSuiteImport` and `decideDisposition` had NO production caller. The
 *     importer's whole triage — what dialect each file is in, how many tests it
 *     declares, which files are build manifests rather than unreadable tests —
 *     ran only from inside the converter, which hard-codes
 *     `requested: 'CONVERT_TO_PROJECT_ECOSYSTEM'`. INDEX_AS_EXISTING_COVERAGE
 *     was therefore UNREACHABLE: the better default could not happen.
 *   · With no target ecosystem, the converter fell back to Playwright
 *     TypeScript. A Java shop uploading its JUnit suite was handed a TypeScript
 *     rewrite — verbatim the defect the importer was written to fix, kept alive
 *     by the one line that calls it.
 *
 * ── WHAT IT DOES NOW ────────────────────────────────────────────────────────
 *
 * ONE. READ FIRST, ALWAYS. `planSuiteImport` runs before anything is converted
 * or written, against the project's OWN ecosystem. It is deterministic and
 * model-free, so the reading happens with no key and cannot fail for want of
 * one.
 *
 * TWO. THE DISPOSITION DECIDES. `requested` is null, so `decideDisposition`
 * applies its default — and the default is to READ the suite and count it,
 * writing nothing, whenever it is already in this project's dialect or QAAI
 * cannot tell what dialect it is in. "We read your 400 tests and here is what
 * they cover" is worth more than 400 rewrites nobody merges, and it is the only
 * outcome that cannot destroy human work.
 *
 * THREE. EVERY NUMBER IS RECONCILABLE. Every file handed in appears in exactly
 * one of FOUR buckets — indexed, convertible, unparseable, skipped —
 * `filesHandedIn` equals their sum on BOTH dispositions, and "N of M" always
 * carries both numbers. Four and not three: the convertible bucket is empty on
 * the INDEX path and is the whole suite on the CONVERT path, so a reconciliation
 * written over three of them is an identity that holds only where it was
 * tested. A file QAAI could not read is UNPARSEABLE with the reason that
 * actually bit — never dropped, never counted as imported, and never reported
 * as holding zero tests.
 *
 * Converted tests are created in an "Imported" suite, each carrying a review
 * flag that names the source framework — a machine migration is a starting
 * point a human signs off on, and the badge in the editor says so. This mirrors
 * how generated tests are flagged; a recorded or imported test is not trusted
 * more than a generated one just because it came from existing code.
 */

import {
  FRAMEWORK_LABELS,
  convertPostmanCollection,
  convertSuiteWithLlm,
  planSuiteImport,
  resolveEcosystem,
  type ConvertedTest,
  type SourceFile,
  type SourceFramework,
  type SuiteImportPlan,
} from '@qaai/agent';
import type { FlowMap, ImportJob } from '@qaai/shared';
import { llm, logger, prisma, publishEvent } from '../context.js';

/**
 * A file this run could not read as a test, with the reason that actually bit.
 *
 * Two producers and they are deliberately not merged into one count: the
 * PLAN's own UNPARSEABLE verdict (no dialect resolved, or no test block found)
 * and a Postman collection that would not parse. The second cannot be known
 * before conversion is attempted, so a single pre-conversion number would have
 * to either omit it or guess it. `stage` says which, because rule twelve of
 * this codebase is that a reported reason must be the one that bit.
 */
export interface UnreadableFile {
  readonly path: string;
  readonly stage: 'READING' | 'CONVERSION';
  readonly reason: string;
}

/** What the processor decided and counted, as one object a human can read. */
export interface ImportOutcome {
  readonly disposition: SuiteImportPlan['disposition'];
  readonly dispositionReason: string;
  readonly targetEcosystemId: string;
  readonly filesHandedIn: number;
  readonly converted: number;
  readonly indexed: number;
  /**
   * Files READ AS CONVERTIBLE TESTS — the bucket this structure was missing.
   *
   * `planSuiteImport` routes every file into exactly one of four outcomes
   * (INDEXED, CONVERTIBLE, UNPARSEABLE, SKIPPED) and this interface carried
   * three of them, so the reconciliation the header promises — and that
   * {@link unreadableFileCount} is named for — held only on the INDEX path,
   * where `convertible` is 0 by construction. On the CONVERT path, which is the
   * path that WRITES FILES, `indexed + skipped + unreadable` was short by
   * exactly this number: a three-file upload with one real test reported
   * `0 + 1 + 1 = 2` against `filesHandedIn: 3`, and the readable test file that
   * the whole migration was about appeared in no bucket at all.
   *
   * The reconciliation test that was supposed to catch that ran on the INDEX
   * path only, which is why `0 + 1 + 1 === 3` was never evaluated.
   */
  readonly convertible: number;
  readonly skipped: number;
  readonly testsRead: number;
  /**
   * Every reason a file could not be read, which is NOT one per file.
   *
   * A file can be unreadable at READING and then fail at CONVERSION — the
   * converter attempts an unparseable file on purpose — so it earns two
   * entries. Use {@link unreadableFileCount} for the count a human reads:
   * counting entries as files makes `indexed + convertible + skipped +
   * unreadable` exceed `filesHandedIn`, which is the reconciliation this whole
   * structure exists to keep true. All FOUR terms, because `convertible` is the
   * bucket every readable file lands in on the CONVERT path — see
   * {@link ImportOutcome.convertible}.
   */
  readonly unreadable: readonly UnreadableFile[];
  readonly summary: string;
}

/**
 * DISTINCT FILES, not reasons. See {@link ImportOutcome.unreadable}.
 *
 * This function exists because the first version of this processor reported
 * `unreadable.length` as a file count, and a one-file upload that was unreadable
 * at both stages reported two — a total that no longer reconciled against
 * `filesHandedIn`, found by the test named for that reconciliation.
 */
export function unreadableFileCount(entries: readonly UnreadableFile[]): number {
  return new Set(entries.map((entry) => entry.path)).size;
}

/**
 * The sentence a human reads, built from the plan and the counts.
 *
 * Exported and pure so the honesty rules can be tested over the STRING a
 * customer sees rather than over the fields that feed it — "N of M converted"
 * is a property of this text, and a test that only checked the fields would
 * pass over a summary that printed one of the two numbers.
 */
export function importSummary(outcome: Omit<ImportOutcome, 'summary'>): string {
  const lines: string[] = [];

  if (outcome.disposition === 'INDEX_AS_EXISTING_COVERAGE') {
    lines.push(
      `Read ${outcome.indexed} of ${outcome.filesHandedIn} uploaded file(s) as existing coverage ` +
        `and wrote NOTHING: ${outcome.dispositionReason}.`,
    );
    lines.push(
      outcome.testsRead === 0
        ? 'No test block could be read in any of them, so no count of your existing tests is ' +
            'claimed here — that is an unread suite, not an empty one.'
        : `Those files declare ${outcome.testsRead} test(s) that QAAI could read.`,
    );
  } else {
    /*
     * BOTH NUMBERS, ALWAYS. "Converted 7 test(s)" is a figure with nothing to
     * divide by: a migration that dropped five source files looks exactly like
     * one that was handed two. The file count is the denominator and the test
     * count is reported against what the reading found, not against itself.
     */
    lines.push(
      `Converted ${outcome.converted} test(s) from ${outcome.filesHandedIn} uploaded file(s) ` +
        `into ${outcome.targetEcosystemId}: ${outcome.dispositionReason}.`,
    );
    if (outcome.testsRead > 0) {
      lines.push(
        `The readable source files declared ${outcome.testsRead} test(s) and this migration ` +
          `produced ${outcome.converted}.`,
      );
    }
  }

  if (outcome.skipped > 0) {
    lines.push(
      `${outcome.skipped} file(s) were SKIPPED as config, build or dependency manifests: they ` +
        'declare no tests, so no conversion was attempted and they are not counted as unreadable.',
    );
  }
  if (outcome.unreadable.length > 0) {
    const files = unreadableFileCount(outcome.unreadable);
    lines.push(
      `${files} file(s) were UNPARSEABLE — counted here rather than dropped, and not counted as ` +
        `imported. ${outcome.unreadable.length} reason(s), because a file QAAI could not read is ` +
        'still ATTEMPTED and can fail twice:',
      ...outcome.unreadable.map((entry) => `  - ${entry.path} [${entry.stage}]: ${entry.reason}`),
    );
  }
  return lines.join('\n');
}

export async function processImport(job: ImportJob): Promise<void> {
  const { orgId, projectId, importBatchId } = job;

  const batch = await prisma.importBatch.findFirst({
    where: { id: importBatchId, orgId },
  });
  if (!batch) throw new Error(`Import batch ${importBatchId} not found`);

  /*
   * THE PROJECT'S OWN ECOSYSTEM, AND IT IS NOT OPTIONAL ANY MORE.
   *
   * This read is the whole fix for "a Java shop is handed a TypeScript
   * rewrite". `resolveEcosystem` is the same resolver the generator uses, so an
   * imported test and a generated test land in the same dialect — and the
   * converter's `targetEcosystemDefaulted` can no longer be true on this path.
   */
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true, primaryLanguage: true, primaryFramework: true },
  });
  if (!project) throw new Error(`Project ${projectId} not found for org ${orgId}`);

  const ecosystem = resolveEcosystem({
    language: project.primaryLanguage,
    framework: project.primaryFramework,
    testType: 'E2E',
    runner: null,
  });

  const files = batch.files as unknown as SourceFile[];
  const framework = batch.framework as SourceFramework;

  const emit = (message: string) =>
    publishEvent(orgId, {
      runId: `import:${importBatchId}`,
      type: 'log',
      data: { message },
      at: new Date().toISOString(),
    });

  /*
   * THE READING, BEFORE ANY DECISION AND BEFORE ANY WRITE.
   *
   * Deterministic and model-free. `requested: null` is the load-bearing part:
   * it is what lets `decideDisposition` apply its own default instead of being
   * told the answer, which is how INDEX_AS_EXISTING_COVERAGE became reachable.
   */
  const plan = planSuiteImport({
    files,
    framework,
    projectEcosystem: ecosystem,
    requested: null,
  });

  /*
   * The plan's own unreadable verdicts, carried with the reason IT gave. The
   * conversion stage appends its own below; neither overwrites the other.
   */
  const unreadable: UnreadableFile[] = plan.files
    .filter((file) => file.outcome === 'UNPARSEABLE')
    .map((file) => ({
      path: file.path,
      stage: 'READING' as const,
      reason: file.reason ?? 'QAAI could not read this file as a test',
    }));

  emit(
    `Read ${files.length} file(s) from ${FRAMEWORK_LABELS[framework] ?? framework}: ` +
      `${plan.disposition} — ${plan.reason}`,
  );

  const finish = async (outcome: ImportOutcome): Promise<void> => {
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        state: 'DONE',
        summary: outcome.summary,
        convertedCount: outcome.converted,
      },
    });
    emit(outcome.summary);
    publishEvent(orgId, {
      runId: `import:${importBatchId}`,
      type: 'run.finished',
      data: {
        framework,
        disposition: outcome.disposition,
        targetEcosystemId: outcome.targetEcosystemId,
        convertedCount: outcome.converted,
        filesHandedIn: outcome.filesHandedIn,
        indexedCount: outcome.indexed,
        /*
         * THE FOURTH BUCKET, so the sum reconciles on the CONVERT path too.
         * See {@link ImportOutcome.convertible}: without it a consumer adding
         * the three counts it was given got a total SHORT of `filesHandedIn`,
         * and the file it was missing was the one that became the tests.
         */
        convertibleCount: outcome.convertible,
        skippedCount: outcome.skipped,
        /*
         * FILES, so the caller can reconcile it: indexed + skipped + unreadable
         * equals filesHandedIn. The reasons can outnumber the files and are
         * reported separately rather than inflating this one.
         */
        unreadableCount: unreadableFileCount(outcome.unreadable),
        unreadableReasonCount: outcome.unreadable.length,
        testsRead: outcome.testsRead,
      },
      at: new Date().toISOString(),
    });
    logger.info(
      {
        importBatchId,
        framework,
        disposition: outcome.disposition,
        converted: outcome.converted,
        indexed: outcome.indexed,
        unreadable: unreadableFileCount(outcome.unreadable),
      },
      'import complete',
    );
  };

  let converted: ConvertedTest[] = [];
  let convertSummary = '';

  try {
    /*
     * ── THE BETTER DEFAULT, AND IT WRITES NOTHING ────────────────────────────
     *
     * `DISPOSITION_WRITES_FILES` has exactly one `true` key and this is the
     * other one. No test row is created, no file is produced, and the whole
     * output is the reading: what dialect, how many tests, which files could
     * not be read and why. A suite already written in this project's dialect
     * is not improved by being rewritten into near-identical copies somebody
     * still has to review.
     */
    if (plan.disposition === 'INDEX_AS_EXISTING_COVERAGE') {
      const base = {
        disposition: plan.disposition,
        dispositionReason: plan.reason,
        targetEcosystemId: ecosystem.id,
        filesHandedIn: plan.totals.filesHandedIn,
        converted: 0,
        indexed: plan.totals.indexed,
        convertible: plan.totals.convertible,
        skipped: plan.totals.skipped,
        testsRead: plan.totals.testsRead,
        unreadable,
      };
      await finish({ ...base, summary: importSummary(base) });
      return;
    }

    if (framework === 'POSTMAN') {
      // Deterministic — every Postman collection in the upload becomes API
      // tests, and no model is involved. The plan's SKIPPED verdicts drive the
      // loop so a `package.json` in the upload is not parsed as a collection.
      for (const [position, file] of files.entries()) {
        if (plan.files[position]?.outcome === 'SKIPPED') continue;
        try {
          const tests = convertPostmanCollection(file.content);
          converted.push(...tests);
          emit(`${file.path}: ${tests.length} API test(s)`);
        } catch (err) {
          /*
           * COUNTED, NOT EMITTED AND FORGOTTEN. This was an `emit` and a
           * `logger.warn`: the file vanished from every number the batch row
           * carried, so an upload of five collections where four would not
           * parse reported one success and no failures.
           */
          unreadable.push({
            path: file.path,
            stage: 'CONVERSION',
            reason: `not a valid ${FRAMEWORK_LABELS[framework]} collection: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          emit(`${file.path}: not a valid Postman collection — counted as unparseable`);
          logger.warn({ err, path: file.path }, 'postman parse failed');
        }
      }
    } else {
      // Code-based — the model does the conversion. Feed it the current flow
      // map's locators so it targets elements that actually exist on the app.
      const flowMapRow = await prisma.flowMap.findFirst({
        where: { orgId, projectId },
        orderBy: { version: 'desc' },
      });
      const flowMap = flowMapRow?.graph as unknown as FlowMap | undefined;
      const knownLocators = flowMap?.nodes
        .flatMap((n) =>
          n.affordances.map(
            (a) => `${a.selector.strategy} "${a.selector.name ?? a.selector.value}"`,
          ),
        )
        .slice(0, 30);

      const result = await convertSuiteWithLlm(
        llm,
        { orgId, projectId, agent: 'GENERATOR', subjectId: importBatchId },
        {
          framework,
          files,
          /*
           * THE ONE ARGUMENT THAT ENDED THE "JAVA SHOP GETS TYPESCRIPT" BUG.
           * Absent, the converter defaults to Playwright TypeScript and says so
           * in `targetEcosystemDefaulted`; supplied, that flag is false and the
           * tests are written in the dialect the project actually uses.
           */
          targetEcosystem: ecosystem,
          knownLocators,
          onFile: (path, count) => emit(`${path}: ${count} test(s)`),
        },
      );
      converted = result.tests;
      convertSummary = result.summary;

      /*
       * The converter's own failure list, carried into one place with the rest.
       * It attempts an UNPARSEABLE file rather than refusing it — see its own
       * comment for why — so a file can be both read-unparseable and
       * conversion-failed, and both reasons survive because each entry names
       * the stage that produced it.
       */
      for (const failure of result.failedSources) {
        unreadable.push({
          path: failure.path,
          stage: 'CONVERSION',
          reason: `conversion failed: ${failure.reason}`,
        });
      }
    }

    const base = {
      disposition: plan.disposition,
      dispositionReason: plan.reason,
      targetEcosystemId: ecosystem.id,
      filesHandedIn: plan.totals.filesHandedIn,
      converted: converted.length,
      indexed: plan.totals.indexed,
      convertible: plan.totals.convertible,
      skipped: plan.totals.skipped,
      testsRead: plan.totals.testsRead,
      unreadable,
    };

    /*
     * Zero tests is a valid outcome — a docs-only Postman collection, a suite of
     * only config files — not a failure. Finish DONE with the honest counts
     * rather than ERRORED-and-retry. The counts are the same ones a non-empty
     * run reports, so an empty import is distinguishable from a failed one by
     * reading them rather than by their absence.
     */
    if (converted.length === 0) {
      await finish({
        ...base,
        summary: [importSummary(base), convertSummary].filter(Boolean).join('\n'),
      });
      return;
    }

    // Two converted tests can slug to the same file path (distinct requests with
    // near-identical names, or two source files whose names collide).
    // Distinct paths on disk are the whole no-lock-in promise, so a collision
    // gets a numeric suffix rather than one test silently overwriting another.
    const usedPaths = new Set<string>();
    for (const test of converted) {
      let path = test.filePath;
      if (usedPaths.has(path)) {
        const dot = path.lastIndexOf('.');
        for (let n = 2; ; n++) {
          const candidate =
            dot > 0 ? `${path.slice(0, dot)}-${n}${path.slice(dot)}` : `${path}-${n}`;
          if (!usedPaths.has(candidate)) {
            path = candidate;
            break;
          }
        }
      }
      usedPaths.add(path);
      test.filePath = path;
    }

    // One transaction for the whole batch: a failure partway through rolls back
    // every insert, so a retry can never find half the tests already written.
    // With attempts:1 on the queue there is no auto-retry either — belt and
    // braces against the duplication the review found.
    await prisma.$transaction(async (tx) => {
      const suite = await tx.suite.upsert({
        where: { projectId_name: { projectId, name: 'Imported' } },
        create: {
          orgId,
          projectId,
          name: 'Imported',
          description: `Migrated from ${FRAMEWORK_LABELS[framework] ?? framework}`,
        },
        update: {},
      });

      for (const test of converted) {
        await tx.test.create({
          data: {
            orgId,
            projectId,
            suiteId: suite.id,
            name: test.name.slice(0, 160),
            type: test.type,
            feature: 'Imported',
            priority: 'IMPORTANT',
            code: test.code,
            filePath: test.filePath,
            spec: test.spec ? (test.spec as unknown as object) : undefined,
            tags: ['imported', framework.toLowerCase()],
            reviewFlags: [
              `Converted from ${FRAMEWORK_LABELS[framework] ?? framework} into ${ecosystem.label} — review before trusting`,
              ...test.notes,
            ],
            versions: {
              create: {
                orgId,
                version: 1,
                code: test.code || '// spec-driven test',
                source: 'IMPORT',
                message: `Imported from ${test.sourceFile}`,
              },
            },
          },
        });
      }
    });

    await finish({
      ...base,
      summary: [importSummary(base), convertSummary].filter(Boolean).join('\n'),
    });
  } catch (err) {
    // Distinguish "the key is missing/rejected" from a genuine conversion
    // problem — the fix differs, and the earlier code buried the AUTH cause
    // under a generic "nothing converted" message.
    const isAuth = err instanceof Error && /API key|ANTHROPIC_API_KEY/i.test(err.message);
    const message = isAuth
      ? 'Conversion needs a working model key. Reading your suite as existing coverage, and ' +
        'importing Postman collections, both work without one.'
      : err instanceof Error
        ? err.message
        : String(err);

    /*
     * The READING survives the failure. It cost no key and no model, so it is
     * still true after a conversion failed — and it is the half that tells a
     * customer what their suite contains, which is the more useful half.
     */
    const partial = importSummary({
      disposition: plan.disposition,
      dispositionReason: plan.reason,
      targetEcosystemId: ecosystem.id,
      filesHandedIn: plan.totals.filesHandedIn,
      converted: converted.length,
      indexed: plan.totals.indexed,
      convertible: plan.totals.convertible,
      skipped: plan.totals.skipped,
      testsRead: plan.totals.testsRead,
      unreadable,
    });

    await prisma.importBatch.update({
      where: { id: batch.id },
      // Keep the reading and the per-file detail too, so the honest numbers
      // survive a failure rather than being replaced by the headline error.
      data: {
        state: 'ERRORED',
        error: message,
        summary: [partial, convertSummary].filter(Boolean).join('\n') || null,
      },
    });
    emit(`Import failed: ${message}`);
    logger.error({ err, importBatchId }, 'import failed');
    throw err;
  }
}
