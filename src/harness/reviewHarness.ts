import { CancellationToken } from 'vscode';
import { ModelProvider } from '../providers/modelProvider';
import { ReviewRequest, ReviewComment } from '../types/review';
import { CommentValidator, ValidationIssue } from './commentValidator';
import { OutputParser } from './outputParser';
import {
  logProviderError,
  logIterationStart,
  logIterationComplete,
  logMaxIterationsReached,
  logRetryPrompt,
  logConvergenceDetected,
  logCancellation,
  logValidatorIssue,
  formatValidationIssues,
  DiagnosticContext,
} from './diagnostics';

export interface IterationStrategy {
  readonly maxIterations: number;
  readonly convergenceThreshold?: number;
  readonly retryOnInvalidOutput?: boolean;
}

export interface IterationResult {
  iteration: number;
  comments: ReviewComment[];
  newComments: ReviewComment[];
  converged: boolean;
  parseErrors: string[];
  providerErrors: string[];
  validationIssues: ValidationIssue[];
  retryPrompt?: string;
}

export interface HarnessResult {
  allComments: ReviewComment[];
  iterations: IterationResult[];
  totalIterations: number;
  converged: boolean;
  finalErrors: string[];
  maxIterationsReached: boolean;
}

export interface ReviewHarnessConfig {
  strategy: IterationStrategy;
  provider: ModelProvider;
  validator: CommentValidator;
  parser: OutputParser;
  workspaceRoot: string;
}

export interface RetryContext {
  parseErrors?: string[];
  validationIssues?: ValidationIssue[];
  rawOutput?: string;
}

export class ReviewHarness {
  private config: ReviewHarnessConfig;
  private lastRetryContext?: RetryContext;

  constructor(config: ReviewHarnessConfig) {
    this.config = config;
  }

  private getDiagnosticContext(request: ReviewRequest, iteration?: number): DiagnosticContext {
    return {
      iteration,
      reviewType: request.reviewType,
      filePath: request.filePath,
    };
  }

  async runReview(
    request: ReviewRequest,
    token?: CancellationToken
  ): Promise<HarnessResult> {
    const iterations: IterationResult[] = [];
    const allComments = new Map<string, ReviewComment>();
    let converged = false;
    const finalErrors: string[] = [];
    let maxIterationsReached = false;
    this.lastRetryContext = undefined;

    for (let iteration = 1; iteration <= this.config.strategy.maxIterations; iteration++) {
      if (token?.isCancellationRequested) {
        logCancellation(this.getDiagnosticContext(request));
        break;
      }

      logIterationStart(iteration, this.getDiagnosticContext(request, iteration));

      const iterationResult = await this.runIteration(request, iteration, token, this.lastRetryContext);
      iterations.push(iterationResult);

      finalErrors.push(...iterationResult.parseErrors, ...iterationResult.providerErrors);

      const newComments = this.filterNewComments(iterationResult.comments, allComments);
      iterationResult.newComments = newComments;

      for (const comment of newComments) {
        const key = this.getCommentKey(comment);
        allComments.set(key, comment);
      }

      logIterationComplete(iteration, iterationResult.comments.length, newComments.length, this.getDiagnosticContext(request, iteration));

      const hasProviderErrors = iterationResult.providerErrors.length > 0;
      const hasInvalidOutput = iterationResult.parseErrors.length > 0 || iterationResult.validationIssues.length > 0;

      if (iterationResult.comments.length === 0 && iteration === 1 && !hasProviderErrors && !hasInvalidOutput) {
        break;
      }

      if (!hasProviderErrors && this.checkConvergence(iterationResult.newComments, iterations)) {
        const threshold = this.config.strategy.convergenceThreshold ?? 0.1;
        const totalCommentsSeen = iterations.reduce((sum, iter) => sum + iter.comments.length, 0);
        const previousTotal = totalCommentsSeen - iterationResult.newComments.length;
        const newCommentRatio = previousTotal > 0 ? iterationResult.newComments.length / previousTotal : 0;
        logConvergenceDetected(threshold, newCommentRatio, this.getDiagnosticContext(request, iteration));
        converged = true;
        break;
      }

      if (iteration === this.config.strategy.maxIterations) {
        logMaxIterationsReached(this.config.strategy.maxIterations, this.getDiagnosticContext(request, iteration));
        maxIterationsReached = true;
        break;
      }

      if (this.config.strategy.retryOnInvalidOutput && hasInvalidOutput && !hasProviderErrors) {
        this.lastRetryContext = {
          parseErrors: iterationResult.parseErrors,
          validationIssues: iterationResult.validationIssues,
        };
        iterationResult.retryPrompt = this.buildRetryPrompt(
          iterationResult.parseErrors,
          iterationResult.validationIssues
        );
        logRetryPrompt(
          `parse errors: ${iterationResult.parseErrors.length}, validation issues: ${iterationResult.validationIssues.length}`,
          this.getDiagnosticContext(request, iteration)
        );
      }
    }

    return {
      allComments: Array.from(allComments.values()),
      iterations,
      totalIterations: iterations.length,
      converged,
      finalErrors: [...new Set(finalErrors)],
      maxIterationsReached,
    };
  }

