import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { FixApplicator } from '../../src/harness/fixApplicator';

vi.mock('vscode', () => ({
  workspace: {
    openTextDocument: vi.fn(),
    applyEdit: vi.fn(),
  },
  Range: vi.fn().mockImplementation(function (startLine: number, startChar: number, endLine: number, endChar: number) {
    return { startLine, startChar, endLine, endChar };
  }),
  WorkspaceEdit: vi.fn().mockImplementation(function () {
    return {
    replace: vi.fn(),
    };
  }),
  Uri: {
    file: vi.fn(),
  },
}));

describe('FixApplicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.Uri.file as any).mockImplementation((path: string) => ({ fsPath: path }));
    (vscode.workspace.openTextDocument as any).mockRejectedValue(new Error('File not found'));
    (vscode.workspace.applyEdit as any).mockResolvedValue(true);
  });

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

    it('should replace the full nearby statement for multi-line fixes', async () => {
      const applicator = new FixApplicator();
      const lines = [
        'if (status === "ACTIVE") {',
        '  // ensure ONLINE payment method is enabled',
        '  paymentSettings.paymentMethods = [',
        '    ...paymentSettings.paymentMethods,',
        '    "ONLINE",',
        '  ];',
        '}',
      ];
      (vscode.workspace.openTextDocument as any).mockResolvedValue({
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] }),
      });

      const fix = `paymentSettings.paymentMethods = [
  ...(paymentSettings.paymentMethods ?? []),
  "ONLINE",
];`;

      const result = await applicator.applyFix('/path/to/file.ts', 1, fix);

      expect(result.success).toBe(true);
      expect(vscode.Range).toHaveBeenCalledWith(2, 0, 5, 4);
      const range = (vscode.Range as any).mock.results[0].value;
      const edit = (vscode.WorkspaceEdit as any).mock.results[0].value;
      expect(edit.replace).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/path/to/file.ts' }),
        range,
        `  paymentSettings.paymentMethods = [
    ...(paymentSettings.paymentMethods ?? []),
    "ONLINE",
  ];`
      );
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
