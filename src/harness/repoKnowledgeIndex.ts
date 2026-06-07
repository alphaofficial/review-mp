import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDebugLoggingEnabled } from '../buildFlags';
import { CodeIndexResolvedSettings, getDefaultCodeIndexSettings } from '../services/code-index/config-shared';
import { parseCodeIndexBlocks } from './codeIndexParser';
import { buildQdrantFileFilter, buildQdrantMatchFilter, QdrantClient } from './qdrantClient';
import { CodeRelationship, extractCodeStructure, getLanguageIdFromFilePath, getSupportedCodeExtensions } from './codeStructure';
import { buildEmbeddingVersion, embedText } from './textEmbedding';
import { LocalIndexStore as JsonStore } from './localIndexStore';

function logDebug(message: string, data?: unknown): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    if (data === undefined) {
      console.log(`[CodeBunny DEBUG ${timestamp}] ${message}`);
      return;
    }

    console.log(`[CodeBunny DEBUG ${timestamp}] ${message}`, data);
  } catch {
    // Logging must never interrupt indexing or review flows.
  }
}

export type CodeChunkRecord = {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch: string;
  filePath: string;
  language: string;
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  vector: number[];
  updatedAt: string;
};

export type CodeDeclarationRecord = {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch: string;
  filePath: string;
  language: string;
  symbolName: string;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  vector: number[];
  updatedAt: string;
};

export type CodeRelationshipRecord = {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch: string;
  filePath: string;
  language: string;
  kind: CodeRelationship['kind'];
  sourceSymbol: string;
  targetSymbol: string;
  targetPath: string;
  line: number;
  updatedAt: string;
};

export type ReviewMemoryRecord = {
  id: string;
  repositoryId: string;
  filePath: string | null;
  ruleId: string | null;
  comment: string;
  outcome: 'accepted' | 'ignored' | 'fixed';
  vector: number[];
  updatedAt: string;
  line: number | null;
  findingId: string;
  severity: string | null;
  branch: string;
  commitSha: string;
};

export type ExactReviewRunRecord = {
  id: string;
  repositoryId: string;
  reviewFingerprint: string;
  targetKind: string;
  filePaths: string;
  unitFingerprints: string;
  findingCount: number;
  status: 'completed' | 'failed';
  updatedAt: string;
};

export type ExactReviewUnitRecord = {
  id: string;
  repositoryId: string;
  unitFingerprint: string;
  reviewFingerprint: string;
  targetKind: string;
  filePaths: string;
  findingCount: number;
  updatedAt: string;
};

export type ExactReviewFindingRecord = {
  id: string;
  repositoryId: string;
  reviewFingerprint: string;
  unitFingerprint: string;
  findingKey: string;
  filePath: string;
  line: number;
  title: string;
  message: string;
  fix: string;
  severity: string;
  outcome: 'pending' | 'dismissed' | 'applied';
  updatedAt: string;
};

export type FileSummaryRecord = {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch: string;
  filePath: string;
  language: string;
  summary: string;
  contentHash: string;
  vector: number[];
  updatedAt: string;
};

export type RepoSummaryRecord = {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch: string;
  summary: string;
  contentHash: string;
  vector: number[];
  updatedAt: string;
};

export type IndexMetadataRecord = {
  id: string;
  repositoryId: string;
  schemaVersion: number;
  embeddingVersion: string;
  status: 'ready' | 'rebuilding' | 'error';
  updatedAt: string;
  lastError: string;
};

export interface CodeSearchInput {
  queryText: string;
  filePath?: string;
  limit?: number;
  branch?: string;
  excludeFilePaths?: string[];
}

export interface ReviewMemorySearchInput {
  queryText: string;
  filePath?: string;
  limit?: number;
}

interface IndexingControl {
  waitIfPaused?: () => Promise<void>;
}

interface LocalIndexState {
  declarations: CodeDeclarationRecord[];
  exactReviewFindings: ExactReviewFindingRecord[];
  exactReviewRuns: ExactReviewRunRecord[];
  exactReviewUnits: ExactReviewUnitRecord[];
  fileSummaries: FileSummaryRecord[];
  metadata?: IndexMetadataRecord;
  reviewMemories: Array<{ id: string; updatedAt: string }>;
  relationships: CodeRelationshipRecord[];
  repoSummary?: RepoSummaryRecord;
}

type CodeChunkPayload = Omit<CodeChunkRecord, 'vector'> & { recordType: 'code_chunk' };
type ReviewMemoryPayload = Omit<ReviewMemoryRecord, 'vector'> & { recordType: 'review_memory' };

const INDEX_DIRECTORY = path.join('.codebunny', 'index');
const SUPPORTED_EXTENSIONS = new Set([
  ...getSupportedCodeExtensions(),
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
]);
const INDEX_SCHEMA_VERSION = 3;
const REVIEW_COMMENT_RETENTION = 100;
const EXACT_REVIEW_RUN_RETENTION = 200;
const EXACT_REVIEW_UNIT_RETENTION = 1_000;
const EXACT_REVIEW_FINDING_RETENTION = 5_000;
const REBUILD_BATCH_SIZE = 128;
const YIELD_INTERVAL = 64;
const MAX_EMBEDDING_CHUNK_CHARS = 1_000;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.codebunny',
  'node_modules',
  'out',
  'dist',
  'coverage',
]);

