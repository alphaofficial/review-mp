import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { buildImportGraph, DiffReviewability, FileDiff, isReviewableDiffFile, parseDiffIntoFiles } from './diffClustering';
import { extractCodeBlocks, extractImportsFromSource, getLanguageIdFromFilePath, selectBlocksBySymbols } from './codeStructure';
import { ReviewComment, ReviewContextReason } from '../types/review';
import { RepoKnowledgeIndex } from './repoKnowledgeIndex';
import { getSettings } from '../settings';

export interface ContextFile {
  filePath: string;
  reason: ReviewContextReason;
  content: string;
}

export interface ContextEnvelope {
  files: ContextFile[];
  totalChars: number;
  text: string;
}

interface DiffContextEnvelopeInput {
  formattedDiff: string;
  primaryFiles: string[];
  existingComments?: ReviewComment[];
  maxContextChars?: number;
  workspaceRoot?: string;
}

interface PreparedDiffReviewContextInput {
  formattedDiff: string;
  workspaceRoot?: string;
}

interface PreparedDiffUnitContextInput {
  primaryFiles: string[];
  existingComments?: ReviewComment[];
  maxContextChars?: number;
}

interface SkippedDiffFileSummary {
  filePath: string;
  reviewability: Exclude<DiffReviewability, 'reviewable'>;
  reason: string;
}

export interface PreparedDiffReviewContext {
  formattedDiff: string;
  workspaceRoot?: string;
  fileDiffs: FileDiff[];
  byPath: Map<string, FileDiff>;
  graph: Map<string, Set<string>>;
  deterministicContextByFile: Map<string, ContextFile[]>;
  historyByFile: Map<string, ContextFile>;
  reviewableFiles: string[];
  skippedFiles: SkippedDiffFileSummary[];
  repoSummary?: ContextFile;
  semanticMatchResolver: (primaryFile: string, excludeFilePaths: string[]) => Promise<ContextFile[]>;
  reviewMemoryResolver: (primaryFile: string) => Promise<ContextFile[]>;
}

const DEFAULT_CONTEXT_BUDGET = 12_000;
const RECENT_HISTORY_MAX_FILES = 4;
const RECENT_HISTORY_MAX_COMMITS = 3;

