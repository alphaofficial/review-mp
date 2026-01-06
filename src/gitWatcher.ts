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
  private repository: Repository | undefined;

  constructor(
    private onStageCallback: () => Promise<void>,
    private onPreCommitCallback: () => Promise<boolean>
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

    // For staging detection, poll the state every 2 seconds
    if (config.autoReviewOnStage) {
      this.startPolling();
    }

    // For commit detection, use onDidCommit event
    if (config.autoReviewOnCommit) {
      const commitDisposable = repo.onDidCommit(() => {
        console.log('[ReviewMP] Commit detected');
        // Commit already happened, could show a post-commit review option
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

    const currentIndexCount = this.repository.state.indexChanges.length;

    // Detect if files were staged (index count increased)
    if (currentIndexCount > this.lastIndexCount) {
      console.log('[ReviewMP] Files staged:', this.lastIndexCount, '->', currentIndexCount);
      this.triggerReview();
    }

    this.lastIndexCount = currentIndexCount;
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
