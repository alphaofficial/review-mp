import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCodeIndexAutoEnableDefault: vi.fn(),
  getCodeIndexFeatureEnabled: vi.fn(),
  getWorkspaceCodeIndexEnabled: vi.fn(),
  setCodeIndexAutoEnableDefault: vi.fn(),
  setCodeIndexEnabled: vi.fn(),
  setWorkspaceCodeIndexEnabled: vi.fn(),
  logDebug: vi.fn(),
  createOrchestrator: vi.fn(),
}));

vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(value: T) {
      this.listeners.forEach((listener) => listener(value));
    }
    dispose() {
      this.listeners = [];
    }
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    })),
  },
  ConfigurationTarget: {
    Workspace: 2,
  },
}));

vi.mock('../../src/settings', () => ({
  getCodeIndexAutoEnableDefault: mocks.getCodeIndexAutoEnableDefault,
  getCodeIndexFeatureEnabled: mocks.getCodeIndexFeatureEnabled,
  getWorkspaceCodeIndexEnabled: mocks.getWorkspaceCodeIndexEnabled,
  setCodeIndexAutoEnableDefault: mocks.setCodeIndexAutoEnableDefault,
  setCodeIndexEnabled: mocks.setCodeIndexEnabled,
  setWorkspaceCodeIndexEnabled: mocks.setWorkspaceCodeIndexEnabled,
  logDebug: mocks.logDebug,
}));

vi.mock('../../src/services/code-index/service-factory', () => ({
  CodeIndexServiceFactory: {
    createOrchestrator: mocks.createOrchestrator,
  },
}));

import { CodeIndexManager } from '../../src/services/code-index/manager';

describe('CodeIndexManager', () => {
  const setupState = {
    embedderProvider: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    modelDimension: 768,
    qdrantUrl: 'http://localhost:6333',
    qdrantApiKey: '',
    qdrantApiKeyConfigured: false,
    searchMinScore: 0.4,
    searchMaxResults: 50,
  };
  const resolvedSettings = {
    embedderProvider: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    modelDimension: 768,
    qdrantUrl: 'http://localhost:6333',
    searchMinScore: 0.4,
    searchMaxResults: 50,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCodeIndexAutoEnableDefault.mockReturnValue(true);
    mocks.getCodeIndexFeatureEnabled.mockReturnValue(false);
    mocks.getWorkspaceCodeIndexEnabled.mockReturnValue(false);
  });

  it('stays in disabled standby when the feature is off', async () => {
    const manager = new CodeIndexManager();

    manager.bindWorkspace('/repo', {
      getSetupState: vi.fn().mockResolvedValue(setupState),
      getResolvedSettings: vi.fn().mockResolvedValue(resolvedSettings),
    } as any);
    await manager.initialize();

    expect(manager.getState().message).toBe('Code indexing is disabled');
    expect(mocks.createOrchestrator).not.toHaveBeenCalled();
  });

  it('starts indexing when effectively enabled', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    mocks.getCodeIndexFeatureEnabled.mockReturnValue(true);
    mocks.getWorkspaceCodeIndexEnabled.mockReturnValue(true);
    mocks.createOrchestrator.mockResolvedValue({
      start,
      stop: vi.fn(),
      dispose: vi.fn(),
      getState: vi.fn().mockReturnValue({
        status: 'standby',
        message: 'Standby',
        indexedFiles: 0,
        pendingFiles: 0,
      }),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
    });

    const manager = new CodeIndexManager();
    manager.bindWorkspace('/repo', {
      getSetupState: vi.fn().mockResolvedValue(setupState),
      getResolvedSettings: vi.fn().mockResolvedValue(resolvedSettings),
    } as any);
    await manager.initialize();

    expect(mocks.createOrchestrator).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('enables the workspace and starts when startIndexing is requested', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    let workspaceEnabled = false;
    mocks.getCodeIndexFeatureEnabled.mockReturnValue(true);
    mocks.getWorkspaceCodeIndexEnabled.mockImplementation(() => workspaceEnabled);
    mocks.setWorkspaceCodeIndexEnabled.mockImplementation(async (enabled: boolean) => {
      workspaceEnabled = enabled;
    });
    mocks.createOrchestrator.mockResolvedValue({
      start,
      stop: vi.fn(),
      dispose: vi.fn(),
      getState: vi.fn().mockReturnValue({
        status: 'standby',
        message: 'Standby',
        indexedFiles: 0,
        pendingFiles: 0,
      }),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
    });

    const manager = new CodeIndexManager();
    manager.bindWorkspace('/repo', {
      getSetupState: vi.fn().mockResolvedValue(setupState),
      getResolvedSettings: vi.fn().mockResolvedValue(resolvedSettings),
    } as any);
    await manager.startIndexing();

    expect(mocks.setWorkspaceCodeIndexEnabled).toHaveBeenCalledWith(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('preserves indexed orchestrator state when rebinding the same workspace', async () => {
    const orchestratorState = {
      status: 'indexed',
      message: 'Indexed - File watcher started',
      indexedFiles: 12,
      pendingFiles: 0,
      lastIndexedAt: Date.now(),
    };
    const orchestrator = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
      dispose: vi.fn(),
      getState: vi.fn().mockReturnValue(orchestratorState),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
    };

    mocks.getCodeIndexFeatureEnabled.mockReturnValue(true);
    mocks.getWorkspaceCodeIndexEnabled.mockReturnValue(true);
    mocks.createOrchestrator.mockResolvedValue(orchestrator);

    const secretStore = {
      getSetupState: vi.fn().mockResolvedValue(setupState),
      getResolvedSettings: vi.fn().mockResolvedValue(resolvedSettings),
    } as any;

    const manager = new CodeIndexManager();
    manager.bindWorkspace('/repo', secretStore);
    await manager.initialize();

    expect(manager.getState().status).toBe('indexed');

    manager.bindWorkspace('/repo', secretStore);

    expect(manager.getState().status).toBe('indexed');
    expect(manager.getState().message).toBe('Indexed - File watcher started');
  });
});