export async function prepareDiffReviewContext(
  input: PreparedDiffReviewContextInput
): Promise<PreparedDiffReviewContext> {
  const parsedFileDiffs = parseDiffIntoFiles(input.formattedDiff);
  const fileDiffs = parsedFileDiffs.filter(isReviewableDiffFile);
  const byPath = new Map(fileDiffs.map((fileDiff) => [fileDiff.filePath, fileDiff]));
  const graph = buildImportGraph(fileDiffs);
  const deterministicContextByFile = new Map<string, ContextFile[]>();
  const historyByFile = new Map<string, ContextFile>();
  const reviewableFiles = fileDiffs.map((fileDiff) => fileDiff.filePath);
  const skippedFiles = parsedFileDiffs
    .filter((fileDiff) => !isReviewableDiffFile(fileDiff))
    .map((fileDiff) => ({
      filePath: fileDiff.filePath,
      reviewability: fileDiff.reviewability as Exclude<DiffReviewability, 'reviewable'>,
      reason: fileDiff.skipReason ?? 'non-reviewable file',
    }));

  for (const fileDiff of fileDiffs) {
    const relatedFiles: ContextFile[] = [];
    if (isCodeLanguage(getLanguageIdFromPath(fileDiff.filePath))) {
      relatedFiles.push(...getImportedContextFiles(fileDiff.filePath, input.workspaceRoot));
      const siblingTest = getSiblingTestFile(fileDiff.filePath, input.workspaceRoot);
      if (siblingTest) {
        relatedFiles.push(siblingTest);
      }
    }

    deterministicContextByFile.set(fileDiff.filePath, relatedFiles);
  }

  if (input.workspaceRoot) {
    for (const historyFile of getRecentHistoryContextFiles(input.workspaceRoot, reviewableFiles)) {
      historyByFile.set(historyFile.filePath, historyFile);
    }
  }

  let repoSummary: ContextFile | undefined;
  let index: RepoKnowledgeIndex | undefined;
  const semanticMatchCache = new Map<string, Promise<ContextFile[]>>();
  const reviewMemoryCache = new Map<string, Promise<ContextFile[]>>();

  if (input.workspaceRoot && getSettings().codeIndexEnabled) {
    try {
      index = await RepoKnowledgeIndex.forWorkspace(input.workspaceRoot);
      const metadata = await index.getIndexMetadata();
      if (metadata?.status !== 'ready') {
        throw new Error('INDEX_NOT_READY');
      }

      const summary = await index.getRepoSummary();
      if (summary) {
        repoSummary = {
          filePath: '(repo summary)',
          reason: 'repo-summary',
          content: summary.summary,
        };
      }
    } catch {
      index = undefined;
    }
  }

  const semanticMatchResolver = async (primaryFile: string, excludeFilePaths: string[]): Promise<ContextFile[]> => {
    if (!index) {
      return [];
    }

    const cacheKey = primaryFile;
    if (!semanticMatchCache.has(cacheKey)) {
      semanticMatchCache.set(
        cacheKey,
        (async () => {
          const fileDiff = byPath.get(primaryFile);
          const queryText = fileDiff ? `${primaryFile}\n${fileDiff.rawDiff}` : primaryFile;
          const relatedChunks = await index!.searchCode({
            queryText,
            filePath: primaryFile,
            excludeFilePaths: [primaryFile],
            limit: 4,
          });

          return relatedChunks.map((chunk) => ({
            filePath: chunk.filePath,
            reason: 'semantic-match' as const,
            content: chunk.content,
          }));
        })()
      );
    }

    const cached = await semanticMatchCache.get(cacheKey)!;
    const excluded = new Set(excludeFilePaths);
    return cached.filter((file) => !excluded.has(file.filePath));
  };

  const reviewMemoryResolver = async (primaryFile: string): Promise<ContextFile[]> => {
    if (!index) {
      return [];
    }

    const cacheKey = primaryFile;
    if (!reviewMemoryCache.has(cacheKey)) {
      reviewMemoryCache.set(
        cacheKey,
        (async () => {
          const fileDiff = byPath.get(primaryFile);
          const reviewMemory = await index!.searchReviewMemory({
            queryText: fileDiff?.rawDiff ?? primaryFile,
            filePath: primaryFile,
            limit: 2,
          });

          return reviewMemory.map((memory) => ({
            filePath: memory.filePath || '(review memory)',
            reason: 'review-memory' as const,
            content: `[${memory.outcome}] ${memory.comment}`,
          }));
        })()
      );
    }

    return await reviewMemoryCache.get(cacheKey)!;
  };

  return {
    formattedDiff: input.formattedDiff,
    workspaceRoot: input.workspaceRoot,
    fileDiffs,
    byPath,
    graph,
    deterministicContextByFile,
    historyByFile,
    reviewableFiles,
    skippedFiles,
    repoSummary,
    semanticMatchResolver,
    reviewMemoryResolver,
  };
}

