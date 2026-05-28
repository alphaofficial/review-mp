import * as vscode from 'vscode';
import { ReviewSessionStore, getReviewSessionStore } from './store/reviewSessionStore';
import { ReviewFinding, ReviewFile, ReviewHistoryEntry, ReviewSession, Severity } from './types/review';

export interface TreeElement {
  id: string;
  label: string;
  icon?: string;
  command?: vscode.Command;
  contextValue?: string;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  children?: TreeElement[];
  finding?: ReviewFinding;
  file?: ReviewFile;
  historyEntry?: ReviewHistoryEntry;
  session?: ReviewSession;
}

export type ReviewTreeViewId = 'reviewmp.newReview' | 'reviewmp.filesToReview' | 'reviewmp.reviews' | 'reviewmp.previousReviews';

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeElement> {
  private viewId: ReviewTreeViewId;
  private store: ReviewSessionStore;
  private _onDidChangeTreeData: vscode.EventEmitter<TreeElement | undefined | void> = new vscode.EventEmitter<TreeElement | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<TreeElement | undefined | void> = this._onDidChangeTreeData.event;

  constructor(viewId: ReviewTreeViewId, store?: ReviewSessionStore) {
    this.viewId = viewId;
    this.store = store || getReviewSessionStore();
    this.subscribeToStoreEvents();
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

  getTreeItem(element: TreeElement): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      element.label,
      element.collapsibleState ?? vscode.TreeItemCollapsibleState.None
    );

    if (element.icon) {
      treeItem.iconPath = new vscode.ThemeIcon(element.icon);
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
      case 'reviewmp.newReview':
        return this.getNewReviewItems();
      case 'reviewmp.filesToReview':
        return this.getFilesToReviewItems();
      case 'reviewmp.reviews':
        return this.getReviewsItems();
      case 'reviewmp.previousReviews':
        return this.getPreviousReviewsItems();
      default:
        return [];
    }
  }

  private getNewReviewItems(): TreeElement[] {
    return [
      {
        id: 'review-all-changes',
        label: 'Review All Changes',
        icon: '$(git-incoming)',
        command: { command: 'reviewmp.reviewAllChanges', title: 'Review All Changes' },
      },
      {
        id: 'review-staged',
        label: 'Review Staged Changes',
        icon: '$(git-staged)',
        command: { command: 'reviewmp.reviewStaged', title: 'Review Staged Changes' },
      },
      {
        id: 'review-uncommitted',
        label: 'Review Uncommitted Changes',
        icon: '$(git-unstaged)',
        command: { command: 'reviewmp.reviewUncommitted', title: 'Review Uncommitted Changes' },
      },
      {
        id: 'review-current-file',
        label: 'Review Current File',
        icon: '$(file)',
        command: { command: 'reviewmp.reviewFile', title: 'Review Current File' },
      },
      {
        id: 'review-selection',
        label: 'Review Current Selection',
        icon: '$(selection)',
        command: { command: 'reviewmp.reviewSelection', title: 'Review Current Selection' },
      },
      {
        id: 'review-last-commit',
        label: 'Review Last Commit',
        icon: '$(git-commit)',
        command: { command: 'reviewmp.reviewLastCommit', title: 'Review Last Commit' },
      },
      {
        id: 'review-branch',
        label: 'Review Branch Changes',
        icon: '$(git-branch)',
        command: { command: 'reviewmp.reviewBranch', title: 'Review Branch Changes' },
      },
    ];
  }

  private getFilesToReviewItems(): TreeElement[] {
    const session = this.store.getActiveSession();
    if (!session) {
      return [{
        id: 'no-session',
        label: 'No active review',
        icon: '$(info)',
      }];
    }

    const files = this.store.getFilesForSession();
    if (files.length === 0) {
      return [{
        id: 'no-files',
        label: 'No files to review',
        icon: '$(circle-outline)',
      }];
    }

    return files.map(file => this.fileToTreeElement(file));
  }

  private fileToTreeElement(file: ReviewFile): TreeElement {
    const statusIcon = this.getFileStatusIcon(file.status);
    const findingCount = file.findings.length;
    const pendingCount = file.findings.filter(f => f.status === 'pending').length;

    let label = this.getRelativePath(file.path);
    if (pendingCount > 0) {
      label += ` (${pendingCount} pending)`;
    }

    return {
      id: `file-${file.path}`,
      label,
      icon: statusIcon,
      file,
      command: {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(file.path)],
      },
    };
  }

  private getReviewsItems(): TreeElement[] {
    const session = this.store.getActiveSession();
    if (!session) {
      return [{
        id: 'no-review',
        label: 'No active review',
        icon: '$(info)',
      }];
    }

    const items: TreeElement[] = [];

    items.push({
      id: 'session-header',
      label: `${session.title} (${this.getStatusLabel(session.status)})`,
      icon: this.getStatusIcon(session.status),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      session,
      children: this.getSessionFileGroups(session),
    });

    return items;
  }

  private getSessionFileGroups(session: ReviewSession): TreeElement[] {
    const files = Array.from(session.files.values());

    return files.map(file => ({
      id: `file-group-${file.path}`,
      label: `${this.getRelativePath(file.path)} (${file.findings.length} findings)`,
      icon: this.getFileStatusIcon(file.status),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
      file,
      children: file.findings.map(finding => this.findingToTreeElement(finding)),
    }));
  }

  private findingToTreeElement(finding: ReviewFinding): TreeElement {
    const severityIcon = this.getSeverityIcon(finding.severity);
    const statusIcon = finding.status === 'applied' ? '$(check)' :
                       finding.status === 'dismissed' ? '$(x)' : '';
    const fixIcon = finding.fix ? ' $(tool)' : '';

    const label = `${severityIcon} Line ${finding.line}: ${finding.message}${fixIcon}${statusIcon ? ` ${statusIcon}` : ''}`;

    return {
      id: `finding-${finding.id}`,
      label,
      icon: severityIcon,
      finding,
      contextValue: finding.fix ? 'findingWithFix' : 'finding',
      command: {
        command: 'reviewmp.openFinding',
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
        icon: '$(history)',
      }];
    }

    return history.map(entry => this.historyEntryToTreeElement(entry));
  }

  private historyEntryToTreeElement(entry: ReviewHistoryEntry): TreeElement {
    const date = new Date(entry.completedAt).toLocaleDateString();
    const duration = this.formatDuration(entry.duration);
    const typeIcon = this.getReviewTypeIcon(entry.reviewType);

    return {
      id: `history-${entry.sessionId}`,
      label: `${entry.title}`,
      icon: typeIcon,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      historyEntry: entry,
      contextValue: 'previousReview',
      command: {
        command: 'reviewmp.openReviewPanel',
        title: 'Open Review',
        arguments: [entry.sessionId],
      },
    };
  }

  private getRelativePath(filePath: string): string {
    const parts = filePath.split('/').filter(p => p.length > 0);
    if (parts.length > 3) {
      return '...' + parts.slice(-2).join('/');
    }
    return filePath;
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      idle: 'Idle',
      settingUp: 'Setting up...',
      analyzing: 'Analyzing...',
      reviewing: 'Reviewing',
      completed: 'Completed',
      failed: 'Failed',
    };
    return labels[status] || status;
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
    return icons[status] || '$(circle)';
  }

  private getFileStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      pending: '$(circle-outline)',
      reviewing: '$(eye)',
      reviewed: '$(check)',
      failed: '$(error)',
    };
    return icons[status] || '$(file)';
  }

  private getSeverityIcon(severity: Severity): string {
    const icons: Record<Severity, string> = {
      error: '$(error)',
      warning: '$(warning)',
      info: '$(info)',
      suggestion: '$(lightbulb)',
    };
    return icons[severity] || '$(info)';
  }

  private getReviewTypeIcon(reviewType: string): string {
    const icons: Record<string, string> = {
      file: '$(file)',
      selection: '$(selection)',
      staged: '$(git-staged)',
      uncommitted: '$(git-unstaged)',
      lastCommit: '$(git-commit)',
      branch: '$(git-branch)',
      pullRequest: '$(git-pull-request)',
    };
    return icons[reviewType] || '$(file)';
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

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
