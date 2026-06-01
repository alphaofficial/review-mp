import * as vscode from 'vscode';
import { CodeIndexController, CodeIndexViewState } from './services/code-index/controller';

interface CodeIndexTreeElement {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  command?: vscode.Command;
}

export class CodeIndexTreeProvider implements vscode.TreeDataProvider<CodeIndexTreeElement>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly controller: CodeIndexController) {
    this.controller.onDidChangeState(() => this.refresh());
  }

  getTreeItem(element: CodeIndexTreeElement): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.command = element.command;
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    return item;
  }

  getChildren(): vscode.ProviderResult<CodeIndexTreeElement[]> {
    const state = this.controller.getState();
    return [
      this.buildStatusItem(state),
      this.buildIndexedFilesItem(state),
      this.buildPendingFilesItem(state),
      this.buildStorageItem(state),
      ...this.buildActionItems(state),
    ];
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private refresh(): void {
    this.changeEmitter.fire();
  }

  private buildStatusItem(state: CodeIndexViewState): CodeIndexTreeElement {
    return {
      id: 'code-index-status',
      label: 'Status',
      description: state.message,
      tooltip: `${this.toStatusLabel(state.status)}${state.lastIndexedAt ? ` · Last updated ${new Date(state.lastIndexedAt).toLocaleString()}` : ''}`,
      icon: this.getStatusIcon(state.status),
    };
  }

  private buildIndexedFilesItem(state: CodeIndexViewState): CodeIndexTreeElement {
    return {
      id: 'code-index-indexed-files',
      label: 'Indexed Files',
      description: String(state.indexedFiles),
      icon: 'files',
    };
  }

  private buildPendingFilesItem(state: CodeIndexViewState): CodeIndexTreeElement {
    return {
      id: 'code-index-pending-files',
      label: 'Pending Updates',
      description: String(state.pendingFiles),
      icon: state.pendingFiles > 0 ? 'sync~spin' : 'check',
    };
  }

  private buildStorageItem(state: CodeIndexViewState): CodeIndexTreeElement {
    return {
      id: 'code-index-storage',
      label: 'Index Storage',
      description: state.storagePath ? '.reviewmp/lancedb' : 'Unavailable',
      tooltip: state.storagePath,
      icon: 'database',
    };
  }

  private buildActionItems(state: CodeIndexViewState): CodeIndexTreeElement[] {
    const items: CodeIndexTreeElement[] = [];

    if (state.enabled) {
      items.push(
        {
          id: 'code-index-rebuild',
          label: 'Rebuild Index',
          icon: 'refresh',
          command: {
            command: 'reviewmp.rebuildCodeIndex',
            title: 'Rebuild Index',
          },
        },
        {
          id: 'code-index-stop',
          label: 'Stop Indexing',
          icon: 'debug-stop',
          command: {
            command: 'reviewmp.stopCodeIndex',
            title: 'Stop Indexing',
          },
        },
        {
          id: 'code-index-disable',
          label: 'Disable Indexing',
          icon: 'circle-slash',
          command: {
            command: 'reviewmp.disableCodeIndex',
            title: 'Disable Indexing',
          },
        },
        {
          id: 'code-index-clear',
          label: 'Clear Index Data',
          icon: 'trash',
          command: {
            command: 'reviewmp.clearCodeIndex',
            title: 'Clear Index Data',
          },
        }
      );
    } else {
      items.push({
        id: 'code-index-enable',
        label: 'Enable Indexing',
        icon: 'play',
        command: {
          command: 'reviewmp.enableCodeIndex',
          title: 'Enable Indexing',
        },
      });
    }

    return items;
  }

  private getStatusIcon(status: CodeIndexViewState['status']): string {
    switch (status) {
      case 'indexed':
        return 'pass-filled';
      case 'indexing':
        return 'sync~spin';
      case 'stopping':
        return 'debug-stop';
      case 'error':
        return 'error';
      case 'standby':
      default:
        return 'circle-large-outline';
    }
  }

  private toStatusLabel(status: CodeIndexViewState['status']): string {
    switch (status) {
      case 'indexed':
        return 'Indexed';
      case 'indexing':
        return 'Indexing';
      case 'stopping':
        return 'Stopping';
      case 'error':
        return 'Error';
      case 'standby':
      default:
        return 'Standby';
    }
  }
}