const instanceCache = new Map<string, Promise<RepoKnowledgeIndex>>();
let configuredStorageRoot: string | undefined;
let configuredConnectionSettings: CodeIndexResolvedSettings | undefined;

export class RepoKnowledgeIndex {
  private readonly repositoryId: string;
  private readonly cacheStore: JsonStore<LocalIndexState>;
  private readonly dbPath: string;
  private readonly embeddingVersion: string;
  private readonly qdrantClient: QdrantClient;
  private collectionReady = false;
  private hasIndexedWorkspace = false;
  private rebuildPromise: Promise<number> | undefined;

  private constructor(
    private readonly workspaceRoot: string,
    private readonly connectionSettings: CodeIndexResolvedSettings
  ) {
    this.repositoryId = buildRepositoryId(workspaceRoot);
    this.dbPath = resolveStoragePathForWorkspace(workspaceRoot);
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.cacheStore = new JsonStore<LocalIndexState>(this.dbPath, 'index-state.json', {
      declarations: [],
      exactReviewFindings: [],
      exactReviewRuns: [],
      exactReviewUnits: [],
      fileSummaries: [],
      relationships: [],
      reviewMemories: [],
    });
    this.embeddingVersion = buildEmbeddingVersion(connectionSettings);
    this.qdrantClient = new QdrantClient({
      apiKey: connectionSettings.qdrantApiKey,
      baseUrl: connectionSettings.qdrantUrl,
      collectionName: buildCollectionName(this.repositoryId),
      dimension: connectionSettings.modelDimension,
    });
  }

  static setDefaultStorageRoot(storageRoot: string | undefined): void {
    configuredStorageRoot = storageRoot;
  }

  static getDefaultStorageRoot(): string | undefined {
    return configuredStorageRoot;
  }

  static setDefaultConnectionSettings(settings: CodeIndexResolvedSettings | undefined): void {
    configuredConnectionSettings = settings;
  }

  static getStoragePathForWorkspace(workspaceRoot: string): string {
    return resolveStoragePathForWorkspace(workspaceRoot);
  }

  static forWorkspace(workspaceRoot: string): Promise<RepoKnowledgeIndex> {
    const cacheKey = buildInstanceCacheKey(workspaceRoot);
    const cached = instanceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const created = Promise.resolve(new RepoKnowledgeIndex(workspaceRoot, resolveConnectionSettings()));
    instanceCache.set(cacheKey, created);
    return created;
  }

  async ensureIndexed(candidateFilePaths?: string[]): Promise<void> {
    await this.runWithRecovery(async () => {
      if (!this.hasIndexedWorkspace) {
        await this.rebuildWorkspace();
        return;
      }

      await this.indexFiles(candidateFilePaths ?? []);
    });
  }

  async listWorkspaceFiles(): Promise<string[]> {
    return this.scanWorkspaceFiles();
  }

  async rebuildWorkspace(control?: IndexingControl): Promise<number> {
    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }

    this.rebuildPromise = this.runWithRecovery(async () => {
      const filesToIndex = await this.scanWorkspaceFiles(control);
      await this.writeMetadata('rebuilding');
      try {
        await this.resetIndexedContent();
        const metadata = this.getGitMetadata();
        for (let start = 0; start < filesToIndex.length; start += REBUILD_BATCH_SIZE) {
          await control?.waitIfPaused?.();
          const batch = filesToIndex.slice(start, start + REBUILD_BATCH_SIZE);
          await this.upsertFiles(batch, { metadata, updateRepoSummary: false }, control);
          await yieldToEventLoop();
        }
        await this.writeRepoSummary(metadata);
        this.hasIndexedWorkspace = true;
        await this.writeMetadata('ready');
        return filesToIndex.length;
      } catch (error) {
        await this.writeMetadata('error', error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        this.rebuildPromise = undefined;
      }
    });

    return this.rebuildPromise;
  }

  async indexFiles(candidateFilePaths: string[], control?: IndexingControl): Promise<void> {
    await this.runWithRecovery(async () => {
      const absolutePaths = this.resolveCandidatePaths(candidateFilePaths);
      if (absolutePaths.length === 0) {
        return;
      }

      await this.upsertFiles(absolutePaths, { updateRepoSummary: true }, control);
      this.hasIndexedWorkspace = true;
      await this.writeMetadata('ready');
    });
  }

  async removeFiles(candidateFilePaths: string[], control?: IndexingControl): Promise<void> {
    await this.runWithRecovery(async () => {
      const relativeTargets = this.resolveRelativeTargets(candidateFilePaths);
      if (relativeTargets.length === 0) {
        return;
      }

      await control?.waitIfPaused?.();
      await this.ensureVectorStoreCompatible();
      for (const relativePath of relativeTargets) {
        await this.qdrantClient.deleteByFilter(buildQdrantFileFilter(this.repositoryId, relativePath, 'code_chunk'));
      }

      const state = await this.cacheStore.read();
      state.declarations = state.declarations.filter((row) => !relativeTargets.includes(row.filePath));
      state.relationships = state.relationships.filter((row) => !relativeTargets.includes(row.filePath));
      state.fileSummaries = state.fileSummaries.filter((row) => !relativeTargets.includes(row.filePath));
      await this.cacheStore.write(state);
      await this.writeRepoSummary(this.getGitMetadata());
      await this.writeMetadata('ready');
    });
  }

