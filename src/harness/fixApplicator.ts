import * as vscode from 'vscode';
import { logDebug } from '../settings';

export interface FixValidationResult {
  valid: boolean;
  error?: string;
}

export interface FixApplicationResult {
  success: boolean;
  error?: string;
}

export class FixApplicator {
  async validateFix(filePath: string, line: number, fix: string): Promise<FixValidationResult> {
    if (!filePath || filePath.trim() === '') {
      logDebug('Fix validation failed: file path is required', { line, fixChars: typeof fix === 'string' ? fix.length : 0 });
      return { valid: false, error: 'File path is required' };
    }

    if (line < 0) {
      logDebug('Fix validation failed: line number is negative', { filePath, line });
      return { valid: false, error: 'Line number must be non-negative' };
    }

    if (typeof fix !== 'string' || fix.trim() === '') {
      logDebug('Fix validation failed: fix content is empty or invalid', { filePath, line });
      return { valid: false, error: 'Fix content is empty or invalid' };
    }

    logDebug('Fix validation succeeded', {
      filePath,
      line,
      fixChars: fix.length,
    });
    return { valid: true };
  }

  async applyFix(
    filePath: string,
    line: number,
    fix: string,
    token?: vscode.CancellationToken
  ): Promise<FixApplicationResult> {
    logDebug('Fix application started', {
      filePath,
      line,
      fixChars: fix.length,
    });
    const validation = await this.validateFix(filePath, line, fix);
    if (!validation.valid) {
      logDebug('Fix application stopped after validation failure', {
        filePath,
        line,
        error: validation.error,
      });
      return { success: false, error: validation.error };
    }

    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      logDebug('Fix application opened document', {
        filePath,
        line,
        lineCount: document.lineCount,
      });

      if (token?.isCancellationRequested) {
        logDebug('Fix application cancelled before edit', {
          filePath,
          line,
        });
        return { success: false, error: 'Fix application cancelled' };
      }

      const lineCount = document.lineCount;
      if (line >= lineCount) {
        logDebug('Fix application failed: target line beyond file length', {
          filePath,
          line,
          lineCount,
        });
        return { success: false, error: `Line ${line + 1} is beyond file length (${lineCount} lines)` };
      }

      const normalizedFix = this.normalizeFix(fix);
      const fixLines = normalizedFix.split(/\r?\n/);
      const startLine = this.findReplacementStartLine(document, line, fixLines);
      const endLine = this.findReplacementEndLine(document, startLine, fixLines);
      const targetLine = document.lineAt(endLine);
      const replacement = this.applyTargetIndentation(
        normalizedFix,
        document.lineAt(startLine).text.match(/^\s*/)?.[0] ?? ''
      );
      const range = new vscode.Range(
        startLine,
        0,
        endLine,
        targetLine.text.length
      );
      logDebug('Fix application computed replacement range', {
        filePath,
        requestedLine: line,
        startLine,
        endLine,
        fixLineCount: fixLines.length,
        replacementChars: replacement.length,
      });

      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, replacement);

      const success = await vscode.workspace.applyEdit(edit);

      if (!success) {
        logDebug('Fix application failed: workspace edit rejected', {
          filePath,
          line,
        });
        return { success: false, error: 'Failed to apply edit to workspace' };
      }

      logDebug('Fix application succeeded', {
        filePath,
        line,
        startLine,
        endLine,
      });
      return { success: true };
    } catch (error) {
      logDebug('Fix application threw', {
        filePath,
        line,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        return { success: false, error: error.message };
      }
      return { success: false, error: 'Unknown error applying fix' };
    }
  }

  async getTargetLineContent(filePath: string, line: number): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      if (line >= 0 && line < document.lineCount) {
        logDebug('Fix applicator read target line content', {
          filePath,
          line,
          lineCount: document.lineCount,
        });
        return document.lineAt(line).text;
      }
      logDebug('Fix applicator target line content unavailable: line out of range', {
        filePath,
        line,
        lineCount: document.lineCount,
      });
      return undefined;
    } catch (error) {
      logDebug('Fix applicator failed to read target line content', {
        filePath,
        line,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private normalizeFix(fix: string): string {
    const trimmed = fix.trim();
    const fencedMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
    return fencedMatch ? fencedMatch[1].trim() : trimmed;
  }

  private findReplacementStartLine(
    document: vscode.TextDocument,
    line: number,
    fixLines: string[]
  ): number {
    if (fixLines.length <= 1) {
      return line;
    }

    const firstFixLine = fixLines.find(fixLine => fixLine.trim().length > 0)?.trim();
    if (!firstFixLine) {
      return line;
    }

    const searchStart = Math.max(0, line - 2);
    const searchEnd = Math.min(document.lineCount - 1, line + 3);
    for (let candidateLine = searchStart; candidateLine <= searchEnd; candidateLine++) {
      if (document.lineAt(candidateLine).text.trim() === firstFixLine) {
        return candidateLine;
      }
    }

    return line;
  }

  private findReplacementEndLine(
    document: vscode.TextDocument,
    startLine: number,
    fixLines: string[]
  ): number {
    if (fixLines.length <= 1) {
      return startLine;
    }

    let balance = 0;
    let sawBlockDelimiter = false;
    const maxScanLine = Math.min(document.lineCount - 1, startLine + 50);

    for (let currentLine = startLine; currentLine <= maxScanLine; currentLine++) {
      const text = document.lineAt(currentLine).text;
      for (const char of text) {
        if (char === '(' || char === '[' || char === '{') {
          balance++;
          sawBlockDelimiter = true;
        } else if (char === ')' || char === ']' || char === '}') {
          balance--;
        }
      }

      const trimmed = text.trim();
      const endsStatement = trimmed.endsWith(';') || trimmed.endsWith('}') || trimmed.endsWith('],');
      if (currentLine > startLine && sawBlockDelimiter && balance <= 0 && endsStatement) {
        return currentLine;
      }
    }

    return startLine;
  }

  private applyTargetIndentation(fix: string, targetIndent: string): string {
    if (!targetIndent) {
      return fix;
    }

    const lines = fix.split(/\r?\n/);
    const firstContentLine = lines.find(line => line.trim().length > 0);
    if (!firstContentLine || /^\s/.test(firstContentLine)) {
      return fix;
    }

    return lines
      .map(line => line.trim().length > 0 ? `${targetIndent}${line}` : line)
      .join('\n');
  }
}

export function createFixApplicator(): FixApplicator {
  return new FixApplicator();
}
