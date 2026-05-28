import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface DiffResult {
  diff: string;
  formattedDiff: string;
}

export class DiffContextCollector {
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
        // Skip removed lines
      } else if (line.startsWith(' ')) {
        currentLineNum++;
      } else {
        formattedLines.push(line);
      }
    }

    return formattedLines.join('\n');
  }

  private async detectBaseBranch(token?: vscode.CancellationToken): Promise<string> {
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

        const cancelHandler = () => {
          proc.kill();
          reject(new Error('Cancelled'));
        };

        token?.onCancellationRequested(cancelHandler);

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

    if (token?.isCancellationRequested) {
      throw new Error('Cancelled');
    }

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

    try {
      const symbolicRef = await execGit(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
      if (match) {
        return `origin/${match[1]}`;
      }
    } catch {
      // symbolic-ref failed
    }

    if (token?.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    const userInput = await vscode.window.showInputBox({
      prompt: 'Could not detect base branch. Please enter the base branch name:',
      placeHolder: 'main',
      value: 'main',
    });

    return userInput || 'main';
  }

  private async executeDiffCommand(
    diffCommand: string,
    token?: vscode.CancellationToken
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

      const cancelHandler = () => {
        proc.kill();
        reject(new Error('Cancelled'));
      };

      token?.onCancellationRequested(cancelHandler);

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

  async getDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch' | 'pullRequest',
    token?: vscode.CancellationToken
  ): Promise<DiffResult> {
    let diffCommand: string;

    if (type === 'branch' || type === 'pullRequest') {
      const baseBranch = await this.detectBaseBranch(token);
      diffCommand = `git diff ${baseBranch}...HEAD`;
    } else {
      const commands: Record<string, string> = {
        staged: 'git diff --cached',
        uncommitted: 'git diff',
        lastCommit: 'git diff HEAD~1 HEAD',
      };
      diffCommand = commands[type];
    }

    const diffOutput = await this.executeDiffCommand(diffCommand, token);
    const formattedDiff = this.formatDiffWithLineNumbers(diffOutput);

    return { diff: diffOutput, formattedDiff };
  }
}
