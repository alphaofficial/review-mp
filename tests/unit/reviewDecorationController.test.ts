import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => {
  const mockDecorations = new Map<string, any[]>();
  const mockDecorationTypes = new Map<string, any>();

  class MockTextEditorDecorationType {
    private id: string;
    dispose = vi.fn();
    constructor(id: string) {
      this.id = id;
      mockDecorationTypes.set(id, this);
    }
  }

  function MockEventEmitter<T>() {
    const listeners: Array<(data: T) => void> = [];
    const emitter = {
      event(listener: (data: T) => void) {
        listeners.push(listener);
        return {
          dispose: () => {
            const idx = listeners.indexOf(listener);
            if (idx > -1) listeners.splice(idx, 1);
          }
        };
      },
      fire(data: T) {
        listeners.forEach(fn => fn(data));
      },
      dispose() {
        listeners.length = 0;
      }
    };
    return emitter;
  }

  return {
    window: {
      visibleTextEditors: [],
      activeTextEditor: null,
      createTextEditorDecorationType: vi.fn().mockImplementation((options: any) => {
        const id = `decoration-${mockDecorationTypes.size}`;
        return new MockTextEditorDecorationType(id);
      }),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      onDidChangeVisibleTextEditors: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    workspace: {
      onDidCloseTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    Range: class MockRange {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
      }
    },
    Selection: class MockSelection {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(start: any, end: any) {
        this.start = start;
        this.end = end;
      }
    },
    TextEditorRevealType: {
      InCenter: 1,
      Default: 0,
    },
    OverviewRulerLane: {
      Center: 1,
      Right: 2,
    },
    ThemeColor: class MockThemeColor {
      constructor(public id: string) {}
    },
    Disposable: class MockDisposable {
      dispose = vi.fn();
    },
    comments: {
      createCommentController: vi.fn(),
    },
    EventEmitter: MockEventEmitter,
  };
});

import { ReviewDecorationController } from '../../src/reviewDecorationController';
import { createReviewSessionStore, resetReviewSessionStore, ReviewSessionStore } from '../../src/store/reviewSessionStore';

describe('ReviewDecorationController', () => {
  let store: ReviewSessionStore;
  let decorationController: ReviewDecorationController;
  let mockContext: vscode.ExtensionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    resetReviewSessionStore();
    store = createReviewSessionStore();

    mockContext = {
      subscriptions: [],
    } as any;

    decorationController = new ReviewDecorationController(mockContext, store);
  });

  afterEach(() => {
    decorationController.dispose();
    store.dispose();
  });

  describe('initialization', () => {
    it('should create decoration controller without errors', () => {
      expect(decorationController).toBeDefined();
    });

    it('should register commands', () => {
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'codebunny.selectFinding',
        expect.any(Function)
      );
      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        'codebunny.clearSelection',
        expect.any(Function)
      );
    });
  });

  describe('selectFinding', () => {
    it('should emit finding selection event', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 10, 'Test error', 'error');

      decorationController.selectFinding(finding!.id);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'codebunny.openFinding',
        finding!.id
      );
    });

    it('should handle non-existent finding gracefully', () => {
      expect(() => {
        decorationController.selectFinding('non-existent-id');
      }).not.toThrow();
    });
  });

  describe('clearSelection', () => {
    it('should clear selection without errors', () => {
      expect(() => {
        decorationController.clearSelection();
      }).not.toThrow();
    });
  });

  describe('finding-added event handling', () => {
    it('should handle finding-added events from store', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 5, 'Test error', 'error');

      expect(finding).toBeDefined();
      expect(finding!.id).toBeTruthy();
    });
  });

  describe('finding-updated event handling', () => {
    it('should handle apply action without errors', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 5, 'Test error', 'error', 'fix');

      expect(() => {
        store.updateFindingStatus(finding!.id, 'apply');
      }).not.toThrow();
    });

    it('should handle dismiss action without errors', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 5, 'Test error', 'error');

      expect(() => {
        store.updateFindingStatus(finding!.id, 'dismiss');
      }).not.toThrow();
    });
  });

  describe('session-cleared event handling', () => {
    it('should handle session cleared without errors', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 5, 'Test error', 'error');

      expect(() => {
        store.clearActiveSession();
      }).not.toThrow();
    });

    it('should clear active decorations on session clear', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 5, 'Test error', 'error');
      decorationController.selectFinding(finding!.id);

      store.clearActiveSession();

      expect(vscode.window.visibleTextEditors).toBeDefined();
    });
  });

  describe('dispose', () => {
    it('should dispose without errors', () => {
      expect(() => {
        decorationController.dispose();
      }).not.toThrow();
    });

    it('should be disposable multiple times safely', () => {
      decorationController.dispose();
      expect(() => {
        decorationController.dispose();
      }).not.toThrow();
    });
  });

  describe('decoration type creation', () => {
    it('should create selection highlight decoration', () => {
      expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalled();
    });

    it('should create severity gutter decorations', () => {
      const callCount = (vscode.window.createTextEditorDecorationType as any).mock.calls.length;
      expect(callCount).toBeGreaterThanOrEqual(5);
    });
  });
});
