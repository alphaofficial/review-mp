import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { logDebug } from '../settings';

export interface DiffResult {
  diff: string;
  formattedDiff: string;
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
}

interface ResolvedBranchBase {
  baseRef: string;
  baseSha: string;
  headSha: string;
  strategy: 'fork-point' | 'merge-base';
}

interface BranchBaseCandidate extends ResolvedBranchBase {
  priority: number;
  timestamp: number;
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

  private async executeGit(
    args: string[],
    token?: vscode.CancellationToken,
    options?: { trim?: boolean }
  ): Promise<string> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

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
          resolve(options?.trim === false ? stdout : stdout.trim());
        } else {
          reject(new Error(stderr || `git exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }

  private async tryExecuteGit(args: string[], token?: vscode.CancellationToken): Promise<string | null> {
    try {
      return await this.executeGit(args, token);
    } catch {
      return null;
    }
  }

  private async getCurrentBranch(token?: vscode.CancellationToken): Promise<string | null> {
    return await this.tryExecuteGit(['rev-parse', '--abbrev-ref', 'HEAD'], token);
  }

  private async getDefaultRemoteBranch(token?: vscode.CancellationToken): Promise<string | null> {
    const symbolicRef = await this.tryExecuteGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], token);
    if (!symbolicRef) {
      return null;
    }

    const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)/);
    return match ? `origin/${match[1]}` : null;
  }

  private getCandidatePriority(ref: string, defaultRemoteBranch: string | null): number {
    const normalizedRef = ref.replace(/^refs\/(heads|remotes)\//, '');
    const preferredRefs = [
      defaultRemoteBranch,
      defaultRemoteBranch?.replace(/^origin\//, ''),
      'origin/main',
      'main',
      'origin/master',
      'master',
      'origin/develop',
      'develop',
      'origin/dev',
      'dev',
      'origin/trunk',
      'trunk',
    ].filter((value): value is string => Boolean(value));

    const preferredIndex = preferredRefs.indexOf(normalizedRef);
    if (preferredIndex >= 0) {
      return preferredIndex;
    }

    return normalizedRef.startsWith('origin/') ? preferredRefs.length : preferredRefs.length + 1;
  }

  private async listCandidateBaseRefs(currentBranch: string | null, token?: vscode.CancellationToken): Promise<string[]> {
    const defaultRemoteBranch = await this.getDefaultRemoteBranch(token);
    const refsOutput = await this.tryExecuteGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      token
    );
    const discoveredRefs = refsOutput
      ?.split('\n')
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0) ?? [];

    const excludedRefs = new Set<string>(['origin/HEAD']);
    if (currentBranch) {
      excludedRefs.add(currentBranch);
      excludedRefs.add(`origin/${currentBranch}`);
    }

    const uniqueRefs = [...new Set(discoveredRefs)].filter((ref) => !excludedRefs.has(ref));
    return uniqueRefs.sort((left, right) => {
      const priorityDelta = this.getCandidatePriority(left, defaultRemoteBranch) - this.getCandidatePriority(right, defaultRemoteBranch);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.localeCompare(right);
    });
  }

  private async evaluateBranchBaseCandidate(
    ref: string,
    headSha: string,
    defaultRemoteBranch: string | null,
    token?: vscode.CancellationToken
  ): Promise<BranchBaseCandidate | null> {
    const forkPointSha = await this.tryExecuteGit(['merge-base', '--fork-point', ref, 'HEAD'], token);
    const mergeBaseSha = forkPointSha ?? await this.tryExecuteGit(['merge-base', ref, 'HEAD'], token);

    if (!mergeBaseSha || mergeBaseSha === headSha) {
      return null;
    }

    const timestampText = await this.tryExecuteGit(['show', '-s', '--format=%ct', mergeBaseSha], token);
    const timestamp = timestampText ? Number(timestampText) : 0;

    return {
      baseRef: ref,
      baseSha: mergeBaseSha,
      headSha,
      strategy: forkPointSha ? 'fork-point' : 'merge-base',
      priority: this.getCandidatePriority(ref, defaultRemoteBranch),
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    };
  }

  private async promptForBaseBranch(token?: vscode.CancellationToken): Promise<string> {
    if (token?.isCancellationRequested) {
      throw new Error('Cancelled');
    }

    const userInput = await vscode.window.showInputBox({
      prompt: 'Could not determine the branch base. Please enter the base branch name:',
      placeHolder: 'main',
      value: 'main',
    });

    return userInput || 'main';
  }

  private async resolveBranchBase(token?: vscode.CancellationToken): Promise<ResolvedBranchBase> {
    const currentBranch = await this.getCurrentBranch(token);
    const headSha = await this.executeGit(['rev-parse', 'HEAD'], token);
    const candidateRefs = await this.listCandidateBaseRefs(currentBranch, token);
    const defaultRemoteBranch = await this.getDefaultRemoteBranch(token);
    const candidates: BranchBaseCandidate[] = [];

    for (const ref of candidateRefs) {
      const candidate = await this.evaluateBranchBaseCandidate(ref, headSha, defaultRemoteBranch, token);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    candidates.sort((left, right) => {
      const timestampDelta = right.timestamp - left.timestamp;
      if (timestampDelta !== 0) {
        return timestampDelta;
      }

      const priorityDelta = left.priority - right.priority;
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.baseRef.localeCompare(right.baseRef);
    });

    if (candidates.length > 0) {
      const best = candidates[0];
      logDebug('Resolved branch review base automatically', {
        currentBranch,
        baseRef: best.baseRef,
        baseSha: best.baseSha,
        headSha,
        strategy: best.strategy,
        candidateCount: candidates.length,
        topCandidates: candidates.slice(0, 5).map((candidate) => ({
          baseRef: candidate.baseRef,
          baseSha: candidate.baseSha,
          strategy: candidate.strategy,
          timestamp: candidate.timestamp,
        })),
      });
      return best;
    }

    const promptedBaseRef = await this.promptForBaseBranch(token);
    const promptedBaseSha = await this.tryExecuteGit(['merge-base', '--fork-point', promptedBaseRef, 'HEAD'], token)
      ?? await this.executeGit(['merge-base', promptedBaseRef, 'HEAD'], token);

    const resolved = {
      baseRef: promptedBaseRef,
      baseSha: promptedBaseSha,
      headSha,
      strategy: 'merge-base' as const,
    };
    logDebug('Resolved branch review base from user input', resolved);
    return resolved;
  }

  async getDiff(
    type: 'staged' | 'uncommitted' | 'lastCommit' | 'branch',
    token?: vscode.CancellationToken
  ): Promise<DiffResult> {
    if (type === 'branch') {
      const resolvedBase = await this.resolveBranchBase(token);
      const diffOutput = await this.executeGit(['diff', resolvedBase.baseSha, resolvedBase.headSha], token, { trim: false });
      const formattedDiff = this.formatDiffWithLineNumbers(diffOutput);

      return {
        diff: diffOutput,
        formattedDiff,
        baseRef: resolvedBase.baseRef,
        baseSha: resolvedBase.baseSha,
        headSha: resolvedBase.headSha,
      };
    }

    const commands: Record<'staged' | 'uncommitted' | 'lastCommit', string[]> = {
      staged: ['diff', '--cached'],
      uncommitted: ['diff'],
      lastCommit: ['diff', 'HEAD~1', 'HEAD'],
    };
    const diffOutput = await this.executeGit(commands[type], token, { trim: false });
    const formattedDiff = this.formatDiffWithLineNumbers(diffOutput);

    return { diff: diffOutput, formattedDiff };
  }
}
