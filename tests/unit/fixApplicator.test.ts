import { describe, it, expect, vi } from 'vitest';
import { FixApplicator } from '../../src/harness/fixApplicator';

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: vi.fn(),
    applyEdit: vi.fn(),
  },
  Range: vi.fn(),
  WorkspaceEdit: vi.fn().mockImplementation(() => ({
    replace: vi.fn(),
  })),
  Uri: {
    file: vi.fn(),
  },
}));

describe('FixApplicator', () => {
  describe('validateFix', () => {
    it('should return valid for correct inputs', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('/path/to/file.ts', 10, 'const x = 1;');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject empty file path', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('', 10, 'const x = 1;');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File path is required');
    });

    it('should reject whitespace-only file path', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('   ', 10, 'const x = 1;');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File path is required');
    });

    it('should reject negative line numbers', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('/path/to/file.ts', -1, 'const x = 1;');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Line number must be non-negative');
    });

    it('should reject empty fix content', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('/path/to/file.ts', 10, '');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Fix content is empty or invalid');
    });

    it('should reject whitespace-only fix content', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('/path/to/file.ts', 10, '   ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Fix content is empty or invalid');
    });

    it('should accept multi-line fix content', async () => {
      const applicator = new FixApplicator();
      const multiLineFix = `if (condition) {
  doSomething();
}`;
      const result = await applicator.validateFix('/path/to/file.ts', 10, multiLineFix);
      expect(result.valid).toBe(true);
    });

    it('should accept zero line number', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.validateFix('/path/to/file.ts', 0, 'const x = 1;');
      expect(result.valid).toBe(true);
    });
  });

  describe('applyFix', () => {
    it('should return error for invalid file path', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.applyFix('', 10, 'const x = 1;');
      expect(result.success).toBe(false);
      expect(result.error).toBe('File path is required');
    });

    it('should return error for invalid line number', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.applyFix('/path/to/file.ts', -1, 'const x = 1;');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Line number must be non-negative');
    });

    it('should return error for empty fix content', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.applyFix('/path/to/file.ts', 10, '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Fix content is empty or invalid');
    });
  });

  describe('getTargetLineContent', () => {
    it('should return undefined for non-existent file', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.getTargetLineContent('/nonexistent/path/file.ts', 0);
      expect(result).toBeUndefined();
    });

    it('should return undefined for invalid line number', async () => {
      const applicator = new FixApplicator();
      const result = await applicator.getTargetLineContent('/nonexistent/path/file.ts', -1);
      expect(result).toBeUndefined();
    });
  });
});
