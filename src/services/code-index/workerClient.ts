import { ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import { CodeIndexBackend } from './backend';
import { CodeIndexResolvedSettings } from './config-shared';

type WorkerRequest =
  | { id: number; method: 'rebuildWorkspace' }
  | { id: number; method: 'indexFiles'; candidateFilePaths: string[] }
  | { id: number; method: 'removeFiles'; candidateFilePaths: string[] }
  | { id: number; method: 'clearStorage' }
  | { id: number; method: 'getCurrentBranch' }
  | { id: number; method: 'close' };

type WorkerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

type WorkerRequestMessage =
  | { method: 'rebuildWorkspace' }
  | { method: 'indexFiles'; candidateFilePaths: string[] }
  | { method: 'removeFiles'; candidateFilePaths: string[] }
  | { method: 'clearStorage' }
  | { method: 'getCurrentBranch' }
  | { method: 'close' };

export class CodeIndexWorkerClient implements CodeIndexBackend {
  private readonly child: ChildProcess;
  private nextRequestId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>();
  private closed = false;

  constructor(
    workspaceRoot: string,
    storageRoot: string | undefined,
    resolvedSettings?: CodeIndexResolvedSettings
  ) {
    const workerPath = path.join(__dirname, 'workerProcess.js');
    this.child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        CODEBUNNY_INDEX_WORKSPACE_ROOT: workspaceRoot,
        CODEBUNNY_INDEX_STORAGE_ROOT: storageRoot ?? '',
        CODEBUNNY_INDEX_EMBEDDER_PROVIDER: resolvedSettings?.embedderProvider ?? '',
        CODEBUNNY_INDEX_OLLAMA_BASE_URL: resolvedSettings?.ollamaBaseUrl ?? '',
        CODEBUNNY_INDEX_OLLAMA_MODEL: resolvedSettings?.ollamaModel ?? '',
        CODEBUNNY_INDEX_MODEL_DIMENSION: String(resolvedSettings?.modelDimension ?? ''),
        CODEBUNNY_INDEX_QDRANT_URL: resolvedSettings?.qdrantUrl ?? '',
        CODEBUNNY_INDEX_QDRANT_API_KEY: resolvedSettings?.qdrantApiKey ?? '',
        CODEBUNNY_INDEX_SEARCH_MIN_SCORE: String(resolvedSettings?.searchMinScore ?? ''),
        CODEBUNNY_INDEX_SEARCH_MAX_RESULTS: String(resolvedSettings?.searchMaxResults ?? ''),
      },
    });

    this.child.on('message', (message: WorkerResponse) => {
      if (!message || typeof message !== 'object' || typeof message.id !== 'number') {
        return;
      }

      const pendingRequest = this.pending.get(message.id);
      if (!pendingRequest) {
        return;
      }

      this.pending.delete(message.id);
      if (message.ok) {
        pendingRequest.resolve(message.result);
      } else {
        pendingRequest.reject(new Error(message.error));
      }
    });

    this.child.on('exit', (code, signal) => {
      this.closed = true;
      const error = new Error(`Code index worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const pendingRequest of this.pending.values()) {
        pendingRequest.reject(error);
      }
      this.pending.clear();
    });
  }

  async rebuildWorkspace(): Promise<number> {
    const result = await this.request({ method: 'rebuildWorkspace' });
    return typeof result === 'number' ? result : 0;
  }

  async indexFiles(candidateFilePaths: string[]): Promise<void> {
    await this.request({ method: 'indexFiles', candidateFilePaths });
  }

  async removeFiles(candidateFilePaths: string[]): Promise<void> {
    await this.request({ method: 'removeFiles', candidateFilePaths });
  }

  async clearStorage(): Promise<void> {
    await this.request({ method: 'clearStorage' });
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.request({ method: 'getCurrentBranch' });
    return typeof result === 'string' ? result : 'workspace';
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.request({ method: 'close' });
    } catch {
      // Best effort shutdown before kill.
    } finally {
      this.closed = true;
      if (!this.child.killed) {
        this.child.kill();
      }
    }
  }

  private request(message: WorkerRequestMessage): Promise<unknown> {
    if (this.closed || !this.child.connected) {
      return Promise.reject(new Error('Code index worker is not available'));
    }

    const id = this.nextRequestId++;
    const payload = { id, ...message } as WorkerRequest;

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send(payload, (error) => {
        if (!error) {
          return;
        }

        this.pending.delete(id);
        reject(error);
      });
    });
  }
}
