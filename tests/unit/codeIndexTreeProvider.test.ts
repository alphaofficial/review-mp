import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join('/') })),
  },
}));

import { CodeIndexPanel } from '../../src/codeIndexPanel';
import { CodeIndexViewState } from '../../src/services/code-index/controller';

describe('CodeIndexPanel', () => {
  let state: CodeIndexViewState;
  let listener: (() => void) | undefined;

  beforeEach(() => {
    state = {
      status: 'indexed',
      message: 'Indexed - File watcher started',
      indexedFiles: 12,
      pendingFiles: 0,
      enabled: true,
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
      lastIndexedAt: 1,
    };
  });

  it('renders the indexing setup in a webview view', () => {
    const panel = new CodeIndexPanel(
      {
        getState: () => state,
        onDidChangeState: (cb: () => void) => {
          listener = cb;
          return { dispose: vi.fn() };
        },
      } as any,
      { fsPath: '/extension' } as any
    );

    const postMessage = vi.fn();
    const onDidReceiveMessage = vi.fn();
    const onDidDispose = vi.fn();

    panel.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        postMessage,
        onDidReceiveMessage,
        asWebviewUri: vi.fn((uri: { fsPath: string }) => uri.fsPath),
      },
      onDidDispose,
    } as any);

    expect(onDidReceiveMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'indexState',
    }));
    expect((panel as any).view?.webview.html ?? '').toContain('Advanced Configuration');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'indexState',
    }));
  });

  it('pushes state updates after the controller changes', () => {
    const panel = new CodeIndexPanel(
      {
        getState: () => state,
        onDidChangeState: (cb: () => void) => {
          listener = cb;
          return { dispose: vi.fn() };
        },
      } as any,
      { fsPath: '/extension' } as any
    );

    const postMessage = vi.fn();
    panel.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        postMessage,
        onDidReceiveMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: { fsPath: string }) => uri.fsPath),
      },
      onDidDispose: vi.fn(),
    } as any);

    state = {
      ...state,
      pendingFiles: 3,
      status: 'indexing',
      message: 'Applying incremental index updates',
    };
    listener?.();

    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'indexState',
      value: expect.objectContaining({
        pendingFiles: 3,
        status: 'indexing',
      }),
    }));
  });
});
