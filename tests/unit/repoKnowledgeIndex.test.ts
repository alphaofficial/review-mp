/// <reference types="node" />

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoKnowledgeIndex } from '../../src/harness/repoKnowledgeIndex';

const tempRoots: string[] = [];

afterEach(async () => {
  for (const tempRoot of tempRoots.splice(0)) {
    const index = await RepoKnowledgeIndex.forWorkspace(tempRoot);
    await index.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempWorkspaceFromFixtures(subdirectory: string): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-index-'));
  tempRoots.push(tempRoot);
  const source = path.join(process.cwd(), 'tests', 'integration', 'fixtures', subdirectory);
  const target = path.join(tempRoot, subdirectory);
  cpSync(source, target, { recursive: true });
  return tempRoot;
}

describe('RepoKnowledgeIndex', () => {
  it('indexes code chunks and retrieves related helper code from LanceDB', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['retrieval/service.ts', 'retrieval/helper.ts']);

    const results = await index.searchCode({
      queryText: 'helper session formatting',
      filePath: 'retrieval/service.ts',
      limit: 3,
    });

    expect(results.some((row) => row.filePath === 'retrieval/helper.ts')).toBe(true);
  });

  it('stores and retrieves review memory records', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.upsertReviewMemory({
      id: 'finding-1',
      findingId: 'finding-1',
      filePath: 'retrieval/service.ts',
      ruleId: 'session-rule',
      comment: 'Avoid leaking session tokens through helper output',
      outcome: 'fixed',
      line: 12,
      severity: 'warning',
    });

    const results = await index.searchReviewMemory({
      queryText: 'session token helper output',
      filePath: 'retrieval/service.ts',
      limit: 2,
    });

    expect(results[0]?.comment).toContain('session tokens');
    expect(results[0]?.outcome).toBe('fixed');
  });

  it('returns relevant review memories from other files when a file path is supplied', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.upsertReviewMemory({
      id: 'cross-file-finding',
      findingId: 'cross-file-finding',
      filePath: 'retrieval/helper.ts',
      ruleId: 'cross-file-rule',
      comment: 'Sanitize session token helper output before service returns it',
      outcome: 'fixed',
      line: 4,
      severity: 'warning',
    });

    const results = await index.searchReviewMemory({
      queryText: 'sanitize session token helper output',
      filePath: 'retrieval/service.ts',
      limit: 3,
    });

    expect(results.some((row) => row.filePath === 'retrieval/helper.ts')).toBe(true);
  });

  it('does not index absolute paths outside the workspace with a shared prefix', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const outsidePath = `${workspaceRoot}-outside.ts`;
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.indexFiles([outsidePath]);

    const results = await index.searchCode({
      queryText: 'outside',
      limit: 10,
    });

    expect(results.some((row) => row.filePath.includes('outside'))).toBe(false);
  });

  it('ignores incremental candidates inside ignored directories', async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-index-'));
    tempRoots.push(workspaceRoot);
    mkdirSync(path.join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, 'node_modules', 'pkg', 'index.ts'),
      'export const vendoredOnlySymbol = "vendored-only-symbol";\n',
      'utf8'
    );
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.indexFiles(['node_modules/pkg/index.ts']);

    const results = await index.searchCode({
      queryText: 'vendored-only-symbol',
      limit: 10,
    });

    expect(results.some((row) => row.filePath === 'node_modules/pkg/index.ts')).toBe(false);
  });

  it('creates file and repo summaries during indexing', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['retrieval/service.ts']);

    const fileSummary = await index.getFileSummary('retrieval/service.ts');
    const repoSummary = await index.getRepoSummary();
    const originalFile = readFileSync(path.join(workspaceRoot, 'retrieval', 'service.ts'), 'utf8');

    expect(fileSummary?.summary).toContain('retrieval/service.ts');
    expect(repoSummary?.summary).toContain('indexed files');
    expect(originalFile).toContain('buildService');
  });

  it('persists multi-language declarations and relationships in the code graph', async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-index-'));
    tempRoots.push(workspaceRoot);
    writeFileSync(
      path.join(workspaceRoot, 'service.py'),
      `from .helper import build_value

class Service:
    def run(self):
        return build_value()
`,
      'utf8'
    );
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['service.py']);

    const declarations = await index.getDeclarationsForFile('service.py');
    const relationships = await index.getRelationshipsForFile('service.py');

    expect(declarations.some((declaration) => declaration.symbolName === 'Service')).toBe(true);
    expect(relationships.some((relationship) => relationship.kind === 'imports' && relationship.targetPath === './helper')).toBe(true);
  });

  it('writes index metadata and repairs schema mismatches by rebuilding the local index', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['retrieval/service.ts']);
    const metadataBefore = await index.getIndexMetadata();
    expect(metadataBefore?.status).toBe('ready');

    const connection = await lancedb.connect(path.join(workspaceRoot, '.codebunny', 'lancedb'));
    const metadataTable = await connection.openTable('index_metadata');
    await metadataTable.update({
      where: `repositoryId = '${metadataBefore?.repositoryId}'`,
      values: { schemaVersion: 0 },
    });
    connection.close();

    await index.ensureIndexed(['retrieval/service.ts']);

    const metadataAfter = await index.getIndexMetadata();
    const results = await index.searchCode({
      queryText: 'build service helper',
      filePath: 'retrieval/service.ts',
      limit: 3,
    });

    expect(metadataAfter?.status).toBe('ready');
    expect(metadataAfter?.schemaVersion).toBeGreaterThan(0);
    expect(results.some((row) => row.filePath === 'retrieval/service.ts')).toBe(true);
  });

  it('caps retained review memory rows instead of growing without bound', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    for (let indexNumber = 0; indexNumber < 105; indexNumber += 1) {
      await index.upsertReviewMemory({
        id: `finding-${indexNumber}`,
        findingId: `finding-${indexNumber}`,
        filePath: 'retrieval/service.ts',
        ruleId: null,
        comment: `Repeated finding ${indexNumber}`,
        outcome: 'accepted',
        line: indexNumber,
        severity: 'warning',
      });
    }

    const connection = await lancedb.connect(path.join(workspaceRoot, '.codebunny', 'lancedb'));
    const table = await connection.openTable('review_comments');
    const rows = await table.query().toArray() as Array<{ id: string }>;
    connection.close();

    expect(rows.length).toBeLessThanOrEqual(100);
  }, 20_000);

  it('stores exact review runs, units, and findings for deterministic reuse', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.upsertExactReviewRun({
      id: 'review-fingerprint',
      reviewFingerprint: 'review-fingerprint',
      targetKind: 'diff',
      filePaths: JSON.stringify(['retrieval/service.ts']),
      unitFingerprints: JSON.stringify(['unit-fingerprint']),
      findingCount: 1,
      status: 'completed',
    });
    await index.upsertExactReviewUnit({
      id: 'unit-fingerprint',
      unitFingerprint: 'unit-fingerprint',
      reviewFingerprint: 'review-fingerprint',
      targetKind: 'diff',
      filePaths: JSON.stringify(['retrieval/service.ts']),
      findingCount: 1,
    });
    await index.replaceExactReviewFindings('review-fingerprint', [{
      id: 'review-fingerprint:finding-key',
      reviewFingerprint: 'review-fingerprint',
      unitFingerprint: 'unit-fingerprint',
      findingKey: 'finding-key',
      filePath: 'retrieval/service.ts',
      line: 9,
      title: 'Leaked token',
      message: 'Avoid leaking tokens from the service response',
      fix: '',
      severity: 'warning',
      outcome: 'pending',
    }]);

    const run = await index.getExactReviewRun('review-fingerprint');
    const runFindings = await index.getExactReviewFindings('review-fingerprint');
    const unit = await index.getExactReviewUnit('unit-fingerprint');
    const unitFindings = await index.getExactReviewUnitFindings('unit-fingerprint');

    expect(run?.status).toBe('completed');
    expect(runFindings).toHaveLength(1);
    expect(runFindings[0]?.message).toContain('Avoid leaking tokens');
    expect(unit?.reviewFingerprint).toBe('review-fingerprint');
    expect(unitFindings).toHaveLength(1);
    expect(unitFindings[0]?.findingKey).toBe('finding-key');
  });
});
