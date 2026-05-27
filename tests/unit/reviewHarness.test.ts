import { describe, it, expect, vi } from 'vitest';
import { ReviewHarness, DefaultIterationStrategy, createReviewHarness, IterationStrategy } from '../../src/harness/reviewHarness';
import { ModelProvider, ProviderConfig } from '../../src/providers/modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../../src/types/review';
import { CommentValidator } from '../../src/harness/commentValidator';
import { OutputParser } from '../../src/harness/outputParser';

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
  });

  it('should accept custom values', () => {
    const strategy = new DefaultIterationStrategy(5, 0.2);

    expect(strategy.maxIterations).toBe(5);
    expect(strategy.convergenceThreshold).toBe(0.2);
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