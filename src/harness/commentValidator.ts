import * as vscode from 'vscode';
import { ReviewComment, Severity } from '../types/review';

export interface ValidationIssue {
  type: 'invalid_file' | 'invalid_line' | 'invalid_severity' | 'duplicate';
  message: string;
  originalComment: ReviewComment;
}

export interface ValidationResult {
  validComments: ReviewComment[];
  issues: ValidationIssue[];
}

export interface CommentValidatorConfig {
  workspaceRoot: vscode.Uri;
  validateFilePaths?: boolean;
  normalizeLineNumbers?: boolean;
  deduplicate?: boolean;
}

export class CommentValidator {
  private workspaceRoot: vscode.Uri;
  private validateFilePaths: boolean;
  private normalizeLineNumbers: boolean;
  private deduplicate: boolean;

  constructor(config: CommentValidatorConfig) {
    this.workspaceRoot = config.workspaceRoot;
    this.validateFilePaths = config.validateFilePaths ?? true;
    this.normalizeLineNumbers = config.normalizeLineNumbers ?? true;
    this.deduplicate = config.deduplicate ?? true;
  }

  validate(comments: ReviewComment[], context?: { filePath?: string; startLine?: number }): ValidationResult {
    const validSeverities: Severity[] = ['error', 'warning', 'info', 'suggestion'];
    const issues: ValidationIssue[] = [];
    const seenComments = new Map<string, ReviewComment>();
    const validComments: ReviewComment[] = [];

    for (const comment of comments) {
      const filePath = comment.file || context?.filePath || '';
      const lineNumber = comment.line;
      let hasInvalidFile = false;
      let hasInvalidLine = false;
      const normalizedComment = { ...comment };

      if (this.validateFilePaths) {
        if (!filePath || typeof filePath !== 'string') {
          issues.push({
            type: 'invalid_file',
            message: `Invalid or missing file path: ${filePath}`,
            originalComment: comment,
          });
          hasInvalidFile = true;
        }
      }

      if (typeof lineNumber !== 'number' || lineNumber < 0 || !Number.isFinite(lineNumber)) {
        issues.push({
          type: 'invalid_line',
          message: `Invalid line number: ${lineNumber}. Line numbers must be non-negative integers.`,
          originalComment: comment,
        });
        hasInvalidLine = true;
      }

      if (comment.severity !== undefined && !validSeverities.includes(comment.severity)) {
        issues.push({
          type: 'invalid_severity',
          message: `Invalid severity: ${comment.severity}. Valid values are: ${validSeverities.join(', ')}`,
          originalComment: { ...comment, severity: undefined },
        });
        normalizedComment.severity = undefined;
      }

      if (hasInvalidFile || hasInvalidLine) {
        continue;
      }

      if (this.deduplicate) {
        const dedupeKey = this.getDedupeKey(comment, context?.filePath);
        if (seenComments.has(dedupeKey)) {
          issues.push({
            type: 'duplicate',
            message: `Duplicate comment on line ${lineNumber} in ${filePath}: "${comment.message.substring(0, 50)}..."`,
            originalComment: comment,
          });
          continue;
        }
        seenComments.set(dedupeKey, comment);
      }

      if (this.normalizeLineNumbers && normalizedComment.line > 0) {
        normalizedComment.line = normalizedComment.line - 1;
      } else if (this.normalizeLineNumbers && normalizedComment.line === 0) {
        normalizedComment.line = 0;
      }

      validComments.push(normalizedComment);
    }

    return {
      validComments,
      issues,
    };
  }

  private getDedupeKey(comment: ReviewComment, defaultFilePath?: string): string {
    const file = comment.file || defaultFilePath || '';
    return `${file}:${comment.line}:${comment.message}`;
  }

  static isValidSeverity(severity: unknown): severity is Severity {
    const validSeverities: Severity[] = ['error', 'warning', 'info', 'suggestion'];
    return typeof severity === 'string' && validSeverities.includes(severity as Severity);
  }

  static normalizeLineNumber(line: number, isOneBased: boolean = true): number {
    if (isOneBased && line > 0) {
      return line - 1;
    }
    return line;
  }
}
