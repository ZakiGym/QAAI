/**
 * The API's artifact storage handle. The worker builds its own from the same
 * env; this one exists so the read endpoint can serve or sign a key.
 */

import { createStorage, defaultLocalArtifactRoot } from '@qaai/storage';
import { env } from './../env.js';

export const storage = createStorage({
  backend: env.ARTIFACTS_LOCAL ? 'local' : 's3',
  bucket: env.S3_BUCKET,
  rootDir: defaultLocalArtifactRoot(),
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  localPublicBaseUrl: env.API_PUBLIC_URL,
});
