import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';
import { ReviewCommentController, ReviewComment } from './comments';
import { ReviewRequest } from './types/review';
import { DiffContextCollector } from './harness/diffContextCollector';
import { clusterDiff, parseDiffIntoFiles } from './harness/diffClustering';
import { buildCrossFilePrompt, checkCrossFileConsistency, CrossFileConsistencyResult } from './harness/crossFileConsistencyPass';
import { ReviewSessionStore } from './store/reviewSessionStore';

export class ReviewOrchestrator implements vscode.Disposable {
  private getProvider: () => ModelProvider;
  private commentController: ReviewCommentController;
  private diffCollector: DiffContextCollector;
  private store: ReviewSessionStore;

  constructor(getProvider: () => ModelProvider, commentController: ReviewCommentController, store: ReviewSessionStore) {
    this.getProvider = getProvider;
    this.commentController = commentController;
    this.diffCollector = new DiffContextCollector();
    this.store = store;
  }

  async reviewFile(document: vscode.TextDocument): Promise<void> {
    const content = document.getText();
    const request: ReviewRequest = {
      code: content,
      languageId: document.languageId,
      filePath: document.uri.fsPath,
      reviewType: 'file',
    };
    await this.reviewCode(request);
  }

  async reviewSelection(
    uri: vscode.Uri,
    selectedText: string,
    startLine: number,
    languageId: string
  ): Promise<void> {
    const request: ReviewRequest = {
      code: selectedText,
      languageId,
      filePath: uri.fsPath,
      reviewType: 'selection',
      startLine,
    };
    await this.reviewCode(request);
  }

  async reviewStaged(): Promise<void> {
    await this.reviewGitChanges('staged');
  }

  async reviewUncommitted(): Promise<void> {
    await this.reviewGitChanges('uncommitted');
  }

  async reviewLastCommit(): Promise<void> {
    await this.reviewGitChanges('lastCommit');
  }

  async reviewBranch(): Promise<void> {
    await this.reviewGitChanges('branch');
  }

  async reviewPR(): Promise<void> {
    await this.reviewGitChanges('pullRequest');
  }

  clearComments(): void {
    this.commentController.clearAllComments();
  }

  clearActiveReview(): void {
    this.store.clearActiveSession();
    this.commentController.clearAllComments();
  }

