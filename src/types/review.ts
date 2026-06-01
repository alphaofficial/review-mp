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
  findingKey?: string;
  reviewFingerprint?: string;
  unitFingerprint?: string;
  source?: 'fresh' | 'reused';
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
  reviewFingerprint?: string;
  reviewTargetKind?: ReviewTargetKind;
  unitFingerprints?: string[];
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
  reviewFingerprint?: string;
  reviewTargetKind?: ReviewTargetKind;
  unitFingerprints?: string[];
}

export type FindingAction = 'apply' | 'dismiss';

export interface ReviewComment {
  file: string;
  line: number;
  title?: string;
  message: string;
  fix?: string;
  severity?: Severity;
  evidence?: ReviewEvidence[];
  findingKey?: string;
  reviewFingerprint?: string;
  unitFingerprint?: string;
  source?: 'fresh' | 'reused';
}

export interface ReviewEvidence {
  file: string;
  line?: number;
  quote: string;
  reason?: string;
}

export type ReviewContextReason =
  | 'diff-manifest'
  | 'change-map'
  | 'related-change'
  | 'recent-change'
  | 'existing-finding'
  | 'semantic-match'
  | 'review-memory'
  | 'code-graph'
  | 'file-summary'
  | 'repo-summary';

export interface ReviewContextItem {
  filePath: string;
  reason: ReviewContextReason;
  content: string;
}

export type ReviewTargetKind = 'file' | 'selection' | 'diff';

export interface ReviewTarget {
  kind: ReviewTargetKind;
  filePath: string;
  languageId?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  pathHint?: string;
}

export interface ReviewPackage {
  reviewType: ReviewType;
  strictReviewOnly: boolean;
  scopeLabel: string;
  target: ReviewTarget;
  supportingContext: ReviewContextItem[];
  changeBrief?: string;
  notes?: string[];
}

export type ReviewType = 'file' | 'selection' | 'staged' | 'uncommitted' | 'lastCommit' | 'branch';

export interface ReviewRequest {
  code: string;
  languageId: string;
  filePath: string;
  reviewType: ReviewType;
  diff?: string;
  startLine?: number;
  crossFileContext?: string;
  fullDocumentCode?: string;
  reviewPackage?: ReviewPackage;
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
