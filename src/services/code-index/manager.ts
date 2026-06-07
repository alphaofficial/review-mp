import * as vscode from 'vscode';
import {
  getCodeIndexAutoEnableDefault,
  getCodeIndexFeatureEnabled,
  getWorkspaceCodeIndexEnabled,
  logDebug,
  setCodeIndexAutoEnableDefault,
  setCodeIndexEnabled,
  setWorkspaceCodeIndexEnabled,
} from '../../settings';
import { RepoKnowledgeIndex } from '../../harness/repoKnowledgeIndex';
import {
  CodeIndexSecretStore,
  CodeIndexSetupSavePayload,
  CodeIndexSetupState,
  getCodeIndexSetupSettings,
  isCodeIndexConfigured,
  saveCodeIndexSetupSettings,
} from './config';
import { CodeIndexResolvedSettings } from './config-shared';
import { CodeIndexOrchestrator, CodeIndexState } from './orchestrator';
import { CodeIndexServiceFactory } from './service-factory';

export interface CodeIndexManagerState extends CodeIndexState {
  workspaceRoot?: string;
  featureEnabled: boolean;
  configured: boolean;
  enabled: boolean;
  autoEnableDefault: boolean;
  workspaceEnabled: boolean;
  storagePath?: string;
  vectorStoreUrl?: string;
  setup: CodeIndexSetupState;
}

export class CodeIndexManager implements vscode.Disposable {
  private static instance: CodeIndexManager | undefined;

  private readonly stateEmitter = new vscode.EventEmitter<CodeIndexManagerState>();
  private orchestratorListener?: vscode.Disposable;
  private orchestrator?: CodeIndexOrchestrator;
  private workspaceRoot?: string;
  private secretStore?: CodeIndexSecretStore;
  private state: CodeIndexManagerState;

  readonly onDidChangeState = this.stateEmitter.event;

  constructor() {
    this.state = this.buildInitialState(undefined);
  }

  static getInstance(): CodeIndexManager {
    if (!CodeIndexManager.instance) {
      CodeIndexManager.instance = new CodeIndexManager();
    }
    return CodeIndexManager.instance;
  }

  bindWorkspace(workspaceRoot: string | undefined, secretStore: CodeIndexSecretStore): void {
    const previousWorkspaceRoot = this.workspaceRoot;
    this.workspaceRoot = workspaceRoot;
    this.secretStore = secretStore;
    if (this.orchestrator && workspaceRoot && workspaceRoot === previousWorkspaceRoot) {
      this.applyOrchestratorState(this.orchestrator.getState());
      return;
    }

    if (this.orchestrator && workspaceRoot !== previousWorkspaceRoot) {
      this.disposeOrchestrator();
    }

    this.state = this.buildInitialState(workspaceRoot);
    this.emitState();
  }

  getState(): CodeIndexManagerState {
    return this.state;
  }

