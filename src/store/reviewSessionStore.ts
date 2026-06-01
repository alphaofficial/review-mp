import { EventEmitter } from 'events';
import { FindingAction, ReviewFile, ReviewFinding, ReviewHistoryEntry, ReviewSession, ReviewStatus, ReviewTargetKind, ReviewType, Severity } from '../types/review';
import { logDebug } from '../settings';

let findingIdCounter = 0;
const MAX_SESSION_HISTORY = 5;
type SessionTransitionEvent = 'startSetup' | 'beginAnalysis' | 'beginReview' | 'complete' | 'fail';
type FileTransitionEvent = 'beginReview' | 'complete' | 'fail';

const SESSION_TRANSITIONS: Record<ReviewStatus, Partial<Record<SessionTransitionEvent, ReviewStatus>>> = {
  idle: {
    startSetup: 'settingUp',
    fail: 'failed',
  },
  settingUp: {
    beginAnalysis: 'analyzing',
    fail: 'failed',
  },
  analyzing: {
    beginReview: 'reviewing',
    complete: 'completed',
    fail: 'failed',
  },
  reviewing: {
    complete: 'completed',
    fail: 'failed',
  },
  completed: {},
  failed: {},
};

const FILE_TRANSITIONS: Record<ReviewFile['status'], Partial<Record<FileTransitionEvent, ReviewFile['status']>>> = {
  pending: {
    beginReview: 'reviewing',
    fail: 'failed',
  },
  reviewing: {
    complete: 'reviewed',
    fail: 'failed',
  },
  reviewed: {
    beginReview: 'reviewing',
    fail: 'failed',
  },
  failed: {},
};

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
    };
    return typeLabels[reviewType];
  }

  getActiveSession(): ReviewSession | null {
    return this.activeSession;
  }

  getSessionHistory(): ReviewHistoryEntry[] {
    return [...this.sessionHistory];
  }

  setSessionReviewMetadata(metadata: {
    reviewFingerprint?: string;
    reviewTargetKind?: ReviewTargetKind;
    unitFingerprints?: string[];
  }): void {
    if (!this.activeSession) {
      return;
    }

    this.activeSession.reviewFingerprint = metadata.reviewFingerprint;
    this.activeSession.reviewTargetKind = metadata.reviewTargetKind;
    this.activeSession.unitFingerprints = metadata.unitFingerprints ? [...metadata.unitFingerprints] : undefined;
  }

  setFilesToReview(filePaths: string[]): void {
    if (!this.activeSession) {
      return;
    }

    const uniqueFilePaths = [...new Set(filePaths.filter(filePath => filePath.trim().length > 0))];
    for (const filePath of uniqueFilePaths) {
      if (!this.activeSession.files.has(filePath)) {
        this.activeSession.files.set(filePath, {
          path: filePath,
          status: 'pending',
          findings: [],
        });
      }
    }

    this.emit('file-status-changed', {
      sessionId: this.activeSession.id,
      filePath: '',
      status: 'pending',
    });
  }

  setReviewFiles(filePaths: string[]): void {
    if (!this.activeSession) {
      return;
    }

    const uniqueFilePaths = [...new Set(filePaths.filter(filePath => filePath.trim().length > 0))];
    const nextFiles = new Map<string, ReviewFile>();
    for (const filePath of uniqueFilePaths) {
      const existingFile = this.activeSession.files.get(filePath);
      nextFiles.set(filePath, existingFile ?? {
        path: filePath,
        status: 'pending',
        findings: [],
      });
    }

    this.activeSession.files = nextFiles;
    this.emit('file-status-changed', {
      sessionId: this.activeSession.id,
      filePath: '',
      status: 'pending',
    });
  }

  transitionSession(event: SessionTransitionEvent, error?: string): boolean {
    if (!this.activeSession) {
      return false;
    }

    const nextStatus = SESSION_TRANSITIONS[this.activeSession.status][event];
    if (!nextStatus) {
      logDebug('Rejected review session transition', {
        sessionId: this.activeSession.id,
        reviewType: this.activeSession.reviewType,
        currentStatus: this.activeSession.status,
        event,
      });
      return false;
    }

    if (nextStatus === 'failed' && error) {
      this.activeSession.error = error;
    }

    this.activeSession.status = nextStatus;
    logDebug('Review session status changed', {
      sessionId: this.activeSession.id,
      reviewType: this.activeSession.reviewType,
      event,
      status: nextStatus,
    });
    this.emit('status-changed', { sessionId: this.activeSession.id, status: nextStatus });

    if (nextStatus === 'completed' || nextStatus === 'failed') {
      this.finalizeSession();
    }

    return true;
  }

  setSessionError(error: string): void {
    this.transitionSession('fail', error);
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
      files: Array.from(this.activeSession.files.values()).map(file => ({
        ...file,
        findings: file.findings.map(finding => ({ ...finding })),
      })),
      findings: this.activeSession.findings.map(finding => ({ ...finding })),
      reviewFingerprint: this.activeSession.reviewFingerprint,
      reviewTargetKind: this.activeSession.reviewTargetKind,
      unitFingerprints: this.activeSession.unitFingerprints ? [...this.activeSession.unitFingerprints] : undefined,
    };

    this.sessionHistory.unshift(entry);

    if (this.sessionHistory.length > MAX_SESSION_HISTORY) {
      this.sessionHistory = this.sessionHistory.slice(0, MAX_SESSION_HISTORY);
    }

    this.emit('session-completed', { sessionId: this.activeSession.id });
  }

  addFinding(
    file: string,
    line: number,
    message: string,
    severity: Severity,
    fix?: string,
    title?: string,
    metadata?: Pick<ReviewFinding, 'findingKey' | 'reviewFingerprint' | 'unitFingerprint' | 'source'>
  ): ReviewFinding | null {
    if (!this.activeSession) {
      return null;
    }

    const finding: ReviewFinding = {
      id: generateFindingId(),
      file,
      line,
      title,
      message,
      severity,
      fix,
      status: 'pending',
      createdAt: Date.now(),
      findingKey: metadata?.findingKey,
      reviewFingerprint: metadata?.reviewFingerprint ?? this.activeSession.reviewFingerprint,
      unitFingerprint: metadata?.unitFingerprint,
      source: metadata?.source ?? 'fresh',
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

    this.transitionFileStatus(this.activeSession, reviewFile, 'beginReview');

    this.emit('finding-added', { sessionId: this.activeSession.id, finding });
    return finding;
  }

  addFindingsFromComments(comments: Array<{
    file: string;
    line: number;
    title?: string;
    message: string;
    severity?: Severity;
    fix?: string;
    findingKey?: string;
    reviewFingerprint?: string;
    unitFingerprint?: string;
    source?: 'fresh' | 'reused';
  }>): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const comment of comments) {
      const finding = this.addFinding(
        comment.file,
        comment.line,
        comment.message,
        comment.severity || 'info',
        comment.fix,
        comment.title,
        {
          findingKey: comment.findingKey,
          reviewFingerprint: comment.reviewFingerprint,
          unitFingerprint: comment.unitFingerprint,
          source: comment.source,
        }
      );
      if (finding) {
        findings.push(finding);
      }
    }
    return findings;
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
    if (allProcessed) {
      this.transitionFileStatus(session, reviewFile, 'complete');
    }
  }

  markFilesReviewing(filePaths: string[]): void {
    if (!this.activeSession) {
      return;
    }

    for (const filePath of [...new Set(filePaths.filter(file => file.trim().length > 0))]) {
      let reviewFile = this.activeSession.files.get(filePath);
      if (!reviewFile) {
        reviewFile = {
          path: filePath,
          status: 'pending',
          findings: [],
        };
        this.activeSession.files.set(filePath, reviewFile);
      }

      this.transitionFileStatus(this.activeSession, reviewFile, 'beginReview');
    }
  }

  completeFilesReview(filePaths: string[]): void {
    if (!this.activeSession) {
      return;
    }

    for (const filePath of [...new Set(filePaths.filter(file => file.trim().length > 0))]) {
      const reviewFile = this.activeSession.files.get(filePath);
      if (!reviewFile) {
        continue;
      }

      const hasPendingFindings = reviewFile.findings.some((finding) => finding.status === 'pending');
      if (hasPendingFindings) {
        continue;
      }

      this.transitionFileStatus(this.activeSession, reviewFile, 'complete');
    }
  }

  getFilesForSession(): ReviewFile[] {
    if (!this.activeSession) {
      return [];
    }
    return Array.from(this.activeSession.files.values());
  }

  restoreSessionFromHistory(sessionId: string): ReviewSession | null {
    const entry = this.sessionHistory.find(historyEntry => historyEntry.sessionId === sessionId);
    if (!entry) {
      return null;
    }

    this.clearActiveSession();

    const files = new Map<string, ReviewFile>();
    for (const file of entry.files) {
      files.set(file.path, {
        ...file,
        findings: file.findings.map(finding => ({ ...finding })),
      });
    }

    const session: ReviewSession = {
      id: entry.sessionId,
      title: entry.title,
      status: 'completed',
      reviewType: entry.reviewType,
      branch: entry.branch,
      startedAt: entry.completedAt - entry.duration,
      completedAt: entry.completedAt,
      files,
      findings: entry.findings.map(finding => ({ ...finding })),
      totalFindings: entry.findingsCount,
      reviewFingerprint: entry.reviewFingerprint,
      reviewTargetKind: entry.reviewTargetKind,
      unitFingerprints: entry.unitFingerprints ? [...entry.unitFingerprints] : undefined,
    };

    this.activeSession = session;
    for (const finding of session.findings) {
      this.findingToSession.set(finding.id, session);
    }

    this.emit('status-changed', { sessionId: session.id, status: session.status });
    return session;
  }

  getFindingsForFile(filePath: string): ReviewFinding[] {
    if (!this.activeSession) {
      return [];
    }
    const reviewFile = this.activeSession.files.get(filePath);
    return reviewFile?.findings || [];
  }

  setFileFailed(filePath: string): boolean {
    if (!this.activeSession) {
      return false;
    }
    const reviewFile = this.activeSession.files.get(filePath);
    if (!reviewFile) {
      return false;
    }
    if (reviewFile.status === 'failed') {
      return true;
    }
    return this.transitionFileStatus(this.activeSession, reviewFile, 'fail');
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

  private transitionFileStatus(session: ReviewSession, reviewFile: ReviewFile, event: FileTransitionEvent): boolean {
    const nextStatus = FILE_TRANSITIONS[reviewFile.status][event];
    if (!nextStatus) {
      return false;
    }

    reviewFile.status = nextStatus;
    this.emit('file-status-changed', { sessionId: session.id, filePath: reviewFile.path, status: nextStatus });
    return true;
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
