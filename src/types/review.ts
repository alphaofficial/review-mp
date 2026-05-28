export type Severity = 'error' | 'warning' | 'info' | 'suggestion';

export type ReviewStatus = 'idle' | 'settingUp' | 'analyzing' | 'reviewing' | 'completed' | 'failed';

export interface ReviewFinding {
  id: string;
  file: string;
  line: number;
  title?: string;
  message: string;
  severity: Severity;
  fix?: string;
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: number;
}

export interface ReviewFile {
  path: string;
  status: 'pending' | 'reviewing' | 'reviewed' | 'failed';
  findings: ReviewFinding[];
}

export interface ReviewSession {
  id: string;
  title: string;
  status: ReviewStatus;
  reviewType: ReviewType;
  branch?: string;
  baseBranch?: string;
  startedAt: number;
  completedAt?: number;
  files: Map<string, ReviewFile>;
  findings: ReviewFinding[];
  totalFindings: number;
  error?: string;
}

export interface ReviewHistoryEntry {
  sessionId: string;
  title: string;
  reviewType: ReviewType;
  branch?: string;
  completedAt: number;
  findingsCount: number;
  duration: number;
  files: ReviewFile[];
  findings: ReviewFinding[];
}

export type FindingAction = 'apply' | 'dismiss';

export interface ReviewComment {
  file: string;
  line: number;
  title?: string;
  message: string;
  fix?: string;
  severity?: Severity;
}

export type ReviewType = 'file' | 'selection' | 'staged' | 'uncommitted' | 'lastCommit' | 'branch' | 'pullRequest';

export interface ReviewRequest {
  code: string;
  languageId: string;
  filePath: string;
  reviewType: ReviewType;
  diff?: string;
  startLine?: number;
  crossFileContext?: string;
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
