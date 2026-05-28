import { describe, it, expect } from 'vitest';
import {
  buildCrossFileContext,
  buildCrossFilePrompt,
  checkCrossFileConsistency,
  formatCrossFileReviewSummary,
  ConsistencyCheckInput,
} from '../../src/harness/crossFileConsistencyPass';
import { ReviewComment } from '../../src/types/review';

describe('crossFileConsistencyPass', () => {
  const sampleDiffOutput = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,2 +1,3 @@
 line1
+another added line`;

  const existingComments: ReviewComment[] = [
    { file: 'src/file1.ts', line: 1, message: 'Issue 1', severity: 'warning' },
  ];

  describe('buildCrossFileContext', () => {
    it('should build context with file headers', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments,
      };

      const context = buildCrossFileContext(input);

      expect(context).toContain('Files Changed');
      expect(context).toContain('src/file1.ts');
      expect(context).toContain('src/file2.ts');
    });

    it('should include existing comments in context', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments,
      };

      const context = buildCrossFileContext(input);

      expect(context).toContain('Initial Review Comments');
      expect(context).toContain('Issue 1');
    });

    it('should handle empty existing comments', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments: [],
      };

      const context = buildCrossFileContext(input);

      expect(context).toContain('No initial comments');
    });
  });

  describe('buildCrossFilePrompt', () => {
    it('should include cross-file consistency guidance', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments,
      };

      const prompt = buildCrossFilePrompt(input);

      expect(prompt).toContain('Cross-File Consistency Check');
      expect(prompt).toContain('JSON array');
    });
  });

  describe('checkCrossFileConsistency', () => {
    it('should deduplicate cross-file comments with existing comments', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments,
      };

      const crossFileComments: ReviewComment[] = [
        { file: 'src/file1.ts', line: 1, message: 'Issue 1', severity: 'warning' },
        { file: 'src/file3.ts', line: 5, message: 'Cross-file issue', severity: 'error' },
      ];

      const result = checkCrossFileConsistency(input, crossFileComments);

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].file).toBe('src/file3.ts');
    });

    it('should return empty array when no new issues found', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments,
      };

      const crossFileComments: ReviewComment[] = [
        { file: 'src/file1.ts', line: 1, message: 'Issue 1', severity: 'warning' },
      ];

      const result = checkCrossFileConsistency(input, crossFileComments);

      expect(result.comments).toHaveLength(0);
      expect(result.issuesFound).toBe(0);
    });

    it('should count issues correctly', () => {
      const input: ConsistencyCheckInput = {
        diffOutput: sampleDiffOutput,
        existingComments: [],
      };

      const crossFileComments: ReviewComment[] = [
        { file: 'src/file1.ts', line: 1, message: 'Issue 1' },
        { file: 'src/file2.ts', line: 2, message: 'Issue 2' },
      ];

      const result = checkCrossFileConsistency(input, crossFileComments);

      expect(result.issuesFound).toBe(2);
      expect(result.comments).toHaveLength(2);
    });
  });

  describe('formatCrossFileReviewSummary', () => {
    it('should format summary with cluster results', () => {
      const clusterResults = [
        { clusterId: 0, comments: [{ file: 'a.ts', line: 1, message: 'msg' }], files: ['a.ts', 'b.ts'] },
        { clusterId: 1, comments: [], files: ['c.ts'] },
      ];

      const crossFileResult = { comments: [], issuesFound: 2 };

      const summary = formatCrossFileReviewSummary(clusterResults, crossFileResult);

      expect(summary).toContain('PR Review Summary');
      expect(summary).toContain('Cluster 0');
      expect(summary).toContain('Cross-file consistency: 2 issues');
    });
  });
});
