import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';
import { FixApplicator, createFixApplicator } from './harness/fixApplicator';
import { ReviewFinding } from './types/review';
import { ReviewSessionStore } from './store/reviewSessionStore';
import { logDebug } from './settings';

export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  fix?: string;
  severity?: 'error' | 'warning' | 'info' | 'suggestion';
}

interface CommentData {
  uri: vscode.Uri;
  line: number;
  title?: string;
  message: string;
  fix?: string;
  thread: vscode.CommentThread;
  findingId: string;
}

export class ReviewCommentController implements vscode.Disposable {
  private controller: vscode.CommentController;
  private threads: Map<string, vscode.CommentThread[]> = new Map();
  private commentDataMap: WeakMap<vscode.Comment, CommentData> = new WeakMap();
  private findingIdToComment: Map<string, vscode.Comment> = new Map();
  private fixApplicator: FixApplicator;
  private store: ReviewSessionStore | null = null;

  constructor(context: vscode.ExtensionContext, provider?: ModelProvider, fixApplicator?: FixApplicator, store?: ReviewSessionStore) {
    this.fixApplicator = fixApplicator || createFixApplicator();
    this.store = store || null;
    this.controller = vscode.comments.createCommentController(
      'codebunny',
      'CodeBunny Comments'
    );

    this.controller.commentingRangeProvider = undefined;
    logDebug('Review comment controller initialized', {
      hasStore: Boolean(this.store),
    });

    context.subscriptions.push(
      vscode.commands.registerCommand('codebunny.acceptFix', (comment: vscode.Comment) =>
        this.acceptFix(comment)
      ),
      vscode.commands.registerCommand('codebunny.rejectComment', (comment: vscode.Comment) =>
        this.rejectComment(comment)
      ),
      vscode.commands.registerCommand('codebunny.copyComment', (comment: vscode.Comment) =>
        this.copyComment(comment)
      ),
      vscode.commands.registerCommand('codebunny.collapseComment', (comment: vscode.Comment) =>
        this.collapseComment(comment)
      )
    );

    if (this.store) {
      this.store.on('finding-updated', this.onFindingUpdated.bind(this));
      this.store.on('session-cleared', this.onSessionCleared.bind(this));
    }
  }

  private onFindingUpdated(data: { sessionId: string; findingId: string; action: 'apply' | 'dismiss' }): void {
    logDebug('Review comment controller observed finding update', data);
    const comment = this.findingIdToComment.get(data.findingId);
    if (!comment) {
      logDebug('Review comment controller could not find comment for updated finding', data);
      return;
    }

    const commentData = this.commentDataMap.get(comment);
    if (!commentData) {
      return;
    }

    if (data.action === 'apply' || data.action === 'dismiss') {
      commentData.thread.dispose();
      this.removeThreadFromMap(commentData.uri, commentData.thread);
      this.findingIdToComment.delete(data.findingId);
    }
  }

  private onSessionCleared(): void {
    logDebug('Review comment controller observed session clear');
    this.clearAllComments();
  }

  addComments(uri: vscode.Uri, findings: ReviewFinding[], languageId?: string) {
    logDebug('Review comment controller adding comments', {
      uri: uri.toString(),
      findingCount: findings.length,
      languageId,
      severityCounts: findings.reduce<Record<string, number>>((counts, finding) => {
        counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
        return counts;
      }, {}),
    });
    this.clearCommentsForFile(uri);

    const threads: vscode.CommentThread[] = [];

    for (const finding of findings) {
      const range = new vscode.Range(finding.line, 0, finding.line, 0);
      const thread = this.controller.createCommentThread(uri, range, []);

      const body = this.createCommentBody(finding, languageId);

      const reviewComment: vscode.Comment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'CodeBunny' },
        contextValue: finding.fix ? 'codebunny-with-fix' : 'codebunny',
      };

      const commentData: CommentData = {
        uri,
        line: finding.line,
        title: finding.title,
        message: finding.message,
        fix: finding.fix,
        thread,
        findingId: finding.id,
      };

