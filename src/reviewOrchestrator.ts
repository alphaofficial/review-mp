import * as vscode from 'vscode';
import { OpenCodeService } from './opencode';
import { ReviewCommentController, ReviewComment } from './comments';

export class ReviewOrchestrator implements vscode.Disposable {
  private opencodeService: OpenCodeService;
  private commentController: ReviewCommentController;

  constructor(opencodeService: OpenCodeService, commentController: ReviewCommentController) {
    this.opencodeService = opencodeService;
    this.commentController = commentController;
  }

  async reviewFile(document: vscode.TextDocument): Promise<void> {
    const content = document.getText();
    await this.reviewCode(document.uri, content, 0, document.languageId);
  }

  async reviewSelection(
    uri: vscode.Uri,
    selectedText: string,
    startLine: number,
    languageId: string
  ): Promise<void> {
    await this.reviewCode(uri, selectedText, startLine, languageId);
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

  private async reviewCode(
    uri: vscode.Uri,
    code: string,
    startLine: number,
    languageId: string
  ): Promise<void> {
    const typeLabel = 'code';
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Analyzing ${typeLabel}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const comments = await this.opencodeService.reviewCode(code, languageId, uri.fsPath, token);

          if (token.isCancellationRequested) {
            return;
          }

          if (comments.length === 0) {
            vscode.window.showInformationMessage('No issues found in the code');
            return;
          }

          const adjustedComments = comments.map((c) => ({
            ...c,
            line: c.line + startLine,
          }));

          this.commentController.addComments(uri, adjustedComments, languageId);
          vscode.window.showInformationMessage(
            `ReviewMP: Found ${comments.length} comment(s)`
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
          const comments = await this.opencodeService.reviewDiff(type, token);

          if (token.isCancellationRequested) {
            return;
          }

          if (comments.length === 0) {
            vscode.window.showInformationMessage('No issues found in the changes');
            return;
          }

          await this.addDiffComments(comments);

          vscode.window.showInformationMessage(
            `ReviewMP: Found ${comments.length} comment(s) in ${labels[type]}`
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
