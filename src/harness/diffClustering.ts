import { DiffResult } from './diffContextCollector';

export interface FileDiff {
  filePath: string;
  oldPath?: string;
  newPath?: string;
  hunks: DiffHunk[];
  rawDiff: string;
}

export interface DiffHunk {
  startLine: number;
  lines: string[];
  oldStart?: number;
  oldCount?: number;
  newStart: number;
  newCount: number;
}

export interface FileCluster {
  id: number;
  files: string[];
  totalLines: number;
  diffContent: string;
}

export interface ClusteringResult {
  clusters: FileCluster[];
  totalFiles: number;
  totalLines: number;
  usedFastPath: boolean;
}

const MAX_CLUSTER_SIZE = 10;
const SMALL_PR_FILE_COUNT = 3;
const SMALL_PR_LINE_COUNT = 500;

export function parseDiffIntoFiles(diffOutput: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diffOutput.split('\n');
  
  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentHunkLines: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile && currentHunk) {
        currentHunk.lines = currentHunkLines;
        currentFile.hunks.push(currentHunk);
      }
      if (currentFile) {
        files.push(currentFile);
      }

      const match = line.match(/diff --git a\/(.+?) b\/(.+)/);
      currentFile = {
        filePath: match ? match[2] : '',
        hunks: [],
        rawDiff: line + '\n',
      };
      currentHunk = null;
      currentHunkLines = [];
      inHunk = false;
      continue;
    }

    if (currentFile) {
      currentFile.rawDiff += line + '\n';
    }

    if (line.startsWith('---') || line.startsWith('+++')) {
      continue;
    }

    if (line.startsWith('@@')) {
      if (currentHunk && currentHunkLines.length > 0) {
        currentHunk.lines = currentHunkLines;
        if (currentFile) {
          currentFile.hunks.push(currentHunk);
        }
      }

      const hunkMatch = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      currentHunk = {
        startLine: hunkMatch ? parseInt(hunkMatch[3], 10) : 0,
        lines: [],
        oldStart: hunkMatch ? parseInt(hunkMatch[1], 10) : 0,
        oldCount: hunkMatch ? parseInt(hunkMatch[2] || '1', 10) : 1,
        newStart: hunkMatch ? parseInt(hunkMatch[3], 10) : 0,
        newCount: hunkMatch ? parseInt(hunkMatch[4] || '1', 10) : 1,
      };
      currentHunkLines = [];
      inHunk = true;
      continue;
    }

    if (inHunk && currentHunk) {
      currentHunkLines.push(line);
    }
  }

  if (currentFile && currentHunk) {
    currentHunk.lines = currentHunkLines;
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return files;
}

export function countDiffLines(fileDiffs: FileDiff[]): number {
  return fileDiffs.reduce((total, file) => {
    return total + file.hunks.reduce((hunkTotal, hunk) => {
      return hunkTotal + hunk.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    }, 0);
  }, 0);
}

