import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => {
  class MockRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
      this.start = { line: startLine, character: startChar };
      this.end = { line: endLine, character: endChar };
    }
  }

  class MockMarkdownString {
    isTrusted = true;
    supportHtml = false;
    appendMarkdown = vi.fn();
    appendCodeblock = vi.fn();
  }

  class MockDisposable {
    dispose = vi.fn();
  }

  const mockThread = {
    comments: [],
    canReply: false,
    label: '',
    collapsibleState: 2,
    dispose: vi.fn(),
  };

  const mockController = {
    createCommentThread: vi.fn().mockReturnValue(mockThread),
    dispose: vi.fn(),
    commentingRangeProvider: undefined,
  };

  return {
    window: {
      withProgress: vi.fn().mockImplementation(async (options: any, callback: Function) => {
        return callback({ report: vi.fn() }, { isCancellationRequested: false });
      }),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInputBox: vi.fn(),
      activeTextEditor: null,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    Uri: {
      file: vi.fn().mockImplementation((path: string) => ({
        fsPath: path,
        toString: () => path,
      })),
      joinPath: vi.fn(),
    },
    Range: MockRange,
    ProgressLocation: {
      Notification: 1,
    },
    CommentMode: {
      Preview: 1,
    },
    CommentThreadCollapsibleState: {
      Expanded: 2,
      Collapsed: 1,
    },
    comments: {
      createCommentController: vi.fn().mockReturnValue(mockController),
    },
    Comment: vi.fn(),
    MarkdownString: MockMarkdownString,
    commands: {
      registerCommand: vi.fn().mockReturnValue(new MockDisposable()),
    },
    Disposable: MockDisposable,
  };
});

