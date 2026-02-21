import * as vscode from 'vscode';
import { ReviewCommentController, ReviewComment } from './comments';
import { OpenCodeService } from './opencode';
import { PRReviewService, PRReviewResult } from './prReview';
import { GitWatcher } from './gitWatcher';

let commentController: ReviewCommentController;
let opencodeService: OpenCodeService;
let prReviewService: PRReviewService;
let gitWatcher: GitWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');

  opencodeService = new OpenCodeService();
  prReviewService = new PRReviewService();
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

  const reviewPRCommand = vscode.commands.registerCommand(
    'reviewmp.reviewPR',
    async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter PR number (leave empty to auto-detect from current branch)',
        placeHolder: 'e.g. 123',
      });

      const prNumber = input && input.trim() !== '' ? parseInt(input.trim(), 10) : undefined;
      if (input && input.trim() !== '' && isNaN(prNumber!)) {
        vscode.window.showErrorMessage('Invalid PR number');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `ReviewMP: Reviewing PR${prNumber ? ` #${prNumber}` : ' (auto-detect)'}...`,
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const result = await prReviewService.reviewPR(prNumber, token);

            if (token.isCancellationRequested) {
              return;
            }

            if (result.comments.length === 0) {
              vscode.window.showInformationMessage('PR review: no issues found');
              return;
            }

            if (result.reviewRef && result.baseRef) {
              // Remote branch — open diff views and place comments on the PR's code
              await addPRComments(result.comments, result.reviewRef, result.baseRef);
            } else {
              // Local branch — place comments on local workspace files
              await addDiffComments(result.comments);
            }

            vscode.window.showInformationMessage(
              `ReviewMP: Found ${result.comments.length} comment(s) across PR`
            );
          } catch (error) {
            if (error instanceof Error) {
              vscode.window.showErrorMessage(`ReviewMP PR Error: ${error.message}`);
            }
          }
        }
      );
    }
  );

  context.subscriptions.push(
    reviewFileCommand,
    reviewSelectionCommand,
    reviewStagedCommand,
    reviewUncommittedCommand,
    reviewLastCommitCommand,
    reviewBranchCommand,
    reviewPRCommand,
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

    commentController.addComments(uri, fileComments, languageId);
  }
}

/**
 * Place comments on PR files by opening diff views (base vs head) via the git extension API.
 * Comments attach to the right side (head/new code) of each diff view.
 * Falls back to opening files at a git ref, then to local files.
 */
async function addPRComments(comments: ReviewComment[], headRef: string, baseRef: string) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  // Get the git extension API for proper URI construction
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>('vscode.git');
  const gitApi = gitExtension?.isActive
    ? gitExtension.exports.getAPI(1)
    : undefined;

  const commentsByFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const existing = commentsByFile.get(comment.file) || [];
    existing.push(comment);
    commentsByFile.set(comment.file, existing);
  }

  const ext2lang: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    rb: 'ruby', php: 'php', cs: 'csharp', cpp: 'cpp',
    c: 'c', swift: 'swift', kt: 'kotlin',
  };

  for (const [filePath, fileComments] of commentsByFile) {
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    const ext = filePath.split('.').pop() || '';
    const languageId = ext2lang[ext] || ext;

    let commentUri: vscode.Uri = fileUri; // fallback

    if (gitApi) {
      try {
        // Use git extension to create proper git: URIs
        const baseUri = gitApi.toGitUri(fileUri, baseRef);
        const headUri = gitApi.toGitUri(fileUri, headRef);

        // Open as diff view: merge-base vs PR head
        // Shows the PR's actual changes in a side-by-side diff editor
        // Comments attach to the right (head) side
        await vscode.commands.executeCommand(
          'vscode.diff',
          baseUri,
          headUri,
          `${filePath} (PR Review)`,
          { preview: false, preserveFocus: true }
        );

        commentUri = headUri;
      } catch {
        // Git extension failed — open the file normally
        console.log(`[ReviewMP-PR] Could not open diff for ${filePath}, falling back to local`);
        try {
          await vscode.window.showTextDocument(fileUri, { preview: false, preserveFocus: true });
        } catch {
          console.log(`[ReviewMP-PR] Could not open ${filePath} locally either, skipping`);
          continue;
        }
      }
    } else {
      // No git extension — just open local files
      console.log('[ReviewMP-PR] Git extension not available, using local files');
      try {
        await vscode.window.showTextDocument(fileUri, { preview: false, preserveFocus: true });
      } catch {
        continue;
      }
    }

    commentController.addComments(commentUri, fileComments, languageId);
  }
}

// Minimal type for VS Code's git extension API (only what we use)
interface GitAPI {
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export function deactivate() {
  if (commentController) {
    commentController.dispose();
  }
  if (gitWatcher) {
    gitWatcher.dispose();
  }
}
