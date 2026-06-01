import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Connection, Table } from '@lancedb/lancedb';
import { isDebugLoggingEnabled } from '../buildFlags';
import { CodeRelationship, extractCodeStructure, getLanguageIdFromFilePath, getSupportedCodeExtensions } from './codeStructure';
import { EMBEDDING_ALGORITHM_VERSION, embedText } from './textEmbedding';

const requireFromHere = createRequire(__filename);
let lancedbModule: typeof import('@lancedb/lancedb') | undefined;

function logDebug(message: string, data?: unknown): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    if (data === undefined) {
      console.log(`[ReviewMP DEBUG ${timestamp}] ${message}`);
      return;
    }

    console.log(`[ReviewMP DEBUG ${timestamp}] ${message}`, data);
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

const INDEX_DIRECTORY = path.join('.reviewmp', 'lancedb');
const CODE_CHUNKS_TABLE = 'code_chunks';
const CODE_DECLARATIONS_TABLE = 'code_declarations';
const CODE_RELATIONSHIPS_TABLE = 'code_relationships';
const REVIEW_COMMENTS_TABLE = 'review_comments';
const EXACT_REVIEW_RUNS_TABLE = 'review_runs';
const EXACT_REVIEW_UNITS_TABLE = 'review_units';
const EXACT_REVIEW_FINDINGS_TABLE = 'review_run_findings';
const FILE_SUMMARIES_TABLE = 'file_summaries';
const REPO_SUMMARIES_TABLE = 'repo_summaries';
const INDEX_METADATA_TABLE = 'index_metadata';
const SUPPORTED_EXTENSIONS = new Set([
  ...getSupportedCodeExtensions(),
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
]);
const INDEX_SCHEMA_VERSION = 2;
const REVIEW_COMMENT_RETENTION = 100;
const EXACT_REVIEW_RUN_RETENTION = 200;
const EXACT_REVIEW_UNIT_RETENTION = 1_000;
const EXACT_REVIEW_FINDING_RETENTION = 5_000;
const REBUILD_BATCH_SIZE = 128;
const YIELD_INTERVAL = 64;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.reviewmp',
  'node_modules',
  'out',
  'dist',
  'coverage',
]);

const instanceCache = new Map<string, Promise<RepoKnowledgeIndex>>();
let configuredStorageRoot: string | undefined;

