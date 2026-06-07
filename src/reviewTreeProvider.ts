import * as vscode from 'vscode';
import { ReviewSessionStore, getReviewSessionStore } from './store/reviewSessionStore';
import { ReviewFinding, ReviewFile, ReviewHistoryEntry, ReviewSession, Severity } from './types/review';

export interface TreeElement {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  command?: vscode.Command;
  contextValue?: string;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: TreeElement[];
  tooltip?: string;
  finding?: ReviewFinding;
  file?: ReviewFile;
  historyEntry?: ReviewHistoryEntry;
  session?: ReviewSession;
}

export type ReviewTreeViewId = 'codebunny.newReview' | 'codebunny.filesToReview' | 'codebunny.reviews' | 'codebunny.previousReviews';

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private viewId: ReviewTreeViewId;
  private store: ReviewSessionStore;
  private timeAgoRefreshTimer: NodeJS.Timeout | undefined;
  private _onDidChangeTreeData: vscode.EventEmitter<TreeElement | undefined | void> = new vscode.EventEmitter<TreeElement | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined | void> = this._onDidChangeTreeData.event;

  constructor(viewId: ReviewTreeViewId, store?: ReviewSessionStore) {
    this.viewId = viewId;
    this.store = store || getReviewSessionStore();
    this.subscribeToStoreEvents();
    this.startTimeAgoRefresh();
  }

  private subscribeToStoreEvents(): void {
    this.store.on('status-changed', () => this.refresh());
    this.store.on('finding-added', () => this.refresh());
    this.store.on('finding-updated', () => this.refresh());
    this.store.on('file-status-changed', () => this.refresh());
    this.store.on('session-cleared', () => this.refresh());
    this.store.on('session-completed', () => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private startTimeAgoRefresh(): void {
    if (this.viewId !== 'codebunny.previousReviews') {
      return;
    }

    this.timeAgoRefreshTimer = setInterval(() => {
      if (this.store.getSessionHistory().length > 0) {
        this.refresh();
      }
    }, 30_000);
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      element.label,
      element.collapsibleState ?? vscode.TreeItemCollapsibleState.None
    );

    if (element.icon) {
      treeItem.iconPath = new vscode.ThemeIcon(element.icon);
    }

    if (element.description) {
      treeItem.description = element.description;
    }

    if (element.tooltip) {
      treeItem.tooltip = element.tooltip;
    }

    if (element.command) {
      treeItem.command = element.command;
    }

    if (element.contextValue) {
      treeItem.contextValue = element.contextValue;
    }

    if (element.finding) {
      treeItem.contextValue = element.finding.fix ? 'findingWithFix' : 'finding';
    }

    return treeItem;
  }

  getChildren(element?: TreeElement): vscode.ProviderResult<TreeElement[]> {
    if (!element) {
      return this.getRootChildren();
    }
    return element.children || [];
  }

  private getRootChildren(): TreeElement[] {
    switch (this.viewId) {
      case 'codebunny.newReview':
        return this.getNewReviewItems();
      case 'codebunny.filesToReview':
        return this.getFilesToReviewItems();
      case 'codebunny.reviews':
        return this.getReviewsItems();
      case 'codebunny.previousReviews':
        return this.getPreviousReviewsItems();
      default:
        return [];
    }
  }

  private getNewReviewItems(): TreeElement[] {
    const session = this.store.getActiveSession();

    if (session && session.status !== 'completed' && session.status !== 'failed') {
      return [
        {
          id: 'active-review-scope',
          label: this.getReviewScopeLabel(session),
          description: this.getStatusLabel(session.status),
          icon: 'git-compare',
        },
        {
          id: 'clear-active-review',
          label: 'Stop Review',
          icon: 'debug-stop',
          command: { command: 'codebunny.clearActiveReview', title: 'Stop Review' },
        },
      ];
    }

    return [
      {
        id: 'review-all-changes',
        label: 'Review All Changes',
        icon: 'git-compare',
        command: { command: 'codebunny.reviewAllChanges', title: 'Review All Changes' },
      },
      {
        id: 'review-staged',
        label: 'Review Staged Changes',
        icon: 'diff-added',
        command: { command: 'codebunny.reviewStaged', title: 'Review Staged Changes' },
      },
      {
        id: 'review-uncommitted',
        label: 'Review Uncommitted Changes',
        icon: 'diff-modified',
        command: { command: 'codebunny.reviewUncommitted', title: 'Review Uncommitted Changes' },
      },
      {
        id: 'review-current-file',
        label: 'Review Current File',
        icon: 'file',
        command: { command: 'codebunny.reviewFile', title: 'Review Current File' },
      },
      {
        id: 'review-selection',
        label: 'Review Current Selection',
        icon: 'selection',
        command: { command: 'codebunny.reviewSelection', title: 'Review Current Selection' },
      },
      {
        id: 'review-last-commit',
        label: 'Review Last Commit',
        icon: 'git-commit',
        command: { command: 'codebunny.reviewLastCommit', title: 'Review Last Commit' },
      },
      {
        id: 'review-branch',
        label: 'Review Branch Changes',
        icon: 'git-branch',
        command: { command: 'codebunny.reviewBranch', title: 'Review Branch Changes' },
      },
    ];
  }

  private getFilesToReviewItems(): TreeElement[] {
    const session = this.store.getActiveSession();
    if (!session) {
      return [{
        id: 'no-session',
        label: 'No active review',
        icon: 'info',
      }];
    }

    const files = this.store.getFilesForSession();
    if (files.length === 0) {
      return [{
        id: 'no-files',
        label: 'No files to review',
        icon: 'circle-outline',
      }];
    }

    return files.map(file => this.fileToTreeElement(file));
  }

  private fileToTreeElement(file: ReviewFile): TreeElement {
    const statusIcon = this.getFileStatusIcon(file.status);
    const findingCount = file.findings.length;
    const pendingCount = file.findings.filter(f => f.status === 'pending').length;

    const label = this.getFileName(file.path);
    const element: TreeElement = {
      id: `file-${file.path}`,
      label,
      description: pendingCount > 0 ? `${pendingCount}!` : findingCount > 0 ? `${findingCount}` : '',
      icon: statusIcon,
      tooltip: file.path,
      file,
      collapsibleState: findingCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      children: file.findings.map(finding => this.findingToTreeElement(finding)),
    };

    if (findingCount === 0) {
      element.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(file.path)],
      };
    }

    return element;
  }

  private getReviewsItems(): TreeElement[] {
    const session = this.store.getActiveSession();
    if (!session) {
      return [{
        id: 'no-review',
        label: 'No active review',
        icon: 'info',
      }];
    }

    const items: TreeElement[] = [];

    items.push({
      id: 'session-header',
      label: session.title,
      description: `${this.getStatusLabel(session.status)} · ${session.totalFindings} ${session.totalFindings === 1 ? 'finding' : 'findings'}`,
      icon: this.getStatusIcon(session.status),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      session,
      children: [
        ...this.getReviewProgressItems(session),
        ...this.getReviewFilesSection(session),
      ],
    });

    return items;
  }

  private getReviewProgressItems(session: ReviewSession): TreeElement[] {
    const currentStep = this.getProgressStepIndex(session.status);
    const steps = [
      { id: 'setting-up', label: 'Setting up' },
      { id: 'analyzing', label: 'Analyzing changes' },
      { id: 'reviewing', label: 'Reviewing files' },
    ];

    return steps.map((step, index) => ({
      id: `progress-${step.id}`,
      label: step.label,
      icon: index < currentStep ? 'check' : index === currentStep ? 'sync~spin' : 'circle-outline',
      description: index === currentStep && session.status !== 'completed' && session.status !== 'failed' ? '...' : '',
    }));
  }

  private getReviewFilesSection(session: ReviewSession): TreeElement[] {
    const files = this.getFilesWithFindings(session);

    if (files.length === 0) {
      return [];
    }

    return [{
      id: 'review-files',
      label: `Files (${files.length})`,
      icon: 'files',
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      children: files.map(file => this.fileToTreeElement(file)),
    }];
  }

  private getFilesWithFindings(session: ReviewSession): ReviewFile[] {
    return Array.from(session.files.values()).filter((file) => file.findings.length > 0);
  }

  private findingToTreeElement(finding: ReviewFinding): TreeElement {
    const severityIcon = this.getSeverityIcon(finding.severity);
    const statusLabel = finding.status === 'applied' ? 'fixed' :
                        finding.status === 'dismissed' ? 'dismissed' : this.getSeverityLabel(finding.severity);
    const fixLabel = finding.fix ? ' · fix' : '';

    return {
      id: `finding-${finding.id}`,
      label: finding.message,
      description: `${statusLabel}${fixLabel}`,
      icon: severityIcon,
      tooltip: `Line ${finding.line}: ${finding.message}`,
      finding,
      contextValue: finding.fix ? 'findingWithFix' : 'finding',
      command: {
        command: 'codebunny.openFinding',
        title: 'Open Finding',
        arguments: [finding.id],
      },
    };
  }

  private getPreviousReviewsItems(): TreeElement[] {
    const history = this.store.getSessionHistory();
    if (history.length === 0) {
      return [{
        id: 'no-history',
        label: 'No previous reviews',
        icon: 'history',
      }];
    }

    return history.map(entry => this.historyEntryToTreeElement(entry));
  }

  private historyEntryToTreeElement(entry: ReviewHistoryEntry): TreeElement {
    const timeAgo = this.formatTimeAgo(entry.completedAt);
    const duration = this.formatDuration(entry.duration);
    const typeIcon = this.getReviewTypeIcon(entry.reviewType);

    return {
      id: `history-${entry.sessionId}`,
      label: entry.title,
      description: `${entry.findingsCount} findings · ${timeAgo} · ${duration}`,
      icon: typeIcon,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      historyEntry: entry,
      contextValue: 'previousReview',
      command: {
        command: 'codebunny.openReviewPanel',
        title: 'Open Review',
        arguments: [entry.sessionId],
      },
    };
  }

  private getFileName(filePath: string): string {
    const parts = filePath.split('/').filter(p => p.length > 0);
    return parts.at(-1) || filePath;
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      idle: 'Idle',
      settingUp: 'Setting up',
      analyzing: 'Analyzing',
      reviewing: 'Reviewing',
      completed: 'Completed',
      failed: 'Failed',
    };
    return labels[status] || status;
  }

  private getProgressStepIndex(status: string): number {
    const indexByStatus: Record<string, number> = {
      idle: 0,
      settingUp: 0,
      analyzing: 1,
      reviewing: 2,
      completed: 3,
      failed: 3,
    };
    return indexByStatus[status] ?? 0;
  }

  private getReviewScopeLabel(session: ReviewSession): string {
    switch (session.reviewType) {
      case 'staged':
        return 'Review staged changes';
      case 'uncommitted':
        return 'Review uncommitted changes';
      case 'lastCommit':
        return 'Review committed changes';
      case 'branch':
        return 'Review all changes';
      case 'file':
        return 'Review current file';
      case 'selection':
        return 'Review current selection';
      default:
        return 'Review all changes';
    }
  }

  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      idle: '$(circle-outline)',
      settingUp: '$(sync~spin)',
      analyzing: '$(sync~spin)',
      reviewing: '$(eye)',
      completed: '$(check-circle)',
      failed: '$(error)',
    };
    return this.toThemeIconId(icons[status] || '$(circle)');
  }

  private getFileStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      pending: '$(circle-outline)',
      reviewing: '$(eye)',
      reviewed: '$(check)',
      failed: '$(error)',
    };
    return this.toThemeIconId(icons[status] || '$(file)');
  }

  private getSeverityIcon(severity: Severity): string {
    const icons: Record<Severity, string> = {
      error: '$(error)',
      warning: '$(warning)',
      info: '$(info)',
      suggestion: '$(lightbulb)',
    };
    return this.toThemeIconId(icons[severity] || '$(info)');
  }

  private getSeverityLabel(severity: Severity): string {
    const labels: Record<Severity, string> = {
      error: 'Potential Issue',
      warning: 'Warning',
      info: 'Info',
      suggestion: 'Suggestion',
    };
    return labels[severity];
  }

  private getReviewTypeIcon(reviewType: string): string {
    const icons: Record<string, string> = {
      file: '$(file)',
      selection: '$(selection)',
      staged: '$(diff-added)',
      uncommitted: '$(diff-modified)',
      lastCommit: '$(git-commit)',
      branch: '$(git-branch)',
    };
    return this.toThemeIconId(icons[reviewType] || '$(file)');
  }

  private toThemeIconId(icon: string): string {
    return icon.replace(/^\$\((.*)\)$/, '$1');
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  private formatTimeAgo(timestamp: number): string {
    const secondsAgo = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (secondsAgo < 60) {
      return `${secondsAgo}s ago`;
    }

    const minutesAgo = Math.floor(secondsAgo / 60);
    if (minutesAgo < 60) {
      return `${minutesAgo}m ago`;
    }

    const hoursAgo = Math.floor(minutesAgo / 60);
    if (hoursAgo < 24) {
      return `${hoursAgo}h ago`;
    }

    const daysAgo = Math.floor(hoursAgo / 24);
    if (daysAgo < 30) {
      return `${daysAgo}d ago`;
    }

    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  dispose(): void {
    if (this.timeAgoRefreshTimer) {
      clearInterval(this.timeAgoRefreshTimer);
      this.timeAgoRefreshTimer = undefined;
    }
    this._onDidChangeTreeData.dispose();
  }
}
