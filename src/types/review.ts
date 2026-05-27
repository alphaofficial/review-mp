export type Severity = 'error' | 'warning' | 'info' | 'suggestion';

export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  fix?: string;
  severity?: Severity;
}

export type ReviewType = 'file' | 'selection' | 'staged' | 'uncommitted' | 'lastCommit' | 'branch';

export interface ReviewRequest {
  code: string;
  languageId: string;
  filePath: string;
  reviewType: ReviewType;
  diff?: string;
}

export interface ReviewResult {
  comments: ReviewComment[];
  provider: string;
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface ModelResponse {
  content: string;
  usage?: ModelUsage;
  raw?: unknown;
}

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool: string;
  result: unknown;
  error?: string;
}