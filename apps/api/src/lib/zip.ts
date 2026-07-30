/**
 * Zip a materialised repo for download.
 *
 * The credential-free half of "your tests are yours": no integration, no token,
 * no network write — just the same tree the git push would send, as a file you
 * own. Deterministic timestamps so re-exporting an unchanged project produces an
 * identical archive.
 */

import JSZip from 'jszip';
import type { RepoTree } from './repo-export.js';

/** A fixed date keeps the archive byte-stable across exports of the same tree. */
const EPOCH = new Date('2020-01-01T00:00:00Z');

export async function zipTree(tree: RepoTree): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of tree) {
    zip.file(path, content, { date: EPOCH });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
