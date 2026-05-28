import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';
import { FixApplicator, createFixApplicator } from './harness/fixApplicator';
import { ReviewFinding, ReviewSessionStore } from './store/reviewSessionStore';

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
      'reviewmp',
      'ReviewMP Comments'
    );

    this.controller.commentingRangeProvider = undefined;

    context.subscriptions.push(
      vscode.commands.registerCommand('reviewmp.acceptFix', (comment: vscode.Comment) =>
        this.acceptFix(comment)
      ),
      vscode.commands.registerCommand('reviewmp.rejectComment', (comment: vscode.Comment) =>
        this.rejectComment(comment)
      )
    );

    if (this.store) {
      this.store.on('finding-updated', this.onFindingUpdated.bind(this));
      this.store.on('session-cleared', this.onSessionCleared.bind(this));
    }
  }

  private onFindingUpdated(data: { sessionId: string; findingId: string; action: 'apply' | 'dismiss' }): void {
    const comment = this.findingIdToComment.get(data.findingId);
    if (!comment) {
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
    this.clearAllComments();
  }

  addComments(uri: vscode.Uri, findings: ReviewFinding[], languageId?: string) {
    this.clearCommentsForFile(uri);

    const threads: vscode.CommentThread[] = [];

    for (const finding of findings) {
      const range = new vscode.Range(finding.line, 0, finding.line, 0);
      const thread = this.controller.createCommentThread(uri, range, []);

      const body = this.createCommentBody(finding.message, finding.fix, languageId);

      const reviewComment: vscode.Comment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'ReviewMP' },
        contextValue: finding.fix ? 'reviewmp-with-fix' : 'reviewmp',
      };

      const commentData: CommentData = {
        uri,
        line: finding.line,
        fix: finding.fix,
        thread,
        findingId: finding.id,
      };

      this.commentDataMap.set(reviewComment, commentData);
      this.findingIdToComment.set(finding.id, reviewComment);

      thread.comments = [reviewComment];
      thread.canReply = false;
      thread.label = this.getSeverityLabel(finding.severity);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

      threads.push(thread);
    }

    this.threads.set(uri.toString(), threads);
  }

  private createCommentBody(message: string, fix?: string, languageId?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = false;

    md.appendMarkdown(message);

    if (fix) {
      md.appendMarkdown('\n\n**Suggested fix:**\n');
      md.appendCodeblock(fix, languageId || '');
    }

    return md;
  }

  private getSeverityLabel(severity?: string): string {
    switch (severity) {
      case 'error':
        return 'Error';
      case 'warning':
        return 'Warning';
      case 'info':
        return 'Info';
      case 'suggestion':
        return 'Suggestion';
      default:
        return 'Review';
    }
  }

  private async acceptFix(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      vscode.window.showWarningMessage('Comment data not found');
      return;
    }

    if (!data.fix) {
      vscode.window.showWarningMessage('No fix available for this comment');
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ReviewMP: Applying fix...',
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
    } catch (error) {
      if (error instanceof Error) {
        vscode.window.showErrorMessage(`Failed to apply fix: ${error.message}`);
      }
    }
  }

  private rejectComment(comment: vscode.Comment) {
    const data = this.commentDataMap.get(comment);
    if (!data) {
      return;
    }

    if (this.store) {
      this.store.updateFindingStatus(data.findingId, 'dismiss');
    }

    data.thread.dispose();
    this.removeThreadFromMap(data.uri, data.thread);
    this.findingIdToComment.delete(data.findingId);
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
      for (const thread of threads) {
        thread.dispose();
      }
      this.threads.delete(key);
    }
  }

  clearAllComments() {
    for (const [, threads] of this.threads) {
      for (const thread of threads) {
        thread.dispose();
      }
    }
    this.threads.clear();
    this.findingIdToComment.clear();
  }

  dispose() {
    this.clearAllComments();
    this.controller.dispose();
    if (this.store) {
      this.store.off('finding-updated', this.onFindingUpdated.bind(this));
      this.store.off('session-cleared', this.onSessionCleared.bind(this));
    }
  }
}
