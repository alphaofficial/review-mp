import * as vscode from 'vscode';
import { ReviewCommentController } from './comments';
import { GitWatcher } from './gitWatcher';
import { ReviewOrchestrator } from './reviewOrchestrator';
import { ModelProvider } from './providers/modelProvider';
import { ReviewResult } from './types/review';
import { CliRuntimeAdapter } from './providers/runtimeAdapter';
import { globalRuntimeRegistry } from './providers/builtInRuntimes';
import { RuntimeId, RuntimeSettings } from './providers/runtimeRegistry';
import { ReviewRequest } from './types/review';
import { getSettings, logDebug, registerSettingsCommands, showDebugLogs } from './settings';
import { ReviewTreeProvider, ReviewTreeViewId } from './reviewTreeProvider';
import { getReviewSessionStore } from './store/reviewSessionStore';
import { FixApplicator, createFixApplicator } from './harness/fixApplicator';
import { ReviewDecorationController } from './reviewDecorationController';
import { ReviewKnowledgeRecorder } from './harness/reviewKnowledgeRecorder';
import { CodeIndexManager } from './services/code-index/manager';
import { CodeIndexController } from './services/code-index/controller';
import { CodeIndexTreeProvider } from './codeIndexTreeProvider';
import { RepoKnowledgeIndex } from './harness/repoKnowledgeIndex';

class RuntimeProviderAdapter implements ModelProvider {
  readonly name: string;
  private adapter: CliRuntimeAdapter;

  constructor(manifestId: RuntimeId, settings: RuntimeSettings, workspaceRoot?: string) {
    const manifest = globalRuntimeRegistry.get(manifestId);
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
let knowledgeRecorder: ReviewKnowledgeRecorder | undefined;
let codeIndexManager: CodeIndexManager | undefined;
let codeIndexController: CodeIndexController | undefined;
let codeIndexTreeProvider: CodeIndexTreeProvider | undefined;
const store = getReviewSessionStore();

export function activate(context: vscode.ExtensionContext) {
  console.log('ReviewMP is now active');
  logDebug('ReviewMP extension activated', {
    extensionPath: context.extensionPath,
    subscriptionCount: context.subscriptions.length,
  });

  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  RepoKnowledgeIndex.setDefaultStorageRoot(context.globalStorageUri?.fsPath);
  logDebug('ReviewMP activation settings loaded', {
    workspaceRoot,
    runtime: settings.runtime,
    model: settings.model,
    autoReviewOnStage: settings.autoReviewOnStage,
    autoReviewOnCommit: settings.autoReviewOnCommit,
    codeIndexEnabled: settings.codeIndexEnabled,
    hasExecutableOverride: Boolean(settings.executableOverride),
    extraArgCount: settings.extraArgs ? settings.extraArgs.split(' ').filter(Boolean).length : 0,
  });

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
      logDebug('Creating runtime provider adapter', {
        runtime: currentSettings.runtime,
        model: currentSettings.model,
        workspaceRoot,
        hasExecutableOverride: Boolean(currentSettings.executableOverride),
      });
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
    logDebug('Registered review tree provider', { viewId });
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider(viewId, treeProvider),
      treeProvider
    );
  }

