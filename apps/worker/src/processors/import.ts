/**
 * Import processor (§7) — converts an uploaded suite into QAAI tests.
 *
 * Two paths by framework:
 *  - Postman is data, not code, so it converts deterministically with no model
 *    and no key. It lands as API tests immediately.
 *  - Everything code-based goes through the model, one source file at a time.
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
  type ConvertedTest,
  type SourceFile,
  type SourceFramework,
} from '@qaai/agent';
import type { FlowMap, ImportJob } from '@qaai/shared';
import { llm, logger, prisma, publishEvent } from '../context.js';

export async function processImport(job: ImportJob): Promise<void> {
  const { orgId, projectId, importBatchId } = job;

  const batch = await prisma.importBatch.findFirst({
    where: { id: importBatchId, orgId },
  });
  if (!batch) throw new Error(`Import batch ${importBatchId} not found`);

  const files = batch.files as unknown as SourceFile[];
  const framework = batch.framework as SourceFramework;

  const emit = (message: string) =>
    publishEvent(orgId, {
      runId: `import:${importBatchId}`,
      type: 'log',
      data: { message },
      at: new Date().toISOString(),
    });

  emit(`Converting ${files.length} file(s) from ${FRAMEWORK_LABELS[framework] ?? framework}…`);

  let converted: ConvertedTest[] = [];
  let summary = '';

  try {
    if (framework === 'POSTMAN') {
      // Deterministic — every Postman collection in the upload becomes API tests.
      for (const file of files) {
        try {
          const tests = convertPostmanCollection(file.content);
          converted.push(...tests);
          emit(`${file.path}: ${tests.length} API test(s)`);
        } catch (err) {
          emit(`${file.path}: not a valid Postman collection — skipped`);
          logger.warn({ err, path: file.path }, 'postman parse failed');
        }
      }
      summary = `Converted ${converted.length} API test(s) from ${files.length} Postman file(s).`;
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
          knownLocators,
          onFile: (path, count) => emit(`${path}: ${count} test(s)`),
        },
      );
      converted = result.tests;
      summary = result.summary;
    }

    // Zero tests is a valid outcome — a docs-only Postman collection, a suite of
    // only config files — not a failure. Finish DONE with a plain summary rather
    // than ERRORED-and-retry.
    if (converted.length === 0) {
      await prisma.importBatch.update({
        where: { id: batch.id },
        data: {
          state: 'DONE',
          summary: summary || 'No tests were found to import.',
          convertedCount: 0,
        },
      });
      emit('No tests found to import.');
      publishEvent(orgId, {
        runId: `import:${importBatchId}`,
        type: 'run.finished',
        data: { convertedCount: 0, framework },
        at: new Date().toISOString(),
      });
      return;
    }

    // Two converted tests can slug to the same file path (distinct requests with
    // near-identical names, or the model reusing a path across source files).
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
              `Converted from ${FRAMEWORK_LABELS[framework] ?? framework} — review before trusting`,
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

    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { state: 'DONE', summary, convertedCount: converted.length },
    });

    emit(`Done — ${converted.length} test(s) added to the Imported suite.`);
    publishEvent(orgId, {
      runId: `import:${importBatchId}`,
      type: 'run.finished',
      data: { convertedCount: converted.length, framework },
      at: new Date().toISOString(),
    });

    logger.info({ importBatchId, converted: converted.length, framework }, 'import complete');
  } catch (err) {
    // Distinguish "the key is missing/rejected" from a genuine conversion
    // problem — the fix differs, and the earlier code buried the AUTH cause
    // under a generic "nothing converted" message.
    const isAuth = err instanceof Error && /API key|ANTHROPIC_API_KEY/i.test(err.message);
    const message = isAuth
      ? 'Conversion needs a working ANTHROPIC_API_KEY. Postman collections import without one.'
      : err instanceof Error
        ? err.message
        : String(err);

    await prisma.importBatch.update({
      where: { id: batch.id },
      // Keep the per-file summary too, so the honest detail survives a failure
      // rather than being replaced by the headline error.
      data: { state: 'ERRORED', error: message, summary: summary || null },
    });
    emit(`Import failed: ${message}`);
    logger.error({ err, importBatchId }, 'import failed');
    throw err;
  }
}