  private async reviewCode(request: ReviewRequest): Promise<void> {
    const typeLabel = 'code';
    const startLine = request.startLine ?? 0;

    const session = this.store.createSession(request.reviewType, undefined, undefined, undefined);
    this.store.updateSessionStatus('settingUp');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Analyzing ${typeLabel}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          this.store.updateSessionStatus('analyzing');
          const result = await this.getProvider().review(request, token);

          if (token.isCancellationRequested) {
            this.store.clearActiveSession();
            return;
          }

          if (result.comments.length === 0) {
            this.store.updateSessionStatus('completed');
            vscode.window.showInformationMessage('No issues found in the code');
            return;
          }

          this.store.updateSessionStatus('reviewing');

          const adjustedComments = result.comments.map((c) => ({
            ...c,
            line: c.line + startLine,
          }));

          this.store.addFindingsFromComments(adjustedComments);
          this.commentController.addComments(vscode.Uri.file(request.filePath), adjustedComments, request.languageId);

          this.store.updateSessionStatus('completed');
          vscode.window.showInformationMessage(
            `ReviewMP: Found ${result.comments.length} comment(s)`
          );
        } catch (error) {
          if (error instanceof Error) {
            this.store.setSessionError(error.message);
            vscode.window.showErrorMessage(`ReviewMP Error: ${error.message}`);
          }
        }
      }
    );
  }

  private async reviewGitChanges(type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch' | 'pullRequest'): Promise<void> {
    const labels: Record<string, string> = {
      staged: 'staged changes',
      uncommitted: 'uncommitted changes',
      lastCommit: 'last commit',
      branch: 'branch changes',
      pullRequest: 'pull request changes',
    };

    const session = this.store.createSession(type);
    this.store.updateSessionStatus('settingUp');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Analyzing ${labels[type]}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          this.store.updateSessionStatus('analyzing');
          const diffResult = await this.diffCollector.getDiff(type, token);

          if (token.isCancellationRequested) {
            this.store.clearActiveSession();
            return;
          }

          if (type === 'pullRequest') {
            await this.reviewPullRequest(diffResult.formattedDiff, token);
          } else {
            const request: ReviewRequest = {
              code: '',
              languageId: '',
              filePath: '',
              reviewType: type,
              diff: diffResult.formattedDiff,
            };

            const result = await this.getProvider().review(request, token);

            if (token.isCancellationRequested) {
              this.store.clearActiveSession();
              return;
            }

            if (result.comments.length === 0) {
              this.store.updateSessionStatus('completed');
              vscode.window.showInformationMessage('No issues found in the changes');
              return;
            }

            this.store.updateSessionStatus('reviewing');
            await this.addDiffComments(result.comments);

            this.store.updateSessionStatus('completed');
            vscode.window.showInformationMessage(
              `ReviewMP: Found ${result.comments.length} comment(s) in ${labels[type]}`
            );
          }
        } catch (error) {
          if (error instanceof Error) {
            this.store.setSessionError(error.message);
            vscode.window.showErrorMessage(`ReviewMP Error: ${error.message}`);
          }
        }
      }
    );
  }

  private async reviewPullRequest(formattedDiff: string, token?: vscode.CancellationToken): Promise<void> {
    const clusteringResult = clusterDiff({ diff: formattedDiff, formattedDiff });

    if (clusteringResult.totalFiles === 0) {
      this.store.updateSessionStatus('completed');
      vscode.window.showInformationMessage('No changes found in the pull request');
      return;
    }

    this.store.updateSessionStatus('reviewing');

    const allComments: ReviewComment[] = [];
    const clusterResults: { clusterId: number; comments: ReviewComment[]; files: string[] }[] = [];

    if (clusteringResult.usedFastPath) {
      const request: ReviewRequest = {
        code: '',
        languageId: '',
        filePath: '',
        reviewType: 'pullRequest',
        diff: formattedDiff,
      };

      const result = await this.getProvider().review(request, token);

      if (token?.isCancellationRequested) {
        this.store.clearActiveSession();
        return;
      }

      allComments.push(...result.comments);
      if (clusteringResult.clusters.length > 0) {
        clusterResults.push({
          clusterId: 0,
          comments: result.comments,
          files: clusteringResult.clusters[0].files,
        });
      }
    } else {
      const maxParallelClusters = 4;
      for (let i = 0; i < clusteringResult.clusters.length; i += maxParallelClusters) {
        if (token?.isCancellationRequested) {
          this.store.clearActiveSession();
          return;
        }

        const clusterBatch = clusteringResult.clusters.slice(i, i + maxParallelClusters);
        const batchPromises = clusterBatch.map(async (cluster) => {
          const fileDiffs = parseDiffIntoFiles(formattedDiff);
          let clusterDiffContent = '';
          for (const filePath of cluster.files) {
            const fileDiff = fileDiffs.find(f => f.filePath === filePath);
            if (fileDiff) {
              clusterDiffContent += fileDiff.rawDiff + '\n';
            }
          }

          const request: ReviewRequest = {
            code: '',
            languageId: '',
            filePath: cluster.files.join(', '),
            reviewType: 'pullRequest',
            diff: clusterDiffContent,
          };

          return this.getProvider().review(request, token);
        });

        const batchResults = await Promise.all(batchPromises);

        for (let j = 0; j < clusterBatch.length; j++) {
          const cluster = clusterBatch[j];
          const result = batchResults[j];
          allComments.push(...result.comments);
          clusterResults.push({
            clusterId: cluster.id,
            comments: result.comments,
            files: cluster.files,
          });
        }
      }
    }

    if (token?.isCancellationRequested) {
      this.store.clearActiveSession();
      return;
    }

    const crossFilePrompt = buildCrossFilePrompt({
      diffOutput: formattedDiff,
      existingComments: allComments,
    });

    const crossFileRequest: ReviewRequest = {
      code: '',
      languageId: '',
      filePath: '',
      reviewType: 'pullRequest',
      diff: undefined,
      crossFileContext: crossFilePrompt,
    };

    let crossFileResult: CrossFileConsistencyResult = { comments: [], issuesFound: 0 };

    try {
      const crossFileReviewResult = await this.getProvider().review(crossFileRequest, token);

      if (token?.isCancellationRequested) {
        this.store.clearActiveSession();
        return;
      }

      crossFileResult = checkCrossFileConsistency(
        { diffOutput: formattedDiff, existingComments: allComments },
        crossFileReviewResult.comments
      );
    } catch {
      // Cross-file review failed, continue with cluster comments only
    }

    const finalComments = [...allComments, ...crossFileResult.comments];

    if (finalComments.length === 0) {
      this.store.updateSessionStatus('completed');
      vscode.window.showInformationMessage('No issues found in the pull request');
      return;
    }

    await this.addDiffComments(finalComments);

    this.store.updateSessionStatus('completed');
    vscode.window.showInformationMessage(
      `ReviewMP: Found ${finalComments.length} comment(s) in pull request`
    );
  }

  private async addDiffComments(comments: ReviewComment[]): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const commentsByFile = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const existing = commentsByFile.get(comment.file) || [];
      existing.push(comment);
      commentsByFile.set(comment.file, existing);
    }

    for (const [filePath, fileComments] of commentsByFile) {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

      const ext = filePath.split('.').pop() || '';
      const languageMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescriptreact',
        js: 'javascript',
        jsx: 'javascriptreact',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        rb: 'ruby',
        php: 'php',
        cs: 'csharp',
        cpp: 'cpp',
        c: 'c',
        swift: 'swift',
        kt: 'kotlin',
      };
      const languageId = languageMap[ext] || ext;

      this.store.addFindingsFromComments(fileComments);
      this.commentController.addComments(uri, fileComments, languageId);
    }
  }

  dispose(): void {
    // Nothing to dispose here; individual services handle their own disposal
  }
}
