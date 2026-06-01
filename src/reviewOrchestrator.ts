import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';
import { ReviewCommentController } from './comments';
import { ReviewComment, ReviewRequest } from './types/review';
import { DiffContextCollector } from './harness/diffContextCollector';
import { ReviewSessionStore } from './store/reviewSessionStore';
import { getSettings, logDebug } from './settings';
import { classifyDiffFile, FileDiff, isReviewableDiffFile, parseDiffIntoFiles } from './harness/diffClustering';
import { buildFileContextEnvelope, buildPreparedDiffContextEnvelope, ContextEnvelope, prepareDiffReviewContext } from './harness/contextRetriever';
import { filterUnsupportedFindings } from './harness/findingGrounding';
import {
  computeDiffReviewFingerprint,
  computeDiffUnitFingerprint,
  computeFileReviewFingerprint,
  computeFindingKey,
  computeSelectionReviewFingerprint,
} from './harness/reviewFingerprint';
import { synthesizeReviewComments } from './harness/reviewSynthesizer';
import { buildDiffReviewPackage, buildFileReviewPackage } from './harness/reviewPackageBuilder';
import { buildChangeBriefPrompt } from './harness/prompts';
import { RepoKnowledgeIndex } from './harness/repoKnowledgeIndex';

interface DiffFileReviewResult {
  scopeId: string;
  comments: ReviewComment[];
  provider: string;
}

interface CachedReviewHit {
  comments: ReviewComment[];
  filePaths: string[];
}

interface DiffReviewScope {
  id: string;
  filePaths: string[];
  diff: string;
  estimatedPromptChars: number;
}

interface PerFileDiffReviewPlan {
  scopes: DiffReviewScope[];
  reviewableFiles: string[];
  skippedFiles: Array<{
    filePath: string;
    reviewability: Exclude<FileDiff['reviewability'], 'reviewable'>;
    reason: string;
  }>;
  totalFiles: number;
  skippedFileCount: number;
}

export class ReviewOrchestrator implements vscode.Disposable {
  private getProvider: () => ModelProvider;
  private commentController: ReviewCommentController;
  private diffCollector: DiffContextCollector;
  private store: ReviewSessionStore;
  private activeProviders = new Set<ModelProvider>();
  private runSequence = 0;
  private activeRunId = 0;

