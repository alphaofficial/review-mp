import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T> = (value: T) => void;

function createEventEmitter<T>() {
  const listeners: Listener<T>[] = [];

  return {
    event: (listener: Listener<T>) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    },
    fire: (value: T) => {
      listeners.forEach((listener) => listener(value));
    },
  };
}

const mockState = vi.hoisted(() => {
  const configurationEmitter = createEventEmitter<{ affectsConfiguration: (section: string) => boolean }>();
  const commitEmitter = createEventEmitter<void>();
  const openRepositoryEmitter = createEventEmitter<any>();

  const repository = {
    state: {
      indexChanges: [],
      workingTreeChanges: [],
    },
    onDidCommit: commitEmitter.event,
  };

  const gitApi = {
    repositories: [repository],
    onDidOpenRepository: openRepositoryEmitter.event,
  };

  return {
    configurationEmitter,
    commitEmitter,
    openRepositoryEmitter,
    repository,
    gitApi,
    config: {
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
    },
  };
});

vi.mock('vscode', () => ({
  workspace: {
    onDidChangeConfiguration: mockState.configurationEmitter.event,
    getConfiguration: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockImplementation((key: string, defaultValue: boolean) => {
        if (key === 'autoReviewOnStage') {
          return mockState.config.autoReviewOnStage;
        }

        if (key === 'autoReviewOnCommit') {
          return mockState.config.autoReviewOnCommit;
        }

        return defaultValue;
      }),
    })),
  },
  extensions: {
    getExtension: vi.fn().mockReturnValue({
      isActive: true,
      exports: {
        getAPI: vi.fn().mockReturnValue(mockState.gitApi),
      },
      activate: vi.fn(),
    }),
  },
}));

import { GitWatcher } from '../../src/gitWatcher';

describe('GitWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockState.config.autoReviewOnStage = false;
    mockState.config.autoReviewOnCommit = false;
    mockState.repository.state.indexChanges = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the stage callback when staged file count increases', async () => {
    mockState.config.autoReviewOnStage = true;

    const onStageCallback = vi.fn().mockResolvedValue(undefined);
    const watcher = new GitWatcher(onStageCallback, vi.fn().mockResolvedValue(true));
    await Promise.resolve();

    mockState.repository.state.indexChanges = [{ uri: { fsPath: 'file-a.ts' } }];
    vi.advanceTimersByTime(2500);
    await Promise.resolve();

    expect(onStageCallback).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });

  it('invokes the stage callback when the staged file set changes without a count increase', async () => {
    mockState.config.autoReviewOnStage = true;
    mockState.repository.state.indexChanges = [{ uri: { fsPath: 'file-a.ts' } }];

    const onStageCallback = vi.fn().mockResolvedValue(undefined);
    const watcher = new GitWatcher(onStageCallback, vi.fn().mockResolvedValue(true));
    await Promise.resolve();

    mockState.repository.state.indexChanges = [{ uri: { fsPath: 'file-b.ts' } }];
    vi.advanceTimersByTime(2500);
    await Promise.resolve();

    expect(onStageCallback).toHaveBeenCalledTimes(1);

    watcher.dispose();
  });

  it('invokes the commit callback when autoReviewOnCommit is enabled and a commit event fires', async () => {
    mockState.config.autoReviewOnCommit = true;

    const onStageCallback = vi.fn().mockResolvedValue(undefined);
    const onCommitCallback = vi.fn().mockResolvedValue(true);

    const watcher = new GitWatcher(onStageCallback, onCommitCallback);
    await Promise.resolve();

    mockState.commitEmitter.fire();
    await Promise.resolve();

    expect(onCommitCallback).toHaveBeenCalledTimes(1);
    expect(onStageCallback).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it('does not invoke the commit callback when autoReviewOnCommit is disabled', async () => {
    const onCommitCallback = vi.fn().mockResolvedValue(true);
    const watcher = new GitWatcher(vi.fn().mockResolvedValue(undefined), onCommitCallback);
    await Promise.resolve();

    mockState.commitEmitter.fire();
    await Promise.resolve();

    expect(onCommitCallback).not.toHaveBeenCalled();

    watcher.dispose();
  });
});
