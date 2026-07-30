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

    if (converted.length === 0) {
      throw new Error('Nothing was converted — check the framework detection and the files');
    }

    // One suite for the whole migration, so the coverage gained is legible.
    const suite = await prisma.suite.upsert({
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
      await prisma.test.create({
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
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { state: 'ERRORED', error: message },
    });
    emit(`Import failed: ${message}`);
    logger.error({ err, importBatchId }, 'import failed');
    throw err;
  }
}