  getCurrentBranch(): string {
    return this.getGitMetadata().branch;
  }

  async searchCode(input: CodeSearchInput): Promise<CodeChunkRecord[]> {
    return this.runWithRecovery(async () => {
      await this.ensureStorageCompatible();
      const rows = await this.qdrantClient.query<CodeChunkPayload>(
        await embedText(input.queryText, this.connectionSettings),
        {
          filter: {
            must: [
              { key: 'recordType', match: { value: 'code_chunk' } },
              { key: 'repositoryId', match: { value: this.repositoryId } },
              { key: 'branch', match: { value: input.branch ?? this.getGitMetadata().branch } },
            ],
          },
          limit: Math.min(input.limit ?? 8, this.connectionSettings.searchMaxResults) * 3,
          scoreThreshold: this.connectionSettings.searchMinScore,
        }
      );

      const exclude = new Set(input.excludeFilePaths ?? []);
      const rankedResults = rankCodeResults(
        rows.map((row) => ({ ...row.payload, symbolName: row.payload.symbolName ?? null, vector: [] })),
        input.queryText,
        input.filePath,
        exclude
      );
      return rankedResults.slice(0, Math.min(input.limit ?? 8, this.connectionSettings.searchMaxResults));
    });
  }

  async searchReviewMemory(input: ReviewMemorySearchInput): Promise<ReviewMemoryRecord[]> {
    return this.runWithRecovery(async () => {
      await this.ensureStorageCompatible();
      const rows = await this.qdrantClient.query<ReviewMemoryPayload>(
        await embedText(input.queryText, this.connectionSettings),
        {
          filter: {
            must: [
              { key: 'recordType', match: { value: 'review_memory' } },
              { key: 'repositoryId', match: { value: this.repositoryId } },
            ],
          },
          limit: Math.min(input.limit ?? 6, this.connectionSettings.searchMaxResults) * 3,
          scoreThreshold: this.connectionSettings.searchMinScore,
        }
      );

      return rows
        .map((row) => ({ ...row.payload, vector: [] }))
        .sort((left, right) => compareOutcome(right.outcome) - compareOutcome(left.outcome))
        .slice(0, Math.min(input.limit ?? 6, this.connectionSettings.searchMaxResults));
    });
  }

  async getExactReviewRun(reviewFingerprint: string): Promise<ExactReviewRunRecord | undefined> {
    const state = await this.cacheStore.read();
    return state.exactReviewRuns.find((row) => row.repositoryId === this.repositoryId && row.reviewFingerprint === reviewFingerprint);
  }

  async getExactReviewFindings(reviewFingerprint: string): Promise<ExactReviewFindingRecord[]> {
    const state = await this.cacheStore.read();
    return state.exactReviewFindings
      .filter((row) => row.repositoryId === this.repositoryId && row.reviewFingerprint === reviewFingerprint)
      .sort(compareExactReviewFindings);
  }

  async getExactReviewUnit(unitFingerprint: string): Promise<ExactReviewUnitRecord | undefined> {
    const state = await this.cacheStore.read();
    return state.exactReviewUnits.find((row) => row.repositoryId === this.repositoryId && row.unitFingerprint === unitFingerprint);
  }

  async getExactReviewUnitFindings(unitFingerprint: string): Promise<ExactReviewFindingRecord[]> {
    const state = await this.cacheStore.read();
    const byFindingKey = new Map<string, ExactReviewFindingRecord>();
    for (const row of state.exactReviewFindings
      .filter((entry) => entry.repositoryId === this.repositoryId && entry.unitFingerprint === unitFingerprint)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      if (!byFindingKey.has(row.findingKey)) {
        byFindingKey.set(row.findingKey, row);
      }
    }

    return Array.from(byFindingKey.values()).sort(compareExactReviewFindings);
  }

  async getFileSummary(filePath: string): Promise<FileSummaryRecord | undefined> {
    const state = await this.cacheStore.read();
    return state.fileSummaries.find((row) => row.repositoryId === this.repositoryId && row.filePath === filePath);
  }

  async getRepoSummary(): Promise<RepoSummaryRecord | undefined> {
    const state = await this.cacheStore.read();
    return state.repoSummary?.repositoryId === this.repositoryId ? state.repoSummary : undefined;
  }

  async getDeclarationsForFile(filePath: string): Promise<CodeDeclarationRecord[]> {
    const state = await this.cacheStore.read();
    return state.declarations
      .filter((row) => row.repositoryId === this.repositoryId && row.filePath === filePath)
      .sort((left, right) => left.startLine - right.startLine);
  }

  async getRelationshipsForFile(filePath: string): Promise<CodeRelationshipRecord[]> {
    const state = await this.cacheStore.read();
    return state.relationships
      .filter((row) => row.repositoryId === this.repositoryId && row.filePath === filePath)
      .sort((left, right) => left.line - right.line);
  }

