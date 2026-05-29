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
import { getSettings, logDebug, registerSettingsCommands, showDebugLogs } from './settings';
import { ReviewTreeProvider, ReviewTreeViewId } from './reviewTreeProvider';
import { getReviewSessionStore } from './store/reviewSessionStore';
import { FixApplicator, createFixApplicator } from './harness/fixApplicator';
import { ReviewDecorationController } from './reviewDecorationController';

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
let orchestrator: ReviewOrchestrator;
let gitWatcher: GitWatcher | undefined;
let treeProviders: ReviewTreeProvider[] = [];
let decorationController: ReviewDecorationController;
let store = getReviewSessionStore();

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');
  logDebug('ReviewMP extension activated');

  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const runtimeSettings: RuntimeSettings = {
    runtime: settings.runtime,
    model: settings.model,
    debug: true,
    autoReviewOnStage: settings.autoReviewOnStage,
    autoReviewOnCommit: settings.autoReviewOnCommit,
    executableOverride: settings.executableOverride || undefined,
    extraArgs: settings.extraArgs ? settings.extraArgs.split(' ').filter(Boolean) : undefined,
  };

  commentController = new ReviewCommentController(context, undefined, undefined, store);
  orchestrator = new ReviewOrchestrator(
    () => {
      const currentSettings = getSettings();
      const currentRuntimeSettings: RuntimeSettings = {
        runtime: currentSettings.runtime,
        model: currentSettings.model,
        debug: true,
        autoReviewOnStage: currentSettings.autoReviewOnStage,
        autoReviewOnCommit: currentSettings.autoReviewOnCommit,
        executableOverride: currentSettings.executableOverride || undefined,
        extraArgs: currentSettings.extraArgs ? currentSettings.extraArgs.split(' ').filter(Boolean) : undefined,
      };
      return new RuntimeProviderAdapter(currentSettings.runtime, currentRuntimeSettings, workspaceRoot);
    },
    commentController,
    store
  );

  const viewIds: ReviewTreeViewId[] = [
    'reviewmp.newReview',
    'reviewmp.filesToReview',
    'reviewmp.reviews',
    'reviewmp.previousReviews'
  ];

  for (const viewId of viewIds) {
    const treeProvider = new ReviewTreeProvider(viewId, store);
    treeProviders.push(treeProvider);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(viewId, treeProvider),
      treeProvider
    );
  }

  decorationController = new ReviewDecorationController(context, store);

  if (gitWatcher) {
    gitWatcher.dispose();
  }

  if (settings.autoReviewOnStage || settings.autoReviewOnCommit) {
    gitWatcher = new GitWatcher(
      async () => {
        await orchestrator.reviewStaged();
      },
      async () => {
        await orchestrator.reviewLastCommit();
        return true;
      }
    );
    context.subscriptions.push(gitWatcher);
  }

  registerSettingsCommands(context);
  showDebugLogs(true);

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

  const reviewAllChangesCommand = vscode.commands.registerCommand(
    'reviewmp.reviewAllChanges',
    async () => {
      await orchestrator.reviewBranch();
    }
  );

  const openFindingCommand = vscode.commands.registerCommand(
    'reviewmp.openFinding',
    async (arg: string | { finding?: { id: string; line: number; message: string }; file?: { path: string } }, ...args: any[]) => {
      const session = store.getActiveSession();
      if (!session) {
        vscode.window.showWarningMessage('No active review');
        return;
      }

      let finding = null;
      let targetFilePath: string | undefined;

      if (typeof arg === 'string') {
        for (const file of session.files.values()) {
          const found = file.findings.find(f => f.id === arg);
          if (found) {
            finding = found;
            targetFilePath = file.path;
            break;
          }
        }
      } else if (arg && typeof arg === 'object' && arg.finding) {
        finding = arg.finding;
        targetFilePath = arg.file?.path;
      }

      if (!finding || !targetFilePath) {
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const uri = resolveReviewFileUri(targetFilePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preserveFocus: false });
      commentController.revealFinding(finding.id);
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const line = Math.max(0, finding.line - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    }
  );

  const fixApplicator: FixApplicator = createFixApplicator();

  const applyFindingFixCommand = vscode.commands.registerCommand(
    'reviewmp.applyFindingFix',
    async (arg: string | { finding?: { id: string; fix?: string; line: number; message: string }; file?: { path: string } }, ...args: any[]) => {
      const session = store.getActiveSession();
      if (!session) {
        vscode.window.showWarningMessage('No active review');
        return;
      }

      let findingId: string;
      let finding = null;
      let filePath: string | undefined;

      if (typeof arg === 'string') {
        findingId = arg;
      } else if (arg && typeof arg === 'object' && arg.finding) {
        findingId = arg.finding.id;
      } else {
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      for (const file of session.files.values()) {
        const found = file.findings.find(f => f.id === findingId);
        if (found) {
          finding = found;
          filePath = file.path;
          break;
        }
      }

      if (!finding || !finding.fix) {
        vscode.window.showWarningMessage('Finding or fix not available');
        return;
      }

      if (!filePath) {
        vscode.window.showWarningMessage('File path not found');
        return;
      }

      try {
        const result = await fixApplicator.applyFix(resolveReviewFileUri(filePath).fsPath, finding.line, finding.fix);
        if (result.success) {
          store.updateFindingStatus(findingId, 'apply');
          vscode.window.showInformationMessage('Fix applied successfully');
        } else {
          vscode.window.showErrorMessage(`Failed to apply fix: ${result.error}`);
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const dismissFindingCommand = vscode.commands.registerCommand(
    'reviewmp.dismissFinding',
    async (arg: string | { finding?: { id: string } }, ...args: any[]) => {
      const session = store.getActiveSession();
      if (!session) {
        vscode.window.showWarningMessage('No active review');
        return;
      }

      let findingId: string;

      if (typeof arg === 'string') {
        findingId = arg;
      } else if (arg && typeof arg === 'object' && arg.finding) {
        findingId = arg.finding.id;
      } else {
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const finding = store.getFinding(findingId);
      if (!finding) {
        vscode.window.showWarningMessage('Finding not found in active review');
        return;
      }

      store.updateFindingStatus(findingId, 'dismiss');
    }
  );

  const clearActiveReviewCommand = vscode.commands.registerCommand(
    'reviewmp.clearActiveReview',
    async () => {
      orchestrator.clearActiveReview();
    }
  );

  const openReviewPanelCommand = vscode.commands.registerCommand(
    'reviewmp.openReviewPanel',
    async (sessionId?: string) => {
      if (sessionId) {
        const restoredSession = store.restoreSessionFromHistory(sessionId);
        if (!restoredSession) {
          vscode.window.showWarningMessage('Previous review not found');
          return;
        }

        commentController.clearAllComments();
        for (const file of restoredSession.files.values()) {
          if (file.findings.length > 0) {
            commentController.addComments(vscode.Uri.file(file.path), file.findings);
          }
        }
      }

      await vscode.commands.executeCommand('reviewmp.reviews.focus');
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
    reviewAllChangesCommand,
    openFindingCommand,
    applyFindingFixCommand,
    dismissFindingCommand,
    clearActiveReviewCommand,
    openReviewPanelCommand,
    commentController,
    orchestrator,
    decorationController,
    store
  );
}

function resolveReviewFileUri(filePath: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return vscode.Uri.file(filePath);
  }

  if (filePath.startsWith(workspaceFolder.uri.fsPath)) {
    return vscode.Uri.file(filePath);
  }

  return vscode.Uri.joinPath(workspaceFolder.uri, filePath.replace(/^\/+/, ''));
}

export function deactivate() {
  if (commentController) {
    commentController.dispose();
  }
  if (orchestrator) {
    orchestrator.dispose();
  }
  if (gitWatcher) {
    gitWatcher.dispose();
  }
  for (const provider of treeProviders) {
    provider.dispose();
  }
  treeProviders = [];
  if (decorationController) {
    decorationController.dispose();
  }
  if (store) {
    store.dispose();
  }
}
