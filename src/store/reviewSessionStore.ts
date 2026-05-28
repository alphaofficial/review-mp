import { EventEmitter } from 'events';
import { FindingAction, ReviewFile, ReviewFinding, ReviewHistoryEntry, ReviewSession, ReviewStatus, ReviewType, Severity } from '../types/review';

let findingIdCounter = 0;

function generateFindingId(): string {
  return `finding-${Date.now()}-${++findingIdCounter}`;
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export type ReviewSessionEvent = {
  'status-changed': { sessionId: string; status: ReviewStatus };
  'finding-added': { sessionId: string; finding: ReviewFinding };
  'finding-updated': { sessionId: string; findingId: string; action: FindingAction };
  'file-status-changed': { sessionId: string; filePath: string; status: ReviewFile['status'] };
  'session-cleared': { sessionId: string };
  'session-completed': { sessionId: string };
};

export class ReviewSessionStore extends EventEmitter {
  private activeSession: ReviewSession | null = null;
  private sessionHistory: ReviewHistoryEntry[] = [];
  private findingToSession: Map<string, ReviewSession> = new Map();

  constructor() {
    super();
    this.sessionHistory = [];
  }

  createSession(reviewType: ReviewType, title?: string, branch?: string, baseBranch?: string): ReviewSession {
    this.clearActiveSession();

    const session: ReviewSession = {
      id: generateSessionId(),
      title: title || this.getDefaultTitle(reviewType, branch),
      status: 'idle',
      reviewType,
      branch,
      baseBranch,
      startedAt: Date.now(),
      files: new Map(),
      findings: [],
      totalFindings: 0,
    };

    this.activeSession = session;
    return session;
  }

  private getDefaultTitle(reviewType: ReviewType, branch?: string): string {
    const typeLabels: Record<ReviewType, string> = {
      file: 'File Review',
      selection: 'Selection Review',
      staged: 'Staged Changes Review',
      uncommitted: 'Uncommitted Changes Review',
      lastCommit: 'Last Commit Review',
      branch: `Branch Review: ${branch || 'current'}`,
      pullRequest: 'Pull Request Review',
    };
    return typeLabels[reviewType];
  }

  getActiveSession(): ReviewSession | null {
    return this.activeSession;
  }

  getSessionHistory(): ReviewHistoryEntry[] {
    return [...this.sessionHistory];
  }

  updateSessionStatus(status: ReviewStatus): void {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.status = status;
    this.emit('status-changed', { sessionId: this.activeSession.id, status });

    if (status === 'completed' || status === 'failed') {
      this.finalizeSession();
    }
  }

  setSessionError(error: string): void {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.error = error;
    this.activeSession.status = 'failed';
    this.emit('status-changed', { sessionId: this.activeSession.id, status: 'failed' });
    this.finalizeSession();
  }

  private finalizeSession(): void {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.completedAt = Date.now();

    const entry: ReviewHistoryEntry = {
      sessionId: this.activeSession.id,
      title: this.activeSession.title,
      reviewType: this.activeSession.reviewType,
      branch: this.activeSession.branch,
      completedAt: this.activeSession.completedAt,
      findingsCount: this.activeSession.totalFindings,
      duration: this.activeSession.completedAt - this.activeSession.startedAt,
    };

    this.sessionHistory.unshift(entry);

    if (this.sessionHistory.length > 10) {
      this.sessionHistory = this.sessionHistory.slice(0, 10);
    }

    this.emit('session-completed', { sessionId: this.activeSession.id });
  }

  addFinding(file: string, line: number, message: string, severity: Severity, fix?: string): ReviewFinding | null {
    if (!this.activeSession) {
      return null;
    }

    const finding: ReviewFinding = {
      id: generateFindingId(),
      file,
      line,
      message,
      severity,
      fix,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.activeSession.findings.push(finding);
    this.activeSession.totalFindings++;
    this.findingToSession.set(finding.id, this.activeSession);

    let reviewFile = this.activeSession.files.get(file);
    if (!reviewFile) {
      reviewFile = {
        path: file,
        status: 'pending',
        findings: [],
      };
      this.activeSession.files.set(file, reviewFile);
    }

    reviewFile.findings.push(finding);

    if (reviewFile.status === 'pending') {
      reviewFile.status = 'reviewing';
      this.emit('file-status-changed', { sessionId: this.activeSession.id, filePath: file, status: 'reviewing' });
    }

    this.emit('finding-added', { sessionId: this.activeSession.id, finding });
    return finding;
  }

  addFindingsFromComments(comments: Array<{ file: string; line: number; message: string; severity?: Severity; fix?: string }>): void {
    for (const comment of comments) {
      this.addFinding(comment.file, comment.line, comment.message, comment.severity || 'info', comment.fix);
    }
  }

  getFinding(findingId: string): ReviewFinding | undefined {
    if (this.activeSession) {
      return this.activeSession.findings.find(f => f.id === findingId);
    }
    return this.findingToSession.get(findingId)?.findings.find(f => f.id === findingId);
  }

  updateFindingStatus(findingId: string, action: FindingAction): boolean {
    const session = this.findingToSession.get(findingId);
    if (!session) {
      return false;
    }

    const finding = session.findings.find(f => f.id === findingId);
    if (!finding) {
      return false;
    }

    if (action === 'apply') {
      finding.status = 'applied';
    } else if (action === 'dismiss') {
      finding.status = 'dismissed';
    }

    this.emit('finding-updated', { sessionId: session.id, findingId, action });
    this.checkFileCompletion(session, finding.file);
    return true;
  }

  private checkFileCompletion(session: ReviewSession, filePath: string): void {
    const reviewFile = session.files.get(filePath);
    if (!reviewFile) {
      return;
    }

    const allProcessed = reviewFile.findings.every(f => f.status !== 'pending');
    if (allProcessed && reviewFile.status !== 'reviewed') {
      reviewFile.status = 'reviewed';
      this.emit('file-status-changed', { sessionId: session.id, filePath, status: 'reviewed' });
    }
  }

  getFilesForSession(): ReviewFile[] {
    if (!this.activeSession) {
      return [];
    }
    return Array.from(this.activeSession.files.values());
  }

  getFindingsForFile(filePath: string): ReviewFinding[] {
    if (!this.activeSession) {
      return [];
    }
    const reviewFile = this.activeSession.files.get(filePath);
    return reviewFile?.findings || [];
  }

  getPendingFindingsCount(): number {
    if (!this.activeSession) {
      return 0;
    }
    return this.activeSession.findings.filter(f => f.status === 'pending').length;
  }

  clearActiveSession(): void {
    if (this.activeSession) {
      for (const finding of this.activeSession.findings) {
        this.findingToSession.delete(finding.id);
      }

      const sessionId = this.activeSession.id;
      this.activeSession = null;
      this.emit('session-cleared', { sessionId });
    }
  }

  clearHistory(): void {
    this.sessionHistory = [];
  }

  dispose(): void {
    this.removeAllListeners();
    this.clearActiveSession();
    this.clearHistory();
  }
}

let storeInstance: ReviewSessionStore | null = null;

export function getReviewSessionStore(): ReviewSessionStore {
  if (!storeInstance) {
    storeInstance = new ReviewSessionStore();
  }
  return storeInstance;
}

export function createReviewSessionStore(): ReviewSessionStore {
  storeInstance = new ReviewSessionStore();
  return storeInstance;
}

export function resetReviewSessionStore(): void {
  if (storeInstance) {
    storeInstance.dispose();
    storeInstance = null;
  }
}