  async searchDeclarationsByName(symbolNames: string[], limit = 20): Promise<CodeDeclarationRecord[]> {
    const state = await this.cacheStore.read();
    const names = new Set(symbolNames.filter(Boolean));
    const branch = this.getGitMetadata().branch;
    return state.declarations
      .filter((row) => row.repositoryId === this.repositoryId && row.branch === branch && names.has(row.symbolName))
      .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine)
      .slice(0, limit);
  }

  async upsertExactReviewRun(record: Omit<ExactReviewRunRecord, 'repositoryId' | 'updatedAt'>): Promise<void> {
    await this.ensureMetadataInitialized();
    const state = await this.cacheStore.read();
    state.exactReviewRuns = upsertById(state.exactReviewRuns, [{
      ...record,
      repositoryId: this.repositoryId,
      updatedAt: new Date().toISOString(),
    }]);
    state.exactReviewRuns = pruneByRetention(state.exactReviewRuns, EXACT_REVIEW_RUN_RETENTION);
    await this.cacheStore.write(state);
  }

  async upsertExactReviewUnit(record: Omit<ExactReviewUnitRecord, 'repositoryId' | 'updatedAt'>): Promise<void> {
    await this.ensureMetadataInitialized();
    const state = await this.cacheStore.read();
    state.exactReviewUnits = upsertById(state.exactReviewUnits, [{
      ...record,
      repositoryId: this.repositoryId,
      updatedAt: new Date().toISOString(),
    }]);
    state.exactReviewUnits = pruneByRetention(state.exactReviewUnits, EXACT_REVIEW_UNIT_RETENTION);
    await this.cacheStore.write(state);
  }

  async upsertExactReviewFinding(record: Omit<ExactReviewFindingRecord, 'repositoryId' | 'updatedAt'>): Promise<void> {
    await this.ensureMetadataInitialized();
    const state = await this.cacheStore.read();
    state.exactReviewFindings = upsertById(state.exactReviewFindings, [{
      ...record,
      repositoryId: this.repositoryId,
      updatedAt: new Date().toISOString(),
    }]);
    state.exactReviewFindings = pruneByRetention(state.exactReviewFindings, EXACT_REVIEW_FINDING_RETENTION);
    await this.cacheStore.write(state);
  }

  async replaceExactReviewFindings(
    reviewFingerprint: string,
    findings: Array<Omit<ExactReviewFindingRecord, 'repositoryId' | 'updatedAt'>>
  ): Promise<void> {
    await this.ensureMetadataInitialized();
    const state = await this.cacheStore.read();
    state.exactReviewFindings = state.exactReviewFindings.filter(
      (row) => !(row.repositoryId === this.repositoryId && row.reviewFingerprint === reviewFingerprint)
    );
    state.exactReviewFindings = upsertById(state.exactReviewFindings, findings.map((record) => ({
      ...record,
      repositoryId: this.repositoryId,
      updatedAt: new Date().toISOString(),
    })));
    state.exactReviewFindings = pruneByRetention(state.exactReviewFindings, EXACT_REVIEW_FINDING_RETENTION);
    await this.cacheStore.write(state);
  }

  async upsertReviewMemory(
    record: Omit<ReviewMemoryRecord, 'repositoryId' | 'vector' | 'updatedAt' | 'branch' | 'commitSha'>
  ): Promise<void> {
    await this.runWithRecovery(async () => {
      await this.ensureVectorStoreCompatible();
      const metadata = this.getGitMetadata();
      const updatedAt = new Date().toISOString();
      const payload: ReviewMemoryPayload = {
        ...record,
        repositoryId: this.repositoryId,
        filePath: record.filePath ?? '',
        ruleId: record.ruleId ?? '',
        line: record.line ?? -1,
        severity: record.severity ?? '',
        branch: metadata.branch,
        commitSha: metadata.commitSha,
        updatedAt,
        recordType: 'review_memory',
      };
      await this.qdrantClient.upsertPoints([{
        id: payload.id,
        payload,
        vector: await embedText(`${record.filePath ?? ''}\n${record.comment}`, this.connectionSettings),
      }]);

      const state = await this.cacheStore.read();
      const nextReviewMemories = pruneByRetention(
        upsertById(state.reviewMemories, [{ id: payload.id, updatedAt }]),
        REVIEW_COMMENT_RETENTION
      );
      const retainedIds = new Set(nextReviewMemories.map((entry) => entry.id));
      const staleIds = state.reviewMemories
        .filter((entry) => !retainedIds.has(entry.id))
        .map((entry) => entry.id);
      state.reviewMemories = nextReviewMemories;
      await this.cacheStore.write(state);

      for (const staleId of staleIds) {
        await this.qdrantClient.deleteByFilter(buildQdrantMatchFilter('id', staleId));
      }
    });
  }

  async getIndexMetadata(): Promise<IndexMetadataRecord | undefined> {
    const state = await this.cacheStore.read();
    return state.metadata;
  }

  async clearStorage(): Promise<void> {
    await this.resetIndexStorage();
  }

  async close(): Promise<void> {
    instanceCache.delete(buildInstanceCacheKey(this.workspaceRoot));
  }

  private async scanWorkspaceFiles(control?: IndexingControl): Promise<string[]> {
    const files: string[] = [];
    const stack = [this.workspaceRoot];
    let visitedDirectoryCount = 0;

    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = await safeReadDirectory(current);
      for (const entry of entries) {
        const absolutePath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) {
            stack.push(absolutePath);
          }
          continue;
        }

        if (entry.isFile() && isIndexableFile(absolutePath)) {
          files.push(absolutePath);
        }
      }

      visitedDirectoryCount += 1;
      if (visitedDirectoryCount % YIELD_INTERVAL === 0) {
        await control?.waitIfPaused?.();
        await yieldToEventLoop();
      }
    }

    return files.sort();
  }

  private async upsertFiles(
    absolutePaths: string[],
    options: { updateRepoSummary: boolean; metadata?: { branch: string; commitSha: string } },
    control?: IndexingControl
  ): Promise<void> {
    if (absolutePaths.length === 0) {
      return;
    }

    await this.ensureVectorStoreCompatible();
    const metadata = options.metadata ?? this.getGitMetadata();
    const state = await this.cacheStore.read();
    const nextChunks: Array<{ payload: CodeChunkPayload; vector: number[] }> = [];
    const nextDeclarations: CodeDeclarationRecord[] = [];
    const nextRelationships: CodeRelationshipRecord[] = [];
    const nextFileSummaries: FileSummaryRecord[] = [];
    const relativePaths = absolutePaths
      .map((absolutePath) => toRelativeFilePath(this.workspaceRoot, absolutePath))
      .filter((relativePath): relativePath is string => relativePath !== undefined);

    state.declarations = state.declarations.filter((row) => !relativePaths.includes(row.filePath));
    state.relationships = state.relationships.filter((row) => !relativePaths.includes(row.filePath));
    state.fileSummaries = state.fileSummaries.filter((row) => !relativePaths.includes(row.filePath));

    for (let index = 0; index < absolutePaths.length; index += 1) {
      await control?.waitIfPaused?.();
      const absolutePath = absolutePaths[index];
      const relativePath = toRelativeFilePath(this.workspaceRoot, absolutePath);
      if (relativePath === undefined) {
        continue;
      }
      const code = await safeReadFile(absolutePath);
      if (!code) {
        continue;
      }

      await this.qdrantClient.deleteByFilter(buildQdrantFileFilter(this.repositoryId, relativePath, 'code_chunk'));

      const language = getLanguageIdFromPath(relativePath);
      const fileHash = sha256(code);
      const structure = extractCodeStructure(language, code, relativePath);
      const chunks = extractChunksForFile(relativePath, language, code, structure);
      const updatedAt = new Date().toISOString();

      for (const chunk of chunks) {
        const payload: CodeChunkPayload = {
          id: chunk.segmentHash
            ? `${this.repositoryId}:${chunk.segmentHash}`
            : `${this.repositoryId}:${relativePath}:${chunk.startLine}-${chunk.endLine}${chunk.segmentIndex === undefined ? '' : `:${chunk.segmentIndex}`}`,
          repositoryId: this.repositoryId,
          commitSha: metadata.commitSha,
          branch: metadata.branch,
          filePath: relativePath,
          language,
          symbolName: chunk.symbolName ?? '',
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          contentHash: sha256(chunk.content),
          updatedAt,
          recordType: 'code_chunk',
        };
        nextChunks.push({
          payload,
          vector: await embedText(`${relativePath}\n${chunk.symbolName ?? ''}\n${chunk.content}`, this.connectionSettings),
        });
      }

      for (const block of structure.blocks) {
        nextDeclarations.push({
          id: `${this.repositoryId}:${relativePath}:${block.kind}:${block.name}:${block.startLine}-${block.endLine}:${fileHash.slice(0, 12)}`,
          repositoryId: this.repositoryId,
          commitSha: metadata.commitSha,
          branch: metadata.branch,
          filePath: relativePath,
          language,
          symbolName: block.name,
          kind: block.kind,
          startLine: block.startLine,
          endLine: block.endLine,
          content: block.content,
          contentHash: sha256(block.content),
          vector: [],
          updatedAt,
        });
      }

      for (const relationship of structure.relationships) {
        nextRelationships.push({
          id: `${this.repositoryId}:${relativePath}:${relationship.kind}:${relationship.line}:${relationship.sourceSymbol ?? ''}:${relationship.targetSymbol ?? ''}:${relationship.targetPath ?? ''}`,
          repositoryId: this.repositoryId,
          commitSha: metadata.commitSha,
          branch: metadata.branch,
          filePath: relativePath,
          language,
          kind: relationship.kind,
          sourceSymbol: relationship.sourceSymbol ?? '',
          targetSymbol: relationship.targetSymbol ?? '',
          targetPath: relationship.targetPath ?? '',
          line: relationship.line,
          updatedAt,
        });
      }

      const summary = buildFileSummary(relativePath, language, chunks);
      nextFileSummaries.push({
        id: `${this.repositoryId}:${relativePath}`,
        repositoryId: this.repositoryId,
        commitSha: metadata.commitSha,
        branch: metadata.branch,
        filePath: relativePath,
        language,
        summary,
        contentHash: fileHash,
        vector: [],
        updatedAt,
      });

      if ((index + 1) % YIELD_INTERVAL === 0) {
        await control?.waitIfPaused?.();
        await yieldToEventLoop();
      }
    }

    await this.qdrantClient.upsertPoints(nextChunks.map((entry) => ({
      id: entry.payload.id,
      payload: entry.payload,
      vector: entry.vector,
    })));

    state.declarations.push(...nextDeclarations);
    state.relationships.push(...nextRelationships);
    state.fileSummaries = upsertById(state.fileSummaries, nextFileSummaries);
    await this.cacheStore.write(state);
    if (options.updateRepoSummary) {
      await this.writeRepoSummary(metadata);
    }
  }

  private async writeRepoSummary(metadata: { branch: string; commitSha: string }): Promise<void> {
    const state = await this.cacheStore.read();
    const allSummaries = state.fileSummaries
      .filter((row) => row.repositoryId === this.repositoryId)
      .map((row) => `${row.filePath}: ${row.summary}`);
    const repoSummary = buildRepoSummary(allSummaries);
    state.repoSummary = {
      id: this.repositoryId,
      repositoryId: this.repositoryId,
      commitSha: metadata.commitSha,
      branch: metadata.branch,
      summary: repoSummary,
      contentHash: sha256(repoSummary),
      vector: [],
      updatedAt: new Date().toISOString(),
    };
    await this.cacheStore.write(state);
  }

  private resolveCandidatePaths(candidateFilePaths?: string[]): string[] {
    if (!candidateFilePaths || candidateFilePaths.length === 0) {
      return [];
    }

    return [...new Set(candidateFilePaths.map((candidate) => (
      path.isAbsolute(candidate) ? candidate : path.join(this.workspaceRoot, candidate)
    )))].filter((absolutePath) => {
      const relativePath = toRelativeFilePath(this.workspaceRoot, absolutePath);
      return relativePath !== undefined && isIndexableFile(absolutePath) && !isIgnoredRelativePath(relativePath);
    });
  }

  private resolveRelativeTargets(candidateFilePaths?: string[]): string[] {
    if (!candidateFilePaths || candidateFilePaths.length === 0) {
      return [];
    }

    return [...new Set(candidateFilePaths.map((candidate) => {
      const absolutePath = path.isAbsolute(candidate)
        ? candidate
        : path.join(this.workspaceRoot, candidate);
      return toRelativeFilePath(this.workspaceRoot, absolutePath);
    }))].filter((relativePath): relativePath is string => (
      relativePath !== undefined
      && SUPPORTED_EXTENSIONS.has(path.extname(relativePath))
      && !isIgnoredRelativePath(relativePath)
    ));
  }

  private getGitMetadata(): { branch: string; commitSha: string } {
    return {
      branch: readGitValue(this.workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'workspace',
      commitSha: readGitValue(this.workspaceRoot, ['rev-parse', '--short', 'HEAD']) ?? 'workspace',
    };
  }

  private async ensureVectorStoreCompatible(): Promise<void> {
    if (this.collectionReady) {
      return;
    }

    await this.qdrantClient.ensureCollection();
    this.collectionReady = true;
  }

  private async ensureStorageCompatible(): Promise<void> {
    await this.ensureVectorStoreCompatible();
    const state = await this.cacheStore.read();
    if (!state.metadata) {
      if (
        state.declarations.length > 0
        || state.relationships.length > 0
        || state.fileSummaries.length > 0
        || state.exactReviewRuns.length > 0
        || state.exactReviewUnits.length > 0
        || state.exactReviewFindings.length > 0
        || state.reviewMemories.length > 0
      ) {
        throw new Error('INDEX_METADATA_MISSING');
      }

      await this.writeMetadata('ready');
      return;
    }

    if (
      state.metadata.schemaVersion !== INDEX_SCHEMA_VERSION
      || state.metadata.embeddingVersion !== this.embeddingVersion
    ) {
      throw new Error('INDEX_SCHEMA_MISMATCH');
    }
  }

  private async writeMetadata(status: IndexMetadataRecord['status'], lastError: string = ''): Promise<void> {
    const state = await this.cacheStore.read();
    state.metadata = {
      id: this.repositoryId,
      repositoryId: this.repositoryId,
      schemaVersion: INDEX_SCHEMA_VERSION,
      embeddingVersion: this.embeddingVersion,
      status,
      updatedAt: new Date().toISOString(),
      lastError,
    };
    await this.cacheStore.write(state);
  }

  private async ensureMetadataInitialized(): Promise<void> {
    const state = await this.cacheStore.read();
    if (state.metadata) {
      return;
    }

    state.metadata = {
      id: this.repositoryId,
      repositoryId: this.repositoryId,
      schemaVersion: INDEX_SCHEMA_VERSION,
      embeddingVersion: this.embeddingVersion,
      status: 'ready',
      updatedAt: new Date().toISOString(),
      lastError: '',
    };
    await this.cacheStore.write(state);
  }

  private async resetIndexedContent(): Promise<void> {
    await this.qdrantClient.recreateCollection();
    this.collectionReady = true;
    const state = await this.cacheStore.read();
    state.declarations = [];
    state.relationships = [];
    state.fileSummaries = [];
    state.reviewMemories = [];
    state.repoSummary = undefined;
    await this.cacheStore.write(state);
    this.hasIndexedWorkspace = false;
  }

  private async resetIndexStorage(): Promise<void> {
    await this.qdrantClient.deleteCollection();
    this.collectionReady = false;
    await this.cacheStore.reset();
    fs.rmSync(this.dbPath, { recursive: true, force: true });
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.hasIndexedWorkspace = false;
  }

  private async runWithRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureStorageCompatible();
      return await operation();
    } catch (error) {
      if (!isRecoverableIndexError(error)) {
        throw error;
      }

      logDebug('Repo knowledge index recovering from failure', {
        workspaceRoot: this.workspaceRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.resetIndexedContent();
      await this.writeMetadata('ready');
      return operation();
    }
  }
}

