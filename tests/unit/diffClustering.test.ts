import { describe, it, expect } from 'vitest';
import {
  parseDiffIntoFiles,
  countDiffLines,
  extractImportsFromDiff,
  buildImportGraph,
  clusterFilesBFS,
  buildClusterDiff,
  clusterDiff,
  deduplicateComments,
  FileDiff,
  DiffResult,
  classifyDiffFile,
  isReviewableDiffFile,
} from '../../src/harness/diffClustering';

describe('diffClustering', () => {
  const sampleDiff = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3
diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,2 +1,3 @@
 line1
+another added line`;

  describe('parseDiffIntoFiles', () => {
    it('should parse diff into file objects', () => {
      const files = parseDiffIntoFiles(sampleDiff);

      expect(files).toHaveLength(2);
      expect(files[0].filePath).toBe('src/file1.ts');
      expect(files[1].filePath).toBe('src/file2.ts');
      expect(files.every((file) => file.reviewability === 'reviewable')).toBe(true);
    });

    it('should extract hunks from diff', () => {
      const files = parseDiffIntoFiles(sampleDiff);

      expect(files[0].hunks).toHaveLength(1);
      expect(files[0].hunks[0].newStart).toBe(1);
    });

    it('should handle empty diff', () => {
      const files = parseDiffIntoFiles('');

      expect(files).toHaveLength(0);
    });

    it('should handle diff with multiple hunks', () => {
      const multiHunkDiff = `diff --git a/src/multi.ts b/src/multi.ts
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,2 +1,3 @@
 line1
+first hunk
@@ -10,2 +11,3 @@
 line10
+second hunk`;

      const files = parseDiffIntoFiles(multiHunkDiff);

      expect(files).toHaveLength(1);
      expect(files[0].hunks).toHaveLength(2);
    });
  });

  describe('countDiffLines', () => {
    it('should count added lines correctly', () => {
      const files = parseDiffIntoFiles(sampleDiff);
      const count = countDiffLines(files);

      expect(count).toBe(2);
    });

    it('should return 0 for empty diff', () => {
      const files = parseDiffIntoFiles('');
      const count = countDiffLines(files);

      expect(count).toBe(0);
    });
  });

  describe('extractImportsFromDiff', () => {
    it('should extract TypeScript imports', () => {
      const fileDiff: FileDiff = {
        filePath: 'src/test.ts',
        hunks: [{
          startLine: 1,
          lines: [
            "import { foo } from './foo';",
            "import bar from './bar';",
            "const x = 1;",
          ],
          newStart: 1,
          newCount: 3,
        }],
        rawDiff: '',
        reviewability: 'reviewable',
      };

      const imports = extractImportsFromDiff(fileDiff);

      expect(imports).toContain('./foo');
      expect(imports).toContain('./bar');
    });
  });

  describe('buildImportGraph', () => {
    it('should build import graph between files', () => {
      const files: FileDiff[] = [
        {
          filePath: 'src/a.ts',
          hunks: [],
          rawDiff: '',
          reviewability: 'reviewable',
        },
        {
          filePath: 'src/b.ts',
          hunks: [],
          rawDiff: '',
          reviewability: 'reviewable',
        },
      ];

      const graph = buildImportGraph(files);

      expect(graph.has('src/a.ts')).toBe(true);
      expect(graph.has('src/b.ts')).toBe(true);
    });
  });

  describe('clusterFilesBFS', () => {
    it('should cluster related files together', () => {
      const files: FileDiff[] = [
        { filePath: 'a.ts', hunks: [], rawDiff: '', reviewability: 'reviewable' },
        { filePath: 'b.ts', hunks: [], rawDiff: '', reviewability: 'reviewable' },
        { filePath: 'c.ts', hunks: [], rawDiff: '', reviewability: 'reviewable' },
      ];

      const graph = new Map<string, Set<string>>();
      graph.set('a.ts', new Set(['b.ts']));
      graph.set('b.ts', new Set(['a.ts', 'c.ts']));
      graph.set('c.ts', new Set(['b.ts']));

      const clusters = clusterFilesBFS(files, graph);

      expect(clusters.length).toBeGreaterThan(0);
    });

    it('should respect max cluster size', () => {
      const files: FileDiff[] = Array.from({ length: 15 }, (_, i) => ({
        filePath: `file${i}.ts`,
        hunks: [],
        rawDiff: '',
        reviewability: 'reviewable',
      }));

      const graph = new Map<string, Set<string>>();
      files.forEach((f) => graph.set(f.filePath, new Set()));

      const clusters = clusterFilesBFS(files, graph, 5);

      for (const cluster of clusters) {
        expect(cluster.files.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('buildClusterDiff', () => {
    it('should build diff content for cluster', () => {
      const cluster = { id: 0, files: ['a.ts', 'b.ts'], totalLines: 0, diffContent: '' };
      const fileDiffs: FileDiff[] = [
        { filePath: 'a.ts', hunks: [], rawDiff: 'diff for a', reviewability: 'reviewable' },
        { filePath: 'b.ts', hunks: [], rawDiff: 'diff for b', reviewability: 'reviewable' },
        { filePath: 'c.ts', hunks: [], rawDiff: 'diff for c', reviewability: 'reviewable' },
      ];

      const result = buildClusterDiff(cluster, fileDiffs);

      expect(result.diffContent).toContain('diff for a');
      expect(result.diffContent).toContain('diff for b');
      expect(result.diffContent).not.toContain('diff for c');
    });
  });

  describe('clusterDiff', () => {
    it('should use fast path for small PRs', () => {
      const diffResult: DiffResult = {
        diff: sampleDiff,
        formattedDiff: sampleDiff,
      };

      const result = clusterDiff(diffResult);

      expect(result.usedFastPath).toBe(true);
      expect(result.clusters).toHaveLength(1);
    });

    it('should cluster large PRs', () => {
      const largeDiff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 line1
+added`;

      const diffResult: DiffResult = {
        diff: largeDiff,
        formattedDiff: largeDiff,
      };

      const result = clusterDiff(diffResult);

      expect(result.totalFiles).toBe(1);
    });
  });

  describe('deduplicateComments', () => {
    it('should deduplicate comments based on file, line, and message', () => {
      const comments = [
        { file: 'a.ts', line: 1, message: 'msg1' },
        { file: 'a.ts', line: 1, message: 'msg1' },
        { file: 'a.ts', line: 2, message: 'msg1' },
      ];

      const result = deduplicateComments(comments);

      expect(result).toHaveLength(2);
    });

    it('should preserve non-duplicate comments', () => {
      const comments = [
        { file: 'a.ts', line: 1, message: 'msg1' },
        { file: 'b.ts', line: 1, message: 'msg1' },
      ];

      const result = deduplicateComments(comments);

      expect(result).toHaveLength(2);
    });
  });

  describe('reviewability classification', () => {
    it('classifies svg files as non-reviewable', () => {
      const classification = classifyDiffFile('assets/logo.svg', 'diff --git a/assets/logo.svg b/assets/logo.svg');

      expect(classification.reviewability).toBe('non-code');
      expect(classification.skipReason).toContain('non-code');
    });

    it('classifies dependency lockfiles as non-reviewable', () => {
      const classification = classifyDiffFile('package-lock.json', 'diff --git a/package-lock.json b/package-lock.json');

      expect(classification.reviewability).toBe('dependency-lockfile');
      expect(classification.skipReason).toBe('dependency lockfile');
    });

    it('keeps source files reviewable', () => {
      const files = parseDiffIntoFiles(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const value = true;`);

      expect(isReviewableDiffFile(files[0])).toBe(true);
    });
  });
});
