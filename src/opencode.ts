import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ReviewComment } from './comments';

export interface DiffReviewComment extends ReviewComment {
  file: string;
}

export class OpenCodeService {
  private getOpenCodePath(): string {
    const config = vscode.workspace.getConfiguration('reviewmp');
    const configured = config.get<string>('opencodePath');
    if (configured && configured !== 'opencode') {
      return configured;
    }
    // Default paths for opencode binary
    const defaultPaths = [
      '/opt/homebrew/bin/opencode',  // macOS ARM
      '/usr/local/bin/opencode',      // macOS Intel / Linux
      'opencode',                      // fallback to PATH
    ];
    return defaultPaths[0]; // Use homebrew path as default for now
  }

  private getModel(): string | undefined {
    const config = vscode.workspace.getConfiguration('reviewmp');
    const model = config.get<string>('model');
    return model && model.trim() !== '' ? model : undefined;
  }

  async reviewCode(
    code: string,
    languageId: string,
    filePath: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    const prompt = this.buildReviewPrompt(code, languageId, filePath);

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

      // No shell - spawn directly
      // IMPORTANT: ignore stdin, otherwise opencode hangs waiting for input
      const proc = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      console.log('[ReviewMP] Process spawned, PID:', proc.pid);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP] stdout:', chunk.substring(0, 300));
        stdout += chunk;
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP] stderr:', chunk.substring(0, 300));
        stderr += chunk;
      });

      cancellationToken.onCancellationRequested(() => {
        console.log('[ReviewMP] Cancelled by user');
        proc.kill();
        reject(new Error('Review cancelled'));
      });

      proc.on('close', (code, signal) => {
        console.log('[ReviewMP] Process closed - code:', code, 'signal:', signal);
        console.log('[ReviewMP] stdout length:', stdout.length);
        
        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseReviewOutput(stdout);
          console.log('[ReviewMP] Parsed comments:', comments.length);
          resolve(comments);
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        console.log('[ReviewMP] Process error:', error.message);
        reject(new Error(`Failed to start OpenCode: ${error.message}`));
      });
    });
  }

  private buildReviewPrompt(code: string, languageId: string, filePath: string): string {
    return `Review the following ${languageId} code from file "${filePath}".

<code>
${code}
</code>

Provide your review as a JSON array of comments. Each comment should identify issues, suggest improvements, or highlight potential bugs.`;
  }

  private parseReviewOutput(output: string): ReviewComment[] {
    // OpenCode with --format json outputs newline-delimited JSON events
    // Each line is a JSON object with structure like:
    // { "type": "text", "part": { "text": "..." } }
    const lines = output.trim().split('\n');
    let collectedText = '';
    
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        
        // Look for text events - the actual content is in part.text
        if (event.type === 'text' && event.part?.text) {
          collectedText += event.part.text;
        }
      } catch {
        // Skip non-JSON lines or parsing errors
        continue;
      }
    }

    // Now parse the collected text as JSON
    if (collectedText) {
      const jsonMatch = collectedText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const comments = JSON.parse(jsonMatch[0]);
          return this.validateComments(comments);
        } catch {
          // JSON parsing failed
        }
      }
    }

    // Fallback: try to find JSON array in the raw output
    const jsonMatch = output.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const comments = JSON.parse(jsonMatch[0]);
        return this.validateComments(comments);
      } catch {
        // Parsing failed
      }
    }

    return [];
  }

  private validateComments(data: unknown): ReviewComment[] {
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
        line: (item.line as number) - 1, // Convert to 0-based line numbers
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

  async reviewDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit',
    cancellationToken: vscode.CancellationToken
  ): Promise<DiffReviewComment[]> {
    const prompts: Record<string, string> = {
      staged: 'Review the staged changes using `git diff --cached`. Analyze the changes and provide your review as a JSON array.',
      uncommitted: 'Review the uncommitted changes using `git diff`. Analyze the changes and provide your review as a JSON array.',
      lastCommit: 'Review the last commit using `git diff HEAD~1 HEAD`. Analyze the changes and provide your review as a JSON array.',
    };

    const prompt = prompts[type];

    return new Promise((resolve, reject) => {
      const opencodePath = this.getOpenCodePath();
      const model = this.getModel();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const args = ['run', '--agent', 'reviewmp-diff', '--format', 'json'];
      if (model) {
        args.push('--model', model);
      }
      args.push(prompt);

      const proc = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      cancellationToken.onCancellationRequested(() => {
        proc.kill();
        reject(new Error('Review cancelled'));
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseDiffReviewOutput(stdout);
          resolve(comments);
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to start OpenCode: ${error.message}`));
      });
    });
  }

  private parseDiffReviewOutput(output: string): DiffReviewComment[] {
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
          return this.validateDiffComments(comments);
        } catch {
          // JSON parsing failed
        }
      }
    }

    return [];
  }

  private validateDiffComments(data: unknown): DiffReviewComment[] {
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
        line: (item.line as number) - 1,
        message: item.message as string,
        file: item.file as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
      }));
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

      const proc = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
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
        reject(new Error(`Failed to start OpenCode: ${error.message}`));
      });
    });
  }
}