export async function buildPreparedDiffContextEnvelope(
  runContext: PreparedDiffReviewContext,
  input: PreparedDiffUnitContextInput
): Promise<ContextEnvelope> {
  const relatedFiles = new Map<string, ContextFile>();
  const maxContextChars = input.maxContextChars ?? DEFAULT_CONTEXT_BUDGET;
  const primaryFileSet = new Set(input.primaryFiles);

  const manifest = buildDiffManifestContext(runContext, input.primaryFiles);
  relatedFiles.set(manifest.filePath, manifest);

  for (const primaryFile of input.primaryFiles) {
    const neighbors = runContext.graph.get(primaryFile);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (primaryFileSet.has(neighbor)) {
          continue;
        }

        const fileDiff = runContext.byPath.get(neighbor);
        if (!fileDiff) {
          continue;
        }

        relatedFiles.set(neighbor, {
          filePath: neighbor,
          reason: 'related-change',
          content: fileDiff.rawDiff,
        });
      }
    }

    for (const relatedFile of runContext.deterministicContextByFile.get(primaryFile) ?? []) {
      if (primaryFileSet.has(relatedFile.filePath)) {
        continue;
      }

      relatedFiles.set(relatedFile.filePath, relatedFile);
    }

    const historyFile = runContext.historyByFile.get(primaryFile);
    if (historyFile) {
      relatedFiles.set(historyFile.filePath, historyFile);
    }
  }

  for (const comment of input.existingComments ?? []) {
    if (primaryFileSet.has(comment.file) || relatedFiles.has(comment.file)) {
      continue;
    }

    relatedFiles.set(comment.file, {
      filePath: comment.file,
      reason: 'existing-finding',
      content: `[${comment.file}:${comment.line}] ${comment.message}`,
    });
  }

  const semanticAndMemory = await Promise.all(
    input.primaryFiles.map(async (primaryFile) => {
      const [semanticMatches, reviewMemory] = await Promise.all([
        runContext.semanticMatchResolver(primaryFile, input.primaryFiles),
        runContext.reviewMemoryResolver(primaryFile),
      ]);

      return [...semanticMatches, ...reviewMemory];
    })
  );

  for (const contextFile of semanticAndMemory.flat()) {
    if (primaryFileSet.has(contextFile.filePath) || relatedFiles.has(contextFile.filePath)) {
      continue;
    }

    relatedFiles.set(contextFile.filePath, contextFile);
  }

  if (runContext.repoSummary) {
    relatedFiles.set(runContext.repoSummary.filePath, runContext.repoSummary);
  }

  const selectedFiles: ContextFile[] = [];
  let totalChars = 0;

  for (const contextFile of relatedFiles.values()) {
    const entryChars = contextFile.content.length;
    if (selectedFiles.length > 0 && totalChars + entryChars > maxContextChars) {
      continue;
    }

    selectedFiles.push(contextFile);
    totalChars += entryChars;
  }

  const text = selectedFiles
    .map((file) => `Related file: ${file.filePath}\nReason: ${file.reason}\n${file.content}`)
    .join('\n\n');

  return {
    files: selectedFiles,
    totalChars,
    text,
  };
}

export async function buildDiffContextEnvelope(input: DiffContextEnvelopeInput): Promise<ContextEnvelope> {
  const runContext = await prepareDiffReviewContext({
    formattedDiff: input.formattedDiff,
    workspaceRoot: input.workspaceRoot,
  });
  return buildPreparedDiffContextEnvelope(runContext, input);
}

interface FileContextEnvelopeInput {
  workspaceRoot?: string;
  filePath: string;
  languageId: string;
  fullCode: string;
  unitCode: string;
  pathHint?: string;
  maxContextChars?: number;
}

