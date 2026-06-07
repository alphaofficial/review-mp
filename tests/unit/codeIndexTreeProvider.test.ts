import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  function MockEventEmitter<T>() {
    const listeners: Array<(data: T) => void> = [];
    return {
      event(listener: (data: T) => void) {
        listeners.push(listener);
        return { dispose: vi.fn() };
      },
      fire(data: T) {
        listeners.forEach((listener) => listener(data));
      },
      dispose: vi.fn(),
    };
  }

  return {
    ThemeIcon: class MockThemeIcon {
      constructor(public id: string) {}
    },
    TreeItemCollapsibleState: { None: 0 },
    TreeItem: class MockTreeItem {
      label: string;
      collapsibleState: number;
      description?: string;
      tooltip?: string;
      iconPath: unknown;
      command: unknown;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    EventEmitter: MockEventEmitter,
  };
});

import { CodeIndexTreeProvider } from '../../src/codeIndexTreeProvider';
import { CodeIndexViewState } from '../../src/services/code-index/controller';

describe('CodeIndexTreeProvider', () => {
  let state: CodeIndexViewState;
  let listener: ((state: CodeIndexViewState) => void) | undefined;
  let provider: CodeIndexTreeProvider;

  beforeEach(() => {
    state = {
      status: 'indexed',
      message: 'Indexed - File watcher started',
      indexedFiles: 12,
      pendingFiles: 0,
      enabled: true,
      workspaceRoot: '/repo',
      storagePath: '/repo/.codebunny/lancedb',
      lastIndexedAt: 1,
    };

    provider = new CodeIndexTreeProvider({
      getState: () => state,
      onDidChangeState: (cb: (next: CodeIndexViewState) => void) => {
        listener = cb;
        return { dispose: vi.fn() };
      },
    } as any);
  });

  it('shows status, counts, storage, and action rows', () => {
    const items = provider.getChildren() as any[];

    expect(items.map((item) => item.label)).toEqual([
      'Status',
      'Indexed Files',
      'Pending Updates',
      'Index Storage',
      'Rebuild Index',
      'Stop Indexing',
      'Disable Indexing',
      'Clear Index Data',
    ]);
  });

  it('switches actions when indexing is disabled', () => {
    state.enabled = false;
    state.status = 'standby';
    state.message = 'Indexing disabled';

    const items = provider.getChildren() as any[];
    expect(items.map((item) => item.label)).toContain('Enable Indexing');
    expect(items.map((item) => item.label)).not.toContain('Disable Indexing');
  });

  it('refreshes when the controller state changes', () => {
    const spy = vi.fn();
    provider.onDidChangeTreeData(spy);

    listener?.({
      ...state,
      pendingFiles: 3,
      status: 'indexing',
      message: 'Applying incremental index updates',
    });

    expect(spy).toHaveBeenCalled();
  });
});
