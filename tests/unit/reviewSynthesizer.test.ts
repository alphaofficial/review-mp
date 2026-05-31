import { describe, expect, it } from 'vitest';
import { synthesizeReviewComments } from '../../src/harness/reviewSynthesizer';

describe('synthesizeReviewComments', () => {
  it('deduplicates repeated findings across overlapping review scopes', () => {
    const result = synthesizeReviewComments([
      [{ file: 'src/a.ts', line: 10, message: 'same issue', severity: 'warning' }],
      [{ file: 'src/a.ts', line: 10, message: 'same issue', severity: 'error' }],
      [{ file: 'src/b.ts', line: 4, message: 'different issue', severity: 'info' }],
      [{ file: 'src/c.ts', line: -1, message: 'invalid issue', severity: 'error' }],
    ]);

    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { file: 'src/a.ts', line: 10, message: 'same issue', severity: 'error' },
      { file: 'src/b.ts', line: 4, message: 'different issue', severity: 'info' },
    ]);
  });
});
