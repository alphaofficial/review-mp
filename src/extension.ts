import * as vscode from 'vscode';
import { ReviewCommentController } from './comments';
import { GitWatcher } from './gitWatcher';
import { ReviewOrchestrator } from './reviewOrchestrator';
import { ModelProvider } from './providers/modelProvider';
import { ReviewResult } from './types/review';
import { CliRuntimeAdapter } from './providers/runtimeAdapter';
import { globalRuntimeRegistry } from './providers/builtInRuntimes';
import { RuntimeSettings } from './providers/runtimeRegistry';
import { ReviewRequest } from './types/review';
import { getSettings, registerSettingsCommands } from './settings';

class RuntimeProviderAdapter implements ModelProvider {
  readonly name: string;
  private adapter: CliRuntimeAdapter;

  constructor(manifestId: string, settings: RuntimeSettings, workspaceRoot?: string) {
    const manifest = globalRuntimeRegistry.get(manifestId as any);
    if (!manifest) {
      throw new Error(`Runtime manifest not found: ${manifestId}`);
    }
    this.name = manifest.name;
    this.adapter = new CliRuntimeAdapter(manifest, settings, workspaceRoot);
  }

  async review(request: ReviewRequest, token?: vscode.CancellationToken): Promise<ReviewResult> {
    const result = await this.adapter.invoke(request, token);
    return {
      comments: result.comments,
      provider: this.name,
      usage: result.usage,
    };
  }

  cancel(): void {
    this.adapter.cancel();
  }

  async isAvailable(): Promise<boolean> {
    return this.adapter.isAvailable();
  }
}

let commentController: ReviewCommentController;
let provider: ModelProvider;
let orchestrator: ReviewOrchestrator;
let gitWatcher: GitWatcher | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');

  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const runtimeSettings: RuntimeSettings = {
    runtime: settings.runtime,
    model: settings.model,
    debug: settings.debug,
    autoReviewOnStage: settings.autoReviewOnStage,
    autoReviewOnCommit: settings.autoReviewOnCommit,
    executableOverride: settings.executableOverride || undefined,
    extraArgs: settings.extraArgs ? settings.extraArgs.split(' ').filter(Boolean) : undefined,
  };

  provider = new RuntimeProviderAdapter(settings.runtime, runtimeSettings, workspaceRoot);
  commentController = new ReviewCommentController(context, provider);
  orchestrator = new ReviewOrchestrator(provider, commentController);

  if (gitWatcher) {
    gitWatcher.dispose();
  }

  if (settings.autoReviewOnStage || settings.autoReviewOnCommit) {
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

  registerSettingsCommands(context);

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

  const reviewPRCommand = vscode.commands.registerCommand(
    'reviewmp.reviewPR',
    async () => {
      await orchestrator.reviewPR();
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
    reviewPRCommand,
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
