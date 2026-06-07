import * as vscode from 'vscode';
import path from 'node:path';
import { CodeIndexBackend } from './backend';
import { logDebug } from '../../settings';

export type CodeIndexStatus = 'standby' | 'indexing' | 'indexed' | 'error' | 'stopping';

export interface CodeIndexState {
  status: CodeIndexStatus;
  message: string;
  indexedFiles: number;
  pendingFiles: number;
  lastIndexedAt?: number;
}

export interface CodeIndexOrchestratorOptions {
  batchSize?: number;
  debounceMs?: number;
  branchPollMs?: number;
}

export class CodeIndexOrchestrator implements vscode.Disposable {
  private readonly batchSize: number;
  private readonly debounceMs: number;
  private readonly branchPollMs: number;
  private watcher?: vscode.FileSystemWatcher;
  private branchPoll?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private started = false;
  private indexing = false;
  private disposed = false;
  private pendingUpserts = new Set<string>();
  private pendingDeletes = new Set<string>();
  private knownBranch = '';
  private readonly stateEmitter = new vscode.EventEmitter<CodeIndexState>();
  private state: CodeIndexState = {
    status: 'standby',
    message: 'Standby',
    indexedFiles: 0,
    pendingFiles: 0,
  };

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    private readonly workspaceRoot: string,
    private readonly index: CodeIndexBackend,
    options: CodeIndexOrchestratorOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 64;
    this.debounceMs = options.debounceMs ?? 1000;
    this.branchPollMs = options.branchPollMs ?? 5000;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      logDebug('Code index start ignored', {
        workspaceRoot: this.workspaceRoot,
        started: this.started,
        disposed: this.disposed,
      });
      return;
    }

    if (this.started) {
      logDebug('Code index start ignored because orchestrator is already started', {
        workspaceRoot: this.workspaceRoot,
        state: this.state,
      });
      return;
    }

    this.setState({
      status: 'indexing',
      message: 'Indexing workspace',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });
    this.started = true;
    this.indexing = true;

    try {
      this.knownBranch = await this.index.getCurrentBranch();
      logDebug('Code index startup beginning', {
        workspaceRoot: this.workspaceRoot,
        branch: this.knownBranch,
        batchSize: this.batchSize,
        debounceMs: this.debounceMs,
        branchPollMs: this.branchPollMs,
      });
      this.installWatcher();
      this.installBranchPoll();
      const indexedFiles = await this.index.rebuildWorkspace();
      logDebug('Code index startup completed', {
        workspaceRoot: this.workspaceRoot,
        branch: this.knownBranch,
        indexedFiles,
      });

      this.setState({
        status: 'indexed',
        message: 'Indexed - File watcher started',
        indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: Date.now(),
      });
    } catch (error) {
      this.started = false;
      this.uninstallRuntimeHooks();
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        indexedFiles: this.state.indexedFiles,
        pendingFiles: this.pendingUpserts.size + this.pendingDeletes.size,
      });
      logDebug('Code index startup failed', {
        workspaceRoot: this.workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.indexing = false;
    }
  }

  async rebuild(): Promise<void> {
    if (this.disposed) {
      logDebug('Code index rebuild ignored because orchestrator is disposed', {
        workspaceRoot: this.workspaceRoot,
      });
      return;
    }

    if (!this.started) {
      this.started = true;
      this.installWatcher();
      this.installBranchPoll();
    }

    this.setState({
      status: 'indexing',
      message: 'Rebuilding workspace index',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });
    this.indexing = true;
    this.flushTimer && clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingDeletes.clear();
    this.pendingUpserts.clear();

    try {
      this.knownBranch = await this.index.getCurrentBranch();
      const indexedFiles = await this.index.rebuildWorkspace();
      this.setState({
        status: 'indexed',
        message: 'Indexed - File watcher started',
        indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: Date.now(),
      });
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        indexedFiles: this.state.indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: this.state.lastIndexedAt,
      });
      throw error;
    } finally {
      this.indexing = false;
    }
  }

  stop(): void {
    if (!this.started || this.disposed) {
      logDebug('Code index stop ignored', {
        workspaceRoot: this.workspaceRoot,
        started: this.started,
        disposed: this.disposed,
      });
      return;
    }

    this.setState({
      status: 'stopping',
      message: 'Stopping index watcher',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });
    this.started = false;
    this.indexing = false;
    this.pendingDeletes.clear();
    this.pendingUpserts.clear();
    this.uninstallRuntimeHooks();
    this.setState({
      status: 'standby',
      message: 'Indexing stopped',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });
  }

  async clearIndexData(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const wasStarted = this.started;
    if (wasStarted) {
      this.stop();
    }

    this.setState({
      status: 'indexing',
      message: 'Clearing index data',
      indexedFiles: 0,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });

    try {
      await this.index.clearStorage();
      this.setState({
        status: 'standby',
        message: 'Index data cleared',
        indexedFiles: 0,
        pendingFiles: 0,
      });
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        indexedFiles: this.state.indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: this.state.lastIndexedAt,
      });
      throw error;
    }
  }

  getState(): CodeIndexState {
    return this.state;
  }

  async flushPending(): Promise<void> {
    if (this.indexing || this.disposed) {
      logDebug('Code index pending flush skipped', {
        workspaceRoot: this.workspaceRoot,
        indexing: this.indexing,
        disposed: this.disposed,
        pendingUpserts: this.pendingUpserts.size,
        pendingDeletes: this.pendingDeletes.size,
      });
      return;
    }

    const deletes = [...this.pendingDeletes];
    const upserts = [...this.pendingUpserts].filter((filePath) => !this.pendingDeletes.has(filePath));
    this.pendingDeletes.clear();
    this.pendingUpserts.clear();

    if (deletes.length === 0 && upserts.length === 0) {
      logDebug('Code index pending flush skipped because queue is empty', {
        workspaceRoot: this.workspaceRoot,
      });
      return;
    }

    this.indexing = true;
    logDebug('Code index pending flush started', {
      workspaceRoot: this.workspaceRoot,
      upsertCount: upserts.length,
      deleteCount: deletes.length,
      sampleUpserts: upserts.slice(0, 5),
      sampleDeletes: deletes.slice(0, 5),
    });
    this.setState({
      status: 'indexing',
      message: 'Applying incremental index updates',
      indexedFiles: this.state.indexedFiles,
      pendingFiles: deletes.length + upserts.length,
      lastIndexedAt: this.state.lastIndexedAt,
    });

    try {
      if (deletes.length > 0) {
        await this.index.removeFiles(deletes);
      }
      if (upserts.length > 0) {
        await this.index.indexFiles(upserts);
      }
      logDebug('Code index pending flush completed', {
        workspaceRoot: this.workspaceRoot,
        upsertCount: upserts.length,
        deleteCount: deletes.length,
      });

      this.setState({
        status: 'indexed',
        message: 'Indexed - File watcher started',
        indexedFiles: this.state.indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: Date.now(),
      });
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        indexedFiles: this.state.indexedFiles,
        pendingFiles: deletes.length + upserts.length,
        lastIndexedAt: this.state.lastIndexedAt,
      });
      logDebug('Code index incremental update failed', {
        workspaceRoot: this.workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.indexing = false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    logDebug('Disposing code index orchestrator', {
      workspaceRoot: this.workspaceRoot,
      pendingUpserts: this.pendingUpserts.size,
      pendingDeletes: this.pendingDeletes.size,
      state: this.state,
    });
    this.disposed = true;
    this.uninstallRuntimeHooks();
    this.stateEmitter.dispose();
    void this.index.close();
  }

  private installWatcher(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,json}');
    this.watcher.onDidCreate((uri) => this.queueUpsert(uri.fsPath));
    this.watcher.onDidChange((uri) => this.queueUpsert(uri.fsPath));
    this.watcher.onDidDelete((uri) => this.queueDelete(uri.fsPath));
    logDebug('Code index file watcher installed', {
      workspaceRoot: this.workspaceRoot,
      pattern: '**/*.{ts,tsx,js,jsx,json}',
    });
  }

  private installBranchPoll(): void {
    if (this.branchPoll) {
      return;
    }

    logDebug('Code index branch polling installed', {
      workspaceRoot: this.workspaceRoot,
      branchPollMs: this.branchPollMs,
      initialBranch: this.knownBranch,
    });
    this.branchPoll = setInterval(() => {
      void this.pollBranch();
    }, this.branchPollMs);
  }

  private uninstallRuntimeHooks(): void {
    this.flushTimer && clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.branchPoll && clearInterval(this.branchPoll);
    this.branchPoll = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private queueUpsert(filePath: string): void {
    const relativePath = this.toRelativePath(filePath);
    if (!relativePath) {
      logDebug('Code index ignored upsert outside workspace', {
        workspaceRoot: this.workspaceRoot,
        filePath,
      });
      return;
    }

    this.pendingDeletes.delete(relativePath);
    this.pendingUpserts.add(relativePath);
    logDebug('Code index queued file upsert', {
      workspaceRoot: this.workspaceRoot,
      relativePath,
      pendingUpserts: this.pendingUpserts.size,
      pendingDeletes: this.pendingDeletes.size,
    });
    this.scheduleFlush();
  }

  private queueDelete(filePath: string): void {
    const relativePath = this.toRelativePath(filePath);
    if (!relativePath) {
      logDebug('Code index ignored delete outside workspace', {
        workspaceRoot: this.workspaceRoot,
        filePath,
      });
      return;
    }

    this.pendingUpserts.delete(relativePath);
    this.pendingDeletes.add(relativePath);
    logDebug('Code index queued file delete', {
      workspaceRoot: this.workspaceRoot,
      relativePath,
      pendingUpserts: this.pendingUpserts.size,
      pendingDeletes: this.pendingDeletes.size,
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.flushTimer && clearTimeout(this.flushTimer);
    logDebug('Code index scheduled pending flush', {
      workspaceRoot: this.workspaceRoot,
      debounceMs: this.debounceMs,
      pendingUpserts: this.pendingUpserts.size,
      pendingDeletes: this.pendingDeletes.size,
    });
    this.setState({
      ...this.state,
      pendingFiles: this.pendingUpserts.size + this.pendingDeletes.size,
    });
    this.flushTimer = setTimeout(() => {
      void this.flushPending();
    }, this.debounceMs);
  }

  private async rebuildForBranchChange(): Promise<void> {
    if (this.disposed) {
      logDebug('Code index branch rebuild skipped because orchestrator is disposed', {
        workspaceRoot: this.workspaceRoot,
        branch: this.knownBranch,
      });
      return;
    }

    const droppedPendingUpserts = this.pendingUpserts.size;
    const droppedPendingDeletes = this.pendingDeletes.size;
    this.flushTimer && clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingDeletes.clear();
    this.pendingUpserts.clear();
    this.indexing = true;
    logDebug('Code index branch rebuild started', {
      workspaceRoot: this.workspaceRoot,
      branch: this.knownBranch,
      droppedPendingUpserts,
      droppedPendingDeletes,
    });
    this.setState({
      status: 'indexing',
      message: `Branch changed to ${this.knownBranch}, rebuilding index`,
      indexedFiles: 0,
      pendingFiles: 0,
      lastIndexedAt: this.state.lastIndexedAt,
    });

    try {
      const indexedFiles = await this.index.rebuildWorkspace();
      logDebug('Code index branch rebuild completed', {
        workspaceRoot: this.workspaceRoot,
        branch: this.knownBranch,
        indexedFiles,
      });
      this.setState({
        status: 'indexed',
        message: 'Indexed - File watcher started',
        indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: Date.now(),
      });
    } catch (error) {
      this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        indexedFiles: this.state.indexedFiles,
        pendingFiles: 0,
        lastIndexedAt: this.state.lastIndexedAt,
      });
      logDebug('Code index branch rebuild failed', {
        workspaceRoot: this.workspaceRoot,
        branch: this.knownBranch,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.indexing = false;
    }
  }

  private toRelativePath(filePath: string): string | undefined {
    const relativePath = path.relative(this.workspaceRoot, filePath);
    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return undefined;
    }

    return relativePath.replace(/\\/g, '/');
  }

  private setState(nextState: CodeIndexState): void {
    this.state = nextState;
    this.stateEmitter.fire(nextState);
    logDebug('Code index state changed', {
      workspaceRoot: this.workspaceRoot,
      ...nextState,
    });
  }

  private async pollBranch(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const nextBranch = await this.index.getCurrentBranch();
    if (nextBranch === this.knownBranch) {
      return;
    }

    logDebug('Code index branch change detected', {
      workspaceRoot: this.workspaceRoot,
      previousBranch: this.knownBranch,
      nextBranch,
    });
    this.knownBranch = nextBranch;
    await this.rebuildForBranchChange();
  }
}
