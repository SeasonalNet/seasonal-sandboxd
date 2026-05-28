import { describe, expect, it } from 'vitest';
import { partitionForDate } from '../src/time.js';

describe('partitionForDate', () => {
  it('uses year and numeric month name', () => {
    expect(partitionForDate(new Date('2026-05-28T00:00:00Z'))).toEqual({ year: '2026', month: '05-May' });
  });
});
