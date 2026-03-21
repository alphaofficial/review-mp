import * as vscode from 'vscode';
import { ReviewCommentController, ReviewComment } from './comments';
import { OpenCodeService } from './opencode';
import { GitWatcher } from './gitWatcher';

const EXT_TO_LANGUAGE: Record<string, string> = {
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

function languageIdFromPath(filePath: string): string {
  const ext = filePath.split('.').pop() || '';
  return EXT_TO_LANGUAGE[ext] || ext;
}

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

async function addDiffComments(comments: ReviewComment[]) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  // Group comments by file
  const commentsByFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = commentsByFile.get(comment.file) || [];
    existing.push(comment);
    commentsByFile.set(comment.file, existing);
  }

  // Add comments to each file
  for (const [filePath, fileComments] of commentsByFile) {
    const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    commentController.addComments(uri, fileComments, languageIdFromPath(filePath));
  }
}

/**
 * Place PR review comments on local files where they exist.
 * Files that don't exist locally get their comments written to an Output channel.
 * Does NOT open files — only attaches comments to files the user opens themselves.
 */
async function placePRComments(
  comments: ReviewComment[]
): Promise<{ placed: number; skipped: number }> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return { placed: 0, skipped: 0 };
  }

  const commentsByFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = commentsByFile.get(comment.file) || [];
    existing.push(comment);
    commentsByFile.set(comment.file, existing);
  }

  let placed = 0;
  const skippedFileComments: Array<{ file: string; comments: ReviewComment[] }> = [];

  for (const [filePath, fileComments] of commentsByFile) {
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    commentController.addComments(fileUri, fileComments, languageIdFromPath(filePath));
    placed += fileComments.length;
  }

  // Dump skipped comments to Output channel
  if (skippedFileComments.length > 0) {
    const totalSkipped = skippedFileComments.reduce((sum, f) => sum + f.comments.length, 0);
    const channel = vscode.window.createOutputChannel('ReviewMP - PR Review');
    channel.clear();
    channel.appendLine(
      `PR Review — ${skippedFileComments.length} file(s) not available locally.\n` +
      `Checkout the PR branch for inline comments.\n`
    );

    for (const { file, comments: fileComments } of skippedFileComments) {
      channel.appendLine(`── ${file} (${fileComments.length} comments) ──`);
      for (const c of fileComments) {
        const severity = c.severity || 'review';
        channel.appendLine(`  L${c.line + 1} [${severity}]: ${c.message}`);
        if (c.fix) {
          channel.appendLine(`    Fix: ${c.fix}`);
        }
      }
      channel.appendLine('');
    }

    channel.show(true);
    return { placed, skipped: totalSkipped };
  }

  return { placed, skipped: 0 };
}

export function deactivate() {
  if (commentController) {
    commentController.dispose();
  }
  if (gitWatcher) {
    gitWatcher.dispose();
  }
}
