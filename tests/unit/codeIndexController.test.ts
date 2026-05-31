import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  setCodeIndexEnabled: vi.fn(),
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
}));

vi.mock('../../src/settings', () => ({
  getSettings: mocks.getSettings,
  setCodeIndexEnabled: mocks.setCodeIndexEnabled,
  logDebug: vi.fn(),
}));

import { CodeIndexController } from '../../src/services/code-index/controller';

describe('CodeIndexController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockReturnValue({ codeIndexEnabled: false });
  });

  it('stays disabled without activating a workspace when indexing is off', async () => {
    const manager = {
      activateWorkspace: vi.fn(),
    } as any;

    const controller = new CodeIndexController(manager, '/repo');
    await controller.initialize();

    expect(manager.activateWorkspace).not.toHaveBeenCalled();
    expect(controller.getState().enabled).toBe(false);
    expect(controller.getState().message).toBe('Indexing disabled');
  });

  it('starts indexing when enabled from the controller', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const orchestrator = {
      start,
      getState: vi.fn().mockReturnValue({
        status: 'standby',
        message: 'Standby',
        indexedFiles: 0,
        pendingFiles: 0,
      }),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const manager = {
      activateWorkspace: vi.fn().mockResolvedValue(orchestrator),
    } as any;

    const controller = new CodeIndexController(manager, '/repo');
    await controller.setEnabled(true);

    expect(mocks.setCodeIndexEnabled).toHaveBeenCalledWith(true);
    expect(manager.activateWorkspace).toHaveBeenCalledWith('/repo');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('can clear index data through the orchestrator', async () => {
    const clearIndexData = vi.fn().mockResolvedValue(undefined);
    const orchestrator = {
      clearIndexData,
      getState: vi.fn().mockReturnValue({
        status: 'standby',
        message: 'Index data cleared',
        indexedFiles: 0,
        pendingFiles: 0,
      }),
      onDidChangeState: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const manager = {
      activateWorkspace: vi.fn().mockResolvedValue(orchestrator),
    } as any;

    const controller = new CodeIndexController(manager, '/repo');
    await controller.clear();

    expect(clearIndexData).toHaveBeenCalledTimes(1);
    expect(controller.getState().message).toBe('Index data cleared');
  });
});
