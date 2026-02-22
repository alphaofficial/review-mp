import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ReviewComment } from './comments';
import * as path from 'path';

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
      // After branch switch, files are local — isRemote is false
      const isRemote = false;

      console.log(`[ReviewMP-PR] Reviewing PR #${prInfo.number}: ${prInfo.title}`);
      console.log(`[ReviewMP-PR] ${prInfo.baseBranch} <- ${prInfo.headBranch}`);

      // Step 2: Get the diff (always use HEAD since we're on the correct branch now)
      const diffTarget = 'HEAD';
      const diffOutput = await this.execCommand(
        ['git', 'diff', `${prInfo.baseBranch}...${diffTarget}`, '-U8'],
        cwd,
        cancellationToken
      );

      if (!diffOutput.trim()) {
        return { comments: [], isRemote };
      }

      // Step 3: Split by file
      const fileChunks = this.splitDiffByFile(diffOutput);
      console.log(`[ReviewMP-PR] ${fileChunks.length} file(s) changed`);

      // Small PRs: single review (preserves full cross-file context naturally)
      const totalLines = fileChunks.reduce((sum, c) => sum + c.diff.split('\n').length, 0);
      if (fileChunks.length <= 3 && totalLines <= 500) {
        const comments = await this.reviewSingleDiff(diffOutput, prInfo, cancellationToken);
        return { comments, isRemote };
      }

      // Step 4: Build import graph and cluster related files
      const importGraph = await this.buildImportGraphFromGit(fileChunks, cwd, diffTarget, cancellationToken);

      const clusters = this.clusterByImports(fileChunks, importGraph);
      console.log(`[ReviewMP-PR] Grouped into ${clusters.length} cluster(s): ${clusters.map(c => `[${c.map(f => f.file).join(', ')}]`).join(', ')}`);

      // Step 5: Pass 1 — review each cluster
      const allComments: ReviewComment[] = [];
      const concurrency = 4;

      for (let i = 0; i < clusters.length; i += concurrency) {
        if (cancellationToken.isCancellationRequested) {
          break;
        }

        const batch = clusters.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(cluster =>
            cluster.length === 1
              ? this.reviewFileChunk(cluster[0], prInfo, cancellationToken)
              : this.reviewCluster(cluster, prInfo, cancellationToken)
          )
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            allComments.push(...result.value);
          } else {
            console.log('[ReviewMP-PR] Cluster review failed:', result.reason);
          }
        }
      }

      // Step 6: Pass 2 — cross-file consistency review
      if (clusters.length > 1 && !cancellationToken.isCancellationRequested) {
        try {
          const crossFileComments = await this.reviewCrossFile(
            fileChunks,
            allComments,
            prInfo,
            cancellationToken
          );
          allComments.push(...crossFileComments);
        } catch (error) {
          console.log('[ReviewMP-PR] Cross-file review failed (non-fatal):', error);
        }
      }

      // Step 7: Final dedup — merge comments on the same file+line
      const dedupedComments = this.deduplicateComments(allComments);
      console.log(`[ReviewMP-PR] Dedup: ${allComments.length} -> ${dedupedComments.length} comments`);

      return { comments: dedupedComments, isRemote };
    } finally {
      // Always restore original branch
      if (needsBranchSwitch) {
        console.log(`[ReviewMP-PR] Restoring branch "${originalBranch}"...`);
        try {
          await this.execCommand(['git', 'checkout', originalBranch], cwd, cancellationToken);
        } catch (e) {
          console.error(`[ReviewMP-PR] Failed to restore branch "${originalBranch}":`, e);
        }
        if (didStash) {
          console.log('[ReviewMP-PR] Restoring stashed changes...');
          try {
            await this.execCommand(['git', 'stash', 'pop'], cwd, cancellationToken);
          } catch (e) {
            console.error('[ReviewMP-PR] Failed to pop stash:', e);
          }
        }
      }
    }
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

  // ─── Import Graph & Clustering ─────────────────────────────────────

  /**
   * Build import graph by reading file contents from git at the given ref.
   * Works for both local and remote PRs since it uses `git show ref:path`
   * rather than reading from disk.
   */
  private async buildImportGraphFromGit(
    fileChunks: FileChunk[],
    cwd: string,
    headRef: string,
    cancellationToken: vscode.CancellationToken
  ): Promise<Map<string, Set<string>>> {
    const graph = new Map<string, Set<string>>();
    const changedFiles = new Set(fileChunks.map(c => c.file));

    for (const chunk of fileChunks) {
      if (cancellationToken.isCancellationRequested) {
        break;
      }

      graph.set(chunk.file, new Set());

      try {
        const content = await this.execCommand(
          ['git', 'show', `${headRef}:${chunk.file}`],
          cwd,
          cancellationToken
        );
        this.extractImports(chunk.file, content, changedFiles, graph);
      } catch {
        // File doesn't exist at this ref (e.g. deleted) — fall back to diff-based extraction
        const lines = chunk.diff.split('\n');
        const contentLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            contentLines.push(line.substring(1));
          } else if (line.startsWith(' ')) {
            contentLines.push(line.substring(1));
          }
        }
        this.extractImports(chunk.file, contentLines.join('\n'), changedFiles, graph);
      }
    }

    return graph;
  }

  /**
   * Extract import statements from file content and add edges to the graph.
   */
  private extractImports(
    file: string,
    content: string,
    changedFiles: Set<string>,
    graph: Map<string, Set<string>>
  ): void {
    const importPatterns = [
      /from\s+['"]([^'"]+)['"]/g,
      /import\s*\(['"]([^'"]+)['"]\)/g,
      /require\s*\(['"]([^'"]+)['"]\)/g,
    ];

    for (const pattern of importPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath.startsWith('.')) {
          const resolved = this.resolveImportPath(file, importPath, changedFiles);
          if (resolved) {
            graph.get(file)!.add(resolved);
          }
        }
      }
    }
  }

  private resolveImportPath(
    fromFile: string,
    importPath: string,
    changedFiles: Set<string>
  ): string | null {
    const dir = path.dirname(fromFile);
    const resolved = path.normalize(path.join(dir, importPath));

    const candidates = [
      resolved,
      ...['ts', 'tsx', 'js', 'jsx'].map(ext => `${resolved}.${ext}`),
      ...['ts', 'tsx', 'js', 'jsx'].map(ext => path.join(resolved, `index.${ext}`)),
    ];

    for (const candidate of candidates) {
      if (changedFiles.has(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private clusterByImports(
    fileChunks: FileChunk[],
    importGraph: Map<string, Set<string>>
  ): FileChunk[][] {
    const fileMap = new Map(fileChunks.map(c => [c.file, c]));
    const visited = new Set<string>();
    const clusters: FileChunk[][] = [];

    // Build bidirectional adjacency
    const adjacency = new Map<string, Set<string>>();
    for (const [file, imports] of importGraph) {
      if (!adjacency.has(file)) {
        adjacency.set(file, new Set());
      }
      for (const imp of imports) {
        adjacency.get(file)!.add(imp);
        if (!adjacency.has(imp)) {
          adjacency.set(imp, new Set());
        }
        adjacency.get(imp)!.add(file);
      }
    }

    // BFS connected components
    for (const chunk of fileChunks) {
      if (visited.has(chunk.file)) {
        continue;
      }

      const cluster: FileChunk[] = [];
      const queue = [chunk.file];
      visited.add(chunk.file);

      while (queue.length > 0) {
        const current = queue.shift()!;
        const fc = fileMap.get(current);
        if (fc) {
          cluster.push(fc);
        }

        const neighbors = adjacency.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor) && fileMap.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      // Cap cluster size to stay within context limits
      if (cluster.length > 10) {
        for (let i = 0; i < cluster.length; i += 5) {
          clusters.push(cluster.slice(i, i + 5));
        }
      } else {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  // ─── Review Methods ────────────────────────────────────────────────

  private async reviewSingleDiff(
    diffOutput: string,
    prInfo: PRInfo,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    const formatted = this.formatDiffWithLineNumbers(diffOutput);

    const prompt = `Review the following changes from PR #${prInfo.number} "${prInfo.title}" (${prInfo.baseBranch} <- ${prInfo.headBranch}).

The diff includes line numbers, context lines, added (+) and removed (-) lines.

<diff>
${formatted}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff
2. Include the file path for each comment
3. Provide your review as a JSON array with required fields: file, line, message, severity
4. Focus on bugs, logic errors, security issues, missing error handling, and breaking changes`;

    return this.executeReview(prompt, cancellationToken);
  }

  private async reviewFileChunk(
    chunk: FileChunk,
    prInfo: PRInfo,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    const formatted = this.formatDiffWithLineNumbers(chunk.diff);

    const prompt = `Review changes to "${chunk.file}" from PR #${prInfo.number} "${prInfo.title}".

<diff>
${formatted}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff
2. Set the file field to "${chunk.file}" for every comment
3. Provide your review as a JSON array with required fields: file, line, message, severity`;

    return this.executeReview(prompt, cancellationToken);
  }

  private async reviewCluster(
    cluster: FileChunk[],
    prInfo: PRInfo,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    const fileList = cluster.map(c => c.file).join(', ');
    const combinedDiff = cluster
      .map(c => this.formatDiffWithLineNumbers(c.diff))
      .join('\n\n');

    const prompt = `Review the following related file changes from PR #${prInfo.number} "${prInfo.title}".

These files import from each other — check for cross-file consistency.
Files: ${fileList}

<diff>
${combinedDiff}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff
2. Include the correct file path for each comment
3. Pay special attention to: type/interface changes vs consumer updates, renamed/removed exports, argument signature changes across call sites
4. Provide your review as a JSON array with required fields: file, line, message, severity`;

    return this.executeReview(prompt, cancellationToken);
  }

  private async reviewCrossFile(
    fileChunks: FileChunk[],
    existingComments: ReviewComment[],
    prInfo: PRInfo,
    cancellationToken: vscode.CancellationToken
  ): Promise<ReviewComment[]> {
    const fileSummaries = fileChunks
      .map(chunk => {
        const lines = chunk.diff.split('\n');
        const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        return `- ${chunk.file} (+${added}/-${removed})`;
      })
      .join('\n');

    const existingSummary =
      existingComments.length > 0
        ? existingComments
            .map(c => `- ${c.file}:${c.line + 1} [${c.severity}] ${c.message}`)
            .join('\n')
        : 'None yet.';

    const coveredLocations = existingComments.length > 0
      ? [...new Set(existingComments.map(c => `${c.file}:${c.line + 1}`))].join(', ')
      : 'None';

    const compactDiff = fileChunks
      .map(chunk => {
        const lines = chunk.diff.split('\n');
        return lines
          .filter(
            l =>
              l.startsWith('diff --git') ||
              l.startsWith('---') ||
              l.startsWith('+++') ||
              l.startsWith('@@')
          )
          .join('\n');
      })
      .join('\n\n');

    const prompt = `Cross-file consistency review for PR #${prInfo.number} "${prInfo.title}".

Individual file reviews are done. Find issues that ONLY appear across file boundaries.

## Changed files
${fileSummaries}

## Diff structure
<diff-headers>
${compactDiff}
</diff-headers>

## Already covered locations (DO NOT comment on these file:line locations again)
${coveredLocations}

## Already found issues (DO NOT duplicate or rephrase these)
${existingSummary}

Focus ONLY on NEW cross-file issues at lines NOT already covered above:
- Type/interface changed but consumers not updated
- Function signatures changed but call sites use old signature
- Imports referencing renamed/removed exports
- Missing coordinated changes (API + client, schema + handler, etc.)

If no cross-file issues: []
Output as JSON array with: file, line, message, severity`;

    return this.executeReview(prompt, cancellationToken);
  }

  // ─── Diff Formatting ───────────────────────────────────────────────

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
        formattedLines.push(`${currentLineNum}: + ${line.substring(1)}`);
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        formattedLines.push(`   : - ${line.substring(1)}`);
      } else if (line.startsWith(' ')) {
        currentLineNum++;
        formattedLines.push(`${currentLineNum}:   ${line.substring(1)}`);
      } else {
        formattedLines.push(line);
      }
    }

    return formattedLines.join('\n');
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
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string' &&
          typeof (item as Record<string, unknown>).file === 'string'
      )
      .map(item => ({
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

  // ─── Deduplication ──────────────────────────────────────────────────

  private deduplicateComments(comments: ReviewComment[]): ReviewComment[] {
    const severityRank: Record<string, number> = {
      error: 4,
      warning: 3,
      suggestion: 2,
      info: 1,
    };

    const groups = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const key = `${comment.file}:${comment.line}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(comment);
    }

    const result: ReviewComment[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        result.push(group[0]);
        continue;
      }

      // Merge: combine messages, keep highest severity, keep first fix
      const mergedMessage = group.map(c => c.message).join('\n\n---\n\n');
      const highestSeverity = group.reduce((best, c) => {
        const bestRank = severityRank[best || 'info'] || 0;
        const currentRank = severityRank[c.severity || 'info'] || 0;
        return currentRank > bestRank ? c.severity : best;
      }, group[0].severity);
      const fix = group.find(c => c.fix)?.fix;

      result.push({
        file: group[0].file,
        line: group[0].line,
        message: mergedMessage,
        severity: highestSeverity,
        fix,
      });
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
