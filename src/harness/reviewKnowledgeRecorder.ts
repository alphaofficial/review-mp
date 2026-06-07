import { ReviewSessionStore } from '../store/reviewSessionStore';
import { ReviewFinding, ReviewHistoryEntry } from '../types/review';
import { RepoKnowledgeIndex } from './repoKnowledgeIndex';
import { getSettings } from '../settings';

export class ReviewKnowledgeRecorder {
  private disposed = false;
  private readonly onSessionCompletedBound = this.onSessionCompleted.bind(this);
  private readonly onFindingUpdatedBound = this.onFindingUpdated.bind(this);

  constructor(private readonly store: ReviewSessionStore, private readonly workspaceRoot?: string) {
    if (!workspaceRoot) {
      return;
    }

    this.store.on('session-completed', this.onSessionCompletedBound);
    this.store.on('finding-updated', this.onFindingUpdatedBound);
  }

  dispose(): void {
    if (this.disposed || !this.workspaceRoot) {
      return;
    }

    this.disposed = true;
    this.store.off('session-completed', this.onSessionCompletedBound);
    this.store.off('finding-updated', this.onFindingUpdatedBound);
  }

  private async onSessionCompleted(data: { sessionId: string }): Promise<void> {
    const entry = this.store.getSessionHistory().find((historyEntry) => historyEntry.sessionId === data.sessionId);
    if (!entry || !this.workspaceRoot) {
      return;
    }

    const index = await RepoKnowledgeIndex.forWorkspace(this.workspaceRoot);
    await this.recordExactReview(index, entry);

    if (getSettings().codeIndexEnabled) {
      for (const finding of entry.findings) {
        await this.upsertSemanticFinding(index, entry, finding);
      }
    }
  }

  private async onFindingUpdated(data: { sessionId: string; findingId: string }): Promise<void> {
    if (!this.workspaceRoot) {
      return;
    }

    const finding = this.store.getFinding(data.findingId);
    if (!finding) {
      return;
    }

    const historyEntry = this.store.getSessionHistory().find((entry) => entry.sessionId === data.sessionId);
    const index = await RepoKnowledgeIndex.forWorkspace(this.workspaceRoot);
    await this.upsertExactFinding(index, historyEntry, finding);
    if (getSettings().codeIndexEnabled) {
      await this.upsertSemanticFinding(index, historyEntry, finding);
    }
  }

  private async recordExactReview(index: RepoKnowledgeIndex, historyEntry: ReviewHistoryEntry): Promise<void> {
    const reviewFingerprint = historyEntry.reviewFingerprint
      ?? historyEntry.findings.find((finding) => finding.reviewFingerprint)?.reviewFingerprint;
    if (!reviewFingerprint) {
      return;
    }

    const normalizedFiles = historyEntry.files.map((file) => normalizeFilePath(file.path, this.workspaceRoot!));
    await index.upsertExactReviewRun({
      id: reviewFingerprint,
      reviewFingerprint,
      targetKind: historyEntry.reviewTargetKind ?? mapReviewTypeToTargetKind(historyEntry.reviewType),
      filePaths: JSON.stringify(normalizedFiles),
      unitFingerprints: JSON.stringify(historyEntry.unitFingerprints ?? []),
      findingCount: historyEntry.findings.length,
      status: 'completed',
    });

    for (const unitFingerprint of historyEntry.unitFingerprints ?? []) {
      await index.upsertExactReviewUnit({
        id: unitFingerprint,
        unitFingerprint,
        reviewFingerprint,
        targetKind: historyEntry.reviewTargetKind ?? mapReviewTypeToTargetKind(historyEntry.reviewType),
        filePaths: JSON.stringify(normalizedFiles),
        findingCount: historyEntry.findings.filter((finding) => finding.unitFingerprint === unitFingerprint).length,
      });
    }

    await index.replaceExactReviewFindings(
      reviewFingerprint,
      historyEntry.findings.map((finding) => this.toExactFindingRecord(historyEntry, finding))
    );
  }

  private async upsertExactFinding(
    index: RepoKnowledgeIndex,
    historyEntry: ReviewHistoryEntry | undefined,
    finding: ReviewFinding
  ): Promise<void> {
    if (!finding.reviewFingerprint) {
      return;
    }

    await index.upsertExactReviewFinding(this.toExactFindingRecord(historyEntry, finding));
  }

  private async upsertSemanticFinding(
    index: RepoKnowledgeIndex,
    historyEntry: ReviewHistoryEntry | undefined,
    finding: ReviewFinding
  ): Promise<void> {
    await index.upsertReviewMemory({
      id: finding.id,
      findingId: finding.id,
      filePath: normalizeFilePath(finding.file, this.workspaceRoot!),
      ruleId: finding.title ?? null,
      comment: [finding.title, finding.message].filter(Boolean).join(': '),
      outcome: mapFindingOutcome(finding.status),
      line: finding.line,
      severity: finding.severity,
    });

  }

  private toExactFindingRecord(
    historyEntry: ReviewHistoryEntry | undefined,
    finding: ReviewFinding
  ) {
    const reviewFingerprint = finding.reviewFingerprint ?? historyEntry?.reviewFingerprint;
    const unitFingerprint = finding.unitFingerprint ?? reviewFingerprint ?? '';

    return {
      id: `${reviewFingerprint}:${finding.findingKey ?? finding.id}`,
      reviewFingerprint: reviewFingerprint ?? '',
      unitFingerprint,
      findingKey: finding.findingKey ?? finding.id,
      filePath: normalizeFilePath(finding.file, this.workspaceRoot!),
      line: finding.line,
      title: finding.title ?? '',
      message: finding.message,
      fix: finding.fix ?? '',
      severity: finding.severity,
      outcome: finding.status,
    } as const;
  }
}

function mapFindingOutcome(status: ReviewFinding['status']): 'accepted' | 'ignored' | 'fixed' {
  switch (status) {
    case 'applied':
      return 'fixed';
    case 'dismissed':
      return 'ignored';
    case 'pending':
    default:
      return 'accepted';
  }
}

function normalizeFilePath(filePath: string, workspaceRoot: string): string {
  if (!filePath.startsWith(workspaceRoot)) {
    return filePath.replace(/\\/g, '/');
  }

  return filePath.slice(workspaceRoot.length + 1).replace(/\\/g, '/');
}

function mapReviewTypeToTargetKind(reviewType: ReviewHistoryEntry['reviewType']): 'file' | 'selection' | 'diff' {
  switch (reviewType) {
    case 'file':
      return 'file';
    case 'selection':
      return 'selection';
    case 'staged':
    case 'uncommitted':
    case 'lastCommit':
    case 'branch':
    default:
      return 'diff';
  }
}