  constructor(getProvider: () => ModelProvider, commentController: ReviewCommentController, store: ReviewSessionStore) {
    this.getProvider = getProvider;
    this.commentController = commentController;
    this.diffCollector = new DiffContextCollector();
    this.store = store;
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
    languageId: string,
    fullDocumentCode?: string
  ): Promise<void> {
    const request: ReviewRequest = {
      code: selectedText,
      languageId,
      filePath: uri.fsPath,
      reviewType: 'selection',
      startLine,
      fullDocumentCode,
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

  clearActiveReview(): void {
    this.activeRunId = ++this.runSequence;
    this.cancelActiveProviders('clearActiveReview');
    this.store.clearActiveSession();
    this.commentController.clearAllComments();
  }

  private async reviewCode(request: ReviewRequest): Promise<void> {
    const typeLabel = 'code';
    const startLine = request.startLine ?? 0;
    const runId = this.beginRun();

    const session = this.store.createSession(request.reviewType, undefined, undefined, undefined);
    if (request.filePath) {
      this.store.setFilesToReview([request.filePath]);
    }
    logDebug('Created code review session', {
      sessionId: session.id,
      reviewType: request.reviewType,
      filePath: request.filePath,
      languageId: request.languageId,
      startLine,
      codeLength: request.code.length,
    });
    this.store.transitionSession('startSetup');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Running ${typeLabel} review...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
            this.store.transitionSession('beginAnalysis');
            logDebug('Invoking provider for code review', {
              sessionId: session.id,
              reviewType: request.reviewType,
              filePath: request.filePath,
            });
            const result = request.reviewType === 'file'
              ? await this.reviewPreparedFile(request, runId, session.id, token)
              : request.reviewType === 'selection'
                ? await this.reviewPreparedSelection(request, runId, session.id, token)
                : await this.reviewDirectRequest(request, token);
            if (!this.isRunCurrent(runId, session.id)) {
              logDebug('Ignoring stale code review result', {
                sessionId: session.id,
                runId,
              });
              return;
            }
            logDebug('Provider returned code review result', {
              sessionId: session.id,
              commentCount: result.comments.length,
              provider: result.provider,
            });

            if (token.isCancellationRequested) {
              this.store.clearActiveSession();
              return;
            }

            if (result.comments.length === 0) {
              if (request.filePath) {
                this.store.completeFilesReview([request.filePath]);
              }
              this.store.transitionSession('complete');
              vscode.window.showInformationMessage('No issues found in the code');
              return;
            }

            const adjustedComments = result.comments.map((c) => ({
              ...c,
              line: c.line + startLine,
            }));

            const findings = this.store.addFindingsFromComments(adjustedComments);
            this.commentController.addComments(vscode.Uri.file(request.filePath), findings, request.languageId);

            if (request.filePath) {
              this.store.completeFilesReview([request.filePath]);
            }
            this.store.transitionSession('complete');
            vscode.window.showInformationMessage(
              `ReviewMP: Found ${result.comments.length} comment(s)`
            );
          } catch (error) {
            if (!this.isRunCurrent(runId, session.id)) {
              logDebug('Ignoring stale code review failure', {
                sessionId: session.id,
                runId,
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }

            if (error instanceof Error) {
              if (this.isCancellationError(error)) {
                this.store.clearActiveSession();
                return;
              }

              logDebug('Code review failed', {
                sessionId: session.id,
                error: error.message,
              });
              this.store.setSessionError(error.message);
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
    const runId = this.beginRun();

    const session = this.store.createSession(type);
    logDebug('Created diff review session', {
      sessionId: session.id,
      reviewType: type,
    });
    this.store.transitionSession('startSetup');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `ReviewMP: Running review for ${labels[type]}...`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
            logDebug('Discovering files for review during setup', {
              sessionId: session.id,
              reviewType: type,
            });
            const setupFilePaths = await this.getSetupReviewFiles(type, token);
            this.store.setReviewFiles(setupFilePaths);
            logDebug('Discovered files for review', {
              sessionId: session.id,
              reviewType: type,
              fileCount: setupFilePaths.length,
              files: setupFilePaths.slice(0, 20),
            });

            if (token.isCancellationRequested) {
              this.store.clearActiveSession();
              return;
            }

            this.store.transitionSession('beginAnalysis');
            logDebug('Collecting diff for review', {
              sessionId: session.id,
              reviewType: type,
            });
            const diffResult = await this.diffCollector.getDiff(type, token);
            logDebug('Collected diff for review', {
              sessionId: session.id,
              reviewType: type,
              diffLength: diffResult.diff.length,
              formattedDiffLength: diffResult.formattedDiff.length,
              baseRef: diffResult.baseRef,
              baseSha: diffResult.baseSha,
              headSha: diffResult.headSha,
            });

            if (token.isCancellationRequested) {
              this.store.clearActiveSession();
              return;
            }

            const result = await this.reviewPlannedDiff(type, diffResult.formattedDiff, runId, session.id, token);
            if (!this.isRunCurrent(runId, session.id)) {
              logDebug('Ignoring stale diff review result', {
                sessionId: session.id,
                reviewType: type,
                runId,
              });
              return;
            }
            logDebug('Provider returned diff review result', {
              sessionId: session.id,
              reviewType: type,
              commentCount: result.comments.length,
              provider: result.provider,
            });

            if (token.isCancellationRequested) {
              this.store.clearActiveSession();
              return;
            }

            if (result.comments.length === 0) {
              this.completeAllActiveFileReviews();
              this.store.transitionSession('complete');
              vscode.window.showInformationMessage('No issues found in the changes');
              return;
            }

            await this.addDiffComments(result.comments);
            this.completeAllActiveFileReviews();

            this.store.transitionSession('complete');
            vscode.window.showInformationMessage(
              `ReviewMP: Found ${result.comments.length} comment(s) in ${labels[type]}`
            );
          } catch (error) {
            if (!this.isRunCurrent(runId, session.id)) {
              logDebug('Ignoring stale diff review failure', {
                sessionId: session.id,
                reviewType: type,
                runId,
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }

            if (error instanceof Error) {
              if (this.isCancellationError(error)) {
                this.store.clearActiveSession();
                return;
              }

              logDebug('Diff review failed', {
                sessionId: session.id,
                reviewType: type,
                error: error.message,
              });
              this.store.setSessionError(error.message);
              vscode.window.showErrorMessage(`ReviewMP Error: ${error.message}`);
            }
          }
      }
    );
  }

  private async reviewPlannedDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    formattedDiff: string,
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ) {
    const plan = this.buildPerFileDiffPlan(formattedDiff);
    const reviewFingerprint = computeDiffReviewFingerprint(formattedDiff);
    const unitFingerprints = plan.scopes.map((scope) => computeDiffUnitFingerprint(scope.filePaths, scope.diff));
    logDebug('Built per-file diff review', {
      sessionId,
      runId,
      reviewType: type,
      reviewFingerprint,
      diffChars: formattedDiff.length,
      fileScopeCount: plan.scopes.length,
      estimatedPromptChars: plan.scopes.reduce((total, scope) => total + scope.estimatedPromptChars, 0),
      filesPerScope: plan.scopes.map((scope) => scope.filePaths.length),
      reviewableFileCount: plan.reviewableFiles.length,
      skippedFileCount: plan.skippedFileCount,
      skippedFilesSample: plan.skippedFiles.slice(0, 8),
    });
    this.store.setReviewFiles(plan.reviewableFiles.map((filePath) => this.resolveWorkspaceFilePath(filePath)));
    this.store.setSessionReviewMetadata({
      reviewFingerprint,
      reviewTargetKind: 'diff',
      unitFingerprints,
    });

    if (plan.scopes.length === 0) {
      return {
        comments: [],
        provider: 'planned',
      };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const exactHit = await this.loadExactReviewHit(workspaceRoot, reviewFingerprint);
    if (exactHit) {
      this.store.transitionSession('beginReview');
      this.store.markFilesReviewing(plan.reviewableFiles.map((filePath) => this.resolveWorkspaceFilePath(filePath)));
      logDebug('Using exact cached diff review hit', {
        sessionId,
        runId,
        reviewType: type,
        reviewFingerprint,
        commentCount: exactHit.comments.length,
      });
      return {
        comments: exactHit.comments,
        provider: 'exact-cache',
      };
    }

    const runContext = await prepareDiffReviewContext({
      formattedDiff,
      workspaceRoot,
    });
    logDebug('Building review-level retrieval context', {
      sessionId,
      runId,
      reviewType: type,
      reviewableFileCount: plan.reviewableFiles.length,
    });
    const reviewContextEnvelope = await buildPreparedDiffContextEnvelope(runContext, {
      primaryFiles: plan.reviewableFiles,
    });
    logDebug('Built review-level retrieval context', {
      sessionId,
      runId,
      reviewType: type,
      contextFileCount: reviewContextEnvelope.files.length,
      contextChars: reviewContextEnvelope.totalChars,
      contextReasons: summarizeContextReasons(reviewContextEnvelope),
    });
    const changeBrief = await this.buildReviewChangeBrief(
      formattedDiff,
      reviewContextEnvelope,
      type,
      runId,
      sessionId,
      token
    );

    this.store.transitionSession('beginReview');

    const scopeResults = await this.executeDiffScopes(
      plan.scopes,
      unitFingerprints,
      type,
      reviewContextEnvelope,
      changeBrief,
      runId,
      sessionId,
      token
    );

    if (!this.isRunCurrent(runId, sessionId) || token?.isCancellationRequested) {
      this.store.clearActiveSession();
      return {
        comments: [],
        provider: scopeResults.provider,
      };
    }

    return {
      comments: synthesizeReviewComments(scopeResults.commentGroups),
      provider: scopeResults.provider,
    };
  }

  private async getSetupReviewFiles(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    token?: vscode.CancellationToken
  ): Promise<string[]> {
    const changedFiles = await this.diffCollector.getChangedFiles(type, token);
    return changedFiles
      .filter((filePath) => classifyDiffFile(filePath, '').reviewability === 'reviewable')
      .map((filePath) => this.resolveWorkspaceFilePath(filePath));
  }

  private async executeDiffScopes(
    scopes: DiffReviewScope[],
    unitFingerprints: string[],
    reviewType: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    reviewContextEnvelope: ContextEnvelope,
    changeBrief: string | undefined,
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ): Promise<{ commentGroups: ReviewComment[][]; provider: string }> {
    const concurrency = Math.min(getSettings().reviewConcurrency, scopes.length);
    const results = new Array<DiffFileReviewResult | undefined>(scopes.length);
    let nextIndex = 0;

    logDebug('Starting parallel diff scope review', {
      sessionId,
      runId,
      reviewType,
      scopeCount: scopes.length,
      concurrency,
    });

    const runWorker = async (workerIndex: number): Promise<void> => {
      while (nextIndex < scopes.length) {
        if (token?.isCancellationRequested || !this.isRunCurrent(runId, sessionId)) {
          return;
        }

        const scopeIndex = nextIndex;
        nextIndex += 1;
        const scope = scopes[scopeIndex];
        logDebug('Invoking per-file diff review scope', {
          sessionId,
          runId,
          reviewType,
          workerIndex,
          scopeIndex,
          scopeId: scope.id,
          filePaths: scope.filePaths,
        });

        const result = await this.executeSingleDiffScope(
          scope,
          unitFingerprints[scopeIndex],
          reviewType,
          reviewContextEnvelope,
          changeBrief,
          runId,
          sessionId,
          token
        );

        if (!this.isRunCurrent(runId, sessionId)) {
          logDebug('Ignoring stale per-file diff review scope result', {
            sessionId,
            runId,
            reviewType,
            workerIndex,
            scopeIndex,
          });
          return;
        }

        results[scopeIndex] = result;
        logDebug('Per-file diff review scope completed', {
          sessionId,
          runId,
          reviewType,
          workerIndex,
          scopeIndex,
          commentCount: result.comments.length,
        });
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index)));

    const completedResults = results.filter((result): result is DiffFileReviewResult => Boolean(result));
    return {
      commentGroups: completedResults.map((result) => result.comments),
      provider: [...new Set(completedResults.map((result) => result.provider).filter(Boolean))].join(', '),
    };
  }

  private async executeSingleDiffScope(
    scope: DiffReviewScope,
    unitFingerprint: string,
    reviewType: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    reviewContextEnvelope: ContextEnvelope,
    changeBrief: string | undefined,
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ): Promise<DiffFileReviewResult> {
    this.store.markFilesReviewing(
      scope.filePaths.map((filePath) => this.resolveWorkspaceFilePath(filePath))
    );

    const request: ReviewRequest = {
      code: '',
      languageId: '',
      filePath: scope.filePaths.join(', '),
      reviewType,
      diff: scope.diff,
    };
    request.crossFileContext = reviewContextEnvelope.text;
    request.reviewPackage = buildDiffReviewPackage(request, scope.diff, reviewContextEnvelope, changeBrief);
    logDebug('Invoking per-file diff review scope', {
      sessionId,
      runId,
      reviewType,
      scopeId: scope.id,
      unitFingerprint,
      filePaths: scope.filePaths,
      diffChars: scope.diff.length,
      estimatedPromptChars: scope.estimatedPromptChars,
      crossFileContextChars: request.crossFileContext?.length ?? 0,
      sharedContextFileCount: reviewContextEnvelope.files.length,
      changeBriefChars: changeBrief?.length ?? 0,
    });

    const cachedComments = await this.loadExactUnitComments(this.getWorkspaceRoot(), unitFingerprint);
    if (cachedComments) {
      logDebug('Using exact cached diff scope hit', {
        sessionId,
        runId,
        reviewType,
        scopeId: scope.id,
        unitFingerprint,
        commentCount: cachedComments.length,
      });
      return {
        scopeId: scope.id,
        comments: cachedComments,
        provider: 'exact-cache',
      };
    }

    const result = await this.invokeProvider(request, token);
    logDebug('Per-file diff review scope completed', {
      sessionId,
      runId,
      reviewType,
      scopeId: scope.id,
      provider: result.provider,
      commentCount: result.comments.length,
    });

    const comments = result.comments.map((comment) => ({
      ...comment,
      findingKey: comment.findingKey ?? computeFindingKey(comment),
      reviewFingerprint: this.store.getActiveSession()?.reviewFingerprint,
      unitFingerprint,
      source: 'fresh' as const,
    }));

    return {
      scopeId: scope.id,
      comments,
      provider: result.provider,
    };
  }

  private async reviewPreparedFile(
    request: ReviewRequest,
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ) {
    const reviewFingerprint = computeFileReviewFingerprint(request.filePath, request.code);
    this.store.setSessionReviewMetadata({
      reviewFingerprint,
      reviewTargetKind: 'file',
      unitFingerprints: [reviewFingerprint],
    });
    logDebug('Prepared file review', {
      sessionId,
      runId,
      filePath: request.filePath,
      languageId: request.languageId,
      reviewType: request.reviewType,
      reviewFingerprint,
      codeChars: request.code.length,
    });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const exactHit = await this.loadExactReviewHit(workspaceRoot, reviewFingerprint, request.filePath);
    if (exactHit) {
      this.store.transitionSession('beginReview');
      this.store.markFilesReviewing([request.filePath]);
      return {
        comments: exactHit.comments,
        provider: 'exact-cache',
      };
    }

    if (token?.isCancellationRequested) {
      this.store.clearActiveSession();
      return {
        comments: [],
        provider: '',
      };
    }

    const contextEnvelope = await buildFileContextEnvelope({
      workspaceRoot,
      filePath: request.filePath,
      languageId: request.languageId,
      fullCode: request.code,
      unitCode: request.code,
    });
    const packagedRequest: ReviewRequest = {
      ...request,
      crossFileContext: contextEnvelope.text || request.crossFileContext,
      reviewPackage: buildFileReviewPackage(request, contextEnvelope),
    };

    this.store.transitionSession('beginReview');
    this.store.markFilesReviewing([request.filePath]);
    logDebug('Invoking prepared file review', {
      sessionId,
      runId,
      filePath: request.filePath,
      reviewFingerprint,
      codeChars: request.code.length,
      crossFileContextChars: packagedRequest.crossFileContext?.length ?? 0,
    });

    const result = await this.invokeProvider(packagedRequest, token);
    return {
      ...result,
      comments: result.comments.map((comment) => ({
        ...comment,
        findingKey: comment.findingKey ?? computeFindingKey(comment),
        reviewFingerprint,
        unitFingerprint: reviewFingerprint,
        source: 'fresh' as const,
      })),
    };
  }

  private async reviewPreparedSelection(
    request: ReviewRequest,
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ) {
    const reviewFingerprint = computeSelectionReviewFingerprint(
      request.filePath,
      request.code,
      request.startLine,
      request.fullDocumentCode
    );
    this.store.setSessionReviewMetadata({
      reviewFingerprint,
      reviewTargetKind: 'selection',
      unitFingerprints: [reviewFingerprint],
    });
    const exactHit = await this.loadExactReviewHit(this.getWorkspaceRoot(), reviewFingerprint, request.filePath);
    if (exactHit) {
      this.store.transitionSession('beginReview');
      this.store.markFilesReviewing([request.filePath]);
      return {
        comments: exactHit.comments,
        provider: 'exact-cache',
      };
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const contextEnvelope = await buildFileContextEnvelope({
      workspaceRoot,
      filePath: request.filePath,
      languageId: request.languageId,
      fullCode: request.fullDocumentCode ?? request.code,
      unitCode: request.code,
      pathHint: request.startLine !== undefined
        ? `selection lines ${request.startLine + 1}-${request.startLine + request.code.split('\n').length}`
        : undefined,
    });
    const packagedRequest: ReviewRequest = {
      ...request,
      crossFileContext: contextEnvelope.text || request.crossFileContext,
      reviewPackage: buildFileReviewPackage(request, contextEnvelope),
    };

    this.store.transitionSession('beginReview');
    this.store.markFilesReviewing([request.filePath]);
    logDebug('Invoking prepared selection review', {
      sessionId,
      runId,
      filePath: request.filePath,
      startLine: request.startLine,
      codeChars: request.code.length,
      reviewFingerprint,
      crossFileContextChars: packagedRequest.crossFileContext?.length ?? 0,
    });

    const result = await this.invokeProvider(packagedRequest, token);
    return {
      ...result,
      comments: result.comments.map((comment) => ({
        ...comment,
        findingKey: comment.findingKey ?? computeFindingKey(comment),
        reviewFingerprint,
        unitFingerprint: reviewFingerprint,
        source: 'fresh' as const,
      })),
    };
  }

  private async reviewDirectRequest(request: ReviewRequest, token?: vscode.CancellationToken) {
    this.store.transitionSession('beginReview');
    if (request.filePath) {
      this.store.markFilesReviewing([request.filePath]);
    }
    return this.invokeProvider(request, token);
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async loadExactReviewHit(
    workspaceRoot: string | undefined,
    reviewFingerprint: string,
    absoluteFilePathHint?: string
  ): Promise<CachedReviewHit | null> {
    if (!workspaceRoot) {
      return null;
    }

    try {
      const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);
      const run = await index.getExactReviewRun(reviewFingerprint);
      if (!run || run.status !== 'completed') {
        return null;
      }

      const findings = await index.getExactReviewFindings(reviewFingerprint);
      const comments = findings
        .filter((finding) => finding.outcome === 'pending')
        .map((finding) => this.restoreStoredComment(finding, absoluteFilePathHint));

      return {
        comments,
        filePaths: safeParseJsonArray(run.filePaths),
      };
    } catch (error) {
      logDebug('Exact review hit lookup failed', {
        reviewFingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async loadExactUnitComments(
    workspaceRoot: string | undefined,
    unitFingerprint: string,
    absoluteFilePathHint?: string
  ): Promise<ReviewComment[] | null> {
    if (!workspaceRoot) {
      return null;
    }

    try {
      const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);
      const unit = await index.getExactReviewUnit(unitFingerprint);
      if (!unit) {
        return null;
      }

      const findings = await index.getExactReviewUnitFindings(unitFingerprint);
      return findings
        .filter((finding) => finding.outcome === 'pending')
        .map((finding) => this.restoreStoredComment(finding, absoluteFilePathHint));
    } catch (error) {
      logDebug('Exact review scope lookup failed', {
        unitFingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private restoreStoredComment(
    finding: {
      filePath: string;
      line: number;
      title: string;
      message: string;
      fix: string;
      severity: string;
      findingKey: string;
      reviewFingerprint: string;
      unitFingerprint: string;
    },
    absoluteFilePathHint?: string
  ): ReviewComment {
    const file = absoluteFilePathHint
      ? this.restoreAbsoluteFilePath(absoluteFilePathHint, finding.filePath)
      : finding.filePath;

    return {
      file,
      line: finding.line,
      title: finding.title || undefined,
      message: finding.message,
      fix: finding.fix || undefined,
      severity: (finding.severity || 'warning') as ReviewComment['severity'],
      findingKey: finding.findingKey || computeFindingKey({ ...finding, file }),
      reviewFingerprint: finding.reviewFingerprint,
      unitFingerprint: finding.unitFingerprint,
      source: 'reused',
    };
  }

  private restoreAbsoluteFilePath(absoluteFilePathHint: string, storedFilePath: string): string {
    if (storedFilePath.startsWith('/') || storedFilePath.includes(':\\')) {
      return storedFilePath;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return absoluteFilePathHint;
    }

    return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), storedFilePath).fsPath;
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

    logDebug('Adding diff comments to workspace files', {
      fileCount: commentsByFile.size,
      totalCommentCount: comments.length,
      files: [...commentsByFile.entries()].map(([filePath, fileComments]) => ({
        filePath,
        commentCount: fileComments.length,
      })),
    });

    for (const [filePath, fileComments] of commentsByFile) {
      const normalizedFilePath = this.normalizeDiffFilePath(filePath);
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedFilePath);

      const ext = normalizedFilePath.split('.').pop() || '';
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

      const findings = this.store.addFindingsFromComments(
        fileComments.map(comment => ({
          ...comment,
          file: uri.fsPath,
        }))
      );
      this.commentController.addComments(uri, findings, languageId);
    }
  }

  private normalizeDiffFilePath(filePath: string): string {
    return filePath.replace(/^\/+/, '');
  }

  private getFilePathsFromDiff(diff: string): string[] {
    const filePaths: string[] = [];
    const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(diff)) !== null) {
      filePaths.push(this.resolveChangedFilePath(match[1], match[2]));
    }

    return filePaths.map(filePath => this.resolveWorkspaceFilePath(filePath));
  }

  private resolveChangedFilePath(oldPath: string, newPath: string): string {
    return newPath === '/dev/null' ? oldPath : newPath;
  }

  private resolveWorkspaceFilePath(filePath: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return this.normalizeDiffFilePath(filePath);
    }

    return vscode.Uri.joinPath(workspaceFolder.uri, this.normalizeDiffFilePath(filePath)).fsPath;
  }

  private completeAllActiveFileReviews(): void {
    this.store.completeFilesReview(
      this.store.getFilesForSession().map((file) => file.path)
    );
  }

  private beginRun(): number {
    const runId = ++this.runSequence;
    this.activeRunId = runId;
    this.cancelActiveProviders('superseded');
    return runId;
  }

  private isRunCurrent(runId: number, sessionId?: string): boolean {
    if (this.activeRunId !== runId) {
      return false;
    }

    if (sessionId) {
      return this.store.getActiveSession()?.id === sessionId;
    }

    return true;
  }

  private async invokeProvider(request: ReviewRequest, token?: vscode.CancellationToken) {
    const provider = this.getProvider();
    this.activeProviders.add(provider);

    try {
      const result = await provider.review(request, token);
      const filteredComments = await filterUnsupportedFindings(
        request,
        result.comments,
        this.getWorkspaceRoot()
      );
      return {
        ...result,
        comments: filteredComments,
      };
    } finally {
      this.activeProviders.delete(provider);
    }
  }

  private async generateChangeBriefWithProvider(prompt: string, token?: vscode.CancellationToken): Promise<{ text: string; provider: string }> {
    const provider = this.getProvider();
    this.activeProviders.add(provider);

    try {
      const text = await provider.generateChangeBrief(prompt, token);
      return {
        text,
        provider: provider.name,
      };
    } finally {
      this.activeProviders.delete(provider);
    }
  }

  private async buildReviewChangeBrief(
    formattedDiff: string,
    reviewContextEnvelope: ContextEnvelope,
    reviewType: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    runId: number,
    sessionId: string,
    token?: vscode.CancellationToken
  ): Promise<string | undefined> {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    const prompt = buildChangeBriefPrompt(formattedDiff, reviewContextEnvelope);
    logDebug('Generating review-level change brief', {
      sessionId,
      runId,
      reviewType,
      diffChars: formattedDiff.length,
      contextFileCount: reviewContextEnvelope.files.length,
      contextChars: reviewContextEnvelope.totalChars,
      promptChars: prompt.length,
    });

    try {
      const result = await this.generateChangeBriefWithProvider(prompt, token);
      const brief = normalizeChangeBrief(result.text);
      logDebug('Generated review-level change brief', {
        sessionId,
        runId,
        reviewType,
        provider: result.provider,
        rawBriefChars: result.text.length,
        briefChars: brief.length,
      });
      return brief;
    } catch (error) {
      if (error instanceof Error && this.isCancellationError(error)) {
        throw error;
      }

      logDebug('Review-level change brief generation failed; continuing without brief', {
        sessionId,
        runId,
        reviewType,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private buildPerFileDiffPlan(formattedDiff: string): PerFileDiffReviewPlan {
    const parsedFileDiffs = parseDiffIntoFiles(formattedDiff);
    const fileDiffs = parsedFileDiffs.filter(isReviewableDiffFile);

    return {
      scopes: fileDiffs.map((fileDiff, index) => this.toPerFileReviewScope(fileDiff, index)),
      reviewableFiles: fileDiffs.map((fileDiff) => fileDiff.filePath),
      skippedFiles: parsedFileDiffs
        .filter((fileDiff) => !isReviewableDiffFile(fileDiff))
        .map((fileDiff) => ({
          filePath: fileDiff.filePath,
          reviewability: fileDiff.reviewability as PerFileDiffReviewPlan['skippedFiles'][number]['reviewability'],
          reason: fileDiff.skipReason ?? 'non-reviewable file',
        })),
      totalFiles: parsedFileDiffs.length,
      skippedFileCount: parsedFileDiffs.filter((fileDiff) => !isReviewableDiffFile(fileDiff)).length,
    };
  }

  private toPerFileReviewScope(fileDiff: FileDiff, index: number): DiffReviewScope {
    return {
      id: `file-scope-${index}`,
      filePaths: [fileDiff.filePath],
      diff: fileDiff.rawDiff.endsWith('\n') ? fileDiff.rawDiff : `${fileDiff.rawDiff}\n`,
      estimatedPromptChars: fileDiff.rawDiff.length,
    };
  }

  private cancelActiveProviders(reason: string): void {
    if (this.activeProviders.size === 0) {
      return;
    }

    logDebug('Cancelling active providers', {
      reason,
      providerCount: this.activeProviders.size,
    });

    for (const provider of Array.from(this.activeProviders)) {
      try {
        provider.cancel();
      } catch (error) {
        logDebug('Provider cancellation failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.activeProviders.clear();
  }

  private isCancellationError(error: Error): boolean {
    return error.message === 'Review cancelled';
  }

  dispose(): void {
    this.cancelActiveProviders('dispose');
  }
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeChangeBrief(value: string): string {
  return value
    .replace(/```(?:\w+)?/g, '')
    .trim()
    .slice(0, 4_000);
}

function summarizeContextReasons(envelope: ContextEnvelope): Record<string, number> {
  return envelope.files.reduce<Record<string, number>>((summary, file) => {
    summary[file.reason] = (summary[file.reason] ?? 0) + 1;
    return summary;
  }, {});
}
