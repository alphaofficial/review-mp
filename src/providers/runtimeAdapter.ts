import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RuntimeAdapter, RuntimeManifest, NormalizedReviewResult, RuntimeSettings } from './runtimeRegistry';
import { ReviewRequest } from '../types/review';
import { buildFileReviewPrompt, buildSelectionReviewPrompt, buildDiffReviewPrompt, formatDiffWithLineNumbers } from '../harness/prompts';
import { NormalizerFactory } from './outputNormalizer';

export class CliRuntimeAdapter implements RuntimeAdapter {
  readonly manifest: RuntimeManifest;
  private currentProcess: ChildProcess | null = null;
  private cancellationToken: vscode.CancellationToken | undefined;
  private readonly workspaceRoot: string | undefined;
  private readonly model: string | undefined;
  private readonly executableOverride: string | undefined;
  private readonly extraArgs: string[] | undefined;

  constructor(
    manifest: RuntimeManifest,
    settings: RuntimeSettings,
    workspaceRoot?: string
  ) {
    this.manifest = manifest;
    this.workspaceRoot = workspaceRoot;
    this.model = settings.model;
    this.executableOverride = settings.executableOverride;
    this.extraArgs = settings.extraArgs;
  }

  async invoke(request: ReviewRequest, token?: vscode.CancellationToken): Promise<NormalizedReviewResult> {
    this.cancellationToken = token;

    const promptResult = this.buildPrompt(request);
    const executable = this.resolveExecutable();

    return this.manifest.promptTransport === 'stdin'
      ? this.invokeWithStdin(executable, promptResult.prompt, request)
      : this.invokeWithArgv(executable, promptResult.prompt, request);
  }

