import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getInstance: vi.fn(),
  activateWorkspace: vi.fn(),
  disposeCodeIndex: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
    createWebviewPanel: vi.fn(() => ({
      webview: {
        html: '',
        postMessage: vi.fn(),
        onDidReceiveMessage: vi.fn(),
      },
      title: '',
      reveal: vi.fn(),
      onDidDispose: vi.fn(),
      dispose: vi.fn(),
    })),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  comments: {
    createCommentController: vi.fn(() => ({
      createCommentThread: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  StatusBarAlignment: { Right: 2 },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath })),
    joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') })),
  },
  Range: class {},
  MarkdownString: class {
    appendMarkdown = vi.fn();
    appendCodeblock = vi.fn();
  },
  CommentMode: { Preview: 1 },
  CommentThreadCollapsibleState: { Expanded: 2, Collapsed: 1 },
  OverviewRulerLane: { Center: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeColor: class { constructor(public id: string) {} },
  ThemeIcon: class { constructor(public id: string) {} },
  ViewColumn: { Active: 1 },
  EventEmitter: class<T> {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock('../../src/settings', () => ({
  getSettings: mocks.getSettings,
  logDebug: vi.fn(),
  registerSettingsCommands: vi.fn(),
  showDebugLogs: vi.fn(),
}));

vi.mock('../../src/services/code-index/manager', () => ({
  CodeIndexManager: {
    getInstance: mocks.getInstance,
  },
}));

describe('extension activation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getSettings.mockReturnValue({
      runtime: 'opencode',
      model: '',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      codeIndexEnabled: false,
      executableOverride: '',
      extraArgs: '',
    });
    mocks.getInstance.mockReturnValue({
      activateWorkspace: mocks.activateWorkspace,
      dispose: mocks.disposeCodeIndex,
    });
  });

  it('does not activate the workspace orchestrator when indexing is disabled', async () => {
    const { activate } = await import('../../src/extension');

    activate({ extensionUri: { fsPath: '/test/extension' }, subscriptions: [] } as any);

    expect(mocks.getInstance).toHaveBeenCalledTimes(1);
    expect(mocks.activateWorkspace).not.toHaveBeenCalled();
  });
});
