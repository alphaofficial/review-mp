import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { ReviewComment } from './comments';

interface SpawnResult {
  stdout: string;
  stderr: string;
}

type CommentValidator = (data: unknown) => ReviewComment[];

export type ReviewAgent = 'reviewmp' | 'reviewmp-design';

export class OpenCodeService {
  private resolvedOpenCodePath: string | undefined;

  private getOpenCodePath(): string {
    if (this.resolvedOpenCodePath) {
      return this.resolvedOpenCodePath;
    }

    const config = vscode.workspace.getConfiguration('reviewmp');
    const configured = config.get<string>('opencodePath');
    if (configured && configured !== 'opencode') {
      this.resolvedOpenCodePath = configured;
      return configured;
    }

    const candidates = [
      '/opt/homebrew/bin/opencode',  // macOS ARM
      '/usr/local/bin/opencode',      // macOS Intel / Linux
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.resolvedOpenCodePath = candidate;
        return candidate;
      }
    }

    // Fallback to PATH lookup
    this.resolvedOpenCodePath = 'opencode';
    return 'opencode';
  }

  private getModel(): string | undefined {
    const config = vscode.workspace.getConfiguration('reviewmp');
    const model = config.get<string>('model');
    return model && model.trim() !== '' ? model : undefined;
  }

  private getCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Spawn a process and collect stdout/stderr. Handles cancellation and cleanup.
   */
  private spawnProcess(
    command: string,
    args: string[],
    cancellationToken?: vscode.CancellationToken
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: this.getCwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          cancelDisposable?.dispose();
          fn();
        }
      };

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const cancelDisposable = cancellationToken?.onCancellationRequested(() => {
        proc.kill();
        settle(() => reject(new Error('Cancelled')));
      });

      proc.on('close', (code) => {
        settle(() => {
          if (code !== 0 && code !== null) {
            reject(new Error(`${command} exited with code ${code}: ${stderr}`));
          } else {
            resolve({ stdout, stderr });
          }
        });
      });

      proc.on('error', (error) => {
        settle(() => reject(new Error(`Failed to start ${command}: ${error.message}`)));
      });
    });
  }

  /**
   * Run opencode with the specified agent and return stdout.
   */
  private async runOpenCodeAgent(
    prompt: string,
    cancellationToken: vscode.CancellationToken,
    agent: ReviewAgent = 'reviewmp'
  ): Promise<string> {
    const args = ['run', '--agent', agent, '--format', 'json'];
    const model = this.getModel();
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);

    const result = await this.spawnProcess(this.getOpenCodePath(), args, cancellationToken);
    return result.stdout;
  }

  /**
   * Run a git command and return stdout.
   */
  private async execGit(
    args: string[],
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    const result = await this.spawnProcess('git', args, cancellationToken);
    return result.stdout.trim();
  }

  // ── Parsing ──────────────────────────────────────────────────────────

  /**
   * Collect text from NDJSON output and extract a JSON array.
   * Returns { comments, parseError } so callers can distinguish
   * "no issues" from "failed to parse".
   */
  private parseNDJSON(
    output: string,
    validator: CommentValidator
  ): { comments: ReviewComment[]; parseError: boolean } {
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

    // Try to extract JSON array from collected text
    const sources = [collectedText, output];
    for (const source of sources) {
      if (!source) {
        continue;
      }
      const jsonStr = this.extractJsonArray(source);
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          return { comments: validator(parsed), parseError: false };
        } catch {
          // continue to next source
        }
      }
    }

    // If we collected text but couldn't parse it, that's a parse error.
    // If there was no text at all, it's also a parse error (unexpected empty output).
    return { comments: [], parseError: collectedText.length > 0 || output.trim().length > 0 };
  }

  /**
   * Extract the first balanced JSON array from a string.
   * Uses bracket counting instead of greedy regex to avoid
   * matching past the actual array boundary.
   */
  private extractJsonArray(text: string): string | null {
    const start = text.indexOf('[');
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
        if (depth === 0) {
          return text.substring(start, i + 1);
        }
      }
    }

    return null;
  }

  private validateFileComments(data: unknown, filePath: string): ReviewComment[] {
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
        file: typeof item.file === 'string' ? item.file : filePath,
        line: (item.line as number) - 1,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
      }));
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

  // ── Public API ───────────────────────────────────────────────────────

  async reviewCode(
    code: string,
    languageId: string,
    filePath: string,
    cancellationToken: vscode.CancellationToken,
    agent: ReviewAgent = 'reviewmp'
  ): Promise<ReviewComment[]> {
    const prompt = this.buildReviewPrompt(code, languageId, filePath);
    const output = await this.runOpenCodeAgent(prompt, cancellationToken, agent);
    const { comments, parseError } = this.parseNDJSON(
      output,
      (data) => this.validateFileComments(data, filePath)
    );

    if (parseError && comments.length === 0) {
      console.warn('[ReviewMP] Failed to parse review output, raw length:', output.length);
      throw new Error('Failed to parse review output — the model may have returned an unexpected format');
    }

    return comments;
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

  async reviewDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    cancellationToken: vscode.CancellationToken,
    agent: ReviewAgent = 'reviewmp'
  ): Promise<ReviewComment[]> {
    let gitArgs: string[];

    if (type === 'branch') {
      const baseBranch = await this.detectBaseBranch(cancellationToken);
      gitArgs = ['diff', `${baseBranch}...HEAD`];
    } else {
      const argMap: Record<string, string[]> = {
        staged: ['diff', '--cached'],
        uncommitted: ['diff'],
        lastCommit: ['diff', 'HEAD~1', 'HEAD'],
      };
      gitArgs = argMap[type];
    }

    const diffOutput = await this.execGit(gitArgs, cancellationToken);
    const formattedDiff = this.formatDiffWithLineNumbers(diffOutput);

    const prompt = `Review the following git changes. The diff is formatted with line numbers for accurate reference:

<diff>
${formattedDiff}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff (the numbers before each line of code)
2. Include the file path for each issue (from the diff header like "diff --git a/path/to/file.ts b/path/to/file.ts")
3. Provide your review as a JSON array with required fields: file, line, message, severity
4. Ensure you understand the changes before reviewing`;

    const output = await this.runOpenCodeAgent(prompt, cancellationToken, agent);
    const { comments, parseError } = this.parseNDJSON(
      output,
      (data) => this.validateDiffComments(data)
    );

    if (parseError && comments.length === 0) {
      console.warn('[ReviewMP-Diff] Failed to parse review output, raw length:', output.length);
      throw new Error('Failed to parse review output — the model may have returned an unexpected format');
    }

    return comments;
  }

  private formatDiffWithLineNumbers(diffOutput: string): string {
    const lines = diffOutput.split('\n');
    const formattedLines: string[] = [];
    let currentLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        formattedLines.push(line);
        inHunk = false;
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
        // Removed line — don't increment counter
      } else if (line.startsWith(' ')) {
        currentLineNum++;
      } else {
        formattedLines.push(line);
      }
    }

    return formattedLines.join('\n');
  }

  private async detectBaseBranch(
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    if (cancellationToken.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    const candidates = [
      ['rev-parse', '--verify', 'main'],
      ['rev-parse', '--verify', 'origin/main'],
      ['rev-parse', '--verify', 'master'],
      ['rev-parse', '--verify', 'origin/master'],
    ];

    for (const args of candidates) {
      try {
        await this.execGit(args, cancellationToken);
        // Return the branch name (last arg)
        return args[args.length - 1];
      } catch {
        // try next
      }
    }

    // Try symbolic-ref
    try {
      const symbolicRef = await this.execGit(
        ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        cancellationToken
      );
      const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return `origin/${match[1]}`;
      }
    } catch {
      // not set
    }

    if (cancellationToken.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    const userInput = await vscode.window.showInputBox({
      prompt: 'Could not detect base branch. Please enter the base branch name:',
      placeHolder: 'main',
      value: 'main',
    });

    return userInput || 'main';
  }

  async applyFix(filePath: string, line: number, fix: string): Promise<void> {
    const prompt = `Apply the following fix to line ${line + 1} in file "${filePath}":

${fix}

Make only this specific change. Do not modify any other lines.`;

    const args = ['run', '--agent', 'reviewmp', '--format', 'json'];
    const model = this.getModel();
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);

    await this.spawnProcess(this.getOpenCodePath(), args);
  }
}