      this.commentDataMap.set(reviewComment, commentData);
      this.findingIdToComment.set(finding.id, reviewComment);

      thread.comments = [reviewComment];
      thread.canReply = false;
      thread.label = this.getSeverityLabel(finding.severity);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

      threads.push(thread);
    }

    this.threads.set(uri.toString(), threads);
    logDebug('Review comment controller added comment threads', {
      uri: uri.toString(),
      threadCount: threads.length,
    });
  }

  revealFinding(findingId: string): boolean {
    const comment = this.findingIdToComment.get(findingId);
    if (!comment) {
      logDebug('Review comment controller revealFinding failed: comment not found', {
        findingId,
      });
      return false;
    }

    const data = this.commentDataMap.get(comment);
    if (!data) {
      logDebug('Review comment controller revealFinding failed: comment data not found', {
        findingId,
      });
      return false;
    }

    data.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    logDebug('Review comment controller revealed finding', {
      findingId,
      uri: data.uri.toString(),
      line: data.line,
    });
    return true;
  }

  private createCommentBody(finding: ReviewFinding, languageId?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = false;

    const { title, body } = this.getCommentText(finding);

    md.appendMarkdown(`**${title}**`);

    if (body) {
      md.appendMarkdown(`\n\n${body}`);
    }

    if (finding.fix) {
      if (this.isLikelyCode(finding.fix)) {
        md.appendMarkdown('\n\n');
        md.appendCodeblock(finding.fix.trim(), this.getFixLanguageId(finding.fix, languageId));
      } else {
        md.appendMarkdown(`\n\n${finding.fix.trim()}`);
      }
    }

    return md;
  }

  private getCommentText(finding: ReviewFinding): { title: string; body: string } {
    if (finding.title?.trim()) {
      return {
        title: finding.title.trim(),
        body: finding.message.trim(),
      };
    }

    return this.splitCommentMessage(finding.message);
  }

  private splitCommentMessage(message: string): { title: string; body: string } {
    const trimmed = message.trim();
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex > 0 && separatorIndex < 90) {
      return {
        title: trimmed.slice(0, separatorIndex).trim(),
        body: trimmed.slice(separatorIndex + 1).trim(),
      };
    }

    const firstSentenceMatch = trimmed.match(/^(.{20,90}?[.!?])\s+(.+)$/s);
    if (firstSentenceMatch) {
      return {
        title: firstSentenceMatch[1].trim(),
        body: firstSentenceMatch[2].trim(),
      };
    }

    return {
      title: this.truncateTitle(trimmed),
      body: trimmed.length > 90 ? trimmed : '',
    };
  }

  private truncateTitle(message: string): string {
    if (message.length <= 90) {
      return message;
    }
    return `${message.slice(0, 87).trim()}...`;
  }

  private isLikelyCode(fix: string): boolean {
    const trimmed = fix.trim();
    if (trimmed.includes('\n')) {
      return true;
    }

    return /[{}();=<>]|\b(const|let|var|if|return|await|async|function|class|import|export)\b/.test(trimmed);
  }

  private getFixLanguageId(fix: string, languageId?: string): string {
    const hasDiffMarkers = fix
      .trim()
      .split('\n')
      .some(line => line.startsWith('+') || line.startsWith('-'));

    return hasDiffMarkers ? 'diff' : languageId || '';
  }

  private getSeverityLabel(severity?: string): string {
    switch (severity) {
      case 'error':
        return 'Potential Issue';
      case 'warning':
        return 'Warning';
      case 'info':
        return 'Info';
      case 'suggestion':
        return 'Refactor Suggestion';
      default:
        return 'Review';
    }
  }

  private async acceptFix(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      logDebug('Accept fix failed: comment data not found');
      vscode.window.showWarningMessage('Comment data not found');
      return;
    }

    if (!data.fix) {
      logDebug('Accept fix skipped: no fix available', {
        findingId: data.findingId,
        uri: data.uri.toString(),
        line: data.line,
      });
      vscode.window.showWarningMessage('No fix available for this comment');
      return;
    }

    try {
      logDebug('Applying fix from review comment', {
        findingId: data.findingId,
        uri: data.uri.toString(),
        line: data.line,
        fixChars: data.fix.length,
      });
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'CodeBunny: Applying fix...',
          cancellable: false,
        },
        async () => {
          return await this.fixApplicator.applyFix(data.uri.fsPath, data.line, data.fix!);
        }
      );

      if (!result.success) {
        throw new Error(result.error || 'Failed to apply fix');
      }

      if (this.store) {
        this.store.updateFindingStatus(data.findingId, 'apply');
      }

      data.thread.dispose();
      this.removeThreadFromMap(data.uri, data.thread);
      this.findingIdToComment.delete(data.findingId);

      vscode.window.showInformationMessage('Fix applied successfully');
      logDebug('Applied fix from review comment', {
        findingId: data.findingId,
        uri: data.uri.toString(),
        line: data.line,
      });
    } catch (error) {
      logDebug('Applying fix from review comment failed', {
        findingId: data.findingId,
        uri: data.uri.toString(),
        line: data.line,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        vscode.window.showErrorMessage(`Failed to apply fix: ${error.message}`);
      }
    }
  }

  private rejectComment(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      logDebug('Reject comment skipped: comment data not found');
      return;
    }

    logDebug('Rejecting review comment', {
      findingId: data.findingId,
      uri: data.uri.toString(),
      line: data.line,
    });

    if (this.store) {
      this.store.updateFindingStatus(data.findingId, 'dismiss');
    }

    data.thread.dispose();
    this.removeThreadFromMap(data.uri, data.thread);
    this.findingIdToComment.delete(data.findingId);
  }

  private async copyComment(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      logDebug('Copy comment skipped: comment data not found');
      return;
    }

    const text = data.fix
      ? `${data.title ? `${data.title}\n\n` : ''}${data.message}\n\n${data.fix}`
      : data.message;
    await vscode.env.clipboard.writeText(text);
    logDebug('Copied review comment to clipboard', {
      findingId: data.findingId,
      hasFix: Boolean(data.fix),
      textChars: text.length,
    });
  }

  private collapseComment(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      logDebug('Collapse comment skipped: comment data not found');
      return;
    }

    data.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    logDebug('Collapsed review comment', {
      findingId: data.findingId,
      uri: data.uri.toString(),
      line: data.line,
    });
  }

  private removeThreadFromMap(uri: vscode.Uri, thread: vscode.CommentThread) {
    const key = uri.toString();
    const threads = this.threads.get(key);
    if (threads) {
      const index = threads.indexOf(thread);
      if (index > -1) {
        threads.splice(index, 1);
      }
      if (threads.length === 0) {
        this.threads.delete(key);
      }
    }
  }

  clearCommentsForFile(uri: vscode.Uri) {
    const key = uri.toString();
    const threads = this.threads.get(key);
    if (threads) {
      logDebug('Clearing review comments for file', {
        uri: key,
        threadCount: threads.length,
      });
      for (const thread of threads) {
        thread.dispose();
      }
      this.threads.delete(key);
    }
  }

  clearAllComments() {
    const threadCount = [...this.threads.values()].reduce((total, threads) => total + threads.length, 0);
    logDebug('Clearing all review comments', {
      fileCount: this.threads.size,
      threadCount,
      findingCommentCount: this.findingIdToComment.size,
    });
    for (const [, threads] of this.threads) {
      for (const thread of threads) {
        thread.dispose();
      }
    }
    this.threads.clear();
    this.findingIdToComment.clear();
  }

  dispose() {
    logDebug('Disposing review comment controller');
    this.clearAllComments();
    this.controller.dispose();
    if (this.store) {
      this.store.off('finding-updated', this.onFindingUpdated.bind(this));
      this.store.off('session-cleared', this.onSessionCleared.bind(this));
    }
  }
}
