/// <reference types="node" />

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestModelProvider } from './helpers/testModelProvider';
import { TestRuntimeAdapter } from './helpers/testRuntimeAdapter';

const mockVscodeState = vi.hoisted(() => ({
  createdThreads: [] as Array<{
    uri: { fsPath: string; toString: () => string };
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    comments: unknown[];
    canReply: boolean;
    label: string;
    collapsibleState: number;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

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

  const mockCommentController = {
    createCommentThread: vi.fn((uri, range) => {
      const thread = {
        uri,
        range,
        comments: [],
        canReply: false,
        label: '',
        collapsibleState: 1,
        dispose: vi.fn(),
      };
      mockVscodeState.createdThreads.push(thread);
      return thread;
    }),
    dispose: vi.fn(),
    commentingRangeProvider: undefined,
  };

  return {
    window: {
      withProgress: vi.fn().mockImplementation(async (_options: unknown, callback: Function) => {
        return callback({ report: vi.fn() }, { isCancellationRequested: false });
      }),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      activeTextEditor: null,
      visibleTextEditors: [],
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    Uri: {
      file: vi.fn().mockImplementation((fsPath: string) => ({
        fsPath,
        toString: () => fsPath,
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
    MarkdownString: MockMarkdownString,
    CommentMode: {
      Preview: 1,
    },
    CommentThreadCollapsibleState: {
      Expanded: 2,
      Collapsed: 1,
    },
    ProgressLocation: {
      Notification: 1,
    },
    comments: {
      createCommentController: vi.fn().mockReturnValue(mockCommentController),
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue(new MockDisposable()),
    },
    Disposable: MockDisposable,
  };
});

import { ReviewCommentController } from '../../src/comments';
import { ReviewOrchestrator } from '../../src/reviewOrchestrator';
import { createReviewSessionStore, resetReviewSessionStore, ReviewSessionStore } from '../../src/store/reviewSessionStore';

const fixturePath = path.join(process.cwd(), 'tests', 'integration', 'fixtures', 'test.json');
function readFixture(): string {
  return readFileSync(fixturePath, 'utf8');
}

function getFeatureFlagLines(code: string): number[] {
  return code
    .split('\n')
    .flatMap((line, index) => (line.includes('"featureFlag": false,') ? [index + 1] : []));
}

describe('JSON file review line mapping', () => {
  let store: ReviewSessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVscodeState.createdThreads.length = 0;
    resetReviewSessionStore();
    store = createReviewSessionStore();
  });

  afterEach(() => {
    store.dispose();
  });

  it('applies the inline comment to the intended duplicated JSON key line', async () => {
    const code = readFixture();
    const [firstOccurrence, secondOccurrence] = getFeatureFlagLines(code);

    const context = {
      extensionUri: { fsPath: '/test/extension', toString: () => '/test/extension' },
      subscriptions: [],
    };

    // @ts-expect-error test-only mock implements the extension context surface this test uses
    const commentController = new ReviewCommentController(context, undefined, undefined, store);
    const orchestrator = new ReviewOrchestrator(
      () => new TestModelProvider(new TestRuntimeAdapter([
        {
          file: 'test.json',
          line: secondOccurrence - 1,
          message: 'Target duplicated JSON key.',
          severity: 'warning',
        },
      ])),
      commentController,
      store
    );

    const document = {
      getText: () => code,
      languageId: 'json',
      uri: { fsPath: 'test.json' },
    };

    // @ts-expect-error test-only mock implements the text document surface this test uses
    await orchestrator.reviewFile(document);

    expect(firstOccurrence).toBeDefined();
    expect(secondOccurrence).toBeDefined();
    expect(mockVscodeState.createdThreads).toHaveLength(1);

    const appliedThread = mockVscodeState.createdThreads[0];
    expect(appliedThread.uri.fsPath).toBe('test.json');
    expect(appliedThread.range.start.line).toBe(secondOccurrence - 1);
    expect(appliedThread.range.start.line).not.toBe(firstOccurrence - 1);
    expect(appliedThread.range.end.line).toBe(secondOccurrence - 1);
  });
});
