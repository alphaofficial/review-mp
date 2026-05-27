import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';
import { ReviewCommentController, ReviewComment } from './comments';
import { ReviewRequest } from './types/review';
import { DiffContextCollector } from './harness/diffContextCollector';

export class ReviewOrchestrator implements vscode.Disposable {
  private provider: ModelProvider;
  private commentController: ReviewCommentController;
  private diffCollector: DiffContextCollector;

  constructor(provider: ModelProvider, commentController: ReviewCommentController) {
    this.provider = provider;
    this.commentController = commentController;
    this.diffCollector = new DiffContextCollector();
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

  clearComments(): void {
    this.commentController.clearAllComments();
  }

  private async reviewCode(request: ReviewRequest): Promise<void> {
    const typeLabel = 'code';
    const startLine = request.startLine ?? 0;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Analyzing ${typeLabel}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const result = await this.provider.review(request, token);

          if (token.isCancellationRequested) {
            return;
          }

          if (result.comments.length === 0) {
            vscode.window.showInformationMessage('No issues found in the code');
            return;
          }

          const adjustedComments = result.comments.map((c) => ({
            ...c,
            line: c.line + startLine,
          }));

          this.commentController.addComments(vscode.Uri.file(request.filePath), adjustedComments, request.languageId);
          vscode.window.showInformationMessage(
            `ReviewMP: Found ${result.comments.length} comment(s)`
          );
        } catch (error) {
          if (error instanceof Error) {
            vscode.window.showErrorMessage(`ReviewMP Error: ${error.message}`);
          }
        }
      }
    );
  }

  private async reviewGitChanges(type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch'): Promise<void> {
    const labels: Record<string, string> = {
      staged: 'staged changes',
      uncommitted: 'uncommitted changes',
      lastCommit: 'last commit',
      branch: 'branch changes',
    };

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Analyzing ${labels[type]}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const diffResult = await this.diffCollector.getDiff(type, token);

          if (token.isCancellationRequested) {
            return;
          }

          const request: ReviewRequest = {
            code: '',
            languageId: '',
            filePath: '',
            reviewType: type,
            diff: diffResult.formattedDiff,
          };

          const result = await this.provider.review(request, token);

          if (token.isCancellationRequested) {
            return;
          }

          if (result.comments.length === 0) {
            vscode.window.showInformationMessage('No issues found in the changes');
            return;
          }

          await this.addDiffComments(result.comments);

          vscode.window.showInformationMessage(
            `ReviewMP: Found ${result.comments.length} comment(s) in ${labels[type]}`
          );
        } catch (error) {
          if (error instanceof Error) {
            vscode.window.showErrorMessage(`ReviewMP Error: ${error.message}`);
          }
        }
      }
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

      this.commentController.addComments(uri, fileComments, languageId);
    }
  }

  dispose(): void {
    // Nothing to dispose here; individual services handle their own disposal
  }
}
