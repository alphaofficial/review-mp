import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ReviewComment } from './comments';

interface FileChunk {
  file: string;
  diff: string;
}

interface PRInfo {
  number: number;
  baseBranch: string;
  headBranch: string;
  title: string;
}

export interface PRReviewResult {
  comments: ReviewComment[];
  /** When true, comments target remote files (may not exist locally). */
  isRemote: boolean;
}

interface HunkRange {
  startLine: number;
  endLine: number;
}

interface PatchLineRange {
  oldHunk: HunkRange;
  newHunk: HunkRange;
}

interface ParsedPatch {
  oldHunk: string;
  newHunk: string;
  range: PatchLineRange;
}

const CHAR_BUDGET = 30_000;

export class PRReviewService {
  private getOpenCodePath(): string {
    const config = vscode.workspace.getConfiguration('reviewmp');
    const configured = config.get<string>('opencodePath');
    if (configured && configured !== 'opencode') {
      return configured;
    }
    return 'opencode';
  }

  private getModel(): string | undefined {
    const config = vscode.workspace.getConfiguration('reviewmp');
    const model = config.get<string>('model');
    return model && model.trim() !== '' ? model : undefined;
  }

  // ─── Patch Splitting & Parsing (CodeRabbit approach) ───────────────

  /**
   * Split a file's diff into individual hunk strings, each starting with `@@`.
   */
  private splitPatch(patch: string): string[] {
    const hunks: string[] = [];
    const lines = patch.split('\n');
    let current: string[] = [];

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (current.length > 0) {
          hunks.push(current.join('\n'));
        }
        current = [line];
      } else if (current.length > 0) {
        current.push(line);
      }
      // skip lines before the first @@
    }

    if (current.length > 0) {
      hunks.push(current.join('\n'));
    }

    return hunks;
  }

  /**
   * Extract line number ranges from a hunk header `@@ -old,count +new,count @@`.
   */
  private patchStartEndLine(patch: string): PatchLineRange | null {
    const headerMatch = patch.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/
    );
    if (!headerMatch) {
      return null;
    }

    const oldStart = parseInt(headerMatch[1], 10);
    const oldCount = parseInt(headerMatch[2] ?? '1', 10);
    const newStart = parseInt(headerMatch[3], 10);
    const newCount = parseInt(headerMatch[4] ?? '1', 10);

    return {
      oldHunk: {
        startLine: oldStart,
        endLine: oldStart + Math.max(oldCount - 1, 0),
      },
      newHunk: {
        startLine: newStart,
        endLine: newStart + Math.max(newCount - 1, 0),
      },
    };
  }

  /**
   * Parse a single hunk into newHunk (with line numbers) and oldHunk (context).
   * Skips line number annotations for first 3 and last 3 context lines.
   */
  private parsePatch(patch: string): ParsedPatch | null {
    const range = this.patchStartEndLine(patch);
    if (!range) {
      return null;
    }

    const lines = patch.split('\n');
    // Skip the @@ header line
    const bodyLines = lines.slice(1);

    const newLines: string[] = [];
    const oldLines: string[] = [];

    let newLineNum = range.newHunk.startLine;
    let oldLineNum = range.oldHunk.startLine;

    // Track context line indices for noise reduction
    const contextIndices: number[] = [];
    bodyLines.forEach((line, idx) => {
      if (!line.startsWith('+') && !line.startsWith('-')) {
        contextIndices.push(idx);
      }
    });

    // First 3 and last 3 context lines should skip line number annotations
    const skipAnnotation = new Set<number>();
    for (let i = 0; i < Math.min(3, contextIndices.length); i++) {
      skipAnnotation.add(contextIndices[i]);
    }
    for (let i = Math.max(0, contextIndices.length - 3); i < contextIndices.length; i++) {
      skipAnnotation.add(contextIndices[i]);
    }

    bodyLines.forEach((line, idx) => {
      if (line.startsWith('+')) {
        // Added line — always include line number
        newLines.push(`${newLineNum}: ${line.substring(1)}`);
        newLineNum++;
      } else if (line.startsWith('-')) {
        // Removed line
        oldLines.push(line.substring(1));
        oldLineNum++;
      } else {
        // Context line
        if (skipAnnotation.has(idx)) {
          newLines.push(line);
        } else {
          newLines.push(`${newLineNum}: ${line}`);
        }
        oldLines.push(line);
        newLineNum++;
        oldLineNum++;
      }
    });

    return {
      oldHunk: oldLines.join('\n'),
      newHunk: newLines.join('\n'),
      range,
    };
  }

  // ─── File Review ───────────────────────────────────────────────────

  /**
   * Review a single file by packing its parsed hunks into a prompt.
   */
  private async reviewFile(
    filename: string,
    patches: ParsedPatch[],
    prInfo: PRInfo,
    allFiles: string[],
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    if (patches.length === 0) {
      return [];
    }

    const otherFiles = allFiles.filter(f => f !== filename);

    // Build change sections, respecting char budget
    let changeSections = '';
    for (const patch of patches) {
      const section = `---new_hunk---
\`\`\`
${patch.newHunk}
\`\`\`
---old_hunk---
\`\`\`
${patch.oldHunk}
\`\`\`
---end_change_section---
`;
      if (changeSections.length + section.length > CHAR_BUDGET) {
        break;
      }
      changeSections += section + '\n';
    }

    const prompt = `Review the changes in "${filename}" from PR #${prInfo.number} "${prInfo.title}".
Other files changed in this PR: ${otherFiles.join(', ')}

Each change section has the new code (with line numbers) and the old code for context.

<changes>
${changeSections}
</changes>

Return your review as a JSON array. Each element must have these fields:
- "file": always "${filename}"
- "startLine": first line number of the issue (from new_hunk line numbers)
- "endLine": last line number of the issue
- "line": same as startLine
- "message": description of the issue
- "severity": one of "error", "warning", "info", "suggestion"
- "fix": (optional) suggested replacement code

Rules:
- Use line numbers from the new_hunk sections only
- Focus on bugs, logic errors, security issues, missing error handling
- Do NOT comment on style, formatting, or minor naming issues
- Do NOT flag missing files/components that may exist in other PR files
- If the changes look good, respond with an empty array: []`;

    const comments = await this.executeReview(prompt, cancellationToken);
    return this.clampCommentLines(comments, patches);
  }

  // ─── Line Clamping ─────────────────────────────────────────────────

  /**
   * If a comment's line falls outside all hunk ranges, snap it to the nearest valid range.
   */
  private clampCommentLines(
    comments: ReviewComment[],
    patches: ParsedPatch[]
  ): ReviewComment[] {
    if (patches.length === 0) {
      return comments;
    }

    return comments.map(comment => {
      const line1 = comment.line + 1; // convert back to 1-based for comparison

      // Check if line falls within any patch's new hunk range
      const inRange = patches.some(
        p => line1 >= p.range.newHunk.startLine && line1 <= p.range.newHunk.endLine
      );

      if (inRange) {
        return comment;
      }

      // Find nearest patch
      let bestPatch = patches[0];
      let bestDist = Infinity;

      for (const patch of patches) {
        const distToStart = Math.abs(line1 - patch.range.newHunk.startLine);
        const distToEnd = Math.abs(line1 - patch.range.newHunk.endLine);
        const dist = Math.min(distToStart, distToEnd);
        if (dist < bestDist) {
          bestDist = dist;
          bestPatch = patch;
        }
      }

      // Clamp to the nearest patch range
      const clamped = Math.max(
        bestPatch.range.newHunk.startLine,
        Math.min(line1, bestPatch.range.newHunk.endLine)
      );

      return {
        ...comment,
        line: clamped - 1, // back to 0-based
        message: comment.message + `\n\n_(Line remapped from ${line1} to ${clamped} to match diff range)_`,
      };
    });
  }

  // ─── Main Entry Point ─────────────────────────────────────────────

  /**
   * Main entry point: review a PR by number or auto-detect from current branch.
   */
  async reviewPR(
    prNumber: number | undefined,
    cancellationToken: vscode.CancellationToken
  ): Promise<PRReviewResult> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      throw new Error('No workspace folder open');
    }

    // Step 1: Resolve PR info
    const prInfo = prNumber
      ? await this.getPRInfo(prNumber, cwd, cancellationToken)
      : await this.detectPRFromBranch(cwd, cancellationToken);

    // Determine if we're on the PR's branch or reviewing remotely
    const originalBranch = (
      await this.execCommand(['git', 'branch', '--show-current'], cwd, cancellationToken)
    ).trim();

    const prBranch = prInfo.headBranch.replace(/^origin\//, '');
    const needsBranchSwitch = !!prNumber && originalBranch !== prBranch;
    let didStash = false;

    if (needsBranchSwitch) {
      console.log(`[ReviewMP-PR] Switching to branch "${prBranch}" for review (currently on "${originalBranch}")...`);

      // Stash uncommitted changes if any
      const statusOutput = await this.execCommand(['git', 'status', '--porcelain'], cwd, cancellationToken);
      if (statusOutput.trim()) {
        console.log('[ReviewMP-PR] Stashing uncommitted changes...');
        await this.execCommand(['git', 'stash'], cwd, cancellationToken);
        didStash = true;
      }

      // Checkout the PR branch
      try {
        await this.execCommand(['git', 'checkout', prBranch], cwd, cancellationToken);
      } catch {
        console.log(`[ReviewMP-PR] Local checkout failed, fetching from origin...`);
        await this.execCommand(
          ['git', 'fetch', 'origin', prBranch],
          cwd,
          cancellationToken
        );
        await this.execCommand(['git', 'checkout', prBranch], cwd, cancellationToken);
      }
      console.log(`[ReviewMP-PR] Now on branch "${prBranch}"`);
    }

    try {
      const isRemote = false;

      console.log(`[ReviewMP-PR] Reviewing PR #${prInfo.number}: ${prInfo.title}`);
      console.log(`[ReviewMP-PR] ${prInfo.baseBranch} <- ${prInfo.headBranch}`);

      // Step 2: Get the diff
      const diffOutput = await this.execCommand(
        ['git', 'diff', `${prInfo.baseBranch}...HEAD`, '-U8'],
        cwd,
        cancellationToken
      );

      if (!diffOutput.trim()) {
        return { comments: [], isRemote };
      }

      // Step 3: Split by file
      const fileChunks = this.splitDiffByFile(diffOutput);
      const allFiles = fileChunks.map(c => c.file);
      console.log(`[ReviewMP-PR] ${fileChunks.length} file(s) changed`);

      // Step 4: For each file, split into hunks, parse, and review
      const allComments: ReviewComment[] = [];
      const concurrency = 4;

      for (let i = 0; i < fileChunks.length; i += concurrency) {
        if (cancellationToken.isCancellationRequested) {
          break;
        }

        const batch = fileChunks.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(chunk => {
            // Split into hunks, parse each
            const rawHunks = this.splitPatch(chunk.diff);
            const parsedPatches: ParsedPatch[] = [];
            for (const hunk of rawHunks) {
              const parsed = this.parsePatch(hunk);
              if (parsed) {
                parsedPatches.push(parsed);
              }
            }
            return this.reviewFile(
              chunk.file,
              parsedPatches,
              prInfo,
              allFiles,
              cancellationToken
            );
          })
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            allComments.push(...result.value);
          } else {
            console.log('[ReviewMP-PR] File review failed:', result.reason);
          }
        }
      }

      // Step 5: Dedup nearby comments
      const dedupedComments = this.deduplicateComments(allComments);
      console.log(`[ReviewMP-PR] Dedup: ${allComments.length} -> ${dedupedComments.length} comments`);

      if (needsBranchSwitch) {
        console.log(`[ReviewMP-PR] Staying on branch "${prBranch}" for review. Switch back manually when done.`);
        if (didStash) {
          console.log(`[ReviewMP-PR] Note: you have stashed changes on "${originalBranch}". Run "git checkout ${originalBranch} && git stash pop" to restore.`);
        }
      }

      return { comments: dedupedComments, isRemote };
  }

  // ─── PR Detection ──────────────────────────────────────────────────

  private async getPRInfo(
    prNumber: number,
    cwd: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<PRInfo> {
    const json = await this.execCommand(
      ['gh', 'pr', 'view', String(prNumber), '--json', 'number,title,baseRefName,headRefName'],
      cwd,
      cancellationToken
    );

    const data = JSON.parse(json);

    // Ensure we have the remote branches fetched
    await this.execCommand(
      ['git', 'fetch', 'origin', data.baseRefName, data.headRefName],
      cwd,
      cancellationToken
    ).catch(() => {});

    return {
      number: data.number,
      baseBranch: `origin/${data.baseRefName}`,
      headBranch: `origin/${data.headRefName}`,
      title: data.title,
    };
  }

  private async detectPRFromBranch(
    cwd: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<PRInfo> {
    try {
      const json = await this.execCommand(
        ['gh', 'pr', 'view', '--json', 'number,title,baseRefName,headRefName'],
        cwd,
        cancellationToken
      );

      const data = JSON.parse(json);
      return {
        number: data.number,
        baseBranch: `origin/${data.baseRefName}`,
        headBranch: 'HEAD',
        title: data.title,
      };
    } catch {
      const currentBranch = (
        await this.execCommand(['git', 'branch', '--show-current'], cwd, cancellationToken)
      ).trim();

      const baseBranch = await this.detectBaseBranch(cwd, cancellationToken);

      return {
        number: 0,
        baseBranch,
        headBranch: 'HEAD',
        title: `Branch: ${currentBranch}`,
      };
    }
  }

  private async detectBaseBranch(
    cwd: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      try {
        await this.execCommand(
          ['git', 'rev-parse', '--verify', candidate],
          cwd,
          cancellationToken
        );
        return candidate;
      } catch {
        continue;
      }
    }

    const input = await vscode.window.showInputBox({
      prompt: 'Could not detect base branch. Enter the base branch:',
      placeHolder: 'main',
      value: 'main',
    });

    return input || 'main';
  }

  // ─── Diff Splitting ────────────────────────────────────────────────

  private splitDiffByFile(diffOutput: string): FileChunk[] {
    const chunks: FileChunk[] = [];
    const lines = diffOutput.split('\n');
    let currentFile = '';
    let currentLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile && currentLines.length > 0) {
          chunks.push({ file: currentFile, diff: currentLines.join('\n') });
        }
        const match = line.match(/diff --git a\/.+ b\/(.+)/);
        currentFile = match ? match[1] : '';
        currentLines = [line];
      } else {
        currentLines.push(line);
      }
    }

    if (currentFile && currentLines.length > 0) {
      chunks.push({ file: currentFile, diff: currentLines.join('\n') });
    }

    return chunks;
  }

  // ─── OpenCode Execution ────────────────────────────────────────────

  private executeReview(
    prompt: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
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

      console.log('[ReviewMP-PR] Started review process, PID:', proc.pid);

      const timeout = setTimeout(() => {
        console.log('[ReviewMP-PR] Timed out after 120s');
        proc.kill();
        resolve([]);
      }, 120_000);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        console.log('[ReviewMP-PR] stderr:', chunk.substring(0, 300));
        stderr += chunk;
      });

      cancellationToken.onCancellationRequested(() => {
        clearTimeout(timeout);
        proc.kill();
        reject(new Error('Review cancelled'));
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0 && code !== null) {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const comments = this.parseOutput(stdout);
          console.log('[ReviewMP-PR] Parsed comments:', comments.length);
          resolve(comments);
        } catch (error) {
          reject(new Error(`Failed to parse review output: ${error}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start OpenCode: ${error.message}`));
      });
    });
  }

  // ─── Output Parsing ────────────────────────────────────────────────

  private parseOutput(output: string): ReviewComment[] {
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
          return this.validateComments(JSON.parse(jsonMatch[0]));
        } catch {
          // Fall through
        }
      }
    }

    // Fallback: raw output
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return this.validateComments(JSON.parse(jsonMatch[0]));
      } catch {}
    }

    return [];
  }

  private validateComments(data: unknown): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).message === 'string' &&
          typeof (item as Record<string, unknown>).file === 'string' &&
          (typeof (item as Record<string, unknown>).line === 'number' ||
           typeof (item as Record<string, unknown>).startLine === 'number')
      )
      .map(item => ({
        file: item.file as string,
        line: ((item.startLine as number | undefined) ?? (item.line as number)) - 1,
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

  // ─── Deduplication ──────────────────────────────────────────────────

  private deduplicateComments(comments: ReviewComment[]): ReviewComment[] {
    const severityRank: Record<string, number> = {
      error: 4,
      warning: 3,
      suggestion: 2,
      info: 1,
    };

    // Group by file
    const byFile = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      if (!byFile.has(comment.file)) {
        byFile.set(comment.file, []);
      }
      byFile.get(comment.file)!.push(comment);
    }

    const result: ReviewComment[] = [];

    for (const fileComments of byFile.values()) {
      fileComments.sort((a, b) => a.line - b.line);

      const merged: ReviewComment[] = [];
      for (const comment of fileComments) {
        const nearby = merged.find(
          m => Math.abs(m.line - comment.line) <= 3
        );

        if (nearby) {
          nearby.message = `${nearby.message}\n\n---\n\n${comment.message}`;
          const nearbyRank = severityRank[nearby.severity || 'info'] || 0;
          const commentRank = severityRank[comment.severity || 'info'] || 0;
          if (commentRank > nearbyRank) {
            nearby.severity = comment.severity;
          }
          if (!nearby.fix && comment.fix) {
            nearby.fix = comment.fix;
          }
        } else {
          merged.push({ ...comment });
        }
      }

      result.push(...merged);
    }

    return result;
  }

  // ─── Utilities ─────────────────────────────────────────────────────

  private execCommand(
    args: string[],
    cwd: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(args[0], args.slice(1), {
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
        if (code === 0 || code === null) {
          resolve(stdout);
        } else {
          reject(new Error(`${args[0]} exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
