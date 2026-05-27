import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ModelProvider, ProviderConfig } from './modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../types/review';
import { getOpenCodeMissingErrorMessage, resolveOpenCodePath } from '../opencodePath';

export class OpenCodeProvider implements ModelProvider {
  readonly name = 'opencode';
  private currentProcess: ChildProcess | null = null;
  private config: ProviderConfig = {};

  constructor(config?: ProviderConfig) {
    if (config) {
      this.config = config;
    }
  }

  private getOpenCodePath(): string {
    const configuredPath = this.config.opencodePath;
    return resolveOpenCodePath({ configuredPath });
  }

  private getModel(): string | undefined {
    const model = this.config.model;
    return model && model.trim() !== '' ? model : undefined;
  }

  private getOpenCodeStartupError(error: Error, opencodePath: string): Error {
    return new Error(
      `Failed to start OpenCode at "${opencodePath}". ${getOpenCodeMissingErrorMessage()} Original error: ${error.message}`
    );
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  async review(request: ReviewRequest, token?: vscode.CancellationToken): Promise<ReviewResult> {
    if (request.reviewType === 'file' || request.reviewType === 'selection') {
      return this.reviewCode(request, token);
    } else {
      return this.reviewDiff(request, token);
    }
  }

  private async reviewCode(
    request: ReviewRequest,
    cancellationToken?: vscode.CancellationToken
  ): Promise<ReviewResult> {
    const prompt = this.buildReviewPrompt(request.code, request.languageId, request.filePath);

    return new Promise((resolve, reject) => {
      const opencodePath = this.getOpenCodePath();
      const model = this.getModel();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const args = ['run', '--agent', 'reviewmp', '--format', 'json'];
      if (model) {
        args.push('--model', model);
      }
      args.push(prompt);

      console.log('[ReviewMP] OpenCode path:', opencodePath);
      console.log('[ReviewMP] Prompt length:', prompt.length);
      console.log('[ReviewMP] CWD:', cwd);

      this.currentProcess = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      console.log('[ReviewMP] Process spawned, PID:', this.currentProcess.pid);

      let stdout = '';
      let stderr = '';

      const proc = this.currentProcess;

      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP] stdout:', chunk.substring(0, 300));
        stdout += chunk;
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP] stderr:', chunk.substring(0, 300));
        stderr += chunk;
      });

      const cancelHandler = () => {
        console.log('[ReviewMP] Cancelled by user');
        proc.kill();
        reject(new Error('Review cancelled'));
      };

      cancellationToken?.onCancellationRequested(cancelHandler);