export async function buildFileContextEnvelope(input: FileContextEnvelopeInput): Promise<ContextEnvelope> {
  const maxContextChars = input.maxContextChars ?? DEFAULT_CONTEXT_BUDGET;
  const relatedFiles: ContextFile[] = [];

  if (input.languageId === 'json') {
    for (const schemaName of extractSchemaRefs(input.unitCode)) {
      const schemaSnippet = extractSchemaByName(input.fullCode, schemaName);
      if (!schemaSnippet) {
        continue;
      }

      relatedFiles.push({
        filePath: input.filePath,
        reason: 'related-change',
        content: `Referenced schema: ${schemaName}\n${schemaSnippet}`,
      });
    }
  } else if (isCodeLanguage(input.languageId)) {
    relatedFiles.push(...getImportedContextFiles(input.filePath, input.workspaceRoot, input.fullCode));
    const siblingTest = getSiblingTestFile(input.filePath, input.workspaceRoot);
    if (siblingTest) {
      relatedFiles.push(siblingTest);
    }
  }

  if (input.workspaceRoot) {
    relatedFiles.push(
      ...getRecentHistoryContextFiles(
        input.workspaceRoot,
        [input.filePath, ...relatedFiles.map((file) => file.filePath)]
      )
    );
  }

  if (input.workspaceRoot && getSettings().codeIndexEnabled) {
    try {
      const index = await RepoKnowledgeIndex.forWorkspace(input.workspaceRoot);
      const metadata = await index.getIndexMetadata();
      if (metadata?.status !== 'ready') {
        throw new Error('INDEX_NOT_READY');
      }

      const relatedChunks = await index.searchCode({
        queryText: `${input.pathHint ?? ''}\n${input.unitCode}`,
        filePath: input.filePath,
        excludeFilePaths: [input.filePath],
        limit: 6,
      });

      for (const chunk of relatedChunks) {
        relatedFiles.push({
          filePath: chunk.filePath,
          reason: 'semantic-match',
          content: chunk.content,
        });
      }

      const graphContext = await buildCodeGraphContext(index, input.filePath);
      if (graphContext) {
        relatedFiles.push(graphContext);
      }

      const reviewMemory = await index.searchReviewMemory({
        queryText: input.unitCode,
        filePath: input.filePath,
        limit: 4,
      });

      for (const memory of reviewMemory) {
        relatedFiles.push({
          filePath: memory.filePath || '(review memory)',
          reason: 'review-memory',
          content: `[${memory.outcome}] ${memory.comment}`,
        });
      }

      const fileSummary = await index.getFileSummary(input.filePath);
      if (fileSummary) {
        relatedFiles.push({
          filePath: input.filePath,
          reason: 'file-summary',
          content: fileSummary.summary,
        });
      }

      const repoSummary = await index.getRepoSummary();
      if (repoSummary) {
        relatedFiles.push({
          filePath: '(repo summary)',
          reason: 'repo-summary',
          content: repoSummary.summary,
        });
      }
    } catch {
      // Fall back to deterministic local retrieval when the persistent index is unavailable or still warming.
    }
  }

  const selectedFiles: ContextFile[] = [];
  let totalChars = 0;

  for (const contextFile of relatedFiles) {
    if (selectedFiles.some((file) => file.filePath === contextFile.filePath && file.content === contextFile.content)) {
      continue;
    }

    const entryChars = contextFile.content.length;
    if (totalChars + entryChars > maxContextChars) {
      continue;
    }

    selectedFiles.push(contextFile);
    totalChars += entryChars;
  }

  const pathHintSection = input.pathHint ? `Focus path: ${input.pathHint}` : '';
  const filesSection = selectedFiles
    .map((file) => `Related file: ${file.filePath}\nReason: ${file.reason}\n${file.content}`)
    .join('\n\n');

  const text = [pathHintSection, filesSection].filter(Boolean).join('\n\n');

  return {
    files: selectedFiles,
    totalChars,
    text,
  };
}

function buildDiffManifestContext(
  runContext: PreparedDiffReviewContext,
  primaryFiles: string[]
): ContextFile {
  const skippedByCategory = new Map<SkippedDiffFileSummary['reviewability'], number>();
  for (const skippedFile of runContext.skippedFiles) {
    skippedByCategory.set(
      skippedFile.reviewability,
      (skippedByCategory.get(skippedFile.reviewability) ?? 0) + 1
    );
  }

  const lines = [
    `Current review files (${primaryFiles.length})`,
    ...primaryFiles.map((filePath) => `- ${filePath}`),
    '',
    `Reviewable changed files in run: ${runContext.reviewableFiles.length}`,
    `Skipped changed files in run: ${runContext.skippedFiles.length}`,
  ];

  if (skippedByCategory.size > 0) {
    lines.push('Skipped file categories:');
    for (const [reviewability, count] of skippedByCategory.entries()) {
      lines.push(`- ${reviewability}: ${count}`);
    }
  }

  if (runContext.skippedFiles.length > 0) {
    lines.push('');
    lines.push('Sample skipped files:');
    for (const skippedFile of runContext.skippedFiles.slice(0, 8)) {
      lines.push(`- ${skippedFile.filePath} (${skippedFile.reason})`);
    }
  }

  return {
    filePath: '(diff manifest)',
    reason: 'diff-manifest',
    content: lines.join('\n'),
  };
}

