import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RuntimeAdapter, RuntimeManifest, NormalizedReviewResult, RuntimeSettings } from './runtimeRegistry';
import { ReviewRequest } from '../types/review';
import { buildFileReviewPrompt, buildSelectionReviewPrompt, buildDiffReviewPrompt, formatDiffWithLineNumbers } from '../harness/prompts';
import { OutputParser } from '../harness/outputParser';

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
      console.log(`[CliRuntimeAdapter:${this.manifest.id}] Executable:`, executable);
      console.log(`[CliRuntimeAdapter:${this.manifest.id}] Prompt length:`, promptResult.prompt.length);
      console.log(`[CliRuntimeAdapter:${this.manifest.id}] Transport:`, this.manifest.promptTransport);
      console.log(`[CliRuntimeAdapter:${this.manifest.id}] Output format:`, this.manifest.outputFormat);
    }

    return this.manifest.promptTransport === 'stdin'
      ? this.invokeWithStdin(executable, promptResult.prompt, request)
      : this.invokeWithArgv(executable, promptResult.prompt, request);
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

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: process.env,
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

      this.currentProcess = spawn(executable, args, {
        cwd: this.workspaceRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.currentProcess.stdin?.write(prompt);
      this.currentProcess.stdin?.end();

      this.collectOutput(resolve, reject, request);
    });
  }

  private buildArgvArgs(prompt: string): string[] {
    const args: string[] = [];

    if (this.extraArgs && this.extraArgs.length > 0) {
      args.push(...this.extraArgs);
    }

    args.push(prompt);

    return args;
  }

  private buildStdinArgs(): string[] {
    const args: string[] = [];

    if (this.extraArgs && this.extraArgs.length > 0) {
      args.push(...this.extraArgs);
    }

    return args;
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

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const cancelHandler = () => {
      if (this.debug) {
        console.log(`[CliRuntimeAdapter:${this.manifest.id}] Cancelled`);
      }
      proc.kill();
      reject(new Error('Review cancelled'));
    };

    this.cancellationToken?.onCancellationRequested(cancelHandler);

    proc.on('close', (code, signal) => {
      if (this.debug) {
        console.log(`[CliRuntimeAdapter:${this.manifest.id}] Process closed - code:`, code, 'signal:', signal);
        console.log(`[CliRuntimeAdapter:${this.manifest.id}] stdout length:`, stdout.length);
      }

      this.cancellationToken?.onCancellationRequested(cancelHandler);

      if (code !== 0 && code !== null) {
        reject(new Error(`${this.manifest.name} exited with code ${code}: ${stderr}`));
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
      if (this.debug) {
        console.log(`[CliRuntimeAdapter:${this.manifest.id}] Process error:`, error.message);
      }
      reject(new Error(`Failed to start ${this.manifest.name}: ${error.message}`));
    });
  }

  private normalizeOutput(rawOutput: string, request: ReviewRequest): NormalizedReviewResult {
    const isDiffReview = request.reviewType !== 'file' && request.reviewType !== 'selection';

    const parser = new OutputParser({
      defaultFilePath: request.filePath,
      strictSeverityValidation: false,
    });

    const comments = isDiffReview
      ? parser.parseForDiffReview(rawOutput)
      : parser.parseForFileReview(rawOutput);

    if (this.debug && comments.length === 0) {
      console.log(`[CliRuntimeAdapter:${this.manifest.id}] No comments parsed from output:`, rawOutput.substring(0, 500));
    }

    return {
      comments,
      rawText: rawOutput,
      metadata: {
        runtimeId: this.manifest.id,
        model: this.model,
      },
    };
  }
}
