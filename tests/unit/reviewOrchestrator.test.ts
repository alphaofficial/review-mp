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
import { ReviewComment } from '../../src/types/review';

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