interface ChunkLike {
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
  segmentIndex?: number;
  segmentHash?: string;
}

function extractChunksForFile(
  filePath: string,
  language: string,
  code: string,
  structure = extractCodeStructure(language, code, filePath)
): ChunkLike[] {
  const semanticBlocks = parseCodeIndexBlocks(language, code, filePath);
  if (semanticBlocks.length > 0) {
    return semanticBlocks.map((block) => ({
      symbolName: block.identifier,
      startLine: block.startLine,
      endLine: block.endLine,
      content: block.content,
      segmentHash: block.segmentHash,
    }));
  }

  if (language === 'json') {
    const schemaChunks = extractJsonSchemaChunks(code);
    if (schemaChunks.length > 0) {
      return splitOversizedChunks(schemaChunks);
    }
  }

  const structuredBlocks = structure.blocks;
  if (structuredBlocks.length > 0) {
    return splitOversizedChunks(structuredBlocks.map((block) => ({
      symbolName: block.name,
      startLine: block.startLine,
      endLine: block.endLine,
      content: block.content,
    })));
  }

  return buildWindowChunks(code);
}

function extractJsonSchemaChunks(code: string): ChunkLike[] {
  const lines = code.split('\n');
  const chunks: ChunkLike[] = [];
  let depth = 0;
  let schemasDepth: number | undefined;
  let currentName: string | undefined;
  let currentStart = -1;
  let currentLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
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

    if (currentName === undefined) {
      if (depth < schemasDepth) {
        break;
      }

      const schemaMatch = depth === schemasDepth ? trimmed.match(/^"([^"]+)":\s*\{$/) : null;
      if (schemaMatch) {
        currentName = schemaMatch[1];
        currentStart = index;
        currentLines = [line];
        depth += braceDelta;
        if (depth === schemasDepth) {
          chunks.push({
            symbolName: currentName,
            startLine: currentStart,
            endLine: index,
            content: currentLines.join('\n'),
          });
          currentName = undefined;
          currentStart = -1;
          currentLines = [];
        }
        continue;
      }
    } else {
      currentLines.push(line);
      depth += braceDelta;
      if (depth === schemasDepth) {
        chunks.push({
          symbolName: currentName,
          startLine: currentStart,
          endLine: index,
          content: currentLines.join('\n'),
        });
        currentName = undefined;
        currentStart = -1;
        currentLines = [];
      }
      continue;
    }

    depth += braceDelta;
  }

  return chunks;
}

