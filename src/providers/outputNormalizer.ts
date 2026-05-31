import { ReviewComment } from '../types/review';
import { OutputFormat, NormalizedReviewResult } from './runtimeRegistry';
import { OutputParser } from '../harness/outputParser';
import { extractTextFromNdJson, validateComments } from '../harness/outputParser';

export interface NormalizationContext {
  defaultFilePath: string;
  reviewType: 'file' | 'selection' | 'staged' | 'uncommitted' | 'lastCommit' | 'branch';
}

export interface OutputNormalizer {
  readonly format: OutputFormat;
  normalize(rawOutput: string, context: NormalizationContext): NormalizedReviewResult;
}

export class TextNormalizer implements OutputNormalizer {
  readonly format: OutputFormat = 'text';

  normalize(rawOutput: string, context: NormalizationContext): NormalizedReviewResult {
    const parser = new OutputParser({
      defaultFilePath: context.defaultFilePath,
      strictSeverityValidation: false,
    });

    const isDiffReview = context.reviewType !== 'file' && context.reviewType !== 'selection';
    const comments = isDiffReview
      ? parser.parseForDiffReview(rawOutput)
      : parser.parseForFileReview(rawOutput);

    return {
      comments,
      rawText: rawOutput,
    };
  }
}

export class JsonNormalizer implements OutputNormalizer {
  readonly format: OutputFormat = 'json';

  normalize(rawOutput: string, context: NormalizationContext): NormalizedReviewResult {
    const comments: ReviewComment[] = [];

    if (rawOutput.trim()) {
      try {
        const parsed = JSON.parse(rawOutput);
        const data = Array.isArray(parsed) ? parsed : (parsed.comments ?? []);
        comments.push(...this.extractComments(data, context.defaultFilePath));
      } catch {
        // Invalid JSON - fall back to text parsing
        const parser = new OutputParser({
          defaultFilePath: context.defaultFilePath,
          strictSeverityValidation: false,
        });
        const isDiffReview = context.reviewType !== 'file' && context.reviewType !== 'selection';
        comments.push(...(isDiffReview
          ? parser.parseForDiffReview(rawOutput)
          : parser.parseForFileReview(rawOutput)));
      }
    }

    return {
      comments,
      rawText: rawOutput,
    };
  }

  private extractComments(data: unknown, defaultFilePath: string): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }
    return validateComments(data, defaultFilePath, true);
  }
}

export class NdJsonNormalizer implements OutputNormalizer {
  readonly format: OutputFormat = 'ndjson';

  normalize(rawOutput: string, context: NormalizationContext): NormalizedReviewResult {
    const extractedText = extractTextFromNdJson(rawOutput);
    const comments: ReviewComment[] = [];

    if (extractedText.trim()) {
      const parser = new OutputParser({
        defaultFilePath: context.defaultFilePath,
        strictSeverityValidation: false,
      });
      const isDiffReview = context.reviewType !== 'file' && context.reviewType !== 'selection';
      comments.push(...(isDiffReview
        ? parser.parseForDiffReview(extractedText)
        : parser.parseForFileReview(extractedText)));
    }

    return {
      comments,
      rawText: rawOutput,
    };
  }
}

export class NormalizerFactory {
  static create(format: OutputFormat): OutputNormalizer {
    switch (format) {
      case 'json':
        return new JsonNormalizer();
      case 'ndjson':
        return new NdJsonNormalizer();
      case 'text':
      default:
        return new TextNormalizer();
    }
  }
}
