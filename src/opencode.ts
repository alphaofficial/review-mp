import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ReviewComment } from './comments';



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
          const comments = this.parseReviewOutput(stdout, filePath);
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
    // Add line numbers to each line of code for unambiguous line tracking
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
          return this.validateComments(comments, filePath);
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
        return this.validateComments(comments, filePath);
      } catch {
        // Parsing failed
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

  private async executeDiffCommand(
    diffCommand: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', diffCommand], {
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
        reject(new Error('Cancelled'));
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`git exited with code ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  private formatDiffWithLineNumbers(diffOutput: string): string {
    const lines = diffOutput.split('\n');
    const formattedLines: string[] = [];
    let currentLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      // File header
      if (line.startsWith('diff --git')) {
        formattedLines.push(line);
        continue;
      }

      if (line.startsWith('---') || line.startsWith('+++')) {
        formattedLines.push(line);
        continue;
      }

      // Hunk header - extract starting line number
      if (line.startsWith('@@')) {
        formattedLines.push(line);
        inHunk = true;
        // Parse line number from hunk header: @@ -10,5 +15,7 @@
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

      // In a hunk - only include added lines, skip context and removed lines
      if (line.startsWith('+') && !line.startsWith('+++')) {
        // Added line - include with line number
        currentLineNum++;
        formattedLines.push(`${currentLineNum}: ${line.substring(1)}`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Removed line - skip it completely (being deleted)
        // Don't increment counter since this line is removed
      } else if (line.startsWith(' ')) {
        // Context line - skip it, just increment counter
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
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const execGit = (args: string[]): Promise<string> => {
      return new Promise((resolve, reject) => {
        const proc = spawn('git', args, {
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
          reject(new Error('Cancelled'));
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            reject(new Error(stderr || `git exited with code ${code}`));
          }
        });

        proc.on('error', (error) => {
          reject(error);
        });
      });
    };

    if (cancellationToken.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    // Check if 'main' exists (local or remote)
    try {
      await execGit(['rev-parse', '--verify', 'main']);
      return 'main';
    } catch {
      // main doesn't exist locally
    }

    try {
      await execGit(['rev-parse', '--verify', 'origin/main']);
      return 'origin/main';
    } catch {
      // origin/main doesn't exist
    }

    // Check if 'master' exists (local or remote)
    try {
      await execGit(['rev-parse', '--verify', 'master']);
      return 'master';
    } catch {
      // master doesn't exist locally
    }

    try {
      await execGit(['rev-parse', '--verify', 'origin/master']);
      return 'origin/master';
    } catch {
      // origin/master doesn't exist
    }

    // Try to get default branch from local ref (no network access)
    try {
      const symbolicRef = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      // Returns something like "refs/remotes/origin/main"
      const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return `origin/${match[1]}`;
      }
    } catch {
      // symbolic-ref failed (origin/HEAD not set)
    }

    if (cancellationToken.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    // Fallback: ask the user
    const userInput = await vscode.window.showInputBox({
      prompt: 'Could not detect base branch. Please enter the base branch name:',
      placeHolder: 'main',
      value: 'main',
    });

    return userInput || 'main';
  }

  async reviewDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    let diffCommand: string;

    if (type === 'branch') {
      const baseBranch = await this.detectBaseBranch(cancellationToken);
      diffCommand = `git diff ${baseBranch}...HEAD`;
    } else {
      const commands: Record<string, string> = {
        staged: 'git diff --cached',
        uncommitted: 'git diff',
        lastCommit: 'git diff HEAD~1 HEAD',
      };
      diffCommand = commands[type];
    }

    // Get the diff output
    const diffOutput = await this.executeDiffCommand(diffCommand, cancellationToken);

    // Format diff with line numbers
    const formattedDiff = this.formatDiffWithLineNumbers(diffOutput);

    // Build prompt with formatted diff
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

      const proc = spawn(opencodePath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      console.log('[ReviewMP-Diff] Started process, PID:', proc.pid);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP-Diff] stdout chunk:', chunk.substring(0, 500));
        stdout += chunk;
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP-Diff] stderr:', chunk);
        stderr += chunk;
      });

      cancellationToken.onCancellationRequested(() => {
        console.log('[ReviewMP-Diff] Cancelled');
        proc.kill();
        reject(new Error('Review cancelled'));
      });

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