function buildWindowChunks(code: string, chunkSize: number = 80): ChunkLike[] {
  const lines = code.split('\n');
  const chunks: ChunkLike[] = [];

  for (let start = 0; start < lines.length; start += chunkSize) {
    const end = Math.min(lines.length, start + chunkSize) - 1;
    chunks.push({
      symbolName: null,
      startLine: start,
      endLine: end,
      content: lines.slice(start, end + 1).join('\n'),
    });
  }

  return chunks;
}

function splitOversizedChunks(chunks: ChunkLike[], maxChars: number = MAX_EMBEDDING_CHUNK_CHARS): ChunkLike[] {
  return chunks.flatMap((chunk) => splitOversizedChunk(chunk, maxChars));
}

function splitOversizedChunk(chunk: ChunkLike, maxChars: number): ChunkLike[] {
  if (chunk.content.length <= maxChars) {
    return [chunk];
  }

  const lines = chunk.content.split('\n');
  const segments: ChunkLike[] = [];
  let currentLines: string[] = [];
  let currentStartLine = chunk.startLine;
  let currentLength = 0;
  let segmentIndex = 0;

  const flush = (endLine: number): void => {
    if (currentLines.length === 0) {
      return;
    }

    segments.push({
      symbolName: chunk.symbolName,
      startLine: currentStartLine,
      endLine,
      content: currentLines.join('\n'),
      segmentIndex,
    });
    segmentIndex += 1;
    currentLines = [];
    currentLength = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const absoluteLine = chunk.startLine + index;
    const slices = splitLineByLength(line, maxChars);

    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex += 1) {
      const slice = slices[sliceIndex];
      const additionLength = currentLines.length === 0 ? slice.length : slice.length + 1;
      if (currentLines.length > 0 && currentLength + additionLength > maxChars) {
        flush(absoluteLine - 1);
        currentStartLine = absoluteLine;
      } else if (currentLines.length === 0) {
        currentStartLine = absoluteLine;
      }

      currentLines.push(slice);
      currentLength += currentLines.length === 1 ? slice.length : slice.length + 1;

      if (sliceIndex < slices.length - 1) {
        flush(absoluteLine);
        currentStartLine = absoluteLine;
      }
    }
  }

  flush(chunk.endLine);
  return segments;
}

