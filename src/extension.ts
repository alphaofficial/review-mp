import * as vscode from 'vscode';
import { ReviewCommentController } from './comments';
import { OpenCodeService, DiffReviewComment } from './opencode';
import { GitWatcher } from './gitWatcher';

let commentController: ReviewCommentController;
let opencodeService: OpenCodeService;
let gitWatcher: GitWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');

  opencodeService = new OpenCodeService();
  commentController = new ReviewCommentController(context, opencodeService);

  // Only initialize git watcher if auto-review settings are enabled
  const config = vscode.workspace.getConfiguration('reviewmp');
  const autoReviewOnStage = config.get<boolean>('autoReviewOnStage', false);
  const autoReviewOnCommit = config.get<boolean>('autoReviewOnCommit', false);

  if (autoReviewOnStage || autoReviewOnCommit) {
    gitWatcher = new GitWatcher(
      async () => {
        await reviewGitChanges('staged');
      },
      async () => {
        await reviewGitChanges('staged');
        return true;
      }
    );
    context.subscriptions.push(gitWatcher);
  }

  const reviewFileCommand = vscode.commands.registerCommand(
    'reviewmp.reviewFile',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active file to review');
        return;
      }

      const document = editor.document;
      await reviewDocument(document);
    }
  );

  const reviewSelectionCommand = vscode.commands.registerCommand(
    'reviewmp.reviewSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const document = editor.document;
      const selectedText = document.getText(selection);
      const startLine = selection.start.line;

      await reviewCode(document.uri, selectedText, startLine, document.languageId);
    }
  );

  const reviewStagedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewStaged',
    async () => {
      await reviewGitChanges('staged');
    }
  );

  const reviewUncommittedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewUncommitted',
    async () => {
      await reviewGitChanges('uncommitted');
    }
  );

  const reviewLastCommitCommand = vscode.commands.registerCommand(
    'reviewmp.reviewLastCommit',
    async () => {
      await reviewGitChanges('lastCommit');
    }
  );

  const reviewBranchCommand = vscode.commands.registerCommand(
    'reviewmp.reviewBranch',
    async () => {
      await reviewGitChanges('branch');
    }
  );

  const clearCommentsCommand = vscode.commands.registerCommand(
    'reviewmp.clearComments',
    () => {
      commentController.clearAllComments();
      vscode.window.showInformationMessage('All review comments cleared');
    }
  );

  context.subscriptions.push(
    reviewFileCommand,
    reviewSelectionCommand,
    reviewStagedCommand,
    reviewUncommittedCommand,
    reviewLastCommitCommand,
    reviewBranchCommand,
    clearCommentsCommand,
    commentController
  );
}

async function reviewDocument(document: vscode.TextDocument) {
  const content = document.getText();
  await reviewCode(document.uri, content, 0, document.languageId);
}

async function reviewCode(
  uri: vscode.Uri,
  code: string,
  startLine: number,
  languageId: string
) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ReviewMP: Analyzing code...',
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const comments = await opencodeService.reviewCode(code, languageId, uri.fsPath, token);

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

        commentController.addComments(uri, adjustedComments, languageId);
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

async function reviewGitChanges(type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch') {
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
        const comments = await opencodeService.reviewDiff(type, token);

        if (token.isCancellationRequested) {
          return;
        }

        if (comments.length === 0) {
          vscode.window.showInformationMessage('No issues found in the changes');
          return;
        }

        await addDiffComments(comments);
        
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

async function addDiffComments(comments: DiffReviewComment[]) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  // Group comments by file
  const commentsByFile = new Map<string, DiffReviewComment[]>();
  for (const comment of comments) {
    const existing = commentsByFile.get(comment.file) || [];
    existing.push(comment);
    commentsByFile.set(comment.file, existing);
  }

  // Add comments to each file
  for (const [filePath, fileComments] of commentsByFile) {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    
    // Try to determine language from file extension
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

    const reviewComments = fileComments.map(c => ({
      line: c.line,
      message: c.message,
      fix: c.fix,
      severity: c.severity,
    }));

    commentController.addComments(uri, reviewComments, languageId);
  }
}

export function deactivate() {
  if (commentController) {
    commentController.dispose();
  }
  if (gitWatcher) {
    gitWatcher.dispose();
  }
}
