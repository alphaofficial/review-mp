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
  private readonly debug: boolean;

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
    this.debug = settings.debug ?? false;
  }

  async invoke(request: ReviewRequest, token?: vscode.CancellationToken): Promise<NormalizedReviewResult> {
    this.cancellationToken = token;

    const promptResult = this.buildPrompt(request);
    const executable = this.resolveExecutable();

    if (this.debug) {
      this.debugLog('Preparing runtime invocation', {
        executable,
        transport: this.manifest.promptTransport,
        outputFormat: this.manifest.outputFormat,
        workspaceRoot: this.workspaceRoot,
        reviewType: request.reviewType,
        filePath: request.filePath,
        promptLength: promptResult.prompt.length,
        prePromptArgs: this.manifest.prePromptArgs ?? [],
        extraArgs: this.extraArgs ?? [],
        model: this.model || undefined,
      });
    }

    return this.manifest.promptTransport === 'stdin'
      ? this.invokeWithStdin(executable, promptResult.prompt, request)
      : this.invokeWithArgv(executable, promptResult.prompt, request);
  }

  cancel(): void {
    if (this.currentProcess) {
      this.debugLog('Cancelling runtime process', {
        pid: this.currentProcess.pid,
      });
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
    if (request.reviewType === 'file') {
      return buildFileReviewPrompt(request);
    } else if (request.reviewType === 'selection') {
      return buildSelectionReviewPrompt(request, request.startLine ?? 0);
    } else {
      const formattedDiff = request.diff ? formatDiffWithLineNumbers(request.diff) : '';
      return buildDiffReviewPrompt(request, formattedDiff);
    }
  }

  private async invokeWithArgv(
    executable: string,
    prompt: string,
    request: ReviewRequest
  ): Promise<NormalizedReviewResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgvArgs(prompt);
      this.debugLog('Spawning argv runtime', {
        executable,
        args,
        cwd: this.workspaceRoot,
      });

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.collectOutput(resolve, reject, request);
    });
  }

  private async invokeWithStdin(
    executable: string,
    prompt: string,
    request: ReviewRequest
  ): Promise<NormalizedReviewResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildStdinArgs();
      this.debugLog('Spawning stdin runtime', {
        executable,
        args,
        cwd: this.workspaceRoot,
        promptLength: prompt.length,
      });

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: this.buildChildEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.debugLog('Writing prompt to stdin', {
        executable,
        promptLength: prompt.length,
      });
      this.currentProcess.stdin?.write(prompt);
      this.currentProcess.stdin?.end();

      this.collectOutput(resolve, reject, request);
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
    let stdoutChunks = 0;
    let stderrChunks = 0;
    const startedAt = Date.now();
    let settled = false;
    const heartbeat = setInterval(() => {
      this.debugLog('Runtime still running', {
        pid: proc.pid,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutChunks,
        stderrChunks,
      });
    }, 5000);
    heartbeat.unref();
    let cancellationSubscription: vscode.Disposable | undefined;

    this.debugLog('Runtime process started', {
      pid: proc.pid,
    });

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
      stdoutChunks++;
      this.debugLog('Received stdout chunk', {
        pid: proc.pid,
        chunkBytes: data.length,
        totalStdoutBytes: stdout.length,
        stdoutChunks,
      });
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      stderrChunks++;
      this.debugLog('Received stderr chunk', {
        pid: proc.pid,
        chunkBytes: data.length,
        totalStderrBytes: stderr.length,
        stderrChunks,
        preview: data.toString().slice(0, 200),
      });
    });

    const cleanup = (): boolean => {
      if (settled) {
        return false;
      }

      settled = true;
      clearInterval(heartbeat);
      cancellationSubscription?.dispose();
      if (this.currentProcess === proc) {
        this.currentProcess = null;
      }
      return true;
    };

    const cancelHandler = () => {
      if (!cleanup()) {
        return;
      }

      this.debugLog('Runtime cancelled', {
        pid: proc.pid,
        elapsedMs: Date.now() - startedAt,
      });
      proc.kill();
      reject(new Error('Review cancelled'));
    };
    cancellationSubscription = this.cancellationToken?.onCancellationRequested(cancelHandler);

    proc.on('close', (code, signal) => {
      if (!cleanup()) {
        return;
      }

      this.debugLog('Runtime process closed', {
        pid: proc.pid,
        code,
        signal,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutChunks,
        stderrChunks,
      });

      if (code !== 0 && code !== null) {
        const errorOutput = stderr.trim() || stdout.trim() || 'No output';
        reject(new Error(`${this.manifest.name} exited with code ${code}: ${errorOutput}`));
        return;
      }

      try {
        const result = this.normalizeOutput(stdout, request);
        this.debugLog('Runtime output normalized', {
          pid: proc.pid,
          comments: result.comments.length,
        });
        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse review output: ${error}`));
      }
    });

    proc.on('error', (error) => {
      if (!cleanup()) {
        return;
      }

      this.debugLog('Runtime process error', {
        pid: proc.pid,
        message: error.message,
        elapsedMs: Date.now() - startedAt,
      });
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

  private debugLog(message: string, data?: unknown): void {
    if (!this.debug) {
      return;
    }

    const timestamp = new Date().toISOString();
    if (data === undefined) {
      console.log(`[ReviewMP DEBUG ${timestamp}] [RuntimeAdapter:${this.manifest.id}] ${message}`);
      return;
    }

    console.log(`[ReviewMP DEBUG ${timestamp}] [RuntimeAdapter:${this.manifest.id}] ${message}`, data);
  }
}