import { ReviewCommentController } from '../../src/comments';
import { ReviewOrchestrator } from '../../src/reviewOrchestrator';
import { ReviewSessionStore, createReviewSessionStore, resetReviewSessionStore } from '../../src/store/reviewSessionStore';
import { ReviewComment, ReviewStatus } from '../../src/types/review';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ReviewOrchestrator', () => {
  let orchestrator: ReviewOrchestrator;
  let mockContext: any;
  let controller: ReviewCommentController;
  let mockController: any;
  let store: ReviewSessionStore;
  let mockGetProvider: () => any;

  beforeEach(() => {
    vi.clearAllMocks();
    resetReviewSessionStore();
    store = createReviewSessionStore();

    mockController = {
      createCommentThread: vi.fn().mockReturnValue({
        comments: [],
        canReply: false,
        label: '',
        collapsibleState: 2,
        dispose: vi.fn(),
      }),
      dispose: vi.fn(),
      commentingRangeProvider: undefined,
    };

    (vscode.comments.createCommentController as any).mockReturnValue(mockController);

    mockContext = {
      subscriptions: [] as any[],
      workspaceState: {
        get: vi.fn(),
        update: vi.fn(),
      },
    };

    controller = new ReviewCommentController(mockContext);

    mockGetProvider = vi.fn().mockReturnValue({
      review: vi.fn().mockResolvedValue({ comments: [] }),
      cancel: vi.fn(),
      isAvailable: vi.fn().mockResolvedValue(true),
    });

    orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);
  });

  describe('store integration', () => {
    it('should create session and update status through store', async () => {
      const statusChanges: ReviewStatus[] = [];
      store.on('status-changed', (data: { status: ReviewStatus }) => {
        statusChanges.push(data.status);
      });

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [{ file: '/test/file.ts', line: 1, message: 'Error' }],
      });

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()).not.toBeNull();
      expect(statusChanges).toContain('settingUp');
      expect(statusChanges).toContain('analyzing');
      expect(statusChanges).toContain('reviewing');
      expect(statusChanges).toContain('completed');
    });

    it('should publish findings to store', async () => {
      const findingsAdded: any[] = [];
      store.on('finding-added', (data: any) => {
        findingsAdded.push(data.finding);
      });

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [
          { file: '/test/file.ts', line: 1, message: 'Error 1', severity: 'error' },
          { file: '/test/file.ts', line: 5, message: 'Error 2', severity: 'warning' },
        ],
      });

      await orchestrator.reviewFile(mockDoc);

      expect(findingsAdded).toHaveLength(2);
      expect(findingsAdded[0].message).toBe('Error 1');
      expect(findingsAdded[1].message).toBe('Error 2');
    });

    it('should add findings from comments with correct severity', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [
          { file: '/test/file.ts', line: 1, message: 'Error', severity: 'error' },
          { file: '/test/file.ts', line: 2, message: 'Warning', severity: 'warning' },
          { file: '/test/file.ts', line: 3, message: 'Info', severity: 'info' },
          { file: '/test/file.ts', line: 4, message: 'Suggestion', severity: 'suggestion' },
        ],
      });

      await orchestrator.reviewFile(mockDoc);

      const session = store.getActiveSession();
      expect(session?.findings[0].severity).toBe('error');
      expect(session?.findings[1].severity).toBe('warning');
      expect(session?.findings[2].severity).toBe('info');
      expect(session?.findings[3].severity).toBe('suggestion');
    });

    it('should add findings with fix when provided', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [
          { file: '/test/file.ts', line: 1, message: 'Error', fix: 'const y = 2;' },
        ],
      });

      await orchestrator.reviewFile(mockDoc);

      const session = store.getActiveSession();
      expect(session?.findings[0].fix).toBe('const y = 2;');
    });

    it('should mark session as failed on error', async () => {
      const statusChanges: ReviewStatus[] = [];
      store.on('status-changed', (data: { status: ReviewStatus }) => {
        statusChanges.push(data.status);
      });

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockRejectedValueOnce(new Error('Provider error'));

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()?.status).toBe('failed');
      expect(store.getActiveSession()?.error).toBe('Provider error');
    });

    it('should clear active session on cancellation', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (vscode.window.withProgress as any).mockImplementationOnce(async (options: any, callback: Function) => {
        return callback({ report: vi.fn() }, { isCancellationRequested: true });
      });

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()).toBeNull();
    });
  });

  describe('progress states', () => {
    it('should transition through idle -> settingUp -> analyzing -> reviewing -> completed', async () => {
      const statusChanges: ReviewStatus[] = [];
      store.on('status-changed', (data: { status: ReviewStatus }) => {
        statusChanges.push(data.status);
      });

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [{ file: '/test/file.ts', line: 1, message: 'Error' }],
      });

      await orchestrator.reviewFile(mockDoc);

      expect(statusChanges).toEqual(['settingUp', 'analyzing', 'reviewing', 'completed']);
    });

    it('should set session to failed when error occurs', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockRejectedValueOnce(new Error('Test error'));

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()?.status).toBe('failed');
    });

    it('should set error message on session when provider fails', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockRejectedValueOnce(new Error('Provider failed'));

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()?.error).toBe('Provider failed');
    });
  });

  describe('empty result handling', () => {
    it('should complete session without findings when no issues found', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({ comments: [] });

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()?.status).toBe('completed');
      expect(store.getActiveSession()?.findings).toHaveLength(0);
    });

    it('should show info message when no issues found', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({ comments: [] });

      await orchestrator.reviewFile(mockDoc);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No issues found in the code');
    });
  });

  describe('clearActiveReview', () => {
    it('should clear both store session and comments', async () => {
      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [{ file: '/test/file.ts', line: 1, message: 'Error' }],
      });

      await orchestrator.reviewFile(mockDoc);
      expect(store.getActiveSession()).not.toBeNull();

      orchestrator.clearActiveReview();

      expect(store.getActiveSession()).toBeNull();
    });

    it('should cancel in-flight providers before clearing the session', async () => {
      const deferred = createDeferred<{ comments: never[] }>();
      const provider = {
        review: vi.fn().mockReturnValue(deferred.promise),
        cancel: vi.fn(() => deferred.reject(new Error('Review cancelled'))),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      const reviewPromise = orchestrator.reviewFile(mockDoc);
      await Promise.resolve();

      orchestrator.clearActiveReview();
      await reviewPromise;

      expect(provider.cancel).toHaveBeenCalledTimes(1);
      expect(store.getActiveSession()).toBeNull();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('ReviewMP Error: Review cancelled');
    });

    it('should cancel stale providers before starting a new review', async () => {
      const firstDeferred = createDeferred<{ comments: never[] }>();
      const firstProvider = {
        review: vi.fn().mockReturnValue(firstDeferred.promise),
        cancel: vi.fn(() => firstDeferred.reject(new Error('Review cancelled'))),
        isAvailable: vi.fn().mockResolvedValue(true),
      };
      const secondProvider = {
        review: vi.fn().mockResolvedValue({ comments: [] }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi
        .fn()
        .mockReturnValueOnce(firstProvider)
        .mockReturnValueOnce(secondProvider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      const mockDoc = {
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any;

      const firstReviewPromise = orchestrator.reviewFile(mockDoc);
      await Promise.resolve();

      await orchestrator.reviewFile(mockDoc);
      await firstReviewPromise;

      expect(firstProvider.cancel).toHaveBeenCalledTimes(1);
      expect(secondProvider.review).toHaveBeenCalledTimes(1);
      expect(store.getActiveSession()?.status).toBe('completed');
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('ReviewMP Error: Review cancelled');
    });
  });

  describe('reviewGitChanges', () => {
    it('should create session for git-based review type', () => {
      const session = store.createSession('staged');
      expect(session.reviewType).toBe('staged');

      const branchSession = store.createSession('branch', 'Branch Review', 'feature-branch');
      expect(branchSession.reviewType).toBe('branch');
      expect(branchSession.branch).toBe('feature-branch');
    });
  });
});

describe('ReviewCommentController', () => {
  let mockContext: any;
  let controller: ReviewCommentController;
  let mockController: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockController = {
      createCommentThread: vi.fn().mockReturnValue({
        comments: [],
        canReply: false,
        label: '',
        collapsibleState: 2,
        dispose: vi.fn(),
      }),
      dispose: vi.fn(),
      commentingRangeProvider: undefined,
    };

    (vscode.comments.createCommentController as any).mockReturnValue(mockController);

    mockContext = {
      subscriptions: [] as any[],
      workspaceState: {
        get: vi.fn(),
        update: vi.fn(),
      },
    };

    controller = new ReviewCommentController(mockContext);
  });

  describe('addComments', () => {
    it('should clear existing comments for the same file before adding new ones', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      controller.addComments(mockUri, [
        { file: '/test/file.ts', line: 1, message: 'First comment' },
      ]);

      const firstCallThreadCount = mockController.createCommentThread.mock.calls.length;

      controller.addComments(mockUri, [
        { file: '/test/file.ts', line: 2, message: 'Second comment' },
      ]);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(firstCallThreadCount + 1);
    });

    it('should create comment threads with correct severity labels', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const comments: ReviewComment[] = [
        { file: '/test/file.ts', line: 1, message: 'Error comment', severity: 'error' },
        { file: '/test/file.ts', line: 2, message: 'Warning comment', severity: 'warning' },
        { file: '/test/file.ts', line: 3, message: 'Info comment', severity: 'info' },
        { file: '/test/file.ts', line: 4, message: 'Suggestion comment', severity: 'suggestion' },
      ];

      controller.addComments(mockUri, comments);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(4);
    });

    it('should handle comments with and without fixes', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const comments: ReviewComment[] = [
        { file: '/test/file.ts', line: 1, message: 'With fix', fix: 'const x = 1;' },
        { file: '/test/file.ts', line: 2, message: 'Without fix' },
      ];

      controller.addComments(mockUri, comments);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(2);
    });

    it('should create threads with correct line numbers', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const comments: ReviewComment[] = [
        { file: '/test/file.ts', line: 10, message: 'Comment at line 10' },
      ];

      controller.addComments(mockUri, comments);

      expect(mockController.createCommentThread).toHaveBeenCalled();
      const call = mockController.createCommentThread.mock.calls[0];
      expect(call[0]).toBe(mockUri);
      expect(call[1].start.line).toBe(10);
      expect(call[1].end.line).toBe(10);
      expect(call[2]).toEqual([]);
    });
  });

  describe('clearCommentsForFile', () => {
    it('should clear threads for a specific file', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      controller.addComments(mockUri, [
        { file: '/test/file.ts', line: 1, message: 'Comment' },
      ]);

      controller.clearCommentsForFile(mockUri);

      const thread = mockController.createCommentThread.mock.results[0].value;
      expect(thread.dispose).toHaveBeenCalled();
    });
  });

  describe('clearAllComments', () => {
    it('should clear all comment threads', () => {
      const mockUri1 = { fsPath: '/test/file1.ts', toString: () => '/test/file1.ts' } as any;
      const mockUri2 = { fsPath: '/test/file2.ts', toString: () => '/test/file2.ts' } as any;

      controller.addComments(mockUri1, [
        { file: '/test/file1.ts', line: 1, message: 'Comment 1' },
      ]);

      controller.addComments(mockUri2, [
        { file: '/test/file2.ts', line: 1, message: 'Comment 2' },
      ]);

      controller.clearAllComments();

      const thread1 = mockController.createCommentThread.mock.results[0].value;
      const thread2 = mockController.createCommentThread.mock.results[1].value;
      expect(thread1.dispose).toHaveBeenCalled();
      expect(thread2.dispose).toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('should dispose controller on cleanup', () => {
      controller.dispose();
      expect(mockController.dispose).toHaveBeenCalled();
    });
  });
});

