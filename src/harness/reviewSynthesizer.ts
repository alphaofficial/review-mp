import { ReviewComment } from '../types/review';

export function synthesizeReviewComments(commentGroups: ReviewComment[][]): ReviewComment[] {
  const byKey = new Map<string, ReviewComment>();

  for (const group of commentGroups) {
    for (const comment of group) {
      if (!isValidComment(comment)) {
        continue;
      }

      const key = `${comment.file}:${comment.line}:${comment.message}`;
      const existing = byKey.get(key);
      if (!existing || compareComments(comment, existing) < 0) {
        byKey.set(key, normalizeComment(comment));
      }
    }
  }

  return Array.from(byKey.values()).sort(compareComments);
}

function isValidComment(comment: ReviewComment): boolean {
  return Boolean(comment.file && comment.message && comment.message.trim().length > 0 && comment.line >= 0);
}

function normalizeComment(comment: ReviewComment): ReviewComment {
  return {
    ...comment,
    message: comment.message.trim(),
    severity: comment.severity ?? 'warning',
  };
}

function compareComments(left: ReviewComment, right: ReviewComment): number {
  const severityOrder: Record<string, number> = {
    error: 0,
    warning: 1,
    info: 2,
    suggestion: 3,
  };

  const leftSeverity = severityOrder[left.severity ?? 'warning'] ?? 4;
  const rightSeverity = severityOrder[right.severity ?? 'warning'] ?? 4;

  if (leftSeverity !== rightSeverity) {
    return leftSeverity - rightSeverity;
  }

  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.message.localeCompare(right.message);
}
