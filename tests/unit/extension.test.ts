import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCodeIndexAutoEnableDefault: vi.fn(),
  getCodeIndexFeatureEnabled: vi.fn(),
  getWorkspaceCodeIndexEnabled: vi.fn(),
  getInstance: vi.fn(),
  bindWorkspace: vi.fn(),
  initializeManager: vi.fn().mockResolvedValue(undefined),
  getManagerState: vi.fn(() => ({
    status: 'standby',
    message: 'Code indexing is disabled',
    indexedFiles: 0,
    pendingFiles: 0,
    featureEnabled: false,
    configured: false,
    enabled: false,
    autoEnableDefault: true,
    workspaceEnabled: false,
    workspaceRoot: '/repo',
    storagePath: '/repo/.global/code-index/repo',
    vectorStoreUrl: 'http://localhost:6333',
    setup: {
      embedderProvider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'nomic-embed-text',
      modelDimension: 768,
      qdrantUrl: 'http://localhost:6333',
      qdrantApiKey: '',
      qdrantApiKeyConfigured: false,
      searchMinScore: 0.4,
      searchMaxResults: 50,
    },
  })),
  onManagerState: vi.fn(() => ({ dispose: vi.fn() })),
  disposeCodeIndex: vi.fn(),
  initializeCodeIndexSettingsState: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
    onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
      inspect: vi.fn(() => ({ workspaceValue: undefined, workspaceFolderValue: undefined })),
      update: vi.fn(),
    })),
  },
  window: {
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
    registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
    createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBarItem: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
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
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
}));

vi.mock('../../src/settings', () => ({
  getSettings: mocks.getSettings,
  getCodeIndexAutoEnableDefault: mocks.getCodeIndexAutoEnableDefault,
  getCodeIndexFeatureEnabled: mocks.getCodeIndexFeatureEnabled,
  getWorkspaceCodeIndexEnabled: mocks.getWorkspaceCodeIndexEnabled,
  initializeCodeIndexSettingsState: mocks.initializeCodeIndexSettingsState,
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
    mocks.getCodeIndexAutoEnableDefault.mockReturnValue(true);
    mocks.getCodeIndexFeatureEnabled.mockReturnValue(false);
    mocks.getWorkspaceCodeIndexEnabled.mockReturnValue(false);
    mocks.getInstance.mockReturnValue({
      bindWorkspace: mocks.bindWorkspace,
      initialize: mocks.initializeManager,
      getState: mocks.getManagerState,
      onDidChangeState: mocks.onManagerState,
      dispose: mocks.disposeCodeIndex,
    });
  });

  it('does not activate the workspace orchestrator when indexing is disabled', async () => {
    const { activate } = await import('../../src/extension');

    activate({
      extensionUri: { fsPath: '/test/extension' },
      globalStorageUri: { fsPath: '/repo/.global' },
      globalState: {
        get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
        update: vi.fn().mockResolvedValue(undefined),
      },
      workspaceState: {
        get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
        update: vi.fn().mockResolvedValue(undefined),
      },
      secrets: {
        get: vi.fn().mockResolvedValue(undefined),
        store: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      subscriptions: [],
    } as any);

    expect(mocks.getInstance).toHaveBeenCalledTimes(1);
    expect(mocks.initializeCodeIndexSettingsState).toHaveBeenCalledTimes(1);
    expect(mocks.bindWorkspace).toHaveBeenCalledTimes(1);
  });
});
