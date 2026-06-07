import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { CodeIndexController } from '../../src/services/code-index/controller';

describe('CodeIndexController', () => {
  const state = {
    status: 'standby',
    message: 'Standby',
    indexedFiles: 0,
    pendingFiles: 0,
    featureEnabled: false,
    configured: false,
    enabled: false,
    autoEnableDefault: true,
    workspaceEnabled: true,
    workspaceRoot: '/repo',
    storagePath: '/repo/.codebunny/index',
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
  } as const;

  let manager: any;

  beforeEach(() => {
    manager = {
      bindWorkspace: vi.fn(),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
      getState: vi.fn(() => state),
      initialize: vi.fn().mockResolvedValue(undefined),
      getResolvedSetup: vi.fn().mockResolvedValue({
        embedderProvider: 'ollama',
        ollamaBaseUrl: 'http://localhost:11434',
        ollamaModel: 'nomic-embed-text',
        modelDimension: 768,
        qdrantUrl: 'http://localhost:6333',
        searchMinScore: 0.4,
        searchMaxResults: 50,
      }),
      setAutoEnableDefault: vi.fn().mockResolvedValue(undefined),
      setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
      saveSetup: vi.fn().mockResolvedValue(undefined),
      setFeatureEnabled: vi.fn().mockResolvedValue(undefined),
      startIndexing: vi.fn().mockResolvedValue(undefined),
      stopIndexing: vi.fn(),
      rebuildIndex: vi.fn().mockResolvedValue(undefined),
      clearIndexData: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('binds the workspace and returns manager state', () => {
    const controller = new CodeIndexController(manager, '/repo', {} as any);

    expect(manager.bindWorkspace).toHaveBeenCalledWith('/repo', {} as any);
    expect(controller.getState()).toEqual(state);
  });

  it('delegates start and stop actions to the manager', async () => {
    const controller = new CodeIndexController(manager, '/repo', {} as any);

    await controller.start();
    await controller.stop();

    expect(manager.startIndexing).toHaveBeenCalledTimes(1);
    expect(manager.stopIndexing).toHaveBeenCalledTimes(1);
  });

  it('delegates save and toggle actions to the manager', async () => {
    const controller = new CodeIndexController(manager, '/repo', {} as any);
    const payload = {
      featureEnabled: true,
      embedderProvider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'nomic-embed-text',
      modelDimension: 768,
      qdrantUrl: 'http://localhost:6333',
      qdrantApiKey: '',
      preserveQdrantApiKey: true,
      searchMinScore: 0.4,
      searchMaxResults: 50,
    } as const;

    await controller.saveSetup(payload);
    await controller.setAutoEnableDefault(false);
    await controller.setWorkspaceEnabled(true);
    await controller.setEnabled(true);

    expect(manager.saveSetup).toHaveBeenCalledWith(payload);
    expect(manager.setAutoEnableDefault).toHaveBeenCalledWith(false);
    expect(manager.setWorkspaceEnabled).toHaveBeenCalledWith(true);
    expect(manager.setFeatureEnabled).toHaveBeenCalledWith(true);
  });
});
