import * as vscode from 'vscode';
import { logDebug } from './settings';

// VS Code Git Extension API types
interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
}

interface Repository {
  state: RepositoryState;
  onDidCommit: vscode.Event<void>;
}

interface RepositoryState {
  indexChanges: Change[];
  workingTreeChanges: Change[];
}

interface Change {
  uri: vscode.Uri;
}

export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private isReviewing: boolean = false;
  private lastIndexCount: number = 0;
  private lastIndexSignature: string = '';
  private repository: Repository | undefined;

  constructor(
    private onStageCallback: () => Promise<void>,
    private onCommitCallback: () => Promise<boolean>
  ) {
    logDebug('Git watcher constructed');
    this.setupConfigListener();
    this.initGitWatcher();
  }

  private setupConfigListener(): void {
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('codebunny.autoReviewOnStage') ||
        e.affectsConfiguration('codebunny.autoReviewOnCommit')
      ) {
        logDebug('Git watcher configuration changed; reinitializing');
        this.stopPolling();
        this.initGitWatcher();
      }
    });
    this.disposables.push(configListener);
  }

  private getConfig(): { autoReviewOnStage: boolean; autoReviewOnCommit: boolean } {
    const config = vscode.workspace.getConfiguration('codebunny');
    return {
      autoReviewOnStage: config.get<boolean>('autoReviewOnStage', false),
      autoReviewOnCommit: config.get<boolean>('autoReviewOnCommit', false),
    };
  }

  private async initGitWatcher(): Promise<void> {
    const config = this.getConfig();
    logDebug('Initializing git watcher', config);
    
    if (!config.autoReviewOnStage && !config.autoReviewOnCommit) {
      logDebug('Auto-review disabled; skipping git watcher initialization', config);
      return;
    }

    // Get VS Code's built-in Git extension
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      logDebug('Git watcher initialization skipped because VS Code Git extension was not found');
      return;
    }

    try {
      const git = gitExtension.isActive 
        ? gitExtension.exports.getAPI(1) 
        : (await gitExtension.activate()).getAPI(1);

      if (git.repositories.length > 0) {
        this.watchRepository(git.repositories[0], config);
      }

      // Watch for new repositories
      const repoDisposable = git.onDidOpenRepository((repo) => {
        this.watchRepository(repo, this.getConfig());
      });
      this.disposables.push(repoDisposable);

      logDebug('Git watcher initialized', {
        repositoryCount: git.repositories.length,
        autoReviewOnStage: config.autoReviewOnStage,
        autoReviewOnCommit: config.autoReviewOnCommit,
      });
    } catch (err) {
      logDebug('Git watcher initialization failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private watchRepository(repo: Repository, config: { autoReviewOnStage: boolean; autoReviewOnCommit: boolean }): void {
    this.repository = repo;
    this.lastIndexCount = repo.state.indexChanges.length;
    this.lastIndexSignature = this.getIndexSignature(repo.state.indexChanges);

    // For staging detection, poll the state every 2 seconds
    if (config.autoReviewOnStage) {
      this.startPolling();
    }

    // VS Code only exposes a post-commit event here, so trigger the commit callback
    // when a commit is created and let the caller decide what review to run.
    if (config.autoReviewOnCommit) {
      const commitDisposable = repo.onDidCommit(async () => {
        if (this.isReviewing) {
          logDebug('Git watcher ignored commit event because review is already running');
          return;
        }

        logDebug('Git watcher detected commit; triggering commit review');

        try {
          this.isReviewing = true;
          await this.onCommitCallback();
          logDebug('Git watcher commit review completed');
        } catch (error) {
          logDebug('Git watcher commit review failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          this.isReviewing = false;
        }
      });
      this.disposables.push(commitDisposable);
    }

    logDebug('Git watcher watching repository', {
      initialStagedFileCount: this.lastIndexCount,
      autoReviewOnStage: config.autoReviewOnStage,
      autoReviewOnCommit: config.autoReviewOnCommit,
    });
  }

  private startPolling(): void {
    logDebug('Git watcher stage polling started', {
      intervalMs: 2000,
    });
    this.pollTimer = setInterval(() => {
      this.checkForStagedChanges();
    }, 2000); // Poll every 2 seconds
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      logDebug('Git watcher stage polling stopped');
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private checkForStagedChanges(): void {
    if (!this.repository || this.isReviewing) {
      logDebug('Git watcher staged-change check skipped', {
        hasRepository: Boolean(this.repository),
        isReviewing: this.isReviewing,
      });
      return;
    }

    const indexChanges = this.repository.state.indexChanges;
    const currentIndexCount = indexChanges.length;
    const currentIndexSignature = this.getIndexSignature(indexChanges);
    const stagedSetChanged = currentIndexCount > 0 && currentIndexSignature !== this.lastIndexSignature;

    // Detect if files were staged or the staged set changed in place.
    if (currentIndexCount > this.lastIndexCount || (currentIndexCount === this.lastIndexCount && stagedSetChanged)) {
      logDebug('Git watcher detected staged changes', {
        previousIndexCount: this.lastIndexCount,
        currentIndexCount,
        stagedSetChanged,
      });
      this.triggerReview();
    }

    this.lastIndexCount = currentIndexCount;
    this.lastIndexSignature = currentIndexSignature;
  }

  private getIndexSignature(changes: Change[]): string {
    return changes
      .map((change) => {
        const uri = change.uri?.fsPath
          ?? (typeof change.uri?.toString === 'function' ? change.uri.toString() : '');
        const metadata = Object.entries(change as unknown as Record<string, unknown>)
          .filter(([key]) => key !== 'uri')
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}:${String(value)}`)
          .join('|');

        return `${uri}|${metadata}`;
      })
      .sort()
      .join('||');
  }

  private triggerReview(): void {
    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    logDebug('Git watcher scheduled staged review', {
      debounceMs: 500,
    });

    this.debounceTimer = setTimeout(async () => {
      if (this.isReviewing) {
        logDebug('Git watcher skipped staged review because review is already running');
        return;
      }

      logDebug('Git watcher triggering staged review');

      try {
        this.isReviewing = true;
        await this.onStageCallback();
        logDebug('Git watcher staged review completed');
      } catch (error) {
        logDebug('Git watcher staged review failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        this.isReviewing = false;
      }
    }, 500);
  }

  dispose(): void {
    logDebug('Disposing git watcher', {
      disposableCount: this.disposables.length,
      hasDebounceTimer: Boolean(this.debounceTimer),
      hasPollTimer: Boolean(this.pollTimer),
    });
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
