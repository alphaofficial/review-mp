import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry';
import { ModelProvider, DEFAULT_OPENCODE_PROVIDER_NAME } from '../../src/providers/modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../../src/types/review';

class MockProvider implements ModelProvider {
  readonly name: string;
  private available: boolean;
  private reviewResult: ReviewResult;
  private shouldFail = false;

  constructor(
    name: string,
    available = true,
    reviewResult: ReviewResult = { comments: [], provider: name }
  ) {
    this.name = name;
    this.available = available;
    this.reviewResult = reviewResult;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  async review(): Promise<ReviewResult> {
    if (this.shouldFail) {
      throw new Error('Mock provider error');
    }
    return this.reviewResult;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  cancel(): void {}
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register', () => {
    it('registers a provider with its name as key', () => {
      const provider = new MockProvider('test');
      registry.register(provider);
      expect(registry.get('test')).toBe(provider);
    });

    it('overwrites existing provider with same name', () => {
      const provider1 = new MockProvider('test', true, { comments: [], provider: 'test' });
      const provider2 = new MockProvider('test', true, { comments: [{ file: 'a.ts', line: 1, message: 'issue' }], provider: 'test' });
      registry.register(provider1);
      registry.register(provider2);
      expect(registry.get('test')).toBe(provider2);
    });
  });

  describe('get', () => {
    it('returns registered provider by name', () => {
      const provider = new MockProvider('myprovider');
      registry.register(provider);
      expect(registry.get('myprovider')).toBe(provider);
    });

    it('returns undefined for unregistered provider', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getDefault', () => {
    it('returns the default opencode provider when registered', () => {
      const opencodeProvider = new MockProvider(DEFAULT_OPENCODE_PROVIDER_NAME);
      registry.register(opencodeProvider);
      expect(registry.getDefault()).toBe(opencodeProvider);
    });

    it('returns undefined when no providers registered', () => {
      expect(registry.getDefault()).toBeUndefined();
    });
  });

  describe('setDefault', () => {
    it('sets the default provider by name', () => {
      const provider = new MockProvider('custom');
      registry.register(provider);
      const result = registry.setDefault('custom');
      expect(result).toBe(true);
      expect(registry.getDefault()).toBe(provider);
    });

    it('returns false if provider does not exist', () => {
      const result = registry.setDefault('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('returns array of registered provider names', () => {
      registry.register(new MockProvider('provider1'));
      registry.register(new MockProvider('provider2'));
      const names = registry.list();
      expect(names).toContain('provider1');
      expect(names).toContain('provider2');
      expect(names).toHaveLength(2);
    });

    it('returns empty array when no providers registered', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('isRegistered', () => {
    it('returns true for registered provider', () => {
      registry.register(new MockProvider('exists'));
      expect(registry.isRegistered('exists')).toBe(true);
    });

    it('returns false for unregistered provider', () => {
      expect(registry.isRegistered('notexists')).toBe(false);
    });
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