function isCodeLanguage(languageId: string): boolean {
  return languageId !== 'json' && languageId !== 'plaintext';
}

function getImportedContextFiles(filePath: string, workspaceRoot?: string, sourceCode?: string): ContextFile[] {
  if (!workspaceRoot) {
    return [];
  }

  const absoluteFilePath = toAbsolutePath(filePath, workspaceRoot);
  const content = sourceCode ?? readFileIfExists(absoluteFilePath);
  if (!content) {
    return [];
  }

  const contextFiles: ContextFile[] = [];

  for (const importInfo of extractImportsFromSource(getLanguageIdFromPath(absoluteFilePath), content, absoluteFilePath)) {
    const resolvedPath = resolveImportFile(importInfo.path, absoluteFilePath);
    if (!resolvedPath) {
      continue;
    }

    const resolvedContent = readFileIfExists(resolvedPath);
    if (!resolvedContent) {
      continue;
    }

    const structuredBlocks = extractCodeBlocks(getLanguageIdFromPath(resolvedPath), resolvedContent, resolvedPath);
    const selectedBlocks = selectBlocksBySymbols(structuredBlocks, importInfo.symbols);
    const contentSnippet = selectedBlocks.length > 0
      ? selectedBlocks.map((block) => block.content).join('\n\n')
      : resolvedContent;

    contextFiles.push({
      filePath: toRelativePath(resolvedPath, workspaceRoot),
      reason: 'related-change',
      content: contentSnippet,
    });
  }

  return contextFiles;
}

function getSiblingTestFile(filePath: string, workspaceRoot?: string): ContextFile | undefined {
  if (!workspaceRoot) {
    return undefined;
  }

  const absoluteFilePath = toAbsolutePath(filePath, workspaceRoot);
  const ext = path.extname(absoluteFilePath);
  const base = absoluteFilePath.slice(0, -ext.length);
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
  ];

  for (const candidate of candidates) {
    const content = readFileIfExists(candidate);
    if (!content) {
      continue;
    }

    return {
      filePath: toRelativePath(candidate, workspaceRoot),
      reason: 'related-change',
      content,
    };
  }

  return undefined;
}

function resolveImportFile(importPath: string, absoluteFromFile: string): string | undefined {
  if (!importPath.startsWith('.')) {
    return undefined;
  }

  const baseDir = path.dirname(absoluteFromFile);
  const basePath = path.resolve(baseDir, importPath);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.py`,
    `${basePath}.go`,
    `${basePath}.rs`,
    `${basePath}.java`,
    `${basePath}.rb`,
    `${basePath}.php`,
    `${basePath}.swift`,
    `${basePath}.kt`,
    `${basePath}.kts`,
    `${basePath}.c`,
    `${basePath}.cpp`,
    `${basePath}.hpp`,
    `${basePath}.cs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.jsx'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function readFileIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function toAbsolutePath(filePath: string, workspaceRoot: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
}

