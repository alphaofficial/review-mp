import * as vscode from 'vscode';
import { getSettings, logDebug, setCodeIndexEnabled } from '../../settings';
import { RepoKnowledgeIndex } from '../../harness/repoKnowledgeIndex';
import { CodeIndexManager } from './manager';
import { CodeIndexOrchestrator, CodeIndexState } from './orchestrator';

export interface CodeIndexViewState extends CodeIndexState {
  workspaceRoot?: string;
  enabled: boolean;
  storagePath?: string;
}

export class CodeIndexController implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<CodeIndexViewState>();
  private orchestratorListener?: vscode.Disposable;
  private orchestrator?: CodeIndexOrchestrator;
  private state: CodeIndexViewState;

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly manager: CodeIndexManager,
    private readonly workspaceRoot: string | undefined
  ) {
    this.state = {
      status: 'standby',
      message: workspaceRoot ? 'Indexing disabled' : 'No workspace folder open',
      indexedFiles: 0,
      pendingFiles: 0,
      enabled: getSettings().codeIndexEnabled,
      workspaceRoot,
      storagePath: workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(workspaceRoot) : undefined,
    };
  }

  async initialize(): Promise<void> {
    if (!this.workspaceRoot) {
      this.emitState();
      return;
    }

    if (getSettings().codeIndexEnabled) {
      await this.attachOrchestrator();
    } else {
      this.syncDisabledState();
    }
  }

  getState(): CodeIndexViewState {
    return this.state;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await setCodeIndexEnabled(enabled);
    this.state.enabled = enabled;
    if (!this.workspaceRoot) {
      this.emitState();
      return;
    }

    if (!enabled) {
      const orchestrator = await this.attachOrchestrator();
      orchestrator.stop();
      this.syncDisabledState(orchestrator.getState());
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.start();
  }

  async start(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    if (!getSettings().codeIndexEnabled) {
      await this.setEnabled(true);
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.start();
  }

  async stop(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    orchestrator.stop();
    this.applyOrchestratorState(orchestrator.getState());
  }

  async rebuild(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    if (!getSettings().codeIndexEnabled) {
      await this.setEnabled(true);
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.rebuild();
  }

  async clear(): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.clearIndexData();
    this.applyOrchestratorState(orchestrator.getState());
  }

  dispose(): void {
    this.orchestratorListener?.dispose();
    this.stateEmitter.dispose();
  }

  private async attachOrchestrator(): Promise<CodeIndexOrchestrator> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    const orchestrator = await this.manager.activateWorkspace(this.workspaceRoot);
    if (this.orchestrator === orchestrator) {
      this.applyOrchestratorState(orchestrator.getState());
      return orchestrator;
    }

    this.orchestratorListener?.dispose();
    this.orchestrator = orchestrator;
    this.orchestratorListener = orchestrator.onDidChangeState((state) => {
      this.applyOrchestratorState(state);
    });
    this.applyOrchestratorState(orchestrator.getState());
    logDebug('Code index controller attached orchestrator', {
      workspaceRoot: this.workspaceRoot,
      state: orchestrator.getState(),
    });
    return orchestrator;
  }

  private syncDisabledState(orchestratorState?: CodeIndexState): void {
    this.state = {
      status: 'standby',
      message: 'Indexing disabled',
      indexedFiles: orchestratorState?.indexedFiles ?? this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: orchestratorState?.lastIndexedAt ?? this.state.lastIndexedAt,
      enabled: false,
      workspaceRoot: this.workspaceRoot,
      storagePath: this.workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(this.workspaceRoot) : undefined,
    };
    this.emitState();
  }

  private applyOrchestratorState(nextState: CodeIndexState): void {
    this.state = {
      ...nextState,
      enabled: getSettings().codeIndexEnabled,
      workspaceRoot: this.workspaceRoot,
      storagePath: this.workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(this.workspaceRoot) : undefined,
    };
    this.emitState();
  }

  private emitState(): void {
    this.stateEmitter.fire({ ...this.state });
  }
}