  async generateChangeBrief(prompt: string, token?: vscode.CancellationToken): Promise<string> {
    this.cancellationToken = token;
    const executable = this.resolveExecutable();
    const effectivePrompt = this.manifest.id === 'codex'
      ? [
          'PROMPT-ONLY MODE',
          'Use only the supplied prompt content.',
          'Do not inspect files, search the repository, or run commands.',
          '',
          prompt,
        ].join('\n')
      : prompt;

    return this.manifest.promptTransport === 'stdin'
      ? this.invokeRawWithStdin(executable, effectivePrompt)
      : this.invokeRawWithArgv(executable, effectivePrompt);
  }

  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const executable = this.resolveExecutable();
    if (this.executableOverride) {
      return this.checkExecutableExists(this.executableOverride);
    }
    return this.findOnPath(executable);
  }

  private checkExecutableExists(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private findOnPath(command: string): boolean {
    const pathValue = process.env.PATH ?? '';
    const extensions = process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

    for (const pathEntry of pathValue.split(path.delimiter)) {
      if (!pathEntry) continue;

      for (const ext of extensions) {
        const candidate = path.join(pathEntry, command + ext.toLowerCase());
        if (this.checkExecutableExists(candidate)) {
          return true;
        }
      }
    }
    return false;
  }

  private resolveExecutable(): string {
    return this.executableOverride || this.manifest.executable;
  }

  private buildPrompt(request: ReviewRequest): { prompt: string; systemGuidelines: string } {
    const promptResult = request.reviewType === 'file'
      ? buildFileReviewPrompt(request)
      : request.reviewType === 'selection'
        ? buildSelectionReviewPrompt(request, request.startLine ?? 0)
        : buildDiffReviewPrompt(request, request.diff ? formatDiffWithLineNumbers(request.diff) : '');

    if (this.manifest.id === 'codex') {
      return {
        ...promptResult,
        prompt: [
          'REVIEW-ONLY MODE',
          'Review only the supplied target and supplied supporting context.',
          'Do not inspect other files.',
          'Do not search the repository.',
          'Do not run commands or gather additional context.',
          'If the supplied material is insufficient, return no finding rather than exploring.',
          '',
          promptResult.prompt,
        ].join('\n'),
      };
    }

    return promptResult;
  }

  private async invokeWithArgv(
    executable: string,
    prompt: string,
    request: ReviewRequest
  ): Promise<NormalizedReviewResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgvArgs(prompt);

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.collectOutput(resolve, reject, request);
    });
  }

  private async invokeRawWithArgv(
    executable: string,
    prompt: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgvArgs(prompt);

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.collectRawOutput(resolve, reject);
    });
  }

  private async invokeWithStdin(
    executable: string,
    prompt: string,
    request: ReviewRequest
  ): Promise<NormalizedReviewResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildStdinArgs();

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentProcess.stdin?.write(prompt);
      this.currentProcess.stdin?.end();

      this.collectOutput(resolve, reject, request);
    });
  }

  private async invokeRawWithStdin(
    executable: string,
    prompt: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = this.buildStdinArgs();

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentProcess.stdin?.write(prompt);
      this.currentProcess.stdin?.end();

      this.collectRawOutput(resolve, reject);
    });
  }

  private buildArgvArgs(prompt: string): string[] {
    const args = this.buildBaseArgs();
    args.push(prompt);
    return args;
  }

  private buildStdinArgs(): string[] {
    return this.buildBaseArgs();
  }

  private buildBaseArgs(): string[] {
    const args: string[] = [];

    if (this.manifest.prePromptArgs && this.manifest.prePromptArgs.length > 0) {
      args.push(...this.manifest.prePromptArgs);
    }

    if (this.manifest.supportsModelOverride && this.model && this.manifest.modelArgFlag) {
      args.push(this.manifest.modelArgFlag, this.model);
    }

    if (this.manifest.workingDirectoryArgFlag && this.workspaceRoot) {
      args.push(this.manifest.workingDirectoryArgFlag, this.workspaceRoot);
    }

    if (this.extraArgs && this.extraArgs.length > 0) {
      args.push(...this.extraArgs);
    }

    return args;
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };

    // Prevent other IDE integrations from hijacking non-Claude runtimes.
    if (this.manifest.id !== 'claude') {
      for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE_CODE_')) {
          delete env[key];
        }
      }
    }

    return env;
  }

  private collectOutput(
    resolve: (result: NormalizedReviewResult) => void,
    reject: (error: Error) => void,
    request: ReviewRequest
  ): void {
    const proc = this.currentProcess;
    if (!proc) {
      reject(new Error('No process spawned'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanupDisposables: vscode.Disposable[] = [];

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }

      settled = true;
      for (const disposable of cleanupDisposables) {
        disposable.dispose();
      }
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      return true;
    };

    const cancelHandler = () => {
      if (!cleanup()) {
        return;
      }

      proc.kill();
      reject(new Error('Review cancelled'));
    };
    const cancellationSubscription = this.cancellationToken?.onCancellationRequested(cancelHandler);
    if (cancellationSubscription) {
      cleanupDisposables.push(cancellationSubscription);
    }

    proc.on('close', (code, signal) => {
      if (!cleanup()) {
        return;
      }

      if (code !== 0 && code !== null) {
        const errorOutput = stderr.trim() || stdout.trim() || 'No output';
        reject(new Error(`${this.manifest.name} exited with code ${code}: ${errorOutput}`));
        return;
      }

      try {
        const result = this.normalizeOutput(stdout, request);
        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse review output: ${error}`));
      }
    });

    proc.on('error', (error) => {
      if (!cleanup()) {
        return;
      }

      reject(new Error(`Failed to start ${this.manifest.name}: ${error.message}`));
    });
  }

  private collectRawOutput(
    resolve: (result: string) => void,
    reject: (error: Error) => void
  ): void {
    const proc = this.currentProcess;
    if (!proc) {
      reject(new Error('No process spawned'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanupDisposables: vscode.Disposable[] = [];

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }

      settled = true;
      for (const disposable of cleanupDisposables) {
        disposable.dispose();
      }
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      return true;
    };

    const cancelHandler = () => {
      if (!cleanup()) {
        return;
      }

      proc.kill();
      reject(new Error('Review cancelled'));
    };
    const cancellationSubscription = this.cancellationToken?.onCancellationRequested(cancelHandler);
    if (cancellationSubscription) {
      cleanupDisposables.push(cancellationSubscription);
    }

    proc.on('close', (code) => {
      if (!cleanup()) {
        return;
      }

      if (code !== 0 && code !== null) {
        const errorOutput = stderr.trim() || stdout.trim() || 'No output';
        reject(new Error(`${this.manifest.name} exited with code ${code}: ${errorOutput}`));
        return;
      }

      resolve(stdout.trim());
    });

    proc.on('error', (error) => {
      if (!cleanup()) {
        return;
      }

      reject(new Error(`Failed to start ${this.manifest.name}: ${error.message}`));
    });
  }

  private normalizeOutput(rawOutput: string, request: ReviewRequest): NormalizedReviewResult {
    const normalizer = NormalizerFactory.create(this.manifest.outputFormat);
    const context = {
      defaultFilePath: request.filePath,
      reviewType: request.reviewType,
    };

    const result = normalizer.normalize(rawOutput, context);

    return {
      comments: result.comments,
      rawText: result.rawText,
      metadata: {
        runtimeId: this.manifest.id,
        model: this.model,
      },
    };
  }

}
