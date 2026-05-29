import * as vscode from 'vscode';

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
    this.setupConfigListener();
    this.initGitWatcher();
  }

  private setupConfigListener(): void {
    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('reviewmp.autoReviewOnStage') ||
        e.affectsConfiguration('reviewmp.autoReviewOnCommit')
      ) {
        this.stopPolling();
        this.initGitWatcher();
      }
    });
    this.disposables.push(configListener);
  }

  private getConfig(): { autoReviewOnStage: boolean; autoReviewOnCommit: boolean } {
    const config = vscode.workspace.getConfiguration('reviewmp');
    return {
      autoReviewOnStage: config.get<boolean>('autoReviewOnStage', false),
      autoReviewOnCommit: config.get<boolean>('autoReviewOnCommit', false),
    };
  }

  private async initGitWatcher(): Promise<void> {
    const config = this.getConfig();
    
    if (!config.autoReviewOnStage && !config.autoReviewOnCommit) {
      console.log('[ReviewMP] Auto-review disabled, skipping git watcher');
      return;
    }

    // Get VS Code's built-in Git extension
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      console.log('[ReviewMP] Git extension not found');
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

      console.log('[ReviewMP] Git watcher initialized');
    } catch (err) {
      console.log('[ReviewMP] Failed to initialize git watcher:', err);
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
          return;
        }

        console.log('[ReviewMP] Commit detected');

        try {
          this.isReviewing = true;
          await this.onCommitCallback();
        } finally {
          this.isReviewing = false;
        }
      });
      this.disposables.push(commitDisposable);
    }

    console.log('[ReviewMP] Watching repository, initial staged files:', this.lastIndexCount);
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      this.checkForStagedChanges();
    }, 2000); // Poll every 2 seconds
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private checkForStagedChanges(): void {
    if (!this.repository || this.isReviewing) {
      return;
    }

    const indexChanges = this.repository.state.indexChanges;
    const currentIndexCount = indexChanges.length;
    const currentIndexSignature = this.getIndexSignature(indexChanges);
    const stagedSetChanged = currentIndexCount > 0 && currentIndexSignature !== this.lastIndexSignature;

    // Detect if files were staged or the staged set changed in place.
    if (currentIndexCount > this.lastIndexCount || (currentIndexCount === this.lastIndexCount && stagedSetChanged)) {
      console.log('[ReviewMP] Files staged:', this.lastIndexCount, '->', currentIndexCount);
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

    this.debounceTimer = setTimeout(async () => {
      if (this.isReviewing) {
        return;
      }

      console.log('[ReviewMP] Triggering staged review');

      try {
        this.isReviewing = true;
        await this.onStageCallback();
      } finally {
        this.isReviewing = false;
      }
    }, 500);
  }

  dispose(): void {
    this.stopPolling();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
