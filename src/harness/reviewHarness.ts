import { CancellationToken } from 'vscode';
import { ModelProvider } from '../providers/modelProvider';
import { ReviewRequest, ReviewComment } from '../types/review';
import { CommentValidator } from './commentValidator';
import { OutputParser } from './outputParser';

export interface IterationStrategy {
  readonly maxIterations: number;
  readonly convergenceThreshold?: number;
}

export interface IterationResult {
  iteration: number;
  comments: ReviewComment[];
  newComments: ReviewComment[];
  converged: boolean;
  parseErrors: string[];
  providerErrors: string[];
}

export interface HarnessResult {
  allComments: ReviewComment[];
  iterations: IterationResult[];
  totalIterations: number;
  converged: boolean;
  finalErrors: string[];
}

export interface ReviewHarnessConfig {
  strategy: IterationStrategy;
  provider: ModelProvider;
  validator: CommentValidator;
  parser: OutputParser;
  workspaceRoot: string;
}

export class ReviewHarness {
  private config: ReviewHarnessConfig;

  constructor(config: ReviewHarnessConfig) {
    this.config = config;
  }

  async runReview(
    request: ReviewRequest,
    token?: CancellationToken
  ): Promise<HarnessResult> {
    const iterations: IterationResult[] = [];
    const allComments = new Map<string, ReviewComment>();
    let converged = false;
    const finalErrors: string[] = [];

    for (let iteration = 1; iteration <= this.config.strategy.maxIterations; iteration++) {
      if (token?.isCancellationRequested) {
        break;
      }

      const iterationResult = await this.runIteration(request, iteration, token);
      iterations.push(iterationResult);

      finalErrors.push(...iterationResult.parseErrors, ...iterationResult.providerErrors);

      const newComments = this.filterNewComments(iterationResult.comments, allComments);
      iterationResult.newComments = newComments;

      for (const comment of newComments) {
        const key = this.getCommentKey(comment);
        allComments.set(key, comment);
      }

      const hasProviderErrors = iterationResult.providerErrors.length > 0;

      if (iterationResult.comments.length === 0 && iteration === 1 && !hasProviderErrors) {
        break;
      }

      if (!hasProviderErrors && this.checkConvergence(iterationResult.newComments, iterations)) {
        converged = true;
        break;
      }

      if (iteration === this.config.strategy.maxIterations) {
        break;
      }
    }

    return {
      allComments: Array.from(allComments.values()),
      iterations,
      totalIterations: iterations.length,
      converged,
      finalErrors: [...new Set(finalErrors)],
    };
  }

  private async runIteration(
    request: ReviewRequest,
    iteration: number,
    token?: CancellationToken
  ): Promise<IterationResult> {
    const parseErrors: string[] = [];
    const providerErrors: string[] = [];
    let comments: ReviewComment[] = [];

    try {
      const result = await this.config.provider.review(request, token);

      if (result.comments && result.comments.length > 0) {
        const validationResult = this.config.validator.validate(result.comments, {
          filePath: request.filePath,
          startLine: request.startLine,
        });
        comments = validationResult.validComments;
        parseErrors.push(...validationResult.issues.map(i => i.message));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push(`Provider error on iteration ${iteration}: ${message}`);
    }

    return {
      iteration,
      comments,
      newComments: [],
      converged: false,
      parseErrors,
      providerErrors,
    };
  }

  private filterNewComments(
    comments: ReviewComment[],
    existingComments: Map<string, ReviewComment>
  ): ReviewComment[] {
    return comments.filter(comment => {
      const key = this.getCommentKey(comment);
      return !existingComments.has(key);
    });
  }

  private getCommentKey(comment: ReviewComment): string {
    return `${comment.file}:${comment.line}:${comment.message}`;
  }

  private checkConvergence(newComments: ReviewComment[], iterations: IterationResult[]): boolean {
    if (iterations.length <= 1) {
      return false;
    }

    if (newComments.length === 0) {
      return true;
    }

    const threshold = this.config.strategy.convergenceThreshold;
    if (threshold === undefined) {
      return false;
    }

    const totalCommentsSeen = iterations.reduce((sum, iter) => sum + iter.comments.length, 0);
    const previousTotal = totalCommentsSeen - newComments.length;

    if (previousTotal === 0) {
      return false;
    }

    const newCommentRatio = newComments.length / previousTotal;
    return newCommentRatio < threshold;
  }

  cancel(): void {
    this.config.provider.cancel();
  }
}

export class DefaultIterationStrategy implements IterationStrategy {
  constructor(
    public readonly maxIterations: number = 3,
    public readonly convergenceThreshold: number = 0.1
  ) {}
}

export function createReviewHarness(
  provider: ModelProvider,
  validator: CommentValidator,
  parser: OutputParser,
  workspaceRoot: string,
  strategy?: IterationStrategy
): ReviewHarness {
  return new ReviewHarness({
    strategy: strategy ?? new DefaultIterationStrategy(),
    provider,
    validator,
    parser,
    workspaceRoot,
  });
}