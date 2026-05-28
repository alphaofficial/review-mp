import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReviewSessionStore, createReviewSessionStore, resetReviewSessionStore } from '../../src/store/reviewSessionStore';
import { ReviewFinding, ReviewFile, ReviewHistoryEntry, ReviewSession, ReviewStatus, ReviewType } from '../../src/types/review';

describe('ReviewSessionStore', () => {
  let store: ReviewSessionStore;

  beforeEach(() => {
    resetReviewSessionStore();
    store = createReviewSessionStore();
  });

  afterEach(() => {
    store.dispose();
  });

  describe('createSession', () => {
    it('should create a new session with correct initial state', () => {
      const session = store.createSession('file', 'Test Review');

      expect(session).toBeDefined();
      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe('Test Review');
      expect(session.status).toBe('idle');
      expect(session.reviewType).toBe('file');
      expect(session.startedAt).toBeGreaterThan(0);
      expect(session.files.size).toBe(0);
      expect(session.findings).toHaveLength(0);
      expect(session.totalFindings).toBe(0);
    });

    it('should generate default title based on review type', () => {
      const fileSession = store.createSession('file');
      expect(fileSession.title).toBe('File Review');

      const stagedSession = store.createSession('staged');
      expect(stagedSession.title).toBe('Staged Changes Review');

      const branchSession = store.createSession('branch', undefined, 'feature-xyz');
      expect(branchSession.title).toBe('Branch Review: feature-xyz');
    });

    it('should clear previous session when creating new one', () => {
      store.createSession('file', 'First');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');

      store.createSession('staged', 'Second');
      store.addFinding('/test/file2.ts', 5, 'Warning', 'warning');

      expect(store.getActiveSession()?.title).toBe('Second');
      expect(store.getFindingsForFile('/test/file.ts')).toHaveLength(0);
    });

    it('should track branch and baseBranch when provided', () => {
      const session = store.createSession('branch', 'Branch Review', 'feature', 'main');

      expect(session.branch).toBe('feature');
      expect(session.baseBranch).toBe('main');
    });
  });

  describe('getActiveSession', () => {
    it('should return null when no session exists', () => {
      expect(store.getActiveSession()).toBeNull();
    });

    it('should return active session after creation', () => {
      store.createSession('selection');
      expect(store.getActiveSession()).not.toBeNull();
    });
  });

  describe('updateSessionStatus', () => {
    it('should update session status', () => {
      store.createSession('file');
      store.updateSessionStatus('settingUp');

      expect(store.getActiveSession()?.status).toBe('settingUp');
    });

    it('should emit status-changed event', () => {
      store.createSession('file');
      const listener = vi.fn();
      store.on('status-changed', listener);

      store.updateSessionStatus('analyzing');

      expect(listener).toHaveBeenCalledWith({ sessionId: expect.any(String), status: 'analyzing' });
    });

    it('should finalize session when status is completed', () => {
      store.createSession('file');
      store.updateSessionStatus('completed');

      expect(store.getActiveSession()?.completedAt).toBeGreaterThan(0);
      expect(store.getSessionHistory()).toHaveLength(1);
    });

    it('should finalize session when status is failed', () => {
      store.createSession('file');
      store.updateSessionStatus('failed');

      expect(store.getActiveSession()?.completedAt).toBeGreaterThan(0);
      expect(store.getSessionHistory()).toHaveLength(1);
    });

    it('should do nothing if no active session', () => {
      store.updateSessionStatus('analyzing');
      expect(store.getActiveSession()).toBeNull();
    });
  });

  describe('setSessionError', () => {
    it('should set error message and mark session as failed', () => {
      store.createSession('file');
      store.setSessionError('Provider timeout');

      expect(store.getActiveSession()?.error).toBe('Provider timeout');
      expect(store.getActiveSession()?.status).toBe('failed');
    });

    it('should emit session-completed event', () => {
      store.createSession('file');
      const listener = vi.fn();
      store.on('session-completed', listener);

      store.setSessionError('Test error');

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('addFinding', () => {
    beforeEach(() => {
      store.createSession('file');
    });

    it('should add finding to active session', () => {
      const finding = store.addFinding('/test/file.ts', 10, 'Unused variable', 'warning', 'const x = 1;');

      expect(finding).not.toBeNull();
      expect(finding?.id).toMatch(/^finding-/);
      expect(finding?.file).toBe('/test/file.ts');
      expect(finding?.line).toBe(10);
      expect(finding?.message).toBe('Unused variable');
      expect(finding?.severity).toBe('warning');
      expect(finding?.fix).toBe('const x = 1;');
      expect(finding?.status).toBe('pending');
    });

    it('should create ReviewFile entry if not exists', () => {
      store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/file.ts', 5, 'Error 2', 'warning');

      const files = store.getFilesForSession();
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/test/file.ts');
      expect(files[0].findings).toHaveLength(2);
    });

    it('should update file status to reviewing when first finding added', () => {
      store.addFinding('/test/file.ts', 1, 'Error', 'error');

      const files = store.getFilesForSession();
      expect(files[0].status).toBe('reviewing');
    });

    it('should increment totalFindings counter', () => {
      store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/file.ts', 2, 'Error 2', 'warning');

      expect(store.getActiveSession()?.totalFindings).toBe(2);
    });

    it('should emit finding-added event', () => {
      const listener = vi.fn();
      store.on('finding-added', listener);

      store.addFinding('/test/file.ts', 1, 'Error', 'error');

      expect(listener).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        finding: expect.objectContaining({ message: 'Error' }),
      });
    });

    it('should return null if no active session', () => {
      store.clearActiveSession();
      const finding = store.addFinding('/test/file.ts', 1, 'Error', 'error');
      expect(finding).toBeNull();
    });

    it('should generate stable unique finding IDs', () => {
      const finding1 = store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      const finding2 = store.addFinding('/test/file.ts', 2, 'Error 2', 'warning');

      expect(finding1?.id).not.toBe(finding2?.id);
    });
  });

  describe('addFindingsFromComments', () => {
    it('should add multiple findings from comment array', () => {
      store.createSession('staged');

      const comments = [
        { file: '/test/a.ts', line: 1, message: 'Error 1', severity: 'error' as const },
        { file: '/test/a.ts', line: 5, message: 'Error 2', severity: 'warning' as const },
        { file: '/test/b.ts', line: 10, message: 'Error 3', severity: 'info' as const },
      ];

      store.addFindingsFromComments(comments);

      expect(store.getActiveSession()?.totalFindings).toBe(3);
      expect(store.getFindingsForFile('/test/a.ts')).toHaveLength(2);
      expect(store.getFindingsForFile('/test/b.ts')).toHaveLength(1);
    });
  });

  describe('getFinding', () => {
    it('should retrieve finding by ID from active session', () => {
      store.createSession('file');
      const added = store.addFinding('/test/file.ts', 1, 'Error', 'error');

      const found = store.getFinding(added!.id);
      expect(found).toEqual(added);
    });

    it('should return undefined for non-existent finding', () => {
      store.createSession('file');
      expect(store.getFinding('non-existent-id')).toBeUndefined();
    });
  });

  describe('updateFindingStatus', () => {
    beforeEach(() => {
      store.createSession('file');
    });

    it('should mark finding as applied when action is apply', () => {
      const finding = store.addFinding('/test/file.ts', 1, 'Error', 'error', 'const x = 1;');

      const result = store.updateFindingStatus(finding!.id, 'apply');

      expect(result).toBe(true);
      expect(store.getFinding(finding!.id)?.status).toBe('applied');
    });

    it('should mark finding as dismissed when action is dismiss', () => {
      const finding = store.addFinding('/test/file.ts', 1, 'Error', 'error');

      const result = store.updateFindingStatus(finding!.id, 'dismiss');

      expect(result).toBe(true);
      expect(store.getFinding(finding!.id)?.status).toBe('dismissed');
    });

    it('should emit finding-updated event', () => {
      const finding = store.addFinding('/test/file.ts', 1, 'Error', 'error');
      const listener = vi.fn();
      store.on('finding-updated', listener);

      store.updateFindingStatus(finding!.id, 'apply');

      expect(listener).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        findingId: finding!.id,
        action: 'apply',
      });
    });

    it('should update file status to reviewed when all findings processed', () => {
      store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/file.ts', 2, 'Error 2', 'warning');

      store.updateFindingStatus(store.getFindingsForFile('/test/file.ts')[0].id, 'apply');
      store.updateFindingStatus(store.getFindingsForFile('/test/file.ts')[1].id, 'dismiss');

      const files = store.getFilesForSession();
      expect(files[0].status).toBe('reviewed');
    });

    it('should return false for non-existent finding', () => {
      expect(store.updateFindingStatus('non-existent', 'apply')).toBe(false);
    });
  });

  describe('setFileFailed', () => {
    it('should set file status to failed', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');

      const result = store.setFileFailed('/test/file.ts');

      expect(result).toBe(true);
      expect(store.getFilesForSession()[0].status).toBe('failed');
    });

    it('should emit file-status-changed event', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');
      const listener = vi.fn();
      store.on('file-status-changed', listener);

      store.setFileFailed('/test/file.ts');

      expect(listener).toHaveBeenCalledWith({
        sessionId: expect.any(String),
        filePath: '/test/file.ts',
        status: 'failed',
      });
    });

    it('should return false if no active session', () => {
      const result = store.setFileFailed('/test/file.ts');
      expect(result).toBe(false);
    });

    it('should return false if file does not exist', () => {
      store.createSession('file');
      const result = store.setFileFailed('/nonexistent/file.ts');
      expect(result).toBe(false);
    });

    it('should return true if file is already failed', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');
      store.setFileFailed('/test/file.ts');

      const result = store.setFileFailed('/test/file.ts');
      expect(result).toBe(true);
    });
  });

  describe('getFilesForSession', () => {
    it('should return empty array when no session', () => {
      expect(store.getFilesForSession()).toEqual([]);
    });

    it('should return all files with their findings', () => {
      store.createSession('branch');
      store.addFinding('/test/a.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/b.ts', 5, 'Error 2', 'warning');

      const files = store.getFilesForSession();
      expect(files).toHaveLength(2);
    });
  });

  describe('getFindingsForFile', () => {
    it('should return findings for specific file', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/file.ts', 5, 'Error 2', 'warning');

      const findings = store.getFindingsForFile('/test/file.ts');
      expect(findings).toHaveLength(2);
    });

    it('should return empty array for file with no findings', () => {
      store.createSession('file');
      expect(store.getFindingsForFile('/test/nonexistent.ts')).toEqual([]);
    });
  });

  describe('getPendingFindingsCount', () => {
    it('should return 0 when no session', () => {
      expect(store.getPendingFindingsCount()).toBe(0);
    });

    it('should return count of pending findings', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error 1', 'error');
      store.addFinding('/test/file.ts', 2, 'Error 2', 'warning');

      expect(store.getPendingFindingsCount()).toBe(2);

      store.updateFindingStatus(store.getFindingsForFile('/test/file.ts')[0].id, 'dismiss');
      expect(store.getPendingFindingsCount()).toBe(1);
    });
  });

  describe('clearActiveSession', () => {
    it('should clear active session', () => {
      store.createSession('file');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');

      store.clearActiveSession();

      expect(store.getActiveSession()).toBeNull();
      expect(store.getFilesForSession()).toEqual([]);
    });

    it('should emit session-cleared event', () => {
      store.createSession('file');
      const listener = vi.fn();
      store.on('session-cleared', listener);

      store.clearActiveSession();

      expect(listener).toHaveBeenCalledWith({ sessionId: expect.any(String) });
    });

    it('should do nothing when no active session', () => {
      expect(() => store.clearActiveSession()).not.toThrow();
    });

    it('should not affect session history when clearing active session', () => {
      store.createSession('staged', 'Historical Review');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');
      store.updateSessionStatus('completed');

      expect(store.getSessionHistory()).toHaveLength(1);
      expect(store.getSessionHistory()[0].title).toBe('Historical Review');

      store.createSession('file', 'Active Review');
      store.clearActiveSession();

      const history = store.getSessionHistory();
      expect(history).toHaveLength(1);
      expect(history[0].title).toBe('Historical Review');
    });
  });

  describe('getSessionHistory', () => {
    it('should return empty array initially', () => {
      expect(store.getSessionHistory()).toEqual([]);
    });

    it('should return completed sessions', () => {
      store.createSession('staged', 'Review 1');
      store.updateSessionStatus('settingUp');
      store.updateSessionStatus('analyzing');
      store.updateSessionStatus('reviewing');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');
      store.updateSessionStatus('completed');

      store.createSession('branch', 'Review 2');
      store.updateSessionStatus('settingUp');
      store.updateSessionStatus('analyzing');
      store.updateSessionStatus('reviewing');
      store.updateSessionStatus('completed');

      const history = store.getSessionHistory();
      expect(history).toHaveLength(2);
      expect(history[0].title).toBe('Review 2');
      expect(history[1].title).toBe('Review 1');
    });

    it('should limit history to 10 entries', () => {
      for (let i = 0; i < 15; i++) {
        store.createSession('file', `Review ${i}`);
        store.addFinding('/test/file.ts', i, 'Error', 'error');
        store.updateSessionStatus('completed');
      }

      const history = store.getSessionHistory();
      expect(history).toHaveLength(10);
      expect(history[0].title).toBe('Review 14');
    });

    it('should record duration and findings count', () => {
      store.createSession('staged', 'Test Review');
      store.updateSessionStatus('settingUp');
      store.addFinding('/test/file.ts', 1, 'Error', 'error');
      store.updateSessionStatus('completed');

      const history = store.getSessionHistory();
      expect(history[0].findingsCount).toBe(1);
      expect(history[0].duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clearHistory', () => {
    it('should clear session history', () => {
      store.createSession('file', 'Review 1');
      store.updateSessionStatus('completed');

      store.clearHistory();

      expect(store.getSessionHistory()).toEqual([]);
    });
  });
});

describe('ReviewSession type exports', () => {
  it('should have correct ReviewSession structure', () => {
    const session: ReviewSession = {
      id: 'test-session',
      title: 'Test Session',
      status: 'idle',
      reviewType: 'file',
      startedAt: Date.now(),
      files: new Map(),
      findings: [],
      totalFindings: 0,
    };

    expect(session.status).toBe('idle');
    expect(session.reviewType).toBe('file');
  });

  it('should have correct ReviewFinding structure', () => {
    const finding: ReviewFinding = {
      id: 'finding-1',
      file: '/test/file.ts',
      line: 10,
      message: 'Test error',
      severity: 'error',
      status: 'pending',
      createdAt: Date.now(),
    };

    expect(finding.status).toBe('pending');
  });

  it('should have correct ReviewFile structure', () => {
    const file: ReviewFile = {
      path: '/test/file.ts',
      status: 'pending',
      findings: [],
    };

    expect(file.status).toBe('pending');
  });

  it('should have correct ReviewHistoryEntry structure', () => {
    const entry: ReviewHistoryEntry = {
      sessionId: 'session-1',
      title: 'Test',
      reviewType: 'file',
      completedAt: Date.now(),
      findingsCount: 5,
      duration: 1000,
    };

    expect(entry.findingsCount).toBe(5);
  });

  it('should allow ReviewStatus values', () => {
    const statuses: ReviewStatus[] = ['idle', 'settingUp', 'analyzing', 'reviewing', 'completed', 'failed'];

    statuses.forEach(status => {
      const session: ReviewSession = {
        id: 'test',
        title: 'Test',
        status,
        reviewType: 'file',
        startedAt: Date.now(),
        files: new Map(),
        findings: [],
        totalFindings: 0,
      };
      expect(session.status).toBe(status);
    });
  });
});
