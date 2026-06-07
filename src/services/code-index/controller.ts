import * as vscode from 'vscode';
import { CodeIndexSecretStore, CodeIndexSetupSavePayload } from './config';
import { CodeIndexResolvedSettings } from './config-shared';
import { CodeIndexManager, CodeIndexManagerState } from './manager';

export type CodeIndexViewState = CodeIndexManagerState;

export class CodeIndexController implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<CodeIndexViewState>();
  private readonly managerListener: vscode.Disposable;

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly manager: CodeIndexManager,
    workspaceRoot: string | undefined,
    secretStore: CodeIndexSecretStore
  ) {
    this.manager.bindWorkspace(workspaceRoot, secretStore);
    this.managerListener = this.manager.onDidChangeState((state) => {
      this.stateEmitter.fire({ ...state });
    });
  }

  async initialize(): Promise<void> {
    await this.manager.initialize();
  }

  getState(): CodeIndexViewState {
    return this.manager.getState();
  }

  async getResolvedSetup(): Promise<CodeIndexResolvedSettings> {
    return this.manager.getResolvedSetup();
  }

  async setAutoEnableDefault(enabled: boolean): Promise<void> {
    await this.manager.setAutoEnableDefault(enabled);
  }

  async setWorkspaceEnabled(enabled: boolean): Promise<void> {
    await this.manager.setWorkspaceEnabled(enabled);
  }

  async saveSetup(nextSetup: CodeIndexSetupSavePayload): Promise<void> {
    await this.manager.saveSetup(nextSetup);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.manager.setFeatureEnabled(enabled);
  }

  async start(): Promise<void> {
    await this.manager.startIndexing();
  }

  async stop(): Promise<void> {
    this.manager.stopIndexing();
  }

  async rebuild(): Promise<void> {
    await this.manager.rebuildIndex();
  }

  async clear(): Promise<void> {
    await this.manager.clearIndexData();
  }

  dispose(): void {
    this.managerListener.dispose();
    this.stateEmitter.dispose();
  }
}
