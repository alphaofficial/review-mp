/// <reference types="node" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
      joinPath: vi.fn().mockImplementation((base: { fsPath: string }, ...segments: string[]) => {
        const fsPath = [base.fsPath, ...segments].join('/').replace(/\/+/g, '/');
        return {
          fsPath,
          toString: () => fsPath,
        };
      }),
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
import { RepoKnowledgeIndex } from '../../src/harness/repoKnowledgeIndex';
import { computeFileReviewFingerprint } from '../../src/harness/reviewFingerprint';
import { ReviewOrchestrator } from '../../src/reviewOrchestrator';
import { ReviewSessionStore, createReviewSessionStore, resetReviewSessionStore } from '../../src/store/reviewSessionStore';
import { ReviewComment, ReviewFinding, ReviewStatus } from '../../src/types/review';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error('Timed out waiting for condition');
}

describe('ReviewOrchestrator', () => {
  const tempRoots: string[] = [];
  let orchestrator: ReviewOrchestrator;
  let mockContext: any;
  let controller: ReviewCommentController;
  let mockController: any;
  let store: ReviewSessionStore;
  let mockGetProvider: () => any;

  beforeEach(() => {
    vi.clearAllMocks();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/test/workspace' } }];
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

  function createTempWorkspaceFromFixtures(subdirectory: string): string {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-orchestrator-'));
    tempRoots.push(tempRoot);
    const source = path.join(process.cwd(), 'tests', 'integration', 'fixtures', subdirectory);
    const target = path.join(tempRoot, subdirectory);
    cpSync(source, target, { recursive: true });
    return tempRoot;
  }

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

    it('switches to reviewing before the provider resolves', async () => {
      const deferred = createDeferred<{ comments: ReviewComment[]; provider: string }>();
      const provider = {
        review: vi.fn().mockReturnValue(deferred.promise),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      const reviewPromise = orchestrator.reviewFile({
        getText: () => 'const x = 1;',
        languageId: 'typescript',
        uri: { fsPath: '/test/file.ts' },
      } as any);

      await waitForCondition(() => provider.review.mock.calls.length === 1);

      expect(store.getActiveSession()?.status).toBe('reviewing');

      deferred.resolve({ comments: [], provider: 'test' });
      await reviewPromise;
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

    it('reuses exact cached file review findings without invoking the provider', async () => {
      const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];

      const relativePath = path.join('retrieval', 'service.ts');
      const absolutePath = path.join(workspaceRoot, relativePath);
      const code = readFileSync(absolutePath, 'utf8');
      const reviewFingerprint = computeFileReviewFingerprint(absolutePath, code);
      const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

      await index.upsertExactReviewRun({
        id: reviewFingerprint,
        reviewFingerprint,
        targetKind: 'file',
        filePaths: JSON.stringify([relativePath]),
        unitFingerprints: JSON.stringify([reviewFingerprint]),
        findingCount: 1,
        status: 'completed',
      });
      await index.upsertExactReviewUnit({
        id: reviewFingerprint,
        unitFingerprint: reviewFingerprint,
        reviewFingerprint,
        targetKind: 'file',
        filePaths: JSON.stringify([relativePath]),
        findingCount: 1,
      });
      await index.replaceExactReviewFindings(reviewFingerprint, [{
        id: `${reviewFingerprint}:cached-finding`,
        reviewFingerprint,
        unitFingerprint: reviewFingerprint,
        findingKey: 'cached-finding',
        filePath: relativePath,
        line: 1,
        title: 'Cached issue',
        message: 'Use the cached review result',
        fix: '',
        severity: 'warning',
        outcome: 'pending',
      }]);

      const provider = mockGetProvider() as any;
      await orchestrator.reviewFile({
        getText: () => code,
        languageId: 'typescript',
        uri: { fsPath: absolutePath },
      } as any);

      expect(provider.review).not.toHaveBeenCalled();
      expect(store.getActiveSession()?.reviewFingerprint).toBe(reviewFingerprint);
      expect(store.getActiveSession()?.findings[0]?.message).toBe('Use the cached review result');
    });

    it('filters unsupported type-property findings before surfacing them', async () => {
      const code = `type MockSwipeableProps = {
  children?: React.ReactNode
  renderRightActions?: (
    progress: { value: number },
    drag: { value: number },
    swipeable: null
  ) => React.ReactNode
}

const Swipeable = React.forwardRef(
  (
    { children, renderRightActions }: MockSwipeableProps,
    _ref: React.Ref<unknown>
  ) => null
)`;

      const mockDoc = {
        getText: () => code,
        languageId: 'typescriptreact',
        uri: { fsPath: '/test/ReanimatedSwipeable.tsx' },
      } as any;

      (mockGetProvider() as any).review.mockResolvedValueOnce({
        comments: [
          {
            file: '/test/ReanimatedSwipeable.tsx',
            line: 11,
            title: 'Destructured property not in type',
            message: 'The function destructures renderRightActions from MockSwipeableProps, but the property does not exist in the type.',
            severity: 'error',
          },
        ],
        provider: 'test',
      });

      await orchestrator.reviewFile(mockDoc);

      expect(store.getActiveSession()?.findings).toHaveLength(0);
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
      await waitForCondition(() => provider.review.mock.calls.length === 1);

      orchestrator.clearActiveReview();
      await reviewPromise;

      expect(provider.cancel).toHaveBeenCalledTimes(1);
      expect(store.getActiveSession()).toBeNull();
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('CodeBunny Error: Review cancelled');
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
      await waitForCondition(() => firstProvider.review.mock.calls.length === 1);

      await orchestrator.reviewFile(mockDoc);
      await firstReviewPromise;

      expect(firstProvider.cancel).toHaveBeenCalledTimes(1);
      expect(secondProvider.review).toHaveBeenCalledTimes(1);
      expect(store.getActiveSession()?.status).toBe('completed');
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith('CodeBunny Error: Review cancelled');
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

    it('reviews staged diffs one file at a time before runtime review', async () => {
      const makeFileSection = (filePath: string, line: string) => [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        '@@ -0,0 +1,1 @@',
        `${line}\n`.repeat(4000),
      ].join('\n');

      const formattedDiff = [
        makeFileSection('src/a.ts', '1: const first = true;'),
        makeFileSection('src/b.ts', '1: const second = true;'),
        makeFileSection('src/c.ts', '1: const third = true;'),
      ].join('\n');

      const provider = {
        review: vi
          .fn()
          .mockResolvedValueOnce({
            comments: [{ file: 'src/a.ts', line: 5, message: 'first file issue' }],
            provider: 'test',
          })
          .mockResolvedValueOnce({
            comments: [{ file: 'src/b.ts', line: 6, message: 'second file issue' }],
            provider: 'test',
          })
          .mockResolvedValueOnce({
            comments: [{ file: 'src/c.ts', line: 8, message: 'third file issue' }],
            provider: 'test',
          }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);
      (orchestrator as any).diffCollector = {
        getChangedFiles: vi.fn().mockResolvedValue(['src/a.ts', 'src/b.ts', 'src/c.ts']),
        getDiff: vi.fn().mockResolvedValue({
          diff: formattedDiff,
          formattedDiff,
        }),
      };

      await orchestrator.reviewStaged();

      expect(provider.review).toHaveBeenCalledTimes(3);
      const firstRequest = provider.review.mock.calls[0][0];
      const secondRequest = provider.review.mock.calls[1][0];
      const thirdRequest = provider.review.mock.calls[2][0];
      expect(firstRequest.reviewPackage?.target.kind).toBe('diff');
      expect(firstRequest.reviewPackage?.strictReviewOnly).toBe(true);
      expect(firstRequest.reviewPackage?.notes).toContain('Review only the supplied diff and supporting context.');
      expect(firstRequest.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
      expect(firstRequest.diff).not.toContain('diff --git a/src/b.ts b/src/b.ts');
      expect(firstRequest.reviewPackage?.target.content).toContain('diff --git a/src/a.ts b/src/a.ts');
      expect(secondRequest.diff).toContain('diff --git a/src/b.ts b/src/b.ts');
      expect(secondRequest.diff).not.toContain('diff --git a/src/c.ts b/src/c.ts');
      expect(thirdRequest.diff).toContain('diff --git a/src/c.ts b/src/c.ts');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'CodeBunny: Found 3 comment(s) in staged changes'
      );
    });

    it('includes referenced schema context for json file reviews', async () => {
      const schemaFixturePath = path.join(process.cwd(), 'tests', 'integration', 'fixtures', 'schema.json');
      const baseCode = readFileSync(schemaFixturePath, 'utf8');
      const code = `${baseCode}\n${' '.repeat(210000)}`;

      const provider = {
        review: vi.fn().mockImplementation(async (request: any) => {
          const relativeLine = request.code
            .split('\n')
            .findIndex((line: string) => line.includes('"additionalProperties": false'));

          return relativeLine >= 0
            ? {
                comments: [{ file: 'schema.json', line: relativeLine, message: 'target schema issue' }],
                provider: 'test',
              }
            : {
                comments: [],
                provider: 'test',
              };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      const mockDoc = {
        getText: () => code,
        languageId: 'json',
        uri: { fsPath: 'schema.json' },
      } as any;

      await orchestrator.reviewFile(mockDoc);

      expect(provider.review.mock.calls.length).toBe(1);
      expect(
        provider.review.mock.calls.some(
          (call) => call[0]?.reviewPackage?.target.kind === 'file'
            && call[0]?.reviewPackage?.scopeLabel.includes('File review')
        )
      ).toBe(true);
      expect(
        provider.review.mock.calls.some(
          (call) => call[0]?.crossFileContext?.includes('Referenced schema: Review')
        )
      ).toBe(true);

      const session = store.getActiveSession();
      const expectedLine = code.split('\n').findIndex((line) => line.includes('"additionalProperties": false'));
      expect(session?.findings.some((finding) => finding.line === expectedLine)).toBe(true);
    });

    it('preserves file line numbers for whole-file reviews', async () => {
      const code = `export function firstFeature() {
${'  const first = true;\n'.repeat(12000)}
}

export function secondFeature() {
  return false;
}`;
      const provider = {
        review: vi.fn().mockImplementation(async (request: any) => {
          const relativeLine = request.code
            .split('\n')
            .findIndex((line: string) => line.includes('secondFeature'));

          return {
            comments: relativeLine >= 0
              ? [{ file: 'src/features.ts', line: relativeLine, message: 'second feature issue' }]
              : [],
            provider: 'test',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      await orchestrator.reviewFile({
        getText: () => code,
        languageId: 'typescript',
        uri: { fsPath: 'src/features.ts' },
      } as any);

      const secondFeatureLine = code.split('\n').findIndex((line) => line.includes('secondFeature'));
      expect(store.getActiveSession()?.findings[0]?.line).toBe(secondFeatureLine);
    });

    it('adds selection start lines once for selection reviews', async () => {
      const selectedText = `export function selectedFirst() {
${'  const first = true;\n'.repeat(12000)}
}

export function selectedSecond() {
  return false;
}`;
      const provider = {
        review: vi.fn().mockImplementation(async (request: any) => {
          const relativeLine = request.code
            .split('\n')
            .findIndex((line: string) => line.includes('selectedSecond'));

          return {
            comments: relativeLine >= 0
              ? [{ file: 'src/features.ts', line: relativeLine, message: 'selected issue' }]
              : [],
            provider: 'test',
          };
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      await orchestrator.reviewSelection({ fsPath: 'src/features.ts' } as any, selectedText, 20, 'typescript');

      const selectedSecondLine = selectedText.split('\n').findIndex((line) => line.includes('selectedSecond'));
      const selectionRequest = provider.review.mock.calls[0][0];
      expect(selectionRequest.reviewPackage?.target.kind).toBe('selection');
      expect(selectionRequest.reviewPackage?.strictReviewOnly).toBe(true);
      expect(selectionRequest.reviewPackage?.target.startLine).toBe(20);
      expect(store.getActiveSession()?.findings[0]?.line).toBe(20 + selectedSecondLine);
    });

    it('retrieves unchanged helper and test context for ts/js file reviews', async () => {
      const fixtureRoot = createTempWorkspaceFromFixtures('retrieval');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: fixtureRoot } }];

      const code = `import { helper } from './helper';

export function firstFeature() {
${'  return helper();\n'.repeat(7000)}
}

export function secondFeature() {
${'  return helper();\n'.repeat(7000)}
}`;

      const provider = {
        review: vi.fn().mockResolvedValue({
          comments: [],
          provider: 'test',
        }),
        cancel: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
      };

      mockGetProvider = vi.fn().mockReturnValue(provider);
      orchestrator = new ReviewOrchestrator(mockGetProvider, controller, store);

      const mockDoc = {
        getText: () => code,
        languageId: 'typescript',
        uri: { fsPath: 'retrieval/service.ts' },
      } as any;

      await orchestrator.reviewFile(mockDoc);

      expect(provider.review.mock.calls.length).toBe(1);
      expect(
        provider.review.mock.calls.every(
          (call) => call[0]?.reviewPackage?.target.kind === 'file'
            && call[0]?.reviewPackage?.strictReviewOnly === true
        )
      ).toBe(true);
      expect(
        provider.review.mock.calls.some(
          (call) => call[0]?.crossFileContext?.includes('Related file: retrieval/helper.ts')
        )
      ).toBe(true);
      expect(
        provider.review.mock.calls.some(
          (call) => call[0]?.crossFileContext?.includes('Related file: retrieval/service.test.ts')
        )
      ).toBe(true);
    });

  });

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('ReviewCommentController', () => {
  let mockContext: any;
  let controller: ReviewCommentController;
  let mockController: any;
  let findingCounter = 0;

  const createFinding = (
    file: string,
    line: number,
    message: string,
    severity: ReviewFinding['severity'] = 'info',
    fix?: string
  ): ReviewFinding => ({
    id: `finding-${++findingCounter}`,
    file,
    line,
    message,
    severity,
    fix,
    status: 'pending',
    createdAt: Date.now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findingCounter = 0;

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

      const firstFinding = createFinding('/test/file.ts', 1, 'First comment');
      controller.addComments(mockUri, [firstFinding]);

      const firstCallThreadCount = mockController.createCommentThread.mock.calls.length;

      const secondFinding = createFinding('/test/file.ts', 2, 'Second comment');
      controller.addComments(mockUri, [secondFinding]);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(firstCallThreadCount + 1);
    });

    it('should create comment threads with correct severity labels', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const findings = [
        createFinding('/test/file.ts', 1, 'Error comment', 'error'),
        createFinding('/test/file.ts', 2, 'Warning comment', 'warning'),
        createFinding('/test/file.ts', 3, 'Info comment', 'info'),
        createFinding('/test/file.ts', 4, 'Suggestion comment', 'suggestion'),
      ];

      controller.addComments(mockUri, findings);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(4);
    });

    it('should handle comments with and without fixes', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const findings = [
        createFinding('/test/file.ts', 1, 'With fix', 'info', 'const x = 1;'),
        createFinding('/test/file.ts', 2, 'Without fix'),
      ];

      controller.addComments(mockUri, findings);

      expect(mockController.createCommentThread).toHaveBeenCalledTimes(2);
    });

    it('should create threads with correct line numbers', () => {
      const mockUri = { fsPath: '/test/file.ts', toString: () => '/test/file.ts' } as any;

      const finding = createFinding('/test/file.ts', 10, 'Comment at line 10');

      controller.addComments(mockUri, [finding]);

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

      const finding = createFinding('/test/file.ts', 1, 'Comment');
      controller.addComments(mockUri, [finding]);

      controller.clearCommentsForFile(mockUri);

      const thread = mockController.createCommentThread.mock.results[0].value;
      expect(thread.dispose).toHaveBeenCalled();
    });
  });

  describe('clearAllComments', () => {
    it('should clear all comment threads', () => {
      const mockUri1 = { fsPath: '/test/file1.ts', toString: () => '/test/file1.ts' } as any;
      const mockUri2 = { fsPath: '/test/file2.ts', toString: () => '/test/file2.ts' } as any;

      const finding1 = createFinding('/test/file1.ts', 1, 'Comment 1');
      controller.addComments(mockUri1, [finding1]);

      const finding2 = createFinding('/test/file2.ts', 1, 'Comment 2');
      controller.addComments(mockUri2, [finding2]);

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

  it('should allow a closed review package on ReviewRequest', () => {
    const request = {
      code: 'const value = helper();',
      languageId: 'typescript',
      filePath: '/test/file.ts',
      reviewType: 'file' as const,
      reviewPackage: {
        scopeLabel: 'file:/test/file.ts',
        strictReviewOnly: true,
        target: {
          kind: 'file' as const,
          label: 'Primary file under review',
          filePath: '/test/file.ts',
          languageId: 'typescript',
          content: 'const value = helper();',
        },
        supportingContext: [{
          label: 'Related file: /test/helper.ts',
          filePath: '/test/helper.ts',
          languageId: 'typescript',
          content: 'export function helper() { return true; }',
          reason: 'importedDependency' as const,
        }],
      },
    };

    expect(request.reviewPackage.strictReviewOnly).toBe(true);
    expect(request.reviewPackage.target.kind).toBe('file');
    expect(request.reviewPackage.supportingContext[0].reason).toBe('importedDependency');
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