function splitLineByLength(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }

  const segments: string[] = [];
  for (let start = 0; start < line.length; start += maxChars) {
    segments.push(line.slice(start, start + maxChars));
  }

  return segments;
}

function countBraceDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }
  return delta;
}

function buildFileSummary(filePath: string, language: string, chunks: ChunkLike[]): string {
  const headline = chunks
    .slice(0, 6)
    .map((chunk) => chunk.symbolName ?? `lines ${chunk.startLine + 1}-${chunk.endLine + 1}`)
    .join(', ');
  return `File ${filePath} (${language}) contains ${chunks.length} review chunks. Main sections: ${headline}.`;
}

function buildRepoSummary(fileSummaries: string[]): string {
  const sample = fileSummaries.slice(0, 24).join(' ');
  return `Repository ${fileSummaries.length} indexed files. ${sample}`;
}

function rankCodeResults(
  rows: CodeChunkRecord[],
  queryText: string,
  currentFilePath: string | undefined,
  exclude: Set<string>
): CodeChunkRecord[] {
  const queryTokens = new Set(queryText.toLowerCase().split(/[^a-z0-9_]+/g).filter(Boolean));

  return rows
    .filter((row) => !exclude.has(row.filePath))
    .map((row) => ({
      row,
      score: overlapScore(queryTokens, row.content, row.symbolName, row.filePath, currentFilePath),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.row);
}

function overlapScore(
  queryTokens: Set<string>,
  content: string,
  symbolName: string | null,
  filePath: string,
  currentFilePath: string | undefined
): number {
  const haystack = `${filePath} ${symbolName ?? ''} ${content}`.toLowerCase();
  let score = currentFilePath && currentFilePath === filePath ? 2 : 4;

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
  }

  if (symbolName && queryTokens.has(symbolName.toLowerCase())) {
    score += 5;
  }

  return score;
}

function compareOutcome(outcome: ReviewMemoryRecord['outcome']): number {
  switch (outcome) {
    case 'fixed':
      return 3;
    case 'accepted':
      return 2;
    case 'ignored':
      return 1;
    default:
      return 0;
  }
}

function compareExactReviewFindings(left: ExactReviewFindingRecord, right: ExactReviewFindingRecord): number {
  const severityOrder: Record<string, number> = {
    error: 0,
    warning: 1,
    info: 2,
    suggestion: 3,
  };

  const severityDelta = (severityOrder[left.severity] ?? 4) - (severityOrder[right.severity] ?? 4);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }

  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.message.localeCompare(right.message);
}

