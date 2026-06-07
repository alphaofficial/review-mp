import { ReviewComment } from '../types/review';

let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

function safeDebugLog(message: string, ...data: unknown[]): void {
  if (debugEnabled) {
    const timestamp = new Date().toISOString();
    console.log(`[CodeBunny DEBUG ${timestamp}]`, message, ...data);
  }
}

export type DiagnosticKind = 'provider' | 'parser' | 'validator' | 'tool';

export interface DiagnosticContext {
  iteration?: number;
  reviewType?: string;
  filePath?: string;
}

export interface ProviderDiagnostic {
  kind: 'provider';
  message: string;
  recoverable: boolean;
  context: DiagnosticContext;
}

export interface ParserDiagnostic {
  kind: 'parser';
  message: string;
  parseErrors: string[];
  rawOutputLength: number;
  context: DiagnosticContext;
}

export interface ValidatorDiagnostic {
  kind: 'validator';
  message: string;
  issues: ValidatorIssueDiagnostic[];
  context: DiagnosticContext;
}

export interface ValidatorIssueDiagnostic {
  type: string;
  message: string;
  affectedLine?: number;
  affectedFile?: string;
}

export interface ToolDiagnostic {
  kind: 'tool';
  tool: string;
  message: string;
  error: string;
  context: DiagnosticContext;
}

export type ReviewDiagnostic = ProviderDiagnostic | ParserDiagnostic | ValidatorDiagnostic | ToolDiagnostic;

export function logProviderError(message: string, recoverable: boolean, context: DiagnosticContext): void {
  safeDebugLog(`[PROVIDER ERROR] ${message}`, { recoverable, ...context });
}

export function logProviderWarning(message: string, context: DiagnosticContext): void {
  safeDebugLog(`[PROVIDER WARN] ${message}`, context);
}

export function logParserError(message: string, parseErrors: string[], rawOutputLength: number, context: DiagnosticContext): void {
  safeDebugLog(`[PARSER ERROR] ${message}`, { parseErrors, rawOutputLength, ...context });
}

export function logParserWarning(message: string, context: DiagnosticContext): void {
  safeDebugLog(`[PARSER WARN] ${message}`, context);
}

export function logValidatorIssue(message: string, issues: ValidatorIssueDiagnostic[], context: DiagnosticContext): void {
  safeDebugLog(`[VALIDATOR] ${message}`, { issueCount: issues.length, issues, ...context });
}

export function logValidatorWarning(message: string, context: DiagnosticContext): void {
  safeDebugLog(`[VALIDATOR WARN] ${message}`, context);
}

export function logToolError(tool: string, message: string, error: string, context: DiagnosticContext): void {
  safeDebugLog(`[TOOL ERROR] ${tool}: ${message}`, { error, ...context });
}

export function logToolWarning(tool: string, message: string, context: DiagnosticContext): void {
  safeDebugLog(`[TOOL WARN] ${tool}: ${message}`, context);
}

export function logMaxIterationsReached(maxIterations: number, context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Max iterations reached: ${maxIterations}`, context);
}

export function logIterationStart(iteration: number, context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Starting iteration ${iteration}`, context);
}

export function logIterationComplete(iteration: number, commentCount: number, newCommentCount: number, context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Iteration ${iteration} complete`, { commentCount, newCommentCount, ...context });
}

export function logRetryPrompt(reason: string, context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Issuing retry prompt due to: ${reason}`, context);
}

export function logConvergenceDetected(threshold: number, newCommentRatio: number, context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Convergence detected`, { threshold, newCommentRatio, ...context });
}

export function logCancellation(context: DiagnosticContext): void {
  safeDebugLog(`[HARNESS] Review cancelled`, context);
}

export function collectDiagnostic<T extends { error?: string }>(
  kind: DiagnosticKind,
  operation: string,
  context: DiagnosticContext,
  fn: () => T
): { result: T; diagnostic?: ReviewDiagnostic } {
  try {
    const result = fn();
    if (result.error) {
      const diagnostic = createDiagnostic(kind, operation, result.error, context);
      if (diagnostic) {
        emitDiagnostic(diagnostic);
      }
    }
    return { result, diagnostic: undefined };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = createDiagnostic(kind, operation, errorMessage, context);
    if (diagnostic) {
      emitDiagnostic(diagnostic);
    }
    return { 
      result: { error: errorMessage } as T, 
      diagnostic 
    };
  }
}

function createDiagnostic(
  kind: DiagnosticKind,
  operation: string,
  error: string,
  context: DiagnosticContext
): ReviewDiagnostic | undefined {
  switch (kind) {
    case 'provider':
      return { kind: 'provider', message: operation, recoverable: true, context };
    case 'parser':
      return { kind: 'parser', message: operation, parseErrors: [error], rawOutputLength: 0, context };
    case 'validator':
      return { kind: 'validator', message: operation, issues: [{ type: 'error', message: error }], context };
    case 'tool':
      return { kind: 'tool', tool: operation, message: error, error, context };
    default:
      return undefined;
  }
}

function emitDiagnostic(diagnostic: ReviewDiagnostic): void {
  switch (diagnostic.kind) {
    case 'provider':
      logProviderError(diagnostic.message, diagnostic.recoverable, diagnostic.context);
      break;
    case 'parser':
      logParserError(diagnostic.message, diagnostic.parseErrors, diagnostic.rawOutputLength, diagnostic.context);
      break;
    case 'validator':
      logValidatorIssue(diagnostic.message, diagnostic.issues, diagnostic.context);
      break;
    case 'tool':
      logToolError(diagnostic.tool, diagnostic.message, diagnostic.error, diagnostic.context);
      break;
  }
}

export function formatValidationIssues(issues: { type: string; message: string; originalComment?: ReviewComment }[]): ValidatorIssueDiagnostic[] {
  return issues.map(issue => ({
    type: issue.type,
    message: issue.message,
    affectedLine: issue.originalComment?.line,
    affectedFile: issue.originalComment?.file,
  }));
}

export function sanitizeForLogging(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.length > 500 ? obj.substring(0, 500) + '...' : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }
  if (obj && typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token')) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }
  return obj;
}