  async initialize(): Promise<void> {
    await this.refreshSetupState();

    if (!this.isEffectivelyEnabled()) {
      this.stopOrchestratorIfNeeded();
      this.syncDisabledState();
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    const orchestratorState = orchestrator.getState();
    this.applyOrchestratorState(orchestratorState);
    if (orchestratorState.status === 'standby') {
      void orchestrator.start();
    }
  }

  async getResolvedSetup(): Promise<CodeIndexResolvedSettings> {
    if (this.secretStore) {
      return this.secretStore.getResolvedSettings();
    }

    return getCodeIndexSetupSettings();
  }

  async saveSetup(nextSetup: CodeIndexSetupSavePayload): Promise<void> {
    await saveCodeIndexSetupSettings({
      embedderProvider: nextSetup.embedderProvider,
      ollamaBaseUrl: nextSetup.ollamaBaseUrl,
      ollamaModel: nextSetup.ollamaModel,
      modelDimension: nextSetup.modelDimension,
      qdrantUrl: nextSetup.qdrantUrl,
      searchMinScore: nextSetup.searchMinScore,
      searchMaxResults: nextSetup.searchMaxResults,
    });
    if (this.secretStore && !nextSetup.preserveQdrantApiKey) {
      await this.secretStore.setQdrantApiKey(nextSetup.qdrantApiKey);
    }
    await setCodeIndexEnabled(nextSetup.featureEnabled);
    await this.refreshSetupState();

    if (!this.isEffectivelyEnabled()) {
      this.stopOrchestratorIfNeeded();
      this.syncDisabledState();
      return;
    }

    const orchestrator = await this.attachOrchestrator(true);
    const orchestratorState = orchestrator.getState();
    this.applyOrchestratorState(orchestratorState);
    if (orchestratorState.status === 'standby') {
      void orchestrator.start();
    }
  }

  async setFeatureEnabled(enabled: boolean): Promise<void> {
    await setCodeIndexEnabled(enabled);
    await this.refreshSetupState();

    if (!this.isEffectivelyEnabled()) {
      this.stopOrchestratorIfNeeded();
      this.syncDisabledState();
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    const orchestratorState = orchestrator.getState();
    this.applyOrchestratorState(orchestratorState);
    if (orchestratorState.status === 'standby') {
      await orchestrator.start();
    }
  }

  async setAutoEnableDefault(enabled: boolean): Promise<void> {
    await setCodeIndexAutoEnableDefault(enabled);
    await this.refreshSetupState();

    if (!this.isEffectivelyEnabled()) {
      this.stopOrchestratorIfNeeded();
      this.syncDisabledState();
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    const orchestratorState = orchestrator.getState();
    this.applyOrchestratorState(orchestratorState);
    if (orchestratorState.status === 'standby') {
      await orchestrator.start();
    }
  }

  async setWorkspaceEnabled(enabled: boolean): Promise<void> {
    await setWorkspaceCodeIndexEnabled(enabled);
    await this.refreshSetupState();

    if (!this.isEffectivelyEnabled()) {
      this.stopOrchestratorIfNeeded();
      this.syncDisabledState();
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    const orchestratorState = orchestrator.getState();
    this.applyOrchestratorState(orchestratorState);
    if (orchestratorState.status === 'standby') {
      await orchestrator.start();
    }
  }

  async startIndexing(): Promise<void> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    if (!getCodeIndexFeatureEnabled()) {
      this.syncDisabledState();
      throw new Error('Code indexing is disabled');
    }

    if (!this.state.configured) {
      this.syncDisabledState();
      throw new Error('Code indexing is not configured');
    }

    if (!getWorkspaceCodeIndexEnabled()) {
      await this.setWorkspaceEnabled(true);
      return;
    }

    if (this.state.status === 'error') {
      await this.recoverFromError();
      await this.initialize();
      return;
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.start();
  }

  stopIndexing(): void {
    this.orchestrator?.stop();
    if (!this.orchestrator) {
      this.syncDisabledState();
    }
  }

  async rebuildIndex(): Promise<void> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    if (!this.isEffectivelyEnabled()) {
      this.syncDisabledState();
      throw new Error(this.getDisabledMessage());
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.rebuild();
  }

  async clearIndexData(): Promise<void> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    const orchestrator = await this.attachOrchestrator();
    await orchestrator.clearIndexData();
    this.applyOrchestratorState(orchestrator.getState());
  }

  async activateWorkspace(workspaceRoot: string, resolvedSettings?: CodeIndexResolvedSettings): Promise<CodeIndexOrchestrator> {
    this.workspaceRoot = workspaceRoot;
    return this.attachOrchestrator(false, resolvedSettings);
  }

  async recreateWorkspace(workspaceRoot: string, resolvedSettings?: CodeIndexResolvedSettings): Promise<CodeIndexOrchestrator> {
    this.workspaceRoot = workspaceRoot;
    return this.attachOrchestrator(true, resolvedSettings);
  }

  dispose(): void {
    logDebug('Disposing code index manager');
    this.disposeOrchestrator();
    this.stateEmitter.dispose();
  }

  private buildInitialState(workspaceRoot: string | undefined): CodeIndexManagerState {
    const setup: CodeIndexSetupState = {
      ...getCodeIndexSetupSettings(),
      qdrantApiKey: '',
      qdrantApiKeyConfigured: false,
    };
    const configured = isCodeIndexConfigured(setup);

    return {
      status: 'standby',
      message: this.getDisabledMessageFor(workspaceRoot, configured),
      indexedFiles: 0,
      pendingFiles: 0,
      featureEnabled: getCodeIndexFeatureEnabled(),
      configured,
      enabled: this.getEffectiveEnabledState(setup),
      autoEnableDefault: getCodeIndexAutoEnableDefault(),
      workspaceEnabled: getWorkspaceCodeIndexEnabled(),
      workspaceRoot,
      storagePath: workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(workspaceRoot) : undefined,
      vectorStoreUrl: setup.qdrantUrl,
      setup,
    };
  }

  private async refreshSetupState(): Promise<void> {
    const setup = this.secretStore
      ? await this.secretStore.getSetupState()
      : {
          ...getCodeIndexSetupSettings(),
          qdrantApiKey: '',
          qdrantApiKeyConfigured: false,
        };
    const resolvedSettings = this.secretStore
      ? await this.secretStore.getResolvedSettings()
      : getCodeIndexSetupSettings();
    RepoKnowledgeIndex.setDefaultConnectionSettings(resolvedSettings);
    this.state = {
      ...this.state,
      featureEnabled: getCodeIndexFeatureEnabled(),
      configured: isCodeIndexConfigured(resolvedSettings),
      enabled: this.getEffectiveEnabledState(resolvedSettings),
      autoEnableDefault: getCodeIndexAutoEnableDefault(),
      workspaceEnabled: getWorkspaceCodeIndexEnabled(),
      workspaceRoot: this.workspaceRoot,
      storagePath: this.workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(this.workspaceRoot) : undefined,
      vectorStoreUrl: setup.qdrantUrl,
      setup,
    };
  }

  private async attachOrchestrator(
    recreate = false,
    resolvedSettingsOverride?: CodeIndexResolvedSettings
  ): Promise<CodeIndexOrchestrator> {
    if (!this.workspaceRoot) {
      throw new Error('No workspace folder open');
    }

    if (recreate) {
      this.disposeOrchestrator();
    }

    if (this.orchestrator) {
      this.applyOrchestratorState(this.orchestrator.getState());
      return this.orchestrator;
    }

    const resolvedSettings = resolvedSettingsOverride ?? await this.getResolvedSetup();
    const orchestrator = await CodeIndexServiceFactory.createOrchestrator(this.workspaceRoot, resolvedSettings);
    this.orchestrator = orchestrator;
    this.orchestratorListener = orchestrator.onDidChangeState((state) => {
      this.applyOrchestratorState(state);
    });
    this.applyOrchestratorState(orchestrator.getState());
    logDebug('Code index manager attached orchestrator', {
      workspaceRoot: this.workspaceRoot,
      state: orchestrator.getState(),
    });
    return orchestrator;
  }

  private disposeOrchestrator(): void {
    this.orchestratorListener?.dispose();
    this.orchestratorListener = undefined;
    if (this.orchestrator) {
      this.orchestrator.dispose();
      this.orchestrator = undefined;
    }
  }

  private stopOrchestratorIfNeeded(): void {
    this.orchestrator?.stop();
  }

  private async recoverFromError(): Promise<void> {
    this.disposeOrchestrator();
    this.syncDisabledState({
      status: 'standby',
      message: '',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });
  }

  private syncDisabledState(orchestratorState?: CodeIndexState): void {
    this.state = {
      status: 'standby',
      message: this.getDisabledMessage(),
      indexedFiles: orchestratorState?.indexedFiles ?? this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: orchestratorState?.lastIndexedAt ?? this.state.lastIndexedAt,
      featureEnabled: getCodeIndexFeatureEnabled(),
      configured: this.state.configured,
      enabled: false,
      autoEnableDefault: getCodeIndexAutoEnableDefault(),
      workspaceEnabled: getWorkspaceCodeIndexEnabled(),
      workspaceRoot: this.workspaceRoot,
      storagePath: this.workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(this.workspaceRoot) : undefined,
      vectorStoreUrl: this.state.setup.qdrantUrl,
      setup: this.state.setup,
    };
    this.emitState();
  }

  private applyOrchestratorState(nextState: CodeIndexState): void {
    this.state = {
      ...nextState,
      featureEnabled: getCodeIndexFeatureEnabled(),
      configured: this.state.configured,
      enabled: this.getEffectiveEnabledState(),
      autoEnableDefault: getCodeIndexAutoEnableDefault(),
      workspaceEnabled: getWorkspaceCodeIndexEnabled(),
      workspaceRoot: this.workspaceRoot,
      storagePath: this.workspaceRoot ? RepoKnowledgeIndex.getStoragePathForWorkspace(this.workspaceRoot) : undefined,
      vectorStoreUrl: this.state.setup.qdrantUrl,
      setup: this.state.setup,
    };
    this.emitState();
  }

  private emitState(): void {
    this.stateEmitter.fire({ ...this.state });
  }

  private getDisabledMessage(): string {
    return this.getDisabledMessageFor(this.workspaceRoot, this.state.configured);
  }

  private getDisabledMessageFor(workspaceRoot: string | undefined, configured: boolean): string {
    if (!workspaceRoot) {
      return 'No workspace folder open';
    }

    if (!getCodeIndexFeatureEnabled()) {
      return 'Code indexing is disabled';
    }

    if (!configured) {
      return 'Code indexing is not configured';
    }

    if (!getWorkspaceCodeIndexEnabled()) {
      return 'Indexing not enabled for this workspace';
    }

    return 'Standby';
  }

  private getEffectiveEnabledState(
    settings: Partial<CodeIndexResolvedSettings | CodeIndexSetupState> = this.state.setup
  ): boolean {
    return getCodeIndexFeatureEnabled()
      && getWorkspaceCodeIndexEnabled()
      && isCodeIndexConfigured(settings);
  }

  private isEffectivelyEnabled(): boolean {
    return this.getEffectiveEnabledState();
  }
}