function buildRepositoryId(workspaceRoot: string): string {
  return `repo_${sha256(workspaceRoot).slice(0, 12)}`;
}

function buildCollectionName(repositoryId: string): string {
  return `ws-${repositoryId.replace(/^repo_/, '')}`;
}

function resolveStoragePathForWorkspace(workspaceRoot: string): string {
  if (configuredStorageRoot) {
    return path.join(configuredStorageRoot, 'code-index', buildRepositoryId(workspaceRoot));
  }

  return path.join(workspaceRoot, INDEX_DIRECTORY);
}

function resolveConnectionSettings(): CodeIndexResolvedSettings {
  const defaults = getDefaultCodeIndexSettings();
  return configuredConnectionSettings ?? {
    ...defaults,
    qdrantApiKey: undefined,
  };
}

function buildInstanceCacheKey(workspaceRoot: string): string {
  const settings = resolveConnectionSettings();
  return [
    workspaceRoot,
    settings.embedderProvider,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
    settings.modelDimension,
    settings.qdrantUrl,
    settings.qdrantApiKey ?? '',
    settings.searchMinScore,
    settings.searchMaxResults,
  ].join('::');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function safeReadFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function safeReadDirectory(directoryPath: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isIndexableFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath));
}

function isIgnoredRelativePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function toRelativeFilePath(workspaceRoot: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return relativePath.replace(/\\/g, '/');
}

function getLanguageIdFromPath(filePath: string): string {
  return getLanguageIdFromFilePath(filePath);
}

function readGitValue(workspaceRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function isRecoverableIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('INDEX_METADATA_MISSING')
    || message.includes('INDEX_SCHEMA_MISMATCH')
    || message.includes('Qdrant')
    || message.includes('Embedding dimension mismatch')
    || message.includes('Ollama embedding request failed')
  );
}

function upsertById<T extends { id: string }>(existing: T[], next: T[]): T[] {
  const rows = new Map(existing.map((row) => [row.id, row]));
  for (const row of next) {
    rows.set(row.id, row);
  }
  return Array.from(rows.values());
}

function pruneByRetention<T extends { updatedAt: string }>(rows: T[], limit: number): T[] {
  return rows
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}
