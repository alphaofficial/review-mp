import { describe, it, expect, vi } from 'vitest';
import { ReviewHarness, DefaultIterationStrategy, createReviewHarness, IterationStrategy } from '../../src/harness/reviewHarness';
import { ModelProvider, ProviderConfig } from '../../src/providers/modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../../src/types/review';
import { CommentValidator } from '../../src/harness/commentValidator';
import { OutputParser } from '../../src/harness/outputParser';
import * as diagnostics from '../../src/harness/diagnostics';

const createMockWorkspaceFolder = (): any => {
  return { fsPath: '/Users/testuser/project' };
};

const createMockProvider = (results: ReviewResult[]): ModelProvider => {
  let callCount = 0;
  return {
    name: 'mock',
    review: vi.fn().mockImplementation(async () => {
      return results[callCount++] || { comments: [], provider: 'mock' };
    }),
    cancel: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    applyFix: vi.fn(),
  };
};

const createMockValidator = (): CommentValidator => {
  return new CommentValidator({
    workspaceRoot: createMockWorkspaceFolder(),
  });
};

const createMockParser = (): OutputParser => {
  return new OutputParser({
    defaultFilePath: '/Users/testuser/project/src/test.ts',
  });
};

const createFileRequest = (): ReviewRequest => ({
  code: 'const x = 1;',
  languageId: 'typescript',
  filePath: '/Users/testuser/project/src/test.ts',
  reviewType: 'file',
});

describe('ReviewHarness', () => {
  describe('runReview', () => {
    it('should return comments and stop when no new findings in second iteration', async () => {
      const mockProvider = createMockProvider([
        {
          comments: [
            { file: 'src/test.ts', line: 1, message: 'Error 1', severity: 'error' },
            { file: 'src/test.ts', line: 2, message: 'Error 2', severity: 'warning' },
          ],
          provider: 'mock',
        },
        { comments: [], provider: 'mock' },
        { comments: [], provider: 'mock' },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(2);
      expect(result.allComments).toHaveLength(2);
      expect(result.converged).toBe(true);
    });

    it('should run multiple iterations until max iterations', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            comments: [{ file: 'src/test.ts', line: callCount, message: `Error ${callCount}` }],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.5),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(3);
      expect(mockProvider.review).toHaveBeenCalledTimes(3);
    });

    it('should converge when new comments ratio is below threshold', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              comments: [
                { file: 'src/test.ts', line: 1, message: 'Error 1' },
                { file: 'src/test.ts', line: 2, message: 'Error 2' },
                { file: 'src/test.ts', line: 3, message: 'Error 3' },
              ],
              provider: 'mock',
            };
          }
          return {
            comments: [
              { file: 'src/test.ts', line: 1, message: 'Error 1' },
              { file: 'src/test.ts', line: 2, message: 'Error 2' },
              { file: 'src/test.ts', line: 3, message: 'Error 3' },
              { file: 'src/test.ts', line: 4, message: 'New Error' },
            ],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.5),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(2);
      expect(result.converged).toBe(true);
      expect(result.allComments).toHaveLength(4);
    });

    it('should deduplicate comments across iterations', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            comments: [
              { file: 'src/test.ts', line: callCount, message: `Error ${callCount}A` },
              { file: 'src/test.ts', line: callCount + 10, message: `Error ${callCount}B` },
            ],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(3);
      const uniqueMessages = new Set(result.allComments.map(c => c.message));
      expect(uniqueMessages.size).toBe(6);
    });

    it('should stop early when no comments found in first iteration', async () => {
      const mockProvider = createMockProvider([
        { comments: [], provider: 'mock' },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(1);
      expect(result.allComments).toHaveLength(0);
      expect(result.converged).toBe(false);
    });

    it('should handle provider errors gracefully', async () => {
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockRejectedValue(new Error('Provider failed')),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(2, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(2);
      expect(result.finalErrors.length).toBeGreaterThan(0);
      expect(result.finalErrors[0]).toContain('Provider failed');
    });

    it('should track new comments per iteration', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            comments: [
              { file: 'src/test.ts', line: callCount, message: `Error ${callCount}` },
            ],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.iterations[0].newComments).toHaveLength(1);
      expect(result.iterations[1].newComments).toHaveLength(1);
      expect(result.iterations[2].newComments).toHaveLength(1);
    });
  });

  describe('cancel', () => {
    it('should call provider cancel', async () => {
      const mockProvider = createMockProvider([
        { comments: [], provider: 'mock' },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      harness.cancel();

      expect(mockProvider.cancel).toHaveBeenCalled();
    });
  });
});

describe('DefaultIterationStrategy', () => {
  it('should use default values', () => {
    const strategy = new DefaultIterationStrategy();

    expect(strategy.maxIterations).toBe(3);
    expect(strategy.convergenceThreshold).toBe(0.1);
    expect(strategy.retryOnInvalidOutput).toBe(true);
  });

  it('should accept custom values', () => {
    const strategy = new DefaultIterationStrategy(5, 0.2);

    expect(strategy.maxIterations).toBe(5);
    expect(strategy.convergenceThreshold).toBe(0.2);
  });

  it('should accept retryOnInvalidOutput option', () => {
    const strategy = new DefaultIterationStrategy(3, 0.1, false);

    expect(strategy.retryOnInvalidOutput).toBe(false);
  });
});