      proc.on('close', (code, signal) => {
        console.log('[ReviewMP] Process closed - code:', code, 'signal:', signal);
        console.log('[ReviewMP] stdout length:', stdout.length);
        cancellationToken?.onCancellationRequested(cancelHandler);

        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseReviewOutput(stdout, request.filePath);
          console.log('[ReviewMP] Parsed comments:', comments.length);
          resolve({ comments, provider: this.name });
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        console.log('[ReviewMP] Process error:', error.message);
        reject(this.getOpenCodeStartupError(error, opencodePath));
      });
    });
  }

  private buildReviewPrompt(code: string, languageId: string, filePath: string): string {
    const lines = code.split('\n');
    const numberedCode = lines
      .map((line, index) => `${index + 1}: ${line}`)
      .join('\n');

    return `Review the following ${languageId} code from file "${filePath}".

<code>
${numberedCode}
</code>

The code is prefixed with line numbers (1-based). When reporting issues, use the line numbers shown in the code.

Provide your review as a JSON array of comments. Understand the entire code before reviewing. Each comment should identify issues, suggest improvements, or highlight potential bugs.`;
  }

  private parseReviewOutput(output: string, filePath: string): ReviewComment[] {
    const lines = output.trim().split('\n');
    let collectedText = '';

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'text' && event.part?.text) {
          collectedText += event.part.text;
        }
      } catch {
        continue;
      }
    }

    if (collectedText) {
      const jsonMatch = collectedText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const comments = JSON.parse(jsonMatch[0]);
          return this.validateComments(comments, filePath);
        } catch {
          // JSON parse failed, fall through to try raw output
        }
      }
    }

    const jsonMatch = output.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const comments = JSON.parse(jsonMatch[0]);
        return this.validateComments(comments, filePath);
      } catch {
        // JSON parse failed, return empty
      }
    }

    return [];
  }

  private validateComments(data: unknown, filePath: string): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item): item is Record<string, unknown> => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string'
        );
      })
      .map((item) => ({
        file: filePath,
        line: (item.line as number) - 1,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
      }));
  }

  private validateSeverity(
    severity: unknown
  ): 'error' | 'warning' | 'info' | 'suggestion' | undefined {
    if (
      severity === 'error' ||
      severity === 'warning' ||
      severity === 'info' ||
      severity === 'suggestion'
    ) {
      return severity;
    }
    return undefined;
  }

  private async reviewDiff(
    request: ReviewRequest,
    cancellationToken?: vscode.CancellationToken
  ): Promise<ReviewResult> {
    if (!request.diff) {
      return { comments: [], provider: this.name };
    }

    const formattedDiff = this.formatDiffWithLineNumbers(request.diff);

    const prompt = `Review the following git changes. The diff is formatted with line numbers for accurate reference:

<diff>
${formattedDiff}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff (the numbers before each line of code)
2. Include the file path for each issue (from the diff header like "diff --git a/path/to/file.ts b/path/to/file.ts")
3. Provide your review as a JSON array with required fields: file, line, message, severity
4. Ensure you understand the changes before reviewing`;

    return new Promise((resolve, reject) => {
      const opencodePath = this.getOpenCodePath();
      const model = this.getModel();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const args = ['run', '--agent', 'reviewmp', '--format', 'json'];
      if (model) {
        args.push('--model', model);
      }
      args.push(prompt);

      this.currentProcess = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      console.log('[ReviewMP-Diff] Started process, PID:', this.currentProcess.pid);

      let stdout = '';
      let stderr = '';

      const proc = this.currentProcess;

      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP-Diff] stdout chunk:', chunk.substring(0, 500));
        stdout += chunk;
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP-Diff] stderr:', chunk);
        stderr += chunk;
      });

      const cancelHandler = () => {
        console.log('[ReviewMP-Diff] Cancelled');
        proc.kill();
        reject(new Error('Review cancelled'));
      };

      cancellationToken?.onCancellationRequested(cancelHandler);

      proc.on('close', (code) => {
        console.log('[ReviewMP-Diff] Process closed, code:', code);
        console.log('[ReviewMP-Diff] stdout length:', stdout.length);

        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseDiffReviewOutput(stdout);
          console.log('[ReviewMP-Diff] Parsed comments:', comments.length);
          resolve({ comments, provider: this.name });
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        reject(this.getOpenCodeStartupError(error, opencodePath));
      });
    });
  }

  private parseDiffReviewOutput(output: string): ReviewComment[] {
    const lines = output.trim().split('\n');
    let collectedText = '';

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'text' && event.part?.text) {
          collectedText += event.part.text;
        }
      } catch {
        continue;
      }
    }

    console.log('[ReviewMP-Diff] Collected text:', collectedText.substring(0, 1000));

    if (collectedText) {
      const jsonMatch = collectedText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        console.log('[ReviewMP-Diff] Found JSON match:', jsonMatch[0].substring(0, 500));
        try {
          const comments = JSON.parse(jsonMatch[0]);
          console.log('[ReviewMP-Diff] Parsed JSON, items:', comments.length);
          return this.validateDiffComments(comments);
        } catch (e) {
          console.log('[ReviewMP-Diff] JSON parse error:', e);
        }
      } else {
        console.log('[ReviewMP-Diff] No JSON array found in collected text');
      }
    } else {
      console.log('[ReviewMP-Diff] No text collected from output');
    }

    return [];
  }

  private validateDiffComments(data: unknown): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item): item is Record<string, unknown> => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string' &&
          typeof (item as Record<string, unknown>).file === 'string'
        );
      })
      .map((item) => ({
        file: item.file as string,
        line: (item.line as number) - 1,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
      }));
  }

  private formatDiffWithLineNumbers(diffOutput: string): string {
    const lines = diffOutput.split('\n');
    const formattedLines: string[] = [];
    let currentLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('---') || line.startsWith('+++')) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('@@')) {
        formattedLines.push(line);
        inHunk = true;
        const match = line.match(/\+(\d+)/);
        if (match) {
          currentLineNum = parseInt(match[1], 10) - 1;
        }
        continue;
      }

      if (!inHunk) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentLineNum++;
        formattedLines.push(`${currentLineNum}: ${line.substring(1)}`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Removed line - skip it (being deleted)
      } else if (line.startsWith(' ')) {
        currentLineNum++;
      } else {
        formattedLines.push(line);
      }
    }

    return formattedLines.join('\n');
  }

  async applyFix(filePath: string, line: number, fix: string): Promise<void> {
    const prompt = `Apply the following fix to line ${line + 1} in file "${filePath}":

${fix}

Make only this specific change. Do not modify any other lines.`;

    return new Promise((resolve, reject) => {
      const opencodePath = this.getOpenCodePath();
      const model = this.getModel();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const args = ['run'];
      if (model) {
        args.push('--model', model);
      }
      args.push(prompt);

      this.currentProcess = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      const proc = this.currentProcess;

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }
        resolve();
      });

      proc.on('error', (error) => {
        reject(this.getOpenCodeStartupError(error, opencodePath));
      });
    });
  }
}