export function extractImportsFromDiff(file: FileDiff): string[] {
  const imports: string[] = [];
  const allContent = file.hunks.map(h => h.lines.join('\n')).join('\n');
  
  const importRegexes = [
    /import\s+.*?from\s+['"](.+?)['"]/g,
    /require\(['"](.+?)['"]\)/g,
    /#include\s+["<](.+?)[>]/g,
    /use\s+([A-Z][a-zA-Z0-9_\\]+);/g,
  ];

  for (const regex of importRegexes) {
    let match;
    while ((match = regex.exec(allContent)) !== null) {
      imports.push(match[1]);
    }
  }

  return imports;
}

export function buildImportGraph(fileDiffs: FileDiff[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const file of fileDiffs) {
    if (!graph.has(file.filePath)) {
      graph.set(file.filePath, new Set());
    }

    const imports = extractImportsFromDiff(file);
    for (const imported of imports) {
      const normalizedImport = normalizeImportPath(imported, file.filePath);
      
      for (const otherFile of fileDiffs) {
        if (otherFile.filePath === normalizedImport || otherFile.filePath.includes(normalizedImport)) {
          graph.get(file.filePath)!.add(otherFile.filePath);
        }
      }
    }
  }

  return graph;
}

function normalizeImportPath(importPath: string, fromFile: string): string {
  if (importPath.startsWith('.')) {
    const baseDir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : '';
    return baseDir ? `${baseDir}/${importPath}` : importPath;
  }
  return importPath;
}

export function clusterFilesBFS(
  fileDiffs: FileDiff[],
  graph: Map<string, Set<string>>,
  maxClusterSize: number = MAX_CLUSTER_SIZE
): FileCluster[] {
  const clustered = new Set<string>();
  const clusters: FileCluster[] = [];
  let clusterId = 0;

  for (const file of fileDiffs) {
    if (clustered.has(file.filePath)) {
      continue;
    }

    const cluster = new Set<string>();
    const queue: string[] = [file.filePath];

    while (queue.length > 0 && cluster.size < maxClusterSize) {
      const current = queue.shift()!;
      if (clustered.has(current)) {
        continue;
      }

      cluster.add(current);
      clustered.add(current);

      const neighbors = graph.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!clustered.has(neighbor) && cluster.size < maxClusterSize) {
            queue.push(neighbor);
          }
        }
      }
    }

    if (cluster.size > 0) {
      clusters.push({
        id: clusterId++,
        files: Array.from(cluster),
        totalLines: 0,
        diffContent: '',
      });
    }
  }

  return clusters;
}

export function buildClusterDiff(cluster: FileCluster, fileDiffs: FileDiff[]): FileCluster {
  const relevantFiles = fileDiffs.filter(f => cluster.files.includes(f.filePath));
  const diffLines: string[] = [];
  let totalLines = 0;

  for (const file of relevantFiles) {
    diffLines.push(file.rawDiff);
    totalLines += file.hunks.reduce((sum, hunk) => {
      return sum + hunk.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
    }, 0);
  }

  return {
    ...cluster,
    totalLines,
    diffContent: diffLines.join('\n'),
  };
}

export function clusterDiff(diffResult: DiffResult): ClusteringResult {
  const fileDiffs = parseDiffIntoFiles(diffResult.diff);
  const totalLines = countDiffLines(fileDiffs);
  const totalFiles = fileDiffs.length;

  if (totalFiles <= SMALL_PR_FILE_COUNT && totalLines <= SMALL_PR_LINE_COUNT) {
    return {
      clusters: [{
        id: 0,
        files: fileDiffs.map(f => f.filePath),
        totalLines,
        diffContent: diffResult.formattedDiff,
      }],
      totalFiles,
      totalLines,
      usedFastPath: true,
    };
  }

  const graph = buildImportGraph(fileDiffs);
  const preliminaryClusters = clusterFilesBFS(fileDiffs, graph);
  
  const clusters = preliminaryClusters.map(c => buildClusterDiff(c, fileDiffs));

  return {
    clusters,
    totalFiles,
    totalLines,
    usedFastPath: false,
  };
}

export function formatClusterForReview(cluster: FileCluster, fileDiffs: FileDiff[]): string {
  const lines: string[] = [];
  
  for (const filePath of cluster.files) {
    const fileDiff = fileDiffs.find(f => f.filePath === filePath);
    if (fileDiff) {
      lines.push(fileDiff.rawDiff);
    }
  }

  return lines.join('\n');
}

export function deduplicateComments(comments: { file: string; line: number; message: string }[]): { file: string; line: number; message: string }[] {
  const seen = new Set<string>();
  const deduplicated: { file: string; line: number; message: string }[] = [];

  for (const comment of comments) {
    const key = `${comment.file}:${comment.line}:${comment.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(comment);
    }
  }

  return deduplicated;
}
