import { describe, expect, it } from 'vitest';
import { createJobId, isJobId } from '../src/ids.js';

describe('job IDs', () => {
  it('creates sandboxd-prefixed UUIDv7 job IDs', () => {
    const jobId = createJobId();
    expect(jobId.startsWith('sandboxd_')).toBe(true);
    expect(isJobId(jobId)).toBe(true);
  });
});
