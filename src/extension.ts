import * as vscode from 'vscode';
import { ReviewCommentController } from './comments';
import { OpenCodeProvider } from './providers/opencode';
import { GitWatcher } from './gitWatcher';
import { ReviewOrchestrator } from './reviewOrchestrator';
import { ProviderConfig } from './providers/modelProvider';

let commentController: ReviewCommentController;
let provider: OpenCodeProvider;
let orchestrator: ReviewOrchestrator;
let gitWatcher: GitWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');

  const config = vscode.workspace.getConfiguration('reviewmp');
  const providerConfig: ProviderConfig = {
    opencodePath: config.get<string>('opencodePath'),
    model: config.get<string>('model'),
  };

  provider = new OpenCodeProvider(providerConfig);
  commentController = new ReviewCommentController(context, provider);
  orchestrator = new ReviewOrchestrator(provider, commentController);

  if (gitWatcher) {
    gitWatcher.dispose();
  }

  const autoReviewOnStage = config.get<boolean>('autoReviewOnStage', false);
  const autoReviewOnCommit = config.get<boolean>('autoReviewOnCommit', false);

  if (autoReviewOnStage || autoReviewOnCommit) {
    gitWatcher = new GitWatcher(
      async () => {
        await orchestrator.reviewStaged();
      },
      async () => {
        await orchestrator.reviewStaged();
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
      await orchestrator.reviewFile(document);
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

      await orchestrator.reviewSelection(document.uri, selectedText, startLine, document.languageId);
    }
  );

  const reviewStagedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewStaged',
    async () => {
      await orchestrator.reviewStaged();
    }
  );

  const reviewUncommittedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewUncommitted',
    async () => {
      await orchestrator.reviewUncommitted();
    }
  );

  const reviewLastCommitCommand = vscode.commands.registerCommand(
    'reviewmp.reviewLastCommit',
    async () => {
      await orchestrator.reviewLastCommit();
    }
  );

  const reviewBranchCommand = vscode.commands.registerCommand(
    'reviewmp.reviewBranch',
    async () => {
      await orchestrator.reviewBranch();
    }
  );

  const clearCommentsCommand = vscode.commands.registerCommand(
    'reviewmp.clearComments',
    () => {
      orchestrator.clearComments();
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

export function deactivate() {
  if (commentController) {
    commentController.dispose();
  }
  if (gitWatcher) {
    gitWatcher.dispose();
  }
}
