import * as vscode from 'vscode';
import { ModelProvider } from './providers/modelProvider';

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
}

export class ReviewCommentController implements vscode.Disposable {
  private controller: vscode.CommentController;
  private threads: Map<string, vscode.CommentThread[]> = new Map();
  private commentDataMap: WeakMap<vscode.Comment, CommentData> = new WeakMap();
  private provider: ModelProvider;

  constructor(context: vscode.ExtensionContext, provider: ModelProvider) {
    this.provider = provider;
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
  }

  addComments(uri: vscode.Uri, comments: ReviewComment[], languageId?: string) {
    // Clear existing comments for this file
    this.clearCommentsForFile(uri);

    const threads: vscode.CommentThread[] = [];

    for (const comment of comments) {
      const range = new vscode.Range(comment.line, 0, comment.line, 0);
      const thread = this.controller.createCommentThread(uri, range, []);

      const body = this.createCommentBody(comment.message, comment.fix, languageId);
      
      const reviewComment: vscode.Comment = {
        body,
        mode: vscode.CommentMode.Preview,
        author: { name: 'ReviewMP' },
        contextValue: comment.fix ? 'reviewmp-with-fix' : 'reviewmp',
      };

      // Store data for later retrieval
      this.commentDataMap.set(reviewComment, {
        uri,
        line: comment.line,
        fix: comment.fix,
        thread,
      });

      thread.comments = [reviewComment];
      thread.canReply = false;
      thread.label = this.getSeverityLabel(comment.severity);
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
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ReviewMP: Applying fix...',
          cancellable: false,
        },
        async () => {
          if (this.provider.applyFix) {
            await this.provider.applyFix(data.uri.fsPath, data.line, data.fix!);
          } else {
            throw new Error('Fix application is not supported by the current provider');
          }
        }
      );

      // Remove the comment thread after successful application
      data.thread.dispose();
      this.removeThreadFromMap(data.uri, data.thread);

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

    data.thread.dispose();
    this.removeThreadFromMap(data.uri, data.thread);
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
  }

  dispose() {
    this.clearAllComments();
    this.controller.dispose();
  }
}