  private async runIteration(
    request: ReviewRequest,
    iteration: number,
    token?: CancellationToken,
    retryContext?: RetryContext
  ): Promise<IterationResult> {
    const parseErrors: string[] = [];
    const providerErrors: string[] = [];
    const validationIssues: ValidationIssue[] = [];
    let comments: ReviewComment[] = [];
    let retryPrompt: string | undefined;

    const effectiveRequest = retryContext
      ? this.buildRetryRequest(request, retryContext)
      : request;

    try {
      const result = await this.config.provider.review(effectiveRequest, token);

      if (result.comments && result.comments.length > 0) {
        const validationResult = this.config.validator.validate(result.comments, {
          filePath: request.filePath,
          startLine: request.startLine,
        });
        comments = validationResult.validComments;
        validationIssues.push(...validationResult.issues);

        if (validationResult.issues.length > 0) {
          logValidatorIssue(
            `Validation found ${validationResult.issues.length} issues`,
            formatValidationIssues(validationResult.issues),
            this.getDiagnosticContext(request, iteration)
          );
        }
      } else if (!result.comments && retryContext) {
        parseErrors.push(...(retryContext.parseErrors || []));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerErrors.push(`Provider error on iteration ${iteration}: ${message}`);
      logProviderError(message, true, this.getDiagnosticContext(request, iteration));
    }

    if (retryContext && (parseErrors.length > 0 || validationIssues.length > 0)) {
      retryPrompt = this.buildRetryPrompt(parseErrors, validationIssues);
    }

    return {
      iteration,
      comments,
      newComments: [],
      converged: false,
      parseErrors,
      providerErrors,
      validationIssues,
      retryPrompt,
    };
  }

  private buildRetryRequest(request: ReviewRequest, retryContext: RetryContext): ReviewRequest {
    const retryPrompt = this.buildRetryPrompt(retryContext.parseErrors || [], retryContext.validationIssues || []);

    return {
      ...request,
      code: request.code + `\n\n${retryPrompt}`,
    };
  }

  private buildRetryPrompt(parseErrors: string[], validationIssues: ValidationIssue[]): string {
    const parts: string[] = [];

    if (parseErrors.length > 0) {
      parts.push(`Previous output could not be parsed:\n- ${parseErrors.slice(0, 3).join('\n- ')}`);
    }

    if (validationIssues.length > 0) {
      const issueSummary = validationIssues.slice(0, 5).map(issue => {
        let summary = `${issue.type}: ${issue.message}`;
        if (issue.originalComment) {
          summary += ` (line ${issue.originalComment.line}`;
          if (issue.originalComment.file) {
            summary += ` in ${issue.originalComment.file}`;
          }
          summary += ')';
        }
        return summary;
      }).join('\n- ');
      parts.push(`Validation issues found:\n- ${issueSummary}`);
    }

    parts.push('Please respond with ONLY a valid JSON array of review comments in this exact format: [{"file": "path", "line": 1, "message": "text", "severity": "error"}]');

    return `\n\n## Previous Issues\n${parts.join('\n\n')}\n\n## Please retry with corrected output`;
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
    public readonly convergenceThreshold: number = 0.1,
    public readonly retryOnInvalidOutput: boolean = true
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