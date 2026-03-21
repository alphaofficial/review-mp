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
  onDidChange: vscode.Event<void>;
}

interface Change {
  uri: vscode.Uri;
}

export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private isReviewing: boolean = false;
  private lastIndexUris: Set<string> = new Set();
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

      const repoDisposable = git.onDidOpenRepository((repo) => {
        this.watchRepository(repo, this.getConfig());
      });
      this.disposables.push(repoDisposable);

      console.log('[ReviewMP] Git watcher initialized');
    } catch (err) {
      console.log('[ReviewMP] Failed to initialize git watcher:', err);
    }
  }

  private watchRepository(
    repo: Repository,
    config: { autoReviewOnStage: boolean; autoReviewOnCommit: boolean }
  ): void {
    this.repository = repo;
    this.lastIndexUris = this.getIndexUriSet(repo);

    if (config.autoReviewOnStage) {
      // Use the state change event instead of polling
      const stateDisposable = repo.state.onDidChange(() => {
        this.checkForStagedChanges();
      });
      this.disposables.push(stateDisposable);
    }

    if (config.autoReviewOnCommit) {
      const commitDisposable = repo.onDidCommit(() => {
        console.log('[ReviewMP] Commit detected');
      });
      this.disposables.push(commitDisposable);
    }

    console.log('[ReviewMP] Watching repository, initial staged files:', this.lastIndexUris.size);
  }

  private getIndexUriSet(repo: Repository): Set<string> {
    return new Set(repo.state.indexChanges.map((c) => c.uri.toString()));
  }

  private checkForStagedChanges(): void {
    if (!this.repository || this.isReviewing) {
      return;
    }

    const currentUris = this.getIndexUriSet(this.repository);

    // Detect newly staged files (URIs present now but not before)
    let hasNewStaged = false;
    for (const uri of currentUris) {
      if (!this.lastIndexUris.has(uri)) {
        hasNewStaged = true;
        break;
      }
    }

    this.lastIndexUris = currentUris;

    if (hasNewStaged) {
      console.log('[ReviewMP] New files staged, count:', currentUris.size);
      this.triggerReview();
    }
  }

  private triggerReview(): void {
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposables.forEach((d) => d.dispose());
  }
}
