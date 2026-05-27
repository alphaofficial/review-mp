import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ModelProvider, ProviderConfig } from './modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../types/review';
import { getSettings, logDebug } from '../settings';
import { buildFileReviewPrompt, buildSelectionReviewPrompt, buildDiffReviewPrompt, formatDiffWithLineNumbers } from '../harness/prompts';
import { OutputParser } from '../harness/outputParser';

export type CliOutputMode = 'text' | 'json' | 'ndjson';

export interface CustomCliConfig extends ProviderConfig {
  command?: string;
  args?: string;
  outputMode?: CliOutputMode;
  promptViaStdin?: boolean;
}

export class CustomCliProvider implements ModelProvider {
  readonly name = 'custom-cli';
  private currentProcess: ChildProcess | null = null;

  constructor(config?: CustomCliConfig) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  private config: CustomCliConfig = {
    command: '',
    args: '',
    outputMode: 'text',
    promptViaStdin: false,
  };

  private getSettings(): CustomCliConfig {
    const settings = getSettings();
    return {
      command: this.config.command || settings.customCliCommand,
      args: this.config.args || settings.customCliArgs,
      outputMode: this.config.outputMode || 'text',
      promptViaStdin: this.config.promptViaStdin || false,
    };
  }

  isAvailable(): Promise<boolean> {
    const config = this.getSettings();
    return Promise.resolve((config.command ?? '').trim().length > 0);
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
    const promptResult = request.reviewType === 'selection'
      ? buildSelectionReviewPrompt(request, request.startLine ?? 0)
      : buildFileReviewPrompt(request);

    return this.executeReview(promptResult.prompt, request.filePath, cancellationToken);
  }

  private async reviewDiff(
    request: ReviewRequest,
    cancellationToken?: vscode.CancellationToken
  ): Promise<ReviewResult> {
    if (!request.diff) {
      return { comments: [], provider: this.name };
    }

    const formattedDiff = formatDiffWithLineNumbers(request.diff);
    const promptResult = buildDiffReviewPrompt(request, formattedDiff);

    return this.executeReview(promptResult.prompt, '', cancellationToken);
  }

  private async executeReview(
    prompt: string,
    defaultFilePath: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<ReviewResult> {
    const config = this.getSettings();

    if (!config.command) {
      throw new Error('Custom CLI command not configured. Set reviewmp.customCliCommand in settings.');
    }

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(config.args ?? '', prompt);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      logDebug('CustomCliProvider: command:', config.command);
      logDebug('CustomCliProvider: args:', args);
      logDebug('CustomCliProvider: cwd:', cwd);
      logDebug('CustomCliProvider: outputMode:', config.outputMode);

      const spawnOptions: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        stdio: ('pipe' | 'ignore')[];
      } = {
        cwd,
        env: process.env,
        stdio: config.promptViaStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      };

      this.currentProcess = spawn(config.command!, args, spawnOptions);

      let stdout = '';
      let stderr = '';

      const proc = this.currentProcess;
      if (!proc) {
        reject(new Error('Failed to spawn process'));
        return;
      }

      if (config.promptViaStdin && proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const cancelHandler = () => {
        logDebug('CustomCliProvider: Cancelled by user');
        proc.kill();
        reject(new Error('Review cancelled'));
      };

      cancellationToken?.onCancellationRequested(cancelHandler);

      proc.on('close', (code, signal) => {
        logDebug('CustomCliProvider: Process closed - code:', code, 'signal:', signal);

        if (code !== 0 && code !== null) {
          reject(new Error(`Custom CLI exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseOutput(stdout, defaultFilePath, config.outputMode ?? 'text');
          logDebug('CustomCliProvider: Parsed comments:', comments.length);
          resolve({ comments, provider: this.name });
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        logDebug('CustomCliProvider: Process error:', error.message);
        reject(new Error(`Failed to start Custom CLI "${config.command}": ${error.message}`));
      });
    });
  }

  private buildArgs(argsString: string, prompt: string): string[] {
    const args: string[] = [];

    if (argsString && argsString.trim()) {
      const parsed = this.parseArgsString(argsString);
      args.push(...parsed);
    }

    if (prompt) {
      args.push(prompt);
    }

    return args;
  }

  private parseArgsString(argsString: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuotes) {
        if (current.trim()) {
          args.push(current.trim());
        }
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      args.push(current.trim());
    }

    return args;
  }

  private parseOutput(output: string, defaultFilePath: string, outputMode: CliOutputMode): ReviewComment[] {
    const parser = new OutputParser({ defaultFilePath });

    switch (outputMode) {
      case 'json':
        return parser.parseForFileReview(output);
      case 'ndjson':
        return this.parseNdJsonOutput(output, defaultFilePath);
      case 'text':
      default:
        return parser.parseForFileReview(output);
    }
  }

  private parseNdJsonOutput(output: string, defaultFilePath: string): ReviewComment[] {
    const comments: ReviewComment[] = [];

    const lines = output.trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          if (this.isValidReviewComment(parsed)) {
            comments.push(this.normalizeNdJsonComment(parsed, defaultFilePath));
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    }

    return comments;
  }

  private isValidReviewComment(item: unknown): item is Record<string, unknown> {
    return (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).line === 'number' &&
      typeof (item as Record<string, unknown>).message === 'string'
    );
  }

  private normalizeNdJsonComment(item: Record<string, unknown>, defaultFilePath: string): ReviewComment {
    return {
      file: (item.file as string) || defaultFilePath,
      line: (item.line as number) - 1,
      message: item.message as string,
      fix: typeof item.fix === 'string' ? item.fix : undefined,
      severity: this.validateSeverity(item.severity),
    };
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

  async applyFix(filePath: string, line: number, fix: string): Promise<void> {
    const prompt = `Apply the following fix to line ${line + 1} in file "${filePath}":

${fix}

Make only this specific change. Do not modify any other lines.`;

    const config = this.getSettings();

    if (!config.command) {
      throw new Error('Custom CLI command not configured. Set reviewmp.customCliCommand in settings.');
    }

    return new Promise((resolve, reject) => {
      const args = this.buildArgs(config.args ?? '', prompt);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const spawnOptions: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
        stdio: ('pipe' | 'ignore')[];
      } = {
        cwd,
        env: process.env,
        stdio: config.promptViaStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      };

      this.currentProcess = spawn(config.command!, args, spawnOptions);

      let stderr = '';

      const proc = this.currentProcess;
      if (!proc) {
        reject(new Error('Failed to spawn process'));
        return;
      }

      if (config.promptViaStdin && proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Custom CLI exited with code ${code}: ${stderr}`));
          return;
        }
        resolve();
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to start Custom CLI "${config.command}": ${error.message}`));
      });
    });
  }
}
