import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => {
  class MockTreeItem {
    label: string;
    collapsibleState: number;
    iconPath: any;
    command: any;
    contextValue: string | undefined;
    constructor(label: string, collapsibleState: number = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
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
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    ThemeIcon: class MockThemeIcon {
      constructor(public id: string) {}
    },
    EventEmitter: MockEventEmitter,
    TreeItem: MockTreeItem,
    window: {
      activeTextEditor: null,
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    Uri: {
      file: vi.fn().mockImplementation((path: string) => ({
        fsPath: path,
        toString: () => path,
      })),
    },
    Range: class MockRange {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
      }
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    Disposable: class MockDisposable {
      dispose = vi.fn();
    },
  };
});

import { ReviewTreeProvider, ReviewTreeViewId, TreeElement } from '../../src/reviewTreeProvider';
import { createReviewSessionStore, resetReviewSessionStore, ReviewSessionStore } from '../../src/store/reviewSessionStore';
import { ReviewStatus } from '../../src/types/review';

function transitionSessionTo(store: ReviewSessionStore, status: ReviewStatus): void {
  switch (status) {
    case 'idle':
      return;
    case 'settingUp':
      store.transitionSession('startSetup');
      return;
    case 'analyzing':
      store.transitionSession('startSetup');
      store.transitionSession('beginAnalysis');
      return;
    case 'reviewing':
      store.transitionSession('startSetup');
      store.transitionSession('beginAnalysis');
      store.transitionSession('beginReview');
      return;
    case 'completed':
      store.transitionSession('startSetup');
      store.transitionSession('beginAnalysis');
      store.transitionSession('complete');
      return;
    case 'failed':
      store.setSessionError('Test failure');
      return;
  }
}

describe('ReviewTreeProvider', () => {
  let store: ReviewSessionStore;
  let newReviewProvider: ReviewTreeProvider;
  let filesProvider: ReviewTreeProvider;
  let reviewsProvider: ReviewTreeProvider;
  let previousReviewsProvider: ReviewTreeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetReviewSessionStore();
    store = createReviewSessionStore();

    newReviewProvider = new ReviewTreeProvider('reviewmp.newReview', store);
    filesProvider = new ReviewTreeProvider('reviewmp.filesToReview', store);
    reviewsProvider = new ReviewTreeProvider('reviewmp.reviews', store);
    previousReviewsProvider = new ReviewTreeProvider('reviewmp.previousReviews', store);
  });

  afterEach(() => {
    newReviewProvider.dispose();
    filesProvider.dispose();
    reviewsProvider.dispose();
    previousReviewsProvider.dispose();
    store.dispose();
  });

  const getFilesRoot = (): TreeElement =>
    (filesProvider.getChildren() as TreeElement[])[0];

  const getFileItems = (): TreeElement[] =>
    getFilesRoot().children || [];

  const getReviewSessionItem = (): TreeElement =>
    (reviewsProvider.getChildren() as TreeElement[])[0];

  const getReviewFileItems = (): TreeElement[] => {
    const filesSection = getReviewSessionItem().children?.find(item => item.id === 'review-files');
    return filesSection?.children || [];
  };

  describe('NEW REVIEW view', () => {
    it('should return 7 command items for new review', () => {
      const items = newReviewProvider.getChildren();
      expect(items).toHaveLength(7);
    });

    it('should have correct command IDs for review items', () => {
      const items = newReviewProvider.getChildren() as TreeElement[];

      const commandMap: Record<string, string> = {};
      items.forEach(item => {
        if (item.command) {
          commandMap[item.command.command] = item.label;
        }
      });

      expect(commandMap['reviewmp.reviewAllChanges']).toBe('Review All Changes');
      expect(commandMap['reviewmp.reviewStaged']).toBe('Review Staged Changes');
      expect(commandMap['reviewmp.reviewUncommitted']).toBe('Review Uncommitted Changes');
      expect(commandMap['reviewmp.reviewFile']).toBe('Review Current File');
      expect(commandMap['reviewmp.reviewSelection']).toBe('Review Current Selection');
      expect(commandMap['reviewmp.reviewLastCommit']).toBe('Review Last Commit');
      expect(commandMap['reviewmp.reviewBranch']).toBe('Review Branch Changes');
    });

    it('should have icons for all new review items', () => {
      const items = newReviewProvider.getChildren() as TreeElement[];
      items.forEach(item => {
        expect(item.icon).toBeTruthy();
      });
    });

    it('should have proper tree items for new review items', () => {
      const items = newReviewProvider.getChildren() as TreeElement[];
      const treeItems = items.map(item => newReviewProvider.getTreeItem(item));

      treeItems.forEach(treeItem => {
        expect(treeItem.label).toBeTruthy();
        expect(treeItem.iconPath).toBeDefined();
      });
    });
  });

  describe('FILES TO REVIEW view', () => {
    it('should show no active review message when no session', () => {
      const items = filesProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No active review');
    });

    it('should show no files message when session has no files', () => {
      store.createSession('file');
      const items = filesProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No files to review');
    });

    it('should list seeded files even before findings are added', () => {
      store.createSession('staged');
      store.setFilesToReview(['/src/a.ts', '/src/b.ts']);

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(2);
      const paths = items.map(i => i.file?.path).sort();
      expect(paths).toEqual(['/src/a.ts', '/src/b.ts']);
    });

    it('should list all files from active session', () => {
      store.createSession('branch');
      store.addFinding('/src/file1.ts', 1, 'Error 1', 'error');
      store.addFinding('/src/file2.ts', 5, 'Error 2', 'warning');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(2);

      const paths = items.map(i => i.file?.path).sort();
      expect(paths).toEqual(['/src/file1.ts', '/src/file2.ts']);
    });

    it('should show pending count for files with pending findings', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');
      store.addFinding('/src/test.ts', 2, 'Warning', 'warning');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].description).toBe('2!');
      expect(items[0].children).toHaveLength(2);
    });

    it('should reserve row click for expansion when file has findings', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].command).toBeUndefined();
      expect(items[0].collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    });

    it('should update when findings are added', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].file?.path).toBe('/src/test.ts');
    });
  });

  describe('REVIEWS view', () => {
    it('should show no active review message when no session', () => {
      const items = reviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No active review');
    });

    it('should show session header with title and status', () => {
      store.createSession('file', 'My Review');
      transitionSessionTo(store, 'reviewing');

      const items = reviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toContain('My Review');
      expect(items[0].description).toContain('Reviewing');
    });

    it('should keep review status as a compact summary row', () => {
      store.createSession('branch');
      store.addFinding('/src/file1.ts', 1, 'Error 1', 'error');
      store.addFinding('/src/file1.ts', 5, 'Error 2', 'warning');
      store.addFinding('/src/file2.ts', 10, 'Error 3', 'info');

      const items = reviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Branch Review: current');
      expect(items[0].description).toContain('3 findings');
      expect(getReviewFileItems()).toHaveLength(2);
    });

    it('should not show seeded files without findings in the review files section', () => {
      store.createSession('staged');
      store.setFilesToReview(['/src/a.ts', '/src/b.ts']);

      const items = reviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      const sessionChildren = items[0].children ?? [];
      expect(sessionChildren.some((child) => child.label.startsWith('Files ('))).toBe(false);
    });

    it('should show finding severity and line number in files view', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 42, 'Test error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileGroup = items[0];
      const finding = fileGroup.children![0];

      expect(finding.tooltip).toContain('Line 42');
      expect(finding.label).toBe('Test error');
      expect(finding.finding?.line).toBe(42);
    });

    it('should set finding context value based on fix availability', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error with fix', 'error', 'const x = 1;');
      store.addFinding('/src/test.ts', 2, 'Error without fix', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileGroup = items[0];
      const findings = fileGroup.children!;

      expect(findings[0].contextValue).toBe('findingWithFix');
      expect(findings[1].contextValue).toBe('finding');
    });

    it('should have open finding command on finding items', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileGroup = items[0];
      const findingItem = fileGroup.children![0];

      expect(findingItem.command?.command).toBe('reviewmp.openFinding');
      expect(findingItem.command?.arguments).toEqual([finding!.id]);
    });

    it('should display all review statuses correctly', () => {
      const statusLabels: Record<ReviewStatus, string> = {
        idle: 'Idle',
        settingUp: 'Setting up',
        analyzing: 'Analyzing',
        reviewing: 'Reviewing',
        completed: 'Completed',
        failed: 'Failed',
      };

      (Object.keys(statusLabels) as Array<keyof typeof statusLabels>).forEach(status => {
        store.createSession('file');
        transitionSessionTo(store, status);

        const items = reviewsProvider.getChildren() as TreeElement[];
        expect(items[0].description).toContain(statusLabels[status]);
      });
    });

    it('should show finding counts in file descriptions', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error 1', 'error');
      store.addFinding('/src/test.ts', 2, 'Error 2', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileGroup = items[0];

      expect(fileGroup.description).toBe('2!');
    });
  });

  describe('PREVIOUS REVIEWS view', () => {
    it('should show no previous reviews message when history is empty', () => {
      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('No previous reviews');
    });

    it('should list completed sessions from history', () => {
      store.createSession('staged', 'Review 1');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');
      transitionSessionTo(store, 'completed');

      store.createSession('branch', 'Review 2');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items).toHaveLength(2);
      expect(items[0].label).toContain('Review 2');
      expect(items[1].label).toContain('Review 1');
    });

    it('should have open review panel command on history entries', () => {
      store.createSession('file', 'Historical Review');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items[0].command?.command).toBe('reviewmp.openReviewPanel');
      expect(items[0].contextValue).toBe('previousReview');
    });

    it('should store history entry data in tree element', () => {
      store.createSession('file', 'Test Review');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items[0].historyEntry).toBeDefined();
      expect(items[0].historyEntry?.title).toBe('Test Review');
    });

    it('should limit history display', () => {
      for (let i = 0; i < 12; i++) {
        store.createSession('file', `Review ${i}`);
        transitionSessionTo(store, 'completed');
      }

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items.length).toBeLessThanOrEqual(5);
    });

    it('should display findings count in history label', () => {
      store.createSession('staged', 'Multi-finding Review');
      store.addFinding('/src/test1.ts', 1, 'Error 1', 'error');
      store.addFinding('/src/test2.ts', 5, 'Error 2', 'warning');
      store.addFinding('/src/test3.ts', 10, 'Error 3', 'info');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items[0].description).toContain('3 findings');
    });

    it('should display relative time in history label', () => {
      store.createSession('file', 'Dated Review');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items[0].description).toContain('ago');
    });

    it('should display duration in history label', () => {
      store.createSession('file', 'Timed Review');
      transitionSessionTo(store, 'completed');

      const items = previousReviewsProvider.getChildren() as TreeElement[];
      expect(items[0].description).toContain('ms');
    });
  });

  describe('refresh behavior', () => {
    it('should refresh previous reviews periodically for time ago labels', () => {
      vi.useFakeTimers();

      previousReviewsProvider.dispose();
      previousReviewsProvider = new ReviewTreeProvider('reviewmp.previousReviews', store);
      store.createSession('file');
      transitionSessionTo(store, 'completed');

      const spy = vi.fn();
      previousReviewsProvider.onDidChangeTreeData(spy);

      vi.advanceTimersByTime(30_000);

      expect(spy).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should emit change event when session is created with previous session present', () => {
      store.createSession('file');
      const spy = vi.fn();
      newReviewProvider.onDidChangeTreeData(spy);

      store.createSession('staged');

      expect(spy).toHaveBeenCalled();
    });

    it('should emit change event when finding is added', () => {
      store.createSession('file');
      const spy = vi.fn();
      filesProvider.onDidChangeTreeData(spy);

      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      expect(spy).toHaveBeenCalled();
    });

    it('should emit change event when finding status is updated', () => {
      store.createSession('file');
      const finding = store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const spy = vi.fn();
      reviewsProvider.onDidChangeTreeData(spy);

      store.updateFindingStatus(finding!.id, 'dismiss');

      expect(spy).toHaveBeenCalled();
    });

    it('should emit change event when session is cleared', () => {
      store.createSession('file');
      const spy = vi.fn();
      reviewsProvider.onDidChangeTreeData(spy);

      store.clearActiveSession();

      expect(spy).toHaveBeenCalled();
    });

    it('should emit change event on session completion', () => {
      store.createSession('file');
      transitionSessionTo(store, 'completed');

      const spy = vi.fn();
      previousReviewsProvider.onDidChangeTreeData(spy);

      store.createSession('file');
      transitionSessionTo(store, 'completed');

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('tree item generation', () => {
    it('should create tree items with correct collapsible state for expandable items', () => {
      store.createSession('branch');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const sessionItem = items[0];

      const treeItem = filesProvider.getTreeItem(sessionItem);
      expect(treeItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
    });

    it('should create tree items with context value for findings', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error', 'fix');

      const items = filesProvider.getChildren() as TreeElement[];
      const findingItem = items[0].children![0];

      const treeItem = filesProvider.getTreeItem(findingItem);
      expect(treeItem.contextValue).toBe('findingWithFix');
    });

    it('should create tree items with context value for findings without fix', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const findingItem = items[0].children![0];

      const treeItem = filesProvider.getTreeItem(findingItem);
      expect(treeItem.contextValue).toBe('finding');
    });
  });

  describe('getTreeItem', () => {
    it('should return tree item with label for command items', () => {
      const items = newReviewProvider.getChildren() as TreeElement[];
      const treeItem = newReviewProvider.getTreeItem(items[0]);

      expect(treeItem.label).toBe('Review All Changes');
    });

    it('should return tree item with command for clickable items', () => {
      const items = newReviewProvider.getChildren() as TreeElement[];
      const treeItem = newReviewProvider.getTreeItem(items[0]);

      expect(treeItem.command).toBeDefined();
      expect(treeItem.command?.command).toBe('reviewmp.reviewAllChanges');
    });
  });

  describe('file name formatting', () => {
    it('should show the file name for long paths', () => {
      store.createSession('file');
      store.addFinding('/Users/name/project/src/components/Button.tsx', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].label).toBe('Button.tsx');
      expect(items[0].tooltip).toBe('/Users/name/project/src/components/Button.tsx');
    });

    it('should show the file name for short paths', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].label).toBe('test.ts');
      expect(items[0].tooltip).toBe('/src/test.ts');
      expect(items[0].description).toBe('1!');
    });
  });

  describe('icon mapping', () => {
    it('should have correct icons for different severity levels', () => {
      store.createSession('file');
      store.addFinding('/src/error.ts', 1, 'Error', 'error');
      store.addFinding('/src/warning.ts', 2, 'Warning', 'warning');
      store.addFinding('/src/info.ts', 3, 'Info', 'info');
      store.addFinding('/src/suggestion.ts', 4, 'Suggestion', 'suggestion');

      const fileGroups = filesProvider.getChildren() as TreeElement[];
      const findings = fileGroups.flatMap(f => f.children!);

      const errorFinding = findings.find(f => f.finding?.severity === 'error');
      const warningFinding = findings.find(f => f.finding?.severity === 'warning');
      const infoFinding = findings.find(f => f.finding?.severity === 'info');
      const suggestionFinding = findings.find(f => f.finding?.severity === 'suggestion');

      expect(errorFinding?.icon).toBe('error');
      expect(warningFinding?.icon).toBe('warning');
      expect(infoFinding?.icon).toBe('info');
      expect(suggestionFinding?.icon).toBe('lightbulb');
    });

    it('should have correct icons for different file statuses', () => {
      store.createSession('file');
      store.addFinding('/src/pending.ts', 1, 'Error', 'error');
      store.updateFindingStatus(store.getFindingsForFile('/src/pending.ts')[0].id, 'apply');
      store.addFinding('/src/reviewing.ts', 1, 'Error', 'error');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileMap = new Map(items.map(i => [i.file?.path, i]));

      expect(fileMap.get('/src/pending.ts')?.icon).toBe('check');
      expect(fileMap.get('/src/reviewing.ts')?.icon).toBe('eye');
    });

    it('should show correct icon for failed file status', () => {
      store.createSession('file');
      store.addFinding('/src/failed.ts', 1, 'Error', 'error');
      store.setFileFailed('/src/failed.ts');

      const items = filesProvider.getChildren() as TreeElement[];
      const fileMap = new Map(items.map(i => [i.file?.path, i]));

      expect(fileMap.get('/src/failed.ts')?.icon).toBe('error');
    });

    it('should have vscode.open command for file rows without findings', () => {
      store.createSession('file');
      store.setFilesToReview(['/src/test.ts']);

      const items = filesProvider.getChildren() as TreeElement[];
      const fileItem = items[0];

      expect(fileItem.command?.command).toBe('vscode.open');
      expect(fileItem.command?.arguments).toEqual([expect.objectContaining({ fsPath: '/src/test.ts' })]);
    });

    it('should update file status icons when finding is applied', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');

      let items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].icon).toBe('eye');

      store.updateFindingStatus(store.getFindingsForFile('/src/test.ts')[0].id, 'apply');

      items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].icon).toBe('check');
    });

    it('should update file status icons when all findings are dismissed', () => {
      store.createSession('file');
      store.addFinding('/src/test.ts', 1, 'Error', 'error');
      store.addFinding('/src/test.ts', 2, 'Warning', 'warning');

      let items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].icon).toBe('eye');

      store.updateFindingStatus(store.getFindingsForFile('/src/test.ts')[0].id, 'dismiss');
      store.updateFindingStatus(store.getFindingsForFile('/src/test.ts')[1].id, 'dismiss');

      items = filesProvider.getChildren() as TreeElement[];
      expect(items[0].icon).toBe('check');
    });
  });
});
