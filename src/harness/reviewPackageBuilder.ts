import { ContextEnvelope } from './contextRetriever';
import { ReviewPackage, ReviewRequest, ReviewTarget } from '../types/review';

function contextItems(envelope?: ContextEnvelope) {
  return envelope?.files.map((file) => ({
    filePath: file.filePath,
    reason: file.reason,
    content: file.content,
  })) ?? [];
}

export function buildFileReviewPackage(request: ReviewRequest, envelope?: ContextEnvelope): ReviewPackage {
  const target: ReviewTarget = {
    kind: request.reviewType === 'selection' ? 'selection' : 'file',
    filePath: request.filePath,
    languageId: request.languageId,
    startLine: request.startLine,
    endLine: request.startLine !== undefined
      ? request.startLine + request.code.split('\n').length - 1
      : request.code.split('\n').length - 1,
    content: request.code,
  };

  return {
    reviewType: request.reviewType,
    strictReviewOnly: true,
    scopeLabel: request.reviewType === 'selection'
      ? `Selection review for ${request.filePath}`
      : `File review for ${request.filePath}`,
    target,
    supportingContext: contextItems(envelope),
    notes: [
      'Review only the supplied target and supporting context.',
      'Do not inspect other files or search the repository.',
    ],
  };
}

export function buildDiffReviewPackage(
  request: ReviewRequest,
  formattedDiff: string,
  envelope?: ContextEnvelope,
  changeBrief?: string
): ReviewPackage {
  return {
    reviewType: request.reviewType,
    strictReviewOnly: true,
    scopeLabel: `${request.reviewType} review for ${request.filePath || 'diff scope'}`,
    target: {
      kind: 'diff',
      filePath: request.filePath,
      content: formattedDiff,
    },
    supportingContext: contextItems(envelope),
    changeBrief,
    notes: [
      'Review only the supplied diff and supporting context.',
      'Do not inspect other files or search the repository.',
    ],
  };
}