describe('ReviewComment data structure', () => {
  it('should have correct ReviewComment interface fields', () => {
    const comment: ReviewComment = {
      file: 'src/test.ts',
      line: 10,
      message: 'Test error',
      severity: 'error',
      fix: 'const x = 1;',
    };

    expect(comment.file).toBe('src/test.ts');
    expect(comment.line).toBe(10);
    expect(comment.message).toBe('Test error');
    expect(comment.severity).toBe('error');
    expect(comment.fix).toBe('const x = 1;');
  });

  it('should allow optional severity', () => {
    const comment: ReviewComment = {
      file: 'src/test.ts',
      line: 10,
      message: 'Test error',
    };

    expect(comment.severity).toBeUndefined();
  });

  it('should allow optional fix', () => {
    const comment: ReviewComment = {
      file: 'src/test.ts',
      line: 10,
      message: 'Test error',
      severity: 'warning',
    };

    expect(comment.fix).toBeUndefined();
  });
});

describe('ReviewRequest structure', () => {
  it('should have correct ReviewRequest interface fields for file review', () => {
    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: '/test/file.ts',
      reviewType: 'file' as const,
    };

    expect(request.code).toBe('const x = 1;');
    expect(request.languageId).toBe('typescript');
    expect(request.filePath).toBe('/test/file.ts');
    expect(request.reviewType).toBe('file');
  });

  it('should have correct ReviewRequest interface fields for selection review', () => {
    const request = {
      code: 'selected text',
      languageId: 'typescript',
      filePath: '/test/file.ts',
      reviewType: 'selection' as const,
      startLine: 5,
    };

    expect(request.reviewType).toBe('selection');
    expect(request.startLine).toBe(5);
  });

  it('should have correct ReviewRequest interface fields for diff review', () => {
    const request = {
      code: '',
      languageId: '',
      filePath: '',
      reviewType: 'staged' as const,
      diff: 'formatted diff content',
    };

    expect(request.reviewType).toBe('staged');
    expect(request.diff).toBe('formatted diff content');
  });
});
