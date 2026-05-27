import * as vscode from 'vscode';

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
      return { valid: false, error: 'File path is required' };
    }

    if (line < 0) {
      return { valid: false, error: 'Line number must be non-negative' };
    }

    if (typeof fix !== 'string' || fix.trim() === '') {
      return { valid: false, error: 'Fix content is empty or invalid' };
    }

    return { valid: true };
  }

  async applyFix(
    filePath: string,
    line: number,
    fix: string,
    token?: vscode.CancellationToken
  ): Promise<FixApplicationResult> {
    const validation = await this.validateFix(filePath, line, fix);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);

      if (token?.isCancellationRequested) {
        return { success: false, error: 'Fix application cancelled' };
      }

      const lineCount = document.lineCount;
      if (line >= lineCount) {
        return { success: false, error: `Line ${line + 1} is beyond file length (${lineCount} lines)` };
      }

      const targetLine = document.lineAt(line);
      const range = new vscode.Range(
        line,
        0,
        line,
        targetLine.text.length
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, fix);

      const success = await vscode.workspace.applyEdit(edit);

      if (!success) {
        return { success: false, error: 'Failed to apply edit to workspace' };
      }

      return { success: true };
    } catch (error) {
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
        return document.lineAt(line).text;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

export function createFixApplicator(): FixApplicator {
  return new FixApplicator();
}
