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

  async generateChangeBrief(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    return this.adapter.generateChangeBrief(prompt, token);
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
  logDebug('CodeBunny extension activated', {
    extensionPath: context.extensionPath,
    subscriptionCount: context.subscriptions.length,
  });

  const settings = getSettings();
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  RepoKnowledgeIndex.setDefaultStorageRoot(context.globalStorageUri?.fsPath);
  logDebug('CodeBunny activation settings loaded', {
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
    'codebunny.newReview',
    'codebunny.filesToReview',
    'codebunny.reviews',
    'codebunny.previousReviews'
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
    vscode.window.registerTreeDataProvider('codebunny.indexing', codeIndexTreeProvider),
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
  logDebug('CodeBunny debug logs initialized');
  showDebugLogs(true);

  const reviewFileCommand = vscode.commands.registerCommand(
    'codebunny.reviewFile',
    async () => {
      logDebug('Command invoked: codebunny.reviewFile');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logDebug('Command codebunny.reviewFile skipped: no active file');
        vscode.window.showWarningMessage('No active file to review');
        return;
      }

      const document = editor.document;
      logDebug('Command codebunny.reviewFile dispatching', {
        filePath: document.uri.fsPath,
        languageId: document.languageId,
      });
      await orchestrator.reviewFile(document);
    }
  );

  const reviewSelectionCommand = vscode.commands.registerCommand(
    'codebunny.reviewSelection',
    async () => {
      logDebug('Command invoked: codebunny.reviewSelection');
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        logDebug('Command codebunny.reviewSelection skipped: no active editor');
        vscode.window.showWarningMessage('No active editor');
        return;
      }

      const selection = editor.selection;
      if (selection.isEmpty) {
        logDebug('Command codebunny.reviewSelection skipped: empty selection');
        vscode.window.showWarningMessage('No text selected');
        return;
      }

      const document = editor.document;
      const selectedText = document.getText(selection);
      const startLine = selection.start.line;
      logDebug('Command codebunny.reviewSelection dispatching', {
        filePath: document.uri.fsPath,
        languageId: document.languageId,
        startLine,
        selectedChars: selectedText.length,
      });

      await orchestrator.reviewSelection(document.uri, selectedText, startLine, document.languageId, document.getText());
    }
  );

  const reviewStagedCommand = vscode.commands.registerCommand(
    'codebunny.reviewStaged',
    async () => {
      logDebug('Command invoked: codebunny.reviewStaged');
      await orchestrator.reviewStaged();
    }
  );

  const reviewUncommittedCommand = vscode.commands.registerCommand(
    'codebunny.reviewUncommitted',
    async () => {
      logDebug('Command invoked: codebunny.reviewUncommitted');
      await orchestrator.reviewUncommitted();
    }
  );

  const reviewLastCommitCommand = vscode.commands.registerCommand(
    'codebunny.reviewLastCommit',
    async () => {
      logDebug('Command invoked: codebunny.reviewLastCommit');
      await orchestrator.reviewLastCommit();
    }
  );

  const reviewBranchCommand = vscode.commands.registerCommand(
    'codebunny.reviewBranch',
    async () => {
      logDebug('Command invoked: codebunny.reviewBranch');
      await orchestrator.reviewBranch();
    }
  );

  const clearCommentsCommand = vscode.commands.registerCommand(
    'codebunny.clearComments',
    () => {
      logDebug('Command invoked: codebunny.clearComments');
      orchestrator.clearComments();
      vscode.window.showInformationMessage('All review comments cleared');
    }
  );

  const reviewAllChangesCommand = vscode.commands.registerCommand(
    'codebunny.reviewAllChanges',
    async () => {
      logDebug('Command invoked: codebunny.reviewAllChanges');
      await orchestrator.reviewBranch();
    }
  );

  const openFindingCommand = vscode.commands.registerCommand(
    'codebunny.openFinding',
    async (
      arg: string | { finding?: { id: string; line: number; message: string }; file?: { path: string } },
      ...args: unknown[]
    ) => {
      logDebug('Command invoked: codebunny.openFinding', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command codebunny.openFinding skipped: no active review');
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
        logDebug('Command codebunny.openFinding failed: finding not found', {
          argType: typeof arg,
        });
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const uri = resolveReviewFileUri(targetFilePath);
      logDebug('Command codebunny.openFinding opening document', {
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
    'codebunny.applyFindingFix',
    async (
      arg: string | { finding?: { id: string; fix?: string; line: number; message: string }; file?: { path: string } },
      ...args: unknown[]
    ) => {
      logDebug('Command invoked: codebunny.applyFindingFix', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command codebunny.applyFindingFix skipped: no active review');
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
        logDebug('Command codebunny.applyFindingFix failed: invalid argument');
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
        logDebug('Command codebunny.applyFindingFix failed: finding or fix unavailable', {
          findingId,
          hasFinding: Boolean(finding),
          hasFix: Boolean(finding?.fix),
        });
        vscode.window.showWarningMessage('Finding or fix not available');
        return;
      }

      if (!filePath) {
        logDebug('Command codebunny.applyFindingFix failed: file path not found', {
          findingId,
        });
        vscode.window.showWarningMessage('File path not found');
        return;
      }

      try {
        logDebug('Command codebunny.applyFindingFix applying fix', {
          findingId,
          filePath,
          line: finding.line,
          fixChars: finding.fix.length,
        });
        const result = await fixApplicator.applyFix(resolveReviewFileUri(filePath).fsPath, finding.line, finding.fix);
        if (result.success) {
          store.updateFindingStatus(findingId, 'apply');
          vscode.window.showInformationMessage('Fix applied successfully');
          logDebug('Command codebunny.applyFindingFix succeeded', {
            findingId,
            filePath,
          });
        } else {
          logDebug('Command codebunny.applyFindingFix failed from applicator result', {
            findingId,
            filePath,
            error: result.error,
          });
          vscode.window.showErrorMessage(`Failed to apply fix: ${result.error}`);
        }
      } catch (error) {
        logDebug('Command codebunny.applyFindingFix threw', {
          findingId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        vscode.window.showErrorMessage(`Failed to apply fix: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const dismissFindingCommand = vscode.commands.registerCommand(
    'codebunny.dismissFinding',
    async (arg: string | { finding?: { id: string } }, ...args: unknown[]) => {
      logDebug('Command invoked: codebunny.dismissFinding', {
        argType: typeof arg,
        extraArgCount: args.length,
      });
      const session = store.getActiveSession();
      if (!session) {
        logDebug('Command codebunny.dismissFinding skipped: no active review');
        vscode.window.showWarningMessage('No active review');
        return;
      }

      let findingId: string;

      if (typeof arg === 'string') {
        findingId = arg;
      } else if (arg && typeof arg === 'object' && arg.finding) {
        findingId = arg.finding.id;
      } else {
        logDebug('Command codebunny.dismissFinding failed: invalid argument');
        vscode.window.showWarningMessage('Finding not found');
        return;
      }

      const finding = store.getFinding(findingId);
      if (!finding) {
        logDebug('Command codebunny.dismissFinding failed: finding not found in active review', {
          findingId,
        });
        vscode.window.showWarningMessage('Finding not found in active review');
        return;
      }

      store.updateFindingStatus(findingId, 'dismiss');
      logDebug('Command codebunny.dismissFinding succeeded', {
        findingId,
      });
    }
  );

  const clearActiveReviewCommand = vscode.commands.registerCommand(
    'codebunny.clearActiveReview',
    async () => {
      logDebug('Command invoked: codebunny.clearActiveReview');
      orchestrator.clearActiveReview();
    }
  );

  const openReviewPanelCommand = vscode.commands.registerCommand(
    'codebunny.openReviewPanel',
    async (sessionId?: string) => {
      logDebug('Command invoked: codebunny.openReviewPanel', {
        sessionId,
      });
      if (sessionId) {
        const restoredSession = store.restoreSessionFromHistory(sessionId);
        if (!restoredSession) {
          logDebug('Command codebunny.openReviewPanel failed: previous review not found', {
            sessionId,
          });
          vscode.window.showWarningMessage('Previous review not found');
          return;
        }

        commentController.clearAllComments();
        logDebug('Command codebunny.openReviewPanel restoring comments', {
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

      await vscode.commands.executeCommand('codebunny.reviews.focus');
    }
  );

  const enableCodeIndexCommand = vscode.commands.registerCommand(
    'codebunny.enableCodeIndex',
    async () => {
      logDebug('Command invoked: codebunny.enableCodeIndex');
      await codeIndexController?.setEnabled(true);
    }
  );

  const disableCodeIndexCommand = vscode.commands.registerCommand(
    'codebunny.disableCodeIndex',
    async () => {
      logDebug('Command invoked: codebunny.disableCodeIndex');
      await codeIndexController?.setEnabled(false);
    }
  );

  const rebuildCodeIndexCommand = vscode.commands.registerCommand(
    'codebunny.rebuildCodeIndex',
    async () => {
      logDebug('Command invoked: codebunny.rebuildCodeIndex');
      await codeIndexController?.rebuild();
    }
  );

  const stopCodeIndexCommand = vscode.commands.registerCommand(
    'codebunny.stopCodeIndex',
    async () => {
      logDebug('Command invoked: codebunny.stopCodeIndex');
      await codeIndexController?.stop();
    }
  );

  const clearCodeIndexCommand = vscode.commands.registerCommand(
    'codebunny.clearCodeIndex',
    async () => {
      logDebug('Command invoked: codebunny.clearCodeIndex');
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
  logDebug('CodeBunny extension deactivating', {
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