function getLanceDb(): typeof import('@lancedb/lancedb') {
  lancedbModule ??= requireFromHere('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
  return lancedbModule;
}

export class RepoKnowledgeIndex {
  private connectionPromise: Promise<Connection>;
  private repositoryId: string;
  private hasIndexedWorkspace = false;
  private rebuildPromise: Promise<number> | undefined;
  private readonly dbPath: string;
  private readonly vectorIndexedTables = new Set<string>();

  private constructor(private readonly workspaceRoot: string) {
    this.repositoryId = buildRepositoryId(workspaceRoot);
    this.dbPath = resolveStoragePathForWorkspace(workspaceRoot);
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.connectionPromise = getLanceDb().connect(this.dbPath);
  }

  static setDefaultStorageRoot(storageRoot: string | undefined): void {
    configuredStorageRoot = storageRoot;
  }

  static getDefaultStorageRoot(): string | undefined {
    return configuredStorageRoot;
  }

  static getStoragePathForWorkspace(workspaceRoot: string): string {
    return resolveStoragePathForWorkspace(workspaceRoot);
  }

  static forWorkspace(workspaceRoot: string): Promise<RepoKnowledgeIndex> {
    const cached = instanceCache.get(workspaceRoot);
    if (cached) {
      logDebug('Repo knowledge index cache hit', {
        workspaceRoot,
      });
      return cached;
    }

    logDebug('Repo knowledge index creating workspace instance', {
      workspaceRoot,
      indexDirectory: path.join(workspaceRoot, INDEX_DIRECTORY),
    });
    const created = Promise.resolve(new RepoKnowledgeIndex(workspaceRoot));
    instanceCache.set(workspaceRoot, created);
    return created;
  }

  async ensureIndexed(candidateFilePaths?: string[]): Promise<void> {
    await this.runWithRecovery('ensureIndexed', async () => {
      logDebug('Repo knowledge index ensureIndexed requested', {
        workspaceRoot: this.workspaceRoot,
        hasIndexedWorkspace: this.hasIndexedWorkspace,
        candidateFileCount: candidateFilePaths?.length ?? 0,
      });
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

    this.rebuildPromise = this.runWithRecovery('rebuildWorkspace', async () => {
      const filesToIndex = await this.scanWorkspaceFiles(control);
      logDebug('Repo knowledge index workspace rebuild started', {
        workspaceRoot: this.workspaceRoot,
        fileCount: filesToIndex.length,
      });
      await this.writeMetadata('rebuilding');
      try {
        await this.clearIndexedContentTables();
        const metadata = this.getGitMetadata();
        for (let start = 0; start < filesToIndex.length; start += REBUILD_BATCH_SIZE) {
          await control?.waitIfPaused?.();
          const batch = filesToIndex.slice(start, start + REBUILD_BATCH_SIZE);
          await this.upsertFiles(batch, { updateRepoSummary: false, metadata }, control);
          await yieldToEventLoop();
        }
        await this.writeRepoSummary(await this.readTable<FileSummaryRecord>(FILE_SUMMARIES_TABLE), metadata);
        this.hasIndexedWorkspace = true;
        await this.writeMetadata('ready');
        logDebug('Repo knowledge index workspace rebuild completed', {
          workspaceRoot: this.workspaceRoot,
          fileCount: filesToIndex.length,
        });
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
    await this.runWithRecovery('indexFiles', async () => {
      const absolutePaths = this.resolveCandidatePaths(candidateFilePaths);
      if (absolutePaths.length === 0) {
        logDebug('Repo knowledge index incremental index skipped because no candidates resolved', {
          workspaceRoot: this.workspaceRoot,
          candidateFileCount: candidateFilePaths.length,
        });
        return;
      }

      logDebug('Repo knowledge index incremental index started', {
        workspaceRoot: this.workspaceRoot,
        candidateFileCount: candidateFilePaths.length,
        resolvedFileCount: absolutePaths.length,
      });
      await this.upsertFiles(absolutePaths, { updateRepoSummary: true }, control);
      this.hasIndexedWorkspace = true;
      await this.writeMetadata('ready');
      logDebug('Repo knowledge index incremental index completed', {
        workspaceRoot: this.workspaceRoot,
        resolvedFileCount: absolutePaths.length,
      });
    });
  }

  async removeFiles(candidateFilePaths: string[], control?: IndexingControl): Promise<void> {
    await this.runWithRecovery('removeFiles', async () => {
      const relativeTargets = this.resolveRelativeTargets(candidateFilePaths);
      if (relativeTargets.length === 0) {
        logDebug('Repo knowledge index removeFiles skipped because no targets resolved', {
          workspaceRoot: this.workspaceRoot,
          candidateFileCount: candidateFilePaths.length,
        });
        return;
      }

      logDebug('Repo knowledge index removeFiles started', {
        workspaceRoot: this.workspaceRoot,
        targetCount: relativeTargets.length,
        sampleTargets: relativeTargets.slice(0, 5),
      });
      await control?.waitIfPaused?.();
      await this.deleteByFilePaths(CODE_CHUNKS_TABLE, relativeTargets);
      await this.deleteByFilePaths(CODE_DECLARATIONS_TABLE, relativeTargets);
      await this.deleteByFilePaths(CODE_RELATIONSHIPS_TABLE, relativeTargets);
      await this.deleteByFilePaths(FILE_SUMMARIES_TABLE, relativeTargets);
      await this.writeRepoSummary(await this.readTable<FileSummaryRecord>(FILE_SUMMARIES_TABLE), this.getGitMetadata());
      await this.writeMetadata('ready');
      logDebug('Repo knowledge index removeFiles completed', {
        workspaceRoot: this.workspaceRoot,
        removedFileCount: relativeTargets.length,
      });
    });
  }

  getCurrentBranch(): string {
    return this.getGitMetadata().branch;
  }

  async searchCode(input: CodeSearchInput): Promise<CodeChunkRecord[]> {
    return this.runWithRecovery('searchCode', async () => {
      const table = await this.openTable(CODE_CHUNKS_TABLE);
      if (!table) {
        logDebug('Repo knowledge index searchCode skipped because table is unavailable', {
          workspaceRoot: this.workspaceRoot,
          filePath: input.filePath,
        });
        return [];
      }

      const metadata = this.getGitMetadata();
      const results = await table
        .search(Float32Array.from(embedText(input.queryText)), 'vector')
        .where(`repositoryId = '${escapeSql(this.repositoryId)}' AND branch = '${escapeSql(input.branch ?? metadata.branch)}'`)
        .limit((input.limit ?? 8) * 3)
        .toArray() as CodeChunkRecord[];

      const exclude = new Set(input.excludeFilePaths ?? []);
      const rankedResults = rankCodeResults(results, input.queryText, input.filePath, exclude).slice(0, input.limit ?? 8);
      logDebug('Repo knowledge index searchCode completed', {
        workspaceRoot: this.workspaceRoot,
        filePath: input.filePath,
        branch: input.branch ?? metadata.branch,
        rawResultCount: results.length,
        rankedResultCount: rankedResults.length,
        excludeCount: exclude.size,
      });
      return rankedResults;
    });
  }

  async searchReviewMemory(input: ReviewMemorySearchInput): Promise<ReviewMemoryRecord[]> {
    return this.runWithRecovery('searchReviewMemory', async () => {
      const table = await this.openTable(REVIEW_COMMENTS_TABLE);
      if (!table) {
        logDebug('Repo knowledge index searchReviewMemory skipped because table is unavailable', {
          workspaceRoot: this.workspaceRoot,
          filePath: input.filePath,
        });
        return [];
      }

      const rows = await table
        .search(Float32Array.from(embedText(input.queryText)), 'vector')
        .where(`repositoryId = '${escapeSql(this.repositoryId)}'`)
        .limit((input.limit ?? 6) * 3)
        .toArray() as ReviewMemoryRecord[];

      const rankedRows = rows
        .sort((left, right) => compareOutcome(right.outcome) - compareOutcome(left.outcome))
        .slice(0, input.limit ?? 6);
      logDebug('Repo knowledge index searchReviewMemory completed', {
        workspaceRoot: this.workspaceRoot,
        filePath: input.filePath,
        rawResultCount: rows.length,
        rankedResultCount: rankedRows.length,
        sameFileResultCount: rankedRows.filter((row) => row.filePath === input.filePath).length,
      });
      return rankedRows;
    });
  }

  async getExactReviewRun(reviewFingerprint: string): Promise<ExactReviewRunRecord | undefined> {
    return this.runWithRecovery('getExactReviewRun', async () => {
      const table = await this.openTable(EXACT_REVIEW_RUNS_TABLE);
      if (!table) {
        return undefined;
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND reviewFingerprint = '${escapeSql(reviewFingerprint)}'`
        )
        .limit(1)
        .toArray() as ExactReviewRunRecord[];

      return rows[0];
    });
  }

  async getExactReviewFindings(reviewFingerprint: string): Promise<ExactReviewFindingRecord[]> {
    return this.runWithRecovery('getExactReviewFindings', async () => {
      const table = await this.openTable(EXACT_REVIEW_FINDINGS_TABLE);
      if (!table) {
        return [];
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND reviewFingerprint = '${escapeSql(reviewFingerprint)}'`
        )
        .toArray() as ExactReviewFindingRecord[];

      return rows.sort(compareExactReviewFindings);
    });
  }

  async getExactReviewUnit(unitFingerprint: string): Promise<ExactReviewUnitRecord | undefined> {
    return this.runWithRecovery('getExactReviewUnit', async () => {
      const table = await this.openTable(EXACT_REVIEW_UNITS_TABLE);
      if (!table) {
        return undefined;
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND unitFingerprint = '${escapeSql(unitFingerprint)}'`
        )
        .limit(1)
        .toArray() as ExactReviewUnitRecord[];

      return rows[0];
    });
  }

  async getExactReviewUnitFindings(unitFingerprint: string): Promise<ExactReviewFindingRecord[]> {
    return this.runWithRecovery('getExactReviewUnitFindings', async () => {
      const table = await this.openTable(EXACT_REVIEW_FINDINGS_TABLE);
      if (!table) {
        return [];
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND unitFingerprint = '${escapeSql(unitFingerprint)}'`
        )
        .toArray() as ExactReviewFindingRecord[];

      const byFindingKey = new Map<string, ExactReviewFindingRecord>();
      for (const row of rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
        if (!byFindingKey.has(row.findingKey)) {
          byFindingKey.set(row.findingKey, row);
        }
      }

      return Array.from(byFindingKey.values()).sort(compareExactReviewFindings);
    });
  }

  async getFileSummary(filePath: string): Promise<FileSummaryRecord | undefined> {
    return this.runWithRecovery('getFileSummary', async () => {
      const table = await this.openTable(FILE_SUMMARIES_TABLE);
      if (!table) {
        return undefined;
      }

      const rows = await table
        .query()
        .where(`repositoryId = '${escapeSql(this.repositoryId)}' AND filePath = '${escapeSql(filePath)}'`)
        .limit(1)
        .toArray() as FileSummaryRecord[];

      return rows[0];
    });
  }

  async getRepoSummary(): Promise<RepoSummaryRecord | undefined> {
    return this.runWithRecovery('getRepoSummary', async () => {
      const table = await this.openTable(REPO_SUMMARIES_TABLE);
      if (!table) {
        return undefined;
      }

      const rows = await table
        .query()
        .where(`repositoryId = '${escapeSql(this.repositoryId)}'`)
        .limit(1)
        .toArray() as RepoSummaryRecord[];

      return rows[0];
    });
  }

  async getDeclarationsForFile(filePath: string): Promise<CodeDeclarationRecord[]> {
    return this.runWithRecovery('getDeclarationsForFile', async () => {
      const table = await this.openTable(CODE_DECLARATIONS_TABLE);
      if (!table) {
        return [];
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND filePath = '${escapeSql(filePath)}'`
        )
        .toArray() as CodeDeclarationRecord[];

      return rows.sort((left, right) => left.startLine - right.startLine);
    });
  }

  async getRelationshipsForFile(filePath: string): Promise<CodeRelationshipRecord[]> {
    return this.runWithRecovery('getRelationshipsForFile', async () => {
      const table = await this.openTable(CODE_RELATIONSHIPS_TABLE);
      if (!table) {
        return [];
      }

      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND filePath = '${escapeSql(filePath)}'`
        )
        .toArray() as CodeRelationshipRecord[];

      return rows.sort((left, right) => left.line - right.line);
    });
  }

  async searchDeclarationsByName(symbolNames: string[], limit = 20): Promise<CodeDeclarationRecord[]> {
    return this.runWithRecovery('searchDeclarationsByName', async () => {
      const names = [...new Set(symbolNames.filter(Boolean))];
      if (names.length === 0) {
        return [];
      }

      const table = await this.openTable(CODE_DECLARATIONS_TABLE);
      if (!table) {
        return [];
      }

      const metadata = this.getGitMetadata();
      const rows = await table
        .query()
        .where(
          `repositoryId = '${escapeSql(this.repositoryId)}' AND branch = '${escapeSql(metadata.branch)}' AND ${buildInPredicate('symbolName', names)}`
        )
        .limit(limit)
        .toArray() as CodeDeclarationRecord[];

      return rows.sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine);
    });
  }

  async upsertExactReviewRun(
    record: Omit<ExactReviewRunRecord, 'repositoryId' | 'updatedAt'>
  ): Promise<void> {
    await this.runWithRecovery('upsertExactReviewRun', async () => {
      await this.upsertRowsById(EXACT_REVIEW_RUNS_TABLE, [{
        ...record,
        repositoryId: this.repositoryId,
        updatedAt: new Date().toISOString(),
      }]);
      await this.pruneTableByRetention<ExactReviewRunRecord>(EXACT_REVIEW_RUNS_TABLE, EXACT_REVIEW_RUN_RETENTION);
    });
  }

  async upsertExactReviewUnit(
    record: Omit<ExactReviewUnitRecord, 'repositoryId' | 'updatedAt'>
  ): Promise<void> {
    await this.runWithRecovery('upsertExactReviewUnit', async () => {
      await this.upsertRowsById(EXACT_REVIEW_UNITS_TABLE, [{
        ...record,
        repositoryId: this.repositoryId,
        updatedAt: new Date().toISOString(),
      }]);
      await this.pruneTableByRetention<ExactReviewUnitRecord>(EXACT_REVIEW_UNITS_TABLE, EXACT_REVIEW_UNIT_RETENTION);
    });
  }

  async upsertExactReviewFinding(
    record: Omit<ExactReviewFindingRecord, 'repositoryId' | 'updatedAt'>
  ): Promise<void> {
    await this.runWithRecovery('upsertExactReviewFinding', async () => {
      await this.upsertRowsById(EXACT_REVIEW_FINDINGS_TABLE, [{
        ...record,
        repositoryId: this.repositoryId,
        updatedAt: new Date().toISOString(),
      }]);
      await this.pruneTableByRetention<ExactReviewFindingRecord>(EXACT_REVIEW_FINDINGS_TABLE, EXACT_REVIEW_FINDING_RETENTION);
    });
  }

  async replaceExactReviewFindings(
    reviewFingerprint: string,
    findings: Array<Omit<ExactReviewFindingRecord, 'repositoryId' | 'updatedAt'>>
  ): Promise<void> {
    await this.runWithRecovery('replaceExactReviewFindings', async () => {
      await this.deleteWhere(
        EXACT_REVIEW_FINDINGS_TABLE,
        `repositoryId = '${escapeSql(this.repositoryId)}' AND reviewFingerprint = '${escapeSql(reviewFingerprint)}'`
      );
      if (findings.length > 0) {
        await this.upsertRowsById(EXACT_REVIEW_FINDINGS_TABLE, findings.map((record) => ({
          ...record,
          repositoryId: this.repositoryId,
          updatedAt: new Date().toISOString(),
        })));
      }
      await this.pruneTableByRetention<ExactReviewFindingRecord>(EXACT_REVIEW_FINDINGS_TABLE, EXACT_REVIEW_FINDING_RETENTION);
    });
  }

  async upsertReviewMemory(record: Omit<ReviewMemoryRecord, 'repositoryId' | 'vector' | 'updatedAt' | 'branch' | 'commitSha'>): Promise<void> {
    await this.runWithRecovery('upsertReviewMemory', async () => {
      const metadata = this.getGitMetadata();
      await this.upsertRowsById(REVIEW_COMMENTS_TABLE, [{
        ...record,
        repositoryId: this.repositoryId,
        filePath: record.filePath ?? '',
        ruleId: record.ruleId ?? '',
        line: record.line ?? -1,
        severity: record.severity ?? '',
        branch: metadata.branch,
        commitSha: metadata.commitSha,
        updatedAt: new Date().toISOString(),
        vector: embedText(`${record.filePath ?? ''}\n${record.comment}`),
      }]);
      await this.pruneTableByRetention<ReviewMemoryRecord>(REVIEW_COMMENTS_TABLE, REVIEW_COMMENT_RETENTION);
    });
  }

  async getIndexMetadata(): Promise<IndexMetadataRecord | undefined> {
    return this.runWithRecovery('getIndexMetadata', async () => this.readMetadata());
  }

  async clearStorage(): Promise<void> {
    await this.resetIndexStorage();
  }

  async close(): Promise<void> {
    const connection = await this.connectionPromise;
    connection.close();
    instanceCache.delete(this.workspaceRoot);
    this.vectorIndexedTables.clear();
  }

  private async openTable(name: string): Promise<Table | undefined> {
    const connection = await this.connectionPromise;
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(name)) {
      return undefined;
    }
    try {
      return await connection.openTable(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found') || message.includes('was not found')) {
        return undefined;
      }
      throw error;
    }
  }

  private async readTable<T>(name: string): Promise<T[]> {
    const table = await this.openTable(name);
    if (!table) {
      return [];
    }
    return table.query().toArray() as Promise<T[]>;
  }

  private async replaceTable<T extends Record<string, unknown>>(name: string, rows: T[]): Promise<void> {
    const connection = await this.connectionPromise;
    const tableNames = await connection.tableNames();
    if (rows.length === 0) {
      if (tableNames.includes(name)) {
        await connection.dropTable(name);
      }
      return;
    }

    const serializableRows = rows.map((row) => serializeRow(row));

    if (!tableNames.includes(name)) {
      const table = await connection.createTable(name, serializableRows, {
        mode: 'create',
        existOk: true,
      });
      await this.maybeEnsureVectorIndex(name, table, rows);
      return;
    }

    const table = await connection.openTable(name);
    await table.add(serializableRows, { mode: 'overwrite' });
    await this.maybeEnsureVectorIndex(name, table, rows);
  }

  private async appendRows<T extends Record<string, unknown>>(name: string, rows: T[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const connection = await this.connectionPromise;
    const tableNames = await connection.tableNames();
    const serializableRows = rows.map((row) => serializeRow(row));

    if (!tableNames.includes(name)) {
      const table = await connection.createTable(name, serializableRows, {
        mode: 'create',
        existOk: true,
      });
      await this.maybeEnsureVectorIndex(name, table, rows);
      return;
    }

    const table = await connection.openTable(name);
    await table.add(serializableRows, { mode: 'append' });
    await this.maybeEnsureVectorIndex(name, table, rows);
  }

  private async upsertRowsById<T extends Record<string, unknown>>(name: string, rows: T[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const connection = await this.connectionPromise;
    const tableNames = await connection.tableNames();
    const serializableRows = rows.map((row) => serializeRow(row));

    if (!tableNames.includes(name)) {
      const table = await connection.createTable(name, serializableRows, {
        mode: 'create',
        existOk: true,
      });
      await this.maybeEnsureVectorIndex(name, table, rows);
      return;
    }

    const table = await connection.openTable(name);
    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(serializableRows);
    await this.maybeEnsureVectorIndex(name, table, rows);
  }

  private async deleteByFilePaths(name: string, relativeTargets: string[]): Promise<void> {
    if (relativeTargets.length === 0) {
      return;
    }

    const table = await this.openTable(name);
    if (!table) {
      return;
    }

    await table.delete(buildInPredicate('filePath', relativeTargets));
  }

  private async deleteWhere(name: string, predicate: string): Promise<void> {
    const table = await this.openTable(name);
    if (!table) {
      return;
    }

    await table.delete(predicate);
  }

  private async pruneTableByRetention<T extends { id: string; updatedAt: string }>(name: string, limit: number): Promise<void> {
    const table = await this.openTable(name);
    if (!table) {
      return;
    }

    const rows = await table.query().where(`repositoryId = '${escapeSql(this.repositoryId)}'`).toArray() as T[];
    if (rows.length <= limit) {
      return;
    }

    const staleRows = rows
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(limit);
    if (staleRows.length === 0) {
      return;
    }

    await table.delete(buildInPredicate('id', staleRows.map((row) => row.id)));
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

  private getGitMetadata(): { branch: string; commitSha: string } {
    return {
      branch: readGitValue(this.workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'workspace',
      commitSha: readGitValue(this.workspaceRoot, ['rev-parse', '--short', 'HEAD']) ?? 'workspace',
    };
  }

  private async upsertFiles(
    absolutePaths: string[],
    options: { updateRepoSummary: boolean; metadata?: { branch: string; commitSha: string } },
    control?: IndexingControl
  ): Promise<void> {
    if (absolutePaths.length === 0) {
      return;
    }

    const metadata = options.metadata ?? this.getGitMetadata();
    const nextChunks: CodeChunkRecord[] = [];
    const nextDeclarations: CodeDeclarationRecord[] = [];
    const nextRelationships: CodeRelationshipRecord[] = [];
    const nextFileSummaries: FileSummaryRecord[] = [];
    const relativePaths = absolutePaths
      .map((absolutePath) => toRelativeFilePath(this.workspaceRoot, absolutePath))
      .filter((relativePath): relativePath is string => relativePath !== undefined);

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

      const language = getLanguageIdFromPath(relativePath);
      const fileHash = sha256(code);
      const structure = extractCodeStructure(language, code, relativePath);
      const chunks = extractChunksForFile(relativePath, language, code, structure);
      const updatedAt = new Date().toISOString();

      for (const chunk of chunks) {
        nextChunks.push({
          id: `${this.repositoryId}:${relativePath}:${chunk.startLine}-${chunk.endLine}:${fileHash.slice(0, 12)}`,
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
          vector: embedText(`${relativePath}\n${chunk.symbolName ?? ''}\n${chunk.content}`),
          updatedAt,
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
          vector: embedText(`${relativePath}\n${block.kind} ${block.name}\n${block.content}`),
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
        vector: embedText(`${relativePath}\n${summary}`),
        updatedAt,
      });

      if ((index + 1) % YIELD_INTERVAL === 0) {
        await control?.waitIfPaused?.();
        await yieldToEventLoop();
      }
    }

    await control?.waitIfPaused?.();
    await this.deleteByFilePaths(CODE_CHUNKS_TABLE, relativePaths);
    await this.deleteByFilePaths(CODE_DECLARATIONS_TABLE, relativePaths);
    await this.deleteByFilePaths(CODE_RELATIONSHIPS_TABLE, relativePaths);
    await this.deleteByFilePaths(FILE_SUMMARIES_TABLE, relativePaths);
    await this.appendRows(CODE_CHUNKS_TABLE, nextChunks);
    await this.appendRows(CODE_DECLARATIONS_TABLE, nextDeclarations);
    await this.appendRows(CODE_RELATIONSHIPS_TABLE, nextRelationships);
    await this.upsertRowsById(FILE_SUMMARIES_TABLE, nextFileSummaries);
    if (options.updateRepoSummary) {
      await this.writeRepoSummary(await this.readTable<FileSummaryRecord>(FILE_SUMMARIES_TABLE), metadata);
    }
  }

  private async clearIndexedContentTables(): Promise<void> {
    await this.replaceTable(CODE_CHUNKS_TABLE, []);
    await this.replaceTable(CODE_DECLARATIONS_TABLE, []);
    await this.replaceTable(CODE_RELATIONSHIPS_TABLE, []);
    await this.replaceTable(FILE_SUMMARIES_TABLE, []);
    await this.replaceTable(REPO_SUMMARIES_TABLE, []);
  }

  private async writeRepoSummary(fileSummaries: FileSummaryRecord[], metadata: { branch: string; commitSha: string }): Promise<void> {
    const allSummaries = fileSummaries
      .filter((row) => row.repositoryId === this.repositoryId)
      .map((row) => `${row.filePath}: ${row.summary}`);
    const repoSummary = buildRepoSummary(allSummaries);

    await this.upsertRowsById(REPO_SUMMARIES_TABLE, [
      {
        id: this.repositoryId,
        repositoryId: this.repositoryId,
        commitSha: metadata.commitSha,
        branch: metadata.branch,
        summary: repoSummary,
        contentHash: sha256(repoSummary),
        vector: embedText(repoSummary),
        updatedAt: new Date().toISOString(),
      },
    ]);
  }

  private async runWithRecovery<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureStorageCompatible();
      return await operation();
    } catch (error) {
      if (!isRecoverableIndexError(error)) {
        throw error;
      }

      logDebug('Repo knowledge index recovering from failure', {
        workspaceRoot: this.workspaceRoot,
        operationName,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.resetIndexStorage();
      await this.ensureStorageCompatible();
      return operation();
    }
  }

  private async ensureStorageCompatible(): Promise<void> {
    const connection = await this.connectionPromise;
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(INDEX_METADATA_TABLE)) {
      if (tableNames.length > 0) {
        throw new Error('INDEX_METADATA_MISSING');
      }

      await this.writeMetadata('ready');
      return;
    }

    const metadata = await this.readMetadata();
    if (!metadata) {
      throw new Error('INDEX_METADATA_MISSING');
    }

    if (
      metadata.schemaVersion !== INDEX_SCHEMA_VERSION
      || metadata.embeddingVersion !== EMBEDDING_ALGORITHM_VERSION
    ) {
      throw new Error('INDEX_SCHEMA_MISMATCH');
    }
  }

  private async readMetadata(): Promise<IndexMetadataRecord | undefined> {
    const table = await this.openTable(INDEX_METADATA_TABLE);
    if (!table) {
      return undefined;
    }

    const rows = await table
      .query()
      .where(`repositoryId = '${escapeSql(this.repositoryId)}'`)
      .limit(1)
      .toArray() as IndexMetadataRecord[];
    return rows[0];
  }

  private async writeMetadata(status: IndexMetadataRecord['status'], lastError: string = ''): Promise<void> {
    await this.upsertRowsById(INDEX_METADATA_TABLE, [{
      id: this.repositoryId,
      repositoryId: this.repositoryId,
      schemaVersion: INDEX_SCHEMA_VERSION,
      embeddingVersion: EMBEDDING_ALGORITHM_VERSION,
      status,
      updatedAt: new Date().toISOString(),
      lastError,
    }]);
  }

  private async resetIndexStorage(): Promise<void> {
    const existingConnection = await this.connectionPromise.catch(() => undefined);
    try {
      existingConnection?.close();
    } catch {
      // Best effort before removing corrupted storage.
    }

    fs.rmSync(this.dbPath, { recursive: true, force: true });
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.connectionPromise = getLanceDb().connect(this.dbPath);
    this.hasIndexedWorkspace = false;
    this.vectorIndexedTables.clear();
  }

  private async maybeEnsureVectorIndex<T extends Record<string, unknown>>(name: string, table: Table, rows: T[]): Promise<void> {
    if (this.vectorIndexedTables.has(name)) {
      return;
    }

    const sample = rows[0];
    if (!sample || !('vector' in sample)) {
      return;
    }

    await ensureVectorIndex(table);
    this.vectorIndexedTables.add(name);
  }
}

interface ChunkLike {
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

function extractChunksForFile(
  filePath: string,
  language: string,
  code: string,
  structure = extractCodeStructure(language, code, filePath)
): ChunkLike[] {
  if (language === 'json') {
    const schemaChunks = extractJsonSchemaChunks(code);
    if (schemaChunks.length > 0) {
      return schemaChunks;
    }
  }

  const structuredBlocks = structure.blocks;
  if (structuredBlocks.length > 0) {
    return structuredBlocks.map((block) => ({
      symbolName: block.name,
      startLine: block.startLine,
      endLine: block.endLine,
      content: block.content,
    }));
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

function resolveStoragePathForWorkspace(workspaceRoot: string): string {
  if (configuredStorageRoot) {
    return path.join(configuredStorageRoot, 'code-index', buildRepositoryId(workspaceRoot));
  }

  return path.join(workspaceRoot, INDEX_DIRECTORY);
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

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function buildInPredicate(column: string, values: string[]): string {
  return `${column} IN (${values.map((value) => `'${escapeSql(value)}'`).join(', ')})`;
}

function isRecoverableIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('INDEX_METADATA_MISSING')
    || message.includes('INDEX_SCHEMA_MISMATCH')
    || message.includes('Corrupt')
    || message.includes('corrupt')
    || message.includes('Invalid argument')
    || message.includes('Arrow')
    || message.includes('IO error')
    || message.includes('not found')
  );
}

async function ensureVectorIndex(table: Table): Promise<void> {
  try {
    await table.createIndex('vector');
  } catch {
    // Ignore duplicate/index compatibility failures; search still works without it.
  }
}

function serializeRow<T extends Record<string, unknown>>(row: T): T {
  if (!('vector' in row) || !Array.isArray(row.vector)) {
    return row;
  }

  return {
    ...row,
    vector: Float32Array.from(row.vector as number[]),
  };
}
