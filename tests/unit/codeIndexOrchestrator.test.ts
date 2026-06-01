/// <reference types="node" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WatcherHandler = (uri: { fsPath: string }) => void;

const watcherHandlers = {
  create: [] as WatcherHandler[],
  change: [] as WatcherHandler[],
  delete: [] as WatcherHandler[],
};

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire(value: T) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {
      this.listeners = [];
    }
  }

  return {
    EventEmitter,
    workspace: {
      createFileSystemWatcher: vi.fn().mockImplementation(() => ({
        onDidCreate: (handler: WatcherHandler) => watcherHandlers.create.push(handler),
        onDidChange: (handler: WatcherHandler) => watcherHandlers.change.push(handler),
        onDidDelete: (handler: WatcherHandler) => watcherHandlers.delete.push(handler),
        dispose: vi.fn(),
      })),
    },
  };
});

import { CodeIndexOrchestrator } from '../../src/services/code-index/orchestrator';

describe('CodeIndexOrchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watcherHandlers.create.length = 0;
    watcherHandlers.change.length = 0;
    watcherHandlers.delete.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds the workspace on startup so stale entries are reconciled', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue([
        '/repo/a.ts',
        '/repo/b.ts',
        '/repo/c.ts',
      ]),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index, {
      batchSize: 2,
      branchPollMs: 1_000,
    });

    await orchestrator.start();

    expect(index.rebuildWorkspace).toHaveBeenCalledTimes(1);
    expect(index.indexFiles).not.toHaveBeenCalled();
    expect(orchestrator.getState().status).toBe('indexed');
    orchestrator.dispose();
  });

  it('can be stopped after startup', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue(['/repo/a.ts']),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index);

    await orchestrator.start();
    orchestrator.stop();

    expect(orchestrator.getState().status).toBe('standby');
    expect(orchestrator.getState().message).toBe('Indexing stopped');
    orchestrator.dispose();
  });

  it('can rebuild on demand after startup', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue(['/repo/a.ts', '/repo/b.ts']),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index);

    await orchestrator.start();
    index.rebuildWorkspace.mockClear();
    await orchestrator.rebuild();

    expect(index.rebuildWorkspace).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe('indexed');
    orchestrator.dispose();
  });

  it('can clear index data on demand', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue(['/repo/a.ts']),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index);

    await orchestrator.start();
    await orchestrator.clearIndexData();

    expect(index.clearStorage).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().status).toBe('standby');
    expect(orchestrator.getState().indexedFiles).toBe(0);
    orchestrator.dispose();
  });

  it('ignores paths outside the workspace even when they share a prefix', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue([]),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo/app', index, {
      debounceMs: 25,
      branchPollMs: 1_000,
    });

    await orchestrator.start();
    watcherHandlers.change[0]({ fsPath: '/repo/application/src/a.ts' });

    await vi.advanceTimersByTimeAsync(30);

    expect(index.indexFiles).not.toHaveBeenCalled();
    orchestrator.dispose();
  });

  it('debounces file changes into incremental upserts', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue([]),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index, {
      debounceMs: 50,
      branchPollMs: 1_000,
    });

    await orchestrator.start();
    watcherHandlers.change[0]({ fsPath: '/repo/src/a.ts' });
    watcherHandlers.change[0]({ fsPath: '/repo/src/a.ts' });
    watcherHandlers.create[0]({ fsPath: '/repo/src/b.ts' });

    await vi.advanceTimersByTimeAsync(60);

    expect(index.indexFiles).toHaveBeenLastCalledWith(['src/a.ts', 'src/b.ts']);
    expect(index.removeFiles).not.toHaveBeenCalled();
    orchestrator.dispose();
  });

  it('processes deletes through incremental removal', async () => {
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue([]),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockReturnValue('main'),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index, {
      debounceMs: 25,
      branchPollMs: 1_000,
    });

    await orchestrator.start();
    watcherHandlers.delete[0]({ fsPath: '/repo/src/old.ts' });

    await vi.advanceTimersByTimeAsync(30);

    expect(index.removeFiles).toHaveBeenCalledWith(['src/old.ts']);
    orchestrator.dispose();
  });

  it('rebuilds the index when the git branch changes', async () => {
    let currentBranch = 'main';
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue(['/repo/a.ts']),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockImplementation(() => currentBranch),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index, {
      branchPollMs: 20,
    });

    await orchestrator.start();
    index.rebuildWorkspace.mockClear();
    currentBranch = 'feature';

    await vi.advanceTimersByTimeAsync(25);

    expect(index.rebuildWorkspace).toHaveBeenCalledTimes(1);
    orchestrator.dispose();
  });

  it('clears queued file updates before rebuilding for a branch change', async () => {
    let currentBranch = 'main';
    const index = {
      listWorkspaceFiles: vi.fn().mockReturnValue(['/repo/a.ts']),
      indexFiles: vi.fn().mockResolvedValue(undefined),
      removeFiles: vi.fn().mockResolvedValue(undefined),
      rebuildWorkspace: vi.fn().mockResolvedValue(undefined),
      clearStorage: vi.fn().mockResolvedValue(undefined),
      getCurrentBranch: vi.fn().mockImplementation(() => currentBranch),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    const orchestrator = new CodeIndexOrchestrator('/repo', index, {
      debounceMs: 50,
      branchPollMs: 20,
    });

    await orchestrator.start();
    index.rebuildWorkspace.mockClear();
    watcherHandlers.change[0]({ fsPath: '/repo/src/a.ts' });
    currentBranch = 'feature';

    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(50);

    expect(index.rebuildWorkspace).toHaveBeenCalledTimes(1);
    expect(index.indexFiles).not.toHaveBeenCalledWith(['src/a.ts']);
    expect(orchestrator.getState().pendingFiles).toBe(0);
    orchestrator.dispose();
  });
});