function toRelativePath(filePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function getLanguageIdFromPath(filePath: string): string {
  return getLanguageIdFromFilePath(filePath);
}

async function buildCodeGraphContext(index: RepoKnowledgeIndex, filePath: string): Promise<ContextFile | undefined> {
  const [declarations, relationships] = await Promise.all([
    index.getDeclarationsForFile(filePath),
    index.getRelationshipsForFile(filePath),
  ]);

  if (declarations.length === 0 && relationships.length === 0) {
    return undefined;
  }

  const declarationLines = declarations
    .slice(0, 20)
    .map((declaration) => `- ${declaration.kind} ${declaration.symbolName} lines ${declaration.startLine + 1}-${declaration.endLine + 1}`);
  const relationshipLines = relationships
    .filter((relationship) => relationship.kind === 'imports' || relationship.targetSymbol || relationship.targetPath)
    .slice(0, 30)
    .map((relationship) => {
      const target = relationship.targetPath || relationship.targetSymbol || '(unknown)';
      return `- ${relationship.kind} ${target} at line ${relationship.line + 1}`;
    });

  const content = [
    `Code graph for ${filePath}`,
    declarationLines.length > 0 ? `Declarations:\n${declarationLines.join('\n')}` : '',
    relationshipLines.length > 0 ? `Relationships:\n${relationshipLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    filePath,
    reason: 'code-graph',
    content,
  };
}

function extractSchemaRefs(code: string): string[] {
  const refs = new Set<string>();
  const refRegex = /#\/components\/schemas\/([^"'\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(code)) !== null) {
    refs.add(match[1]);
  }

  return Array.from(refs);
}

function extractSchemaByName(fullCode: string, schemaName: string): string | undefined {
  const lines = fullCode.split('\n');
  let depth = 0;
  let schemasDepth: number | undefined;
  let collecting = false;
  let schemaDepth = 0;
  const schemaLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const braceDelta = countBraceDelta(line);

    if (schemasDepth === undefined && trimmed === '"schemas": {') {
      schemasDepth = depth + 1;
      depth += braceDelta;
      continue;
    }

    if (schemasDepth === undefined) {
      depth += braceDelta;
      continue;
    }

    if (!collecting && depth === schemasDepth && trimmed === `"${schemaName}": {`) {
      collecting = true;
      schemaDepth = 1;
      schemaLines.push(line);
      depth += braceDelta;
      if (schemaDepth === 0) {
        return schemaLines.join('\n');
      }
      continue;
    }

    if (collecting) {
      schemaLines.push(line);
      schemaDepth += braceDelta;
      depth += braceDelta;
      if (schemaDepth === 0) {
        return schemaLines.join('\n');
      }
      continue;
    }

    depth += braceDelta;
  }

  return undefined;
}

function getRecentHistoryContextFiles(workspaceRoot: string, candidateFiles: string[]): ContextFile[] {
  const dedupedFiles = [...new Set(candidateFiles)]
    .filter((filePath) => isRealWorkspaceFile(filePath))
    .slice(0, RECENT_HISTORY_MAX_FILES);
  const historyFiles: ContextFile[] = [];

  for (const filePath of dedupedFiles) {
    const summary = getRecentCommitSummary(workspaceRoot, filePath);
    if (!summary) {
      continue;
    }

    historyFiles.push({
      filePath,
      reason: 'recent-change',
      content: summary,
    });
  }

  return historyFiles;
}

function getRecentCommitSummary(workspaceRoot: string, filePath: string): string | undefined {
  try {
    const output = execFileSync(
      'git',
      [
        'log',
        `-n${RECENT_HISTORY_MAX_COMMITS}`,
        '--date=short',
        '--pretty=format:%h%x1f%ad%x1f%s',
        '--',
        filePath,
      ],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();

    if (!output) {
      return undefined;
    }

    const lines = output
      .split('\n')
      .map((line) => line.split('\u001f'))
      .filter((parts) => parts.length === 3)
      .map(([sha, date, subject]) => `- ${sha} | ${date} | ${subject}`);

    if (lines.length === 0) {
      return undefined;
    }

    return `Recent commits touching ${filePath}\n${lines.join('\n')}`;
  } catch {
    return undefined;
  }
}

function isRealWorkspaceFile(filePath: string): boolean {
  return filePath.length > 0 && !filePath.startsWith('(');
}

function countBraceDelta(line: string): number {
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  return opens - closes;
}
