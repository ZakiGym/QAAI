/** Split out to keep `jobs.ts` free of a cycle back into `types.ts`. */
export type RunTrigger = 'MANUAL' | 'SCHEDULE' | 'CI' | 'WEBHOOK' | 'MONITOR';
