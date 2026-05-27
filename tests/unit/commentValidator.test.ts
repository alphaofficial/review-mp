import { describe, it, expect } from 'vitest';
import { CommentValidator, ValidationResult } from '../../src/harness/commentValidator';
import { ReviewComment, Severity } from '../../src/types/review';

const createMockWorkspaceFolder = (): any => {
  return { fsPath: '/Users/testuser/project' };
};

describe('CommentValidator', () => {
  describe('validate', () => {
    it('should pass through valid comments unchanged', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: 10, message: 'Test error', severity: 'error' },
        { file: 'src/test.ts', line: 20, message: 'Test warning', severity: 'warning' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(2);
      expect(result.issues).toHaveLength(0);
      expect(result.validComments[0].line).toBe(9);
      expect(result.validComments[1].line).toBe(19);
    });

    it('should filter out comments with invalid file paths', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
        validateFilePaths: true,
      });

      const comments: ReviewComment[] = [
        { file: '', line: 10, message: 'No file' },
        { file: 'src/test.ts', line: 20, message: 'Valid file' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(1);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('invalid_file');
      expect(result.validComments[0].message).toBe('Valid file');
    });

    it('should filter out comments with invalid line numbers', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: -1, message: 'Negative line' },
        { file: 'src/test.ts', line: 10, message: 'Valid line' },
        { file: 'src/test.ts', line: NaN, message: 'NaN line' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(1);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].type).toBe('invalid_line');
      expect(result.issues[1].type).toBe('invalid_line');
    });

    it('should report invalid severity but still include comment with normalized severity', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: 10, message: 'Invalid severity', severity: 'invalid' as Severity },
        { file: 'src/test.ts', line: 20, message: 'Valid severity', severity: 'error' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(2);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('invalid_severity');
      expect(result.validComments[0].severity).toBeUndefined();
      expect(result.validComments[1].severity).toBe('error');
    });

    it('should deduplicate comments with same file, line, and message', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
        deduplicate: true,
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: 10, message: 'Duplicate message' },
        { file: 'src/test.ts', line: 10, message: 'Duplicate message' },
        { file: 'src/test.ts', line: 10, message: 'Different message' },
        { file: 'src/test.ts', line: 20, message: 'Duplicate message' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(3);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('duplicate');
    });

    it('should normalize 1-based line numbers to 0-based', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
        normalizeLineNumbers: true,
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: 1, message: 'First line' },
        { file: 'src/test.ts', line: 5, message: 'Fifth line' },
        { file: 'src/test.ts', line: 0, message: 'Zero line' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments[0].line).toBe(0);
      expect(result.validComments[1].line).toBe(4);
      expect(result.validComments[2].line).toBe(0);
    });

    it('should not normalize line numbers when disabled', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
        normalizeLineNumbers: false,
      });

      const comments: ReviewComment[] = [
        { file: 'src/test.ts', line: 5, message: 'Fifth line' },
      ];

      const result = validator.validate(comments);

      expect(result.validComments[0].line).toBe(5);
    });

    it('should use context filePath when comment file is missing', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        { file: '', line: 10, message: 'Uses context file' },
      ];

      const result = validator.validate(comments, { filePath: 'src/context.ts' });

      expect(result.validComments).toHaveLength(1);
      expect(result.issues).toHaveLength(0);
    });

    it('should handle empty comments array', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const result = validator.validate([]);

      expect(result.validComments).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
    });

    it('should preserve fix and other optional properties', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        {
          file: 'src/test.ts',
          line: 10,
          message: 'Error with fix',
          fix: 'const x = 1;',
          severity: 'error',
        },
      ];

      const result = validator.validate(comments);

      expect(result.validComments[0].fix).toBe('const x = 1;');
      expect(result.validComments[0].severity).toBe('error');
    });

    it('should report multiple issues for a single invalid comment', () => {
      const validator = new CommentValidator({
        workspaceRoot: createMockWorkspaceFolder(),
      });

      const comments: ReviewComment[] = [
        { file: '', line: -1, message: 'Bad', severity: 'invalid' as Severity },
      ];

      const result = validator.validate(comments);

      expect(result.validComments).toHaveLength(0);
      expect(result.issues).toHaveLength(3);
      expect(result.issues.map(i => i.type)).toContain('invalid_file');
      expect(result.issues.map(i => i.type)).toContain('invalid_line');
      expect(result.issues.map(i => i.type)).toContain('invalid_severity');
    });
  });

  describe('isValidSeverity', () => {
    it('should return true for valid severities', () => {
      expect(CommentValidator.isValidSeverity('error')).toBe(true);
      expect(CommentValidator.isValidSeverity('warning')).toBe(true);
      expect(CommentValidator.isValidSeverity('info')).toBe(true);
      expect(CommentValidator.isValidSeverity('suggestion')).toBe(true);
    });

    it('should return false for invalid severities', () => {
      expect(CommentValidator.isValidSeverity('invalid')).toBe(false);
      expect(CommentValidator.isValidSeverity('')).toBe(false);
      expect(CommentValidator.isValidSeverity(undefined)).toBe(false);
      expect(CommentValidator.isValidSeverity(null)).toBe(false);
      expect(CommentValidator.isValidSeverity(123)).toBe(false);
    });
  });

  describe('normalizeLineNumber', () => {
    it('should convert 1-based to 0-based', () => {
      expect(CommentValidator.normalizeLineNumber(1, true)).toBe(0);
      expect(CommentValidator.normalizeLineNumber(10, true)).toBe(9);
    });

    it('should not convert when isOneBased is false', () => {
      expect(CommentValidator.normalizeLineNumber(1, false)).toBe(1);
      expect(CommentValidator.normalizeLineNumber(10, false)).toBe(10);
    });

    it('should handle zero correctly', () => {
      expect(CommentValidator.normalizeLineNumber(0, true)).toBe(0);
      expect(CommentValidator.normalizeLineNumber(0, false)).toBe(0);
    });
  });
});