  decorationController = new ReviewDecorationController(context, store);
  knowledgeRecorder?.dispose();
  knowledgeRecorder = new ReviewKnowledgeRecorder(store, workspaceRoot);
  context.subscriptions.push({ dispose: () => knowledgeRecorder?.dispose() });
  codeIndexManager ??= CodeIndexManager.getInstance();
  codeIndexController?.dispose();
  codeIndexController = new CodeIndexController(codeIndexManager, workspaceRoot);
  codeIndexTreeProvider?.dispose();
  codeIndexTreeProvider = new CodeIndexTreeProvider(codeIndexController);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('reviewmp.indexing', codeIndexTreeProvider),
    codeIndexTreeProvider,
    codeIndexController,
    { dispose: () => codeIndexManager?.dispose() }
  );
  void codeIndexController.initialize();

  if (gitWatcher) {
    gitWatcher.dispose();
  }

  if (settings.autoReviewOnStage || settings.autoReviewOnCommit) {
    logDebug('Creating git watcher from extension activation', {
      autoReviewOnStage: settings.autoReviewOnStage,
      autoReviewOnCommit: settings.autoReviewOnCommit,
    });
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
  } else {
    logDebug('Git watcher creation skipped from extension activation', {
      autoReviewOnStage: settings.autoReviewOnStage,
      autoReviewOnCommit: settings.autoReviewOnCommit,
    });
  }

  registerSettingsCommands(context);
  showDebugLogs(true);

  const reviewFileCommand = vscode.commands.registerCommand(
    'reviewmp.reviewFile',
    async () => {
      logDebug('Command invoked: reviewmp.reviewFile');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logDebug('Command reviewmp.reviewFile skipped: no active file');
        vscode.window.showWarningMessage('No active file to review');
        return;
      }

      const document = editor.document;
      logDebug('Command reviewmp.reviewFile dispatching', {
        filePath: document.uri.fsPath,
        languageId: document.languageId,
      });
      await orchestrator.reviewFile(document);
    }
  );

  const reviewSelectionCommand = vscode.commands.registerCommand(
    'reviewmp.reviewSelection',
    async () => {
      logDebug('Command invoked: reviewmp.reviewSelection');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logDebug('Command reviewmp.reviewSelection skipped: no active editor');
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        logDebug('Command reviewmp.reviewSelection skipped: empty selection');
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const document = editor.document;
      const selectedText = document.getText(selection);
      const startLine = selection.start.line;
      logDebug('Command reviewmp.reviewSelection dispatching', {
        filePath: document.uri.fsPath,
        languageId: document.languageId,
        startLine,
        selectedChars: selectedText.length,
      });

      await orchestrator.reviewSelection(document.uri, selectedText, startLine, document.languageId, document.getText());
    }
  );

  const reviewStagedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewStaged',
    async () => {
      logDebug('Command invoked: reviewmp.reviewStaged');
      await orchestrator.reviewStaged();
    }
  );

  const reviewUncommittedCommand = vscode.commands.registerCommand(
    'reviewmp.reviewUncommitted',
    async () => {
      logDebug('Command invoked: reviewmp.reviewUncommitted');
      await orchestrator.reviewUncommitted();
    }
  );

  const reviewLastCommitCommand = vscode.commands.registerCommand(
    'reviewmp.reviewLastCommit',
    async () => {
      logDebug('Command invoked: reviewmp.reviewLastCommit');
      await orchestrator.reviewLastCommit();
    }
  );

  const reviewBranchCommand = vscode.commands.registerCommand(
    'reviewmp.reviewBranch',
    async () => {
      logDebug('Command invoked: reviewmp.reviewBranch');
      await orchestrator.reviewBranch();
    }
  );

  const clearCommentsCommand = vscode.commands.registerCommand(
    'reviewmp.clearComments',
    () => {
      logDebug('Command invoked: reviewmp.clearComments');
      orchestrator.clearComments();
      vscode.window.showInformationMessage('All review comments cleared');
    }
  );

  const reviewAllChangesCommand = vscode.commands.registerCommand(
    'reviewmp.reviewAllChanges',
    async () => {
      logDebug('Command invoked: reviewmp.reviewAllChanges');
      await orchestrator.reviewBranch();
    }
  );

  const openFindingCommand = vscode.commands.registerCommand(
    'reviewmp.openFinding',
    async (
      arg: string | { finding?: { id: string; line: number; message: string }; file?: { path: string } },
      ...args: unknown[]
    ) => {
      logDebug('Command invoked: reviewmp.openFinding', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command reviewmp.openFinding skipped: no active review');
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
        logDebug('Command reviewmp.openFinding failed: finding not found', {
          argType: typeof arg,
        });
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const uri = resolveReviewFileUri(targetFilePath);
      logDebug('Command reviewmp.openFinding opening document', {
        findingId: finding.id,
        targetFilePath,
        resolvedPath: uri.fsPath,
        line: finding.line,
      });
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
    async (
      arg: string | { finding?: { id: string; fix?: string; line: number; message: string }; file?: { path: string } },
      ...args: unknown[]
    ) => {
      logDebug('Command invoked: reviewmp.applyFindingFix', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command reviewmp.applyFindingFix skipped: no active review');
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
        logDebug('Command reviewmp.applyFindingFix failed: invalid argument');
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
        logDebug('Command reviewmp.applyFindingFix failed: finding or fix unavailable', {
          findingId,
          hasFinding: Boolean(finding),
          hasFix: Boolean(finding?.fix),
        });
        vscode.window.showWarningMessage('Finding or fix not available');
        return;
      }

      if (!filePath) {
        logDebug('Command reviewmp.applyFindingFix failed: file path not found', {
          findingId,
        });
        vscode.window.showWarningMessage('File path not found');
        return;
      }

      try {
        logDebug('Command reviewmp.applyFindingFix applying fix', {
          findingId,
          filePath,
          line: finding.line,
          fixChars: finding.fix.length,
        });
        const result = await fixApplicator.applyFix(resolveReviewFileUri(filePath).fsPath, finding.line, finding.fix);
        if (result.success) {
          store.updateFindingStatus(findingId, 'apply');
          vscode.window.showInformationMessage('Fix applied successfully');
          logDebug('Command reviewmp.applyFindingFix succeeded', {
            findingId,
            filePath,
          });
        } else {
          logDebug('Command reviewmp.applyFindingFix failed from applicator result', {
            findingId,
            filePath,
            error: result.error,
          });
          vscode.window.showErrorMessage(`Failed to apply fix: ${result.error}`);
        }
      } catch (error) {
        logDebug('Command reviewmp.applyFindingFix threw', {
          findingId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        vscode.window.showErrorMessage(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const dismissFindingCommand = vscode.commands.registerCommand(
    'reviewmp.dismissFinding',
    async (arg: string | { finding?: { id: string } }, ...args: unknown[]) => {
      logDebug('Command invoked: reviewmp.dismissFinding', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command reviewmp.dismissFinding skipped: no active review');
        vscode.window.showWarningMessage('No active review');
        return;
      }

      let findingId: string;

      if (typeof arg === 'string') {
        findingId = arg;
      } else if (arg && typeof arg === 'object' && arg.finding) {
        findingId = arg.finding.id;
      } else {
        logDebug('Command reviewmp.dismissFinding failed: invalid argument');
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const finding = store.getFinding(findingId);
      if (!finding) {
        logDebug('Command reviewmp.dismissFinding failed: finding not found in active review', {
          findingId,
        });
        vscode.window.showWarningMessage('Finding not found in active review');
        return;
      }

      store.updateFindingStatus(findingId, 'dismiss');
      logDebug('Command reviewmp.dismissFinding succeeded', {
        findingId,
      });
    }
  );

  const clearActiveReviewCommand = vscode.commands.registerCommand(
    'reviewmp.clearActiveReview',
    async () => {
      logDebug('Command invoked: reviewmp.clearActiveReview');
      orchestrator.clearActiveReview();
    }
  );

  const openReviewPanelCommand = vscode.commands.registerCommand(
    'reviewmp.openReviewPanel',
    async (sessionId?: string) => {
      logDebug('Command invoked: reviewmp.openReviewPanel', {
        sessionId,
      });
      if (sessionId) {
        const restoredSession = store.restoreSessionFromHistory(sessionId);
        if (!restoredSession) {
          logDebug('Command reviewmp.openReviewPanel failed: previous review not found', {
            sessionId,
          });
          vscode.window.showWarningMessage('Previous review not found');
          return;
        }

        commentController.clearAllComments();
        logDebug('Command reviewmp.openReviewPanel restoring comments', {
          sessionId,
          fileCount: restoredSession.files.size,
          findingCount: restoredSession.findings.length,
        });
        for (const file of restoredSession.files.values()) {
          if (file.findings.length > 0) {
            commentController.addComments(vscode.Uri.file(file.path), file.findings);
          }
        }
      }

      await vscode.commands.executeCommand('reviewmp.reviews.focus');
    }
  );

  const enableCodeIndexCommand = vscode.commands.registerCommand(
    'reviewmp.enableCodeIndex',
    async () => {
      logDebug('Command invoked: reviewmp.enableCodeIndex');
      await codeIndexController?.setEnabled(true);
    }
  );

  const disableCodeIndexCommand = vscode.commands.registerCommand(
    'reviewmp.disableCodeIndex',
    async () => {
      logDebug('Command invoked: reviewmp.disableCodeIndex');
      await codeIndexController?.setEnabled(false);
    }
  );

  const rebuildCodeIndexCommand = vscode.commands.registerCommand(
    'reviewmp.rebuildCodeIndex',
    async () => {
      logDebug('Command invoked: reviewmp.rebuildCodeIndex');
      await codeIndexController?.rebuild();
    }
  );

  const stopCodeIndexCommand = vscode.commands.registerCommand(
    'reviewmp.stopCodeIndex',
    async () => {
      logDebug('Command invoked: reviewmp.stopCodeIndex');
      await codeIndexController?.stop();
    }
  );

  const clearCodeIndexCommand = vscode.commands.registerCommand(
    'reviewmp.clearCodeIndex',
    async () => {
      logDebug('Command invoked: reviewmp.clearCodeIndex');
      await codeIndexController?.clear();
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
    reviewAllChangesCommand,
    openFindingCommand,
    applyFindingFixCommand,
    dismissFindingCommand,
    clearActiveReviewCommand,
    openReviewPanelCommand,
    enableCodeIndexCommand,
    disableCodeIndexCommand,
    rebuildCodeIndexCommand,
    stopCodeIndexCommand,
    clearCodeIndexCommand,
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
  logDebug('ReviewMP extension deactivating', {
    treeProviderCount: treeProviders.length,
    hasGitWatcher: Boolean(gitWatcher),
    hasCommentController: Boolean(commentController),
    hasOrchestrator: Boolean(orchestrator),
    hasDecorationController: Boolean(decorationController),
    hasCodeIndexController: Boolean(codeIndexController),
    hasStore: Boolean(store),
  });
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
  codeIndexController?.dispose();
  codeIndexTreeProvider?.dispose();
}
