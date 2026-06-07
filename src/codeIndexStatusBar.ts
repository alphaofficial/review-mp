import * as vscode from 'vscode';
import { CodeIndexController } from './services/code-index/controller';

export class CodeIndexStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly listener: vscode.Disposable;

  constructor(controller: CodeIndexController) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'codebunny.openIndexPanel';
    this.listener = controller.onDidChangeState((state) => {
      this.item.text = `$(database) ${this.getDot(state.status)}`;
      this.item.tooltip = [
        'CodeBunny Codebase Indexing',
        `${this.toStatusLabel(state.status)}${state.enabled ? '' : ' (disabled)'}`,
        state.message,
        `Indexed files: ${state.indexedFiles}`,
        `Pending updates: ${state.pendingFiles}`,
      ].join('\n');
      this.item.color = this.getColor(state.status);
      this.item.show();
    });
    const initialState = controller.getState();
    this.item.text = `$(database) ${this.getDot(initialState.status)}`;
    this.item.tooltip = 'CodeBunny Codebase Indexing';
    this.item.color = this.getColor(initialState.status);
    this.item.show();
  }

  dispose(): void {
    this.listener.dispose();
    this.item.dispose();
  }

  private getDot(status: string): string {
    switch (status) {
      case 'indexed':
        return '●';
      case 'indexing':
        return '◔';
      case 'stopping':
        return '◑';
      case 'error':
        return '●';
      case 'standby':
      default:
        return '○';
    }
  }

  private getColor(status: string): string | undefined {
    switch (status) {
      case 'indexed':
        return '#22c55e';
      case 'indexing':
        return '#f59e0b';
      case 'stopping':
        return '#fb923c';
      case 'error':
        return '#ef4444';
      default:
        return undefined;
    }
  }

  private toStatusLabel(status: string): string {
    switch (status) {
      case 'indexed':
        return 'Indexed';
      case 'indexing':
        return 'Indexing';
      case 'stopping':
        return 'Stopping';
      case 'error':
        return 'Error';
      default:
        return 'Standby';
    }
  }
}