describe('createReviewHarness', () => {
  it('should create harness with default strategy', () => {
    const mockProvider = createMockProvider([{ comments: [], provider: 'mock' }]);

    const harness = createReviewHarness(
      mockProvider,
      createMockValidator(),
      createMockParser(),
      '/Users/testuser/project'
    );

    expect(harness).toBeInstanceOf(ReviewHarness);
  });

  it('should create harness with custom strategy', () => {
    const mockProvider = createMockProvider([{ comments: [], provider: 'mock' }]);
    const customStrategy: IterationStrategy = { maxIterations: 5, convergenceThreshold: 0.2 };

    const harness = createReviewHarness(
      mockProvider,
      createMockValidator(),
      createMockParser(),
      '/Users/testuser/project',
      customStrategy
    );

    expect(harness).toBeInstanceOf(ReviewHarness);
  });
});

describe('Retry and Diagnostic Features', () => {
  describe('maxIterationsReached', () => {
    it('should set maxIterationsReached true when max iterations reached', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            comments: [{ file: 'src/test.ts', line: callCount, message: `Error ${callCount}` }],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.maxIterationsReached).toBe(true);
    });

    it('should set maxIterationsReached false when converged early', async () => {
      const mockProvider = createMockProvider([
        {
          comments: [
            { file: 'src/test.ts', line: 1, message: 'Error 1' },
          ],
          provider: 'mock',
        },
        { comments: [], provider: 'mock' },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.maxIterationsReached).toBe(false);
    });
  });

  describe('retryOnInvalidOutput', () => {
    it('should include retryPrompt when validation issues exist with retry enabled', async () => {
      const mockValidator: CommentValidator = {
        validate: vi.fn().mockReturnValue({
          validComments: [],
          issues: [{
            type: 'invalid_severity' as const,
            message: 'Invalid severity',
            originalComment: { file: 'src/test.ts', line: 1, message: 'Error 1' },
          }],
        }),
      } as any;

      const mockProvider = createMockProvider([
        {
          comments: [{ file: 'src/test.ts', line: 1, message: 'Error 1', severity: 'bad' as any }],
          provider: 'mock',
        },
        { comments: [], provider: 'mock' },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(2, 0.1, true),
        provider: mockProvider,
        validator: mockValidator,
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.iterations[0].retryPrompt).toBeDefined();
      expect(result.iterations[0].retryPrompt).toContain('Validation issues found');
    });

    it('should not retry when retryOnInvalidOutput is false', async () => {
      let callCount = 0;
      const mockProvider: ModelProvider = {
        name: 'mock',
        review: vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            comments: [{ file: 'src/test.ts', line: 1, message: `Error ${callCount}` }],
            provider: 'mock',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(3, 0.1, false),
        provider: mockProvider,
        validator: createMockValidator(),
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.totalIterations).toBe(3);
      expect(mockProvider.review).toHaveBeenCalledTimes(3);
    });
  });

  describe('validationIssues tracking', () => {
    it('should track validation issues in iteration result', async () => {
      const mockValidator: CommentValidator = {
        validate: vi.fn().mockReturnValue({
          validComments: [],
          issues: [{
            type: 'invalid_severity' as const,
            message: 'Invalid severity: bad-severity. Valid values are: error, warning, info, suggestion',
            originalComment: { file: 'src/test.ts', line: 1, message: 'Error 1' },
          }],
        }),
      } as any;

      const mockProvider = createMockProvider([
        {
          comments: [
            { file: 'src/test.ts', line: 1, message: 'Error 1', severity: 'bad-severity' as any },
          ],
          provider: 'mock',
        },
      ]);

      const harness = new ReviewHarness({
        strategy: new DefaultIterationStrategy(1, 0.1),
        provider: mockProvider,
        validator: mockValidator,
        parser: createMockParser(),
        workspaceRoot: '/Users/testuser/project',
      });

      const result = await harness.runReview(createFileRequest());

      expect(result.iterations[0].validationIssues.length).toBeGreaterThan(0);
      expect(result.iterations[0].validationIssues[0].type).toBe('invalid_severity');
    });
  });
});

describe('diagnostics module', () => {
  it('should set debug enabled', () => {
    diagnostics.setDebugEnabled(true);
    expect(diagnostics).toBeDefined();
  });

  it('should format validation issues', () => {
    const issues = [
      {
        type: 'invalid_file',
        message: 'Invalid file',
        originalComment: { file: 'test.ts', line: 1, message: 'Test' },
      },
    ];
    const formatted = diagnostics.formatValidationIssues(issues);
    expect(formatted).toHaveLength(1);
    expect(formatted[0].type).toBe('invalid_file');
    expect(formatted[0].affectedLine).toBe(1);
    expect(formatted[0].affectedFile).toBe('test.ts');
  });

  it('should sanitize sensitive data in logging', () => {
    const sensitiveData = {
      apiKey: 'secret-key-123',
      token: 'token-456',
      secret: 'secret-value',
      password: 'password-789',
      data: 'safe-data',
    };
    const sanitized = diagnostics.sanitizeForLogging(sensitiveData) as Record<string, unknown>;
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.secret).toBe('[REDACTED]');
    expect(sanitized.password).toBe('password-789');
    expect(sanitized.data).toBe('safe-data');
  });

  it('should truncate long strings in sanitization', () => {
    const longString = 'a'.repeat(600);
    const result = diagnostics.sanitizeForLogging(longString) as string;
    expect(result).toHaveLength(503);
    expect(result.endsWith('...')).toBe(true);
  });
});