import { describe, it, expect } from 'vitest';

describe('ReviewComment validation', () => {
  interface ReviewComment {
    file: string;
    line: number;
    message: string;
    fix?: string;
    severity?: 'error' | 'warning' | 'info' | 'suggestion';
  }

  function validateSeverity(
    severity: unknown
  ): 'error' | 'warning' | 'info' | 'suggestion' | undefined {
    if (
      severity === 'error' ||
      severity === 'warning' ||
      severity === 'info' ||
      severity === 'suggestion'
    ) {
      return severity;
    }
    return undefined;
  }

  function validateComments(data: unknown, filePath: string): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item): item is Record<string, unknown> => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string'
        );
      })
      .map((item) => ({
        file: filePath,
        line: (item.line as number) - 1,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: validateSeverity(item.severity),
      }));
  }

  describe('validateSeverity', () => {
    it('returns valid severity strings unchanged', () => {
      expect(validateSeverity('error')).toBe('error');
      expect(validateSeverity('warning')).toBe('warning');
      expect(validateSeverity('info')).toBe('info');
      expect(validateSeverity('suggestion')).toBe('suggestion');
    });

    it('returns undefined for invalid severity values', () => {
      expect(validateSeverity('invalid')).toBeUndefined();
      expect(validateSeverity('')).toBeUndefined();
      expect(validateSeverity(null)).toBeUndefined();
      expect(validateSeverity(undefined)).toBeUndefined();
      expect(validateSeverity(123)).toBeUndefined();
    });
  });

  describe('validateComments', () => {
    it('returns empty array for non-array input', () => {
      expect(validateComments(null, 'test.ts')).toEqual([]);
      expect(validateComments({}, 'test.ts')).toEqual([]);
      expect(validateComments('string', 'test.ts')).toEqual([]);
    });

    it('filters out items without required fields', () => {
      const input = [
        { line: 1, message: 'Valid' },
        { line: 'not-a-number', message: 'Invalid line type' },
        { message: 'Missing line' },
        { line: 2, message: 123 },
        {},
        null,
      ];
      const result = validateComments(input, 'test.ts');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        file: 'test.ts',
        line: 0,
        message: 'Valid',
      });
    });

    it('converts line numbers from 1-based to 0-based', () => {
      const input = [{ line: 1, message: 'Line 1' }, { line: 5, message: 'Line 5' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].line).toBe(0);
      expect(result[1].line).toBe(4);
    });

    it('preserves optional fix field when present', () => {
      const input = [{ line: 1, message: 'Has fix', fix: 'code fix' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].fix).toBe('code fix');
    });

    it('omits fix field when missing or not a string', () => {
      const input = [
        { line: 1, message: 'No fix' },
        { line: 2, message: 'Fix is number', fix: 123 },
      ];
      const result = validateComments(input, 'test.ts');
      expect(result[0].fix).toBeUndefined();
      expect(result[1].fix).toBeUndefined();
    });

    it('validates and preserves severity', () => {
      const input = [
        { line: 1, message: 'Error', severity: 'error' },
        { line: 2, message: 'Warning', severity: 'warning' },
        { line: 3, message: 'Info', severity: 'info' },
        { line: 4, message: 'Suggestion', severity: 'suggestion' },
      ];
      const result = validateComments(input, 'test.ts');
      expect(result[0].severity).toBe('error');
      expect(result[1].severity).toBe('warning');
      expect(result[2].severity).toBe('info');
      expect(result[3].severity).toBe('suggestion');
    });

    it('omits invalid severity', () => {
      const input = [{ line: 1, message: 'Test', severity: 'invalid' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].severity).toBeUndefined();
    });
  });
});

describe('Diff output parsing', () => {
  function formatDiffWithLineNumbers(diffOutput: string): string {
    const lines = diffOutput.split('\n');
    const formattedLines: string[] = [];
    let currentLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('---') || line.startsWith('+++')) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('@@')) {
        formattedLines.push(line);
        inHunk = true;
        const match = line.match(/\+(\d+)/);
        if (match) {
          currentLineNum = parseInt(match[1], 10) - 1;
        }
        continue;
      }

      if (!inHunk) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentLineNum++;
        formattedLines.push(`${currentLineNum}: ${line.substring(1)}`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
      } else if (line.startsWith(' ')) {
        currentLineNum++;
      } else {
        formattedLines.push(line);
      }
    }

    return formattedLines.join('\n');
  }

  describe('formatDiffWithLineNumbers', () => {
    it('preserves diff headers', () => {
      const input = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts`;
      const result = formatDiffWithLineNumbers(input);
      expect(result).toContain('diff --git a/test.ts b/test.ts');
      expect(result).toContain('--- a/test.ts');
      expect(result).toContain('+++ b/test.ts');
    });

    it('extracts line numbers from hunk headers', () => {
      const input = `@@ -10,5 +15,7 @@ some context`;
      const result = formatDiffWithLineNumbers(input);
      expect(result).toContain('@@ -10,5 +15,7 @@ some context');
    });

    it('numbers added lines within hunks', () => {
      const input = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;
      const result = formatDiffWithLineNumbers(input);
      expect(result).toContain('2: added line');
    });

    it('skips removed lines', () => {
      const input = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
-deleted line
 line1
 line2`;
      const result = formatDiffWithLineNumbers(input);
      expect(result).not.toContain('deleted line');
    });

    it('skips context lines and removed lines but numbers added lines', () => {
      const input = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-old
+new`;
      const result = formatDiffWithLineNumbers(input);
      expect(result).not.toContain('old');
      expect(result).toContain('1: new');
    });
  });
});
