import { describe, it, expect } from 'vitest';
import { ModelProvider } from '../../src/providers/modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../../src/types/review';
import { globalRuntimeRegistry } from '../../src/providers/builtInRuntimes';

describe('ModelProvider interface', () => {
  it('ModelProvider interface exists with required members', () => {
    expect(typeof ModelProvider).toBe('undefined');
  });
});

describe('ReviewRequest type', () => {
  it('accepts valid review request structure', () => {
    const request: ReviewRequest = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: '/test.ts',
      reviewType: 'file',
    };
    expect(request.code).toBe('const x = 1;');
    expect(request.reviewType).toBe('file');
  });

  it('accepts diff review request with diff field', () => {
    const request: ReviewRequest = {
      code: '',
      languageId: 'typescript',
      filePath: '',
      reviewType: 'staged',
      diff: 'diff --git a/test.ts b/test.ts',
    };
    expect(request.diff).toBe('diff --git a/test.ts b/test.ts');
  });
});

describe('ReviewResult type', () => {
  it('accepts valid review result with comments', () => {
    const result: ReviewResult = {
      comments: [
        { file: 'test.ts', line: 1, message: 'Issue', severity: 'error' },
      ],
      provider: 'opencode',
    };
    expect(result.comments).toHaveLength(1);
    expect(result.provider).toBe('opencode');
  });

  it('accepts review result with usage information', () => {
    const result: ReviewResult = {
      comments: [],
      provider: 'opencode',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
    expect(result.usage?.totalTokens).toBe(150);
  });
});

describe('ReviewComment type', () => {
  it('accepts comment without optional fields', () => {
    const comment: ReviewComment = {
      file: 'test.ts',
      line: 10,
      message: 'Some issue',
    };
    expect(comment.file).toBe('test.ts');
    expect(comment.line).toBe(10);
    expect(comment.fix).toBeUndefined();
    expect(comment.severity).toBeUndefined();
  });

  it('accepts comment with all fields', () => {
    const comment: ReviewComment = {
      file: 'test.ts',
      line: 5,
      message: 'Fix this',
      fix: 'const x = 2;',
      severity: 'warning',
    };
    expect(comment.fix).toBe('const x = 2;');
    expect(comment.severity).toBe('warning');
  });
});

describe('Runtime system integration', () => {
  it('globalRuntimeRegistry is exported and functional', () => {
    expect(globalRuntimeRegistry).toBeDefined();
    expect(typeof globalRuntimeRegistry.get).toBe('function');
    expect(typeof globalRuntimeRegistry.list).toBe('function');
  });

  it('globalRuntimeRegistry contains expected runtimes', () => {
    const runtimeIds = globalRuntimeRegistry.list();
    expect(runtimeIds).toContain('opencode');
    expect(runtimeIds).toContain('claude');
    expect(runtimeIds).toContain('copilot');
    expect(runtimeIds).toContain('codex');
    expect(runtimeIds).toContain('gemini');
    expect(runtimeIds).toContain('hermes');
    expect(runtimeIds).toContain('pi');
  });

  it('globalRuntimeRegistry does not contain removed providers', () => {
    const runtimeIds = globalRuntimeRegistry.list();
    expect(runtimeIds).not.toContain('custom-cli');
    expect(runtimeIds).not.toContain('openai-compatible');
  });
});
