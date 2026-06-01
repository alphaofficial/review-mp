import * as vscode from 'vscode';
import { getSettings, logDebug } from '../../settings';
import { CodeIndexOrchestrator } from './orchestrator';
import { CodeIndexServiceFactory } from './service-factory';

export class CodeIndexManager implements vscode.Disposable {
  private static instance: CodeIndexManager | undefined;
  private readonly orchestrators = new Map<string, CodeIndexOrchestrator>();

  static getInstance(): CodeIndexManager {
    if (!CodeIndexManager.instance) {
      CodeIndexManager.instance = new CodeIndexManager();
    }
    return CodeIndexManager.instance;
  }

  async activateWorkspace(workspaceRoot: string): Promise<CodeIndexOrchestrator> {
    const existing = this.orchestrators.get(workspaceRoot);
    if (existing) {
      logDebug('Code index workspace activation reused existing orchestrator', {
        workspaceRoot,
        state: existing.getState(),
      });
      return existing;
    }

    const orchestrator = await CodeIndexServiceFactory.createOrchestrator(workspaceRoot);
    this.orchestrators.set(workspaceRoot, orchestrator);
    const codeIndexEnabled = getSettings().codeIndexEnabled;
    logDebug('Code index workspace activation initialized orchestrator', {
      workspaceRoot,
      codeIndexEnabled,
    });
    if (codeIndexEnabled) {
      void orchestrator.start();
    } else {
      logDebug('Code index startup skipped because codeIndexEnabled is false', {
        workspaceRoot,
      });
    }
    return orchestrator;
  }

  getOrchestrator(workspaceRoot: string): CodeIndexOrchestrator | undefined {
    return this.orchestrators.get(workspaceRoot);
  }

  dispose(): void {
    logDebug('Disposing code index manager', {
      orchestratorCount: this.orchestrators.size,
    });
    for (const orchestrator of this.orchestrators.values()) {
      orchestrator.dispose();
    }
    this.orchestrators.clear();
  }
}
