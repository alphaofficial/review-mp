/// <reference types="node" />

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(),
    })),
  },
  ConfigurationTarget: {
    Workspace: 2,
  },
  SecretStorage: class {},
}));

import { RepoKnowledgeIndex } from '../../src/harness/repoKnowledgeIndex';

type StoredPoint = {
  id: string;
  payload: Record<string, unknown>;
  vector: number[];
};

const tempRoots: string[] = [];
const qdrantCollections = new Map<string, { dimension: number; points: Map<string, StoredPoint> }>();
let ollamaMaxInputLength: number | undefined;

beforeEach(() => {
  qdrantCollections.clear();
  ollamaMaxInputLength = undefined;
  RepoKnowledgeIndex.setDefaultConnectionSettings({
    embedderProvider: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'nomic-embed-text',
    modelDimension: 8,
    qdrantUrl: 'http://localhost:6333',
    searchMinScore: 0.4,
    searchMaxResults: 50,
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('http://localhost:11434')) {
      return handleOllamaRequest(url, init);
    }

    if (url.startsWith('http://localhost:6333')) {
      return handleQdrantRequest(url, init);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
  it('indexes code chunks and retrieves related helper code from Qdrant', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['retrieval/service.ts', 'retrieval/helper.ts']);

    const results = await index.searchCode({
      queryText: 'helper session formatting',
      filePath: 'retrieval/service.ts',
      limit: 3,
    });

    expect(results.some((row) => row.filePath === 'retrieval/helper.ts')).toBe(true);
    const collection = getSingleCollection();
    expect(Array.from(collection.points.keys()).every((id) => isUuid(String(id)))).toBe(true);
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

  it('splits oversized structured chunks before sending them to Ollama', async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-index-'));
    tempRoots.push(workspaceRoot);
    const largeFunctionBody = new Array(120)
      .fill('  const repeatedValue = "abcdefghijklmnopqrstuvwxyz0123456789";')
      .join('\n');
    writeFileSync(
      path.join(workspaceRoot, 'large.ts'),
      `export function largeExample() {\n${largeFunctionBody}\n  return repeatedValue;\n}\n`,
      'utf8'
    );
    ollamaMaxInputLength = 1_200;
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['large.ts']);

    const collection = getSingleCollection();
    const codeChunks = Array.from(collection.points.values())
      .filter((point) => point.payload.recordType === 'code_chunk' && point.payload.filePath === 'large.ts');

    expect(codeChunks.length).toBeGreaterThan(1);
    expect(codeChunks.every((point) => String(point.payload.codeChunk).length <= 1_000)).toBe(true);
  });

  it('repairs schema mismatches by rebuilding the local cache and vector collection', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);

    await index.ensureIndexed(['retrieval/service.ts']);
    const metadataBefore = await index.getIndexMetadata();
    expect(metadataBefore?.status).toBe('ready');

    const statePath = path.join(RepoKnowledgeIndex.getStoragePathForWorkspace(workspaceRoot), 'index-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.metadata.schemaVersion = 0;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

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

    const collection = getSingleCollection();
    const reviewMemoryCount = Array.from(collection.points.values())
      .filter((point) => point.payload.recordType === 'review_memory')
      .length;

    expect(reviewMemoryCount).toBeLessThanOrEqual(100);
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

  it('preserves exact review records when recovering indexed storage metadata', async () => {
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

    const statePath = path.join(RepoKnowledgeIndex.getStoragePathForWorkspace(workspaceRoot), 'index-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    delete state.metadata;
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

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

    const run = await index.getExactReviewRun('review-fingerprint');
    const findings = await index.getExactReviewFindings('review-fingerprint');

    expect(run?.status).toBe('completed');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.findingKey).toBe('finding-key');
  });
});

function handleOllamaRequest(url: string, init?: RequestInit): Response {
  expect(url).toContain('/api/embed');
  const body = JSON.parse(String(init?.body ?? '{}'));
  const input = typeof body.input === 'string' ? body.input : '';
  if (ollamaMaxInputLength !== undefined && input.length > ollamaMaxInputLength) {
    return new Response('{"error":"the input length exceeds the context length"}', {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
  const vector = buildDeterministicVector(input, 8);
  return jsonResponse({
    embeddings: [vector],
  });
}

function handleQdrantRequest(url: string, init?: RequestInit): Response {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const collectionName = segments[1];
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;

  if (!collectionName) {
    throw new Error(`Unexpected Qdrant path: ${parsed.pathname}`);
  }

  if (segments.length === 2 && method === 'GET') {
    const collection = qdrantCollections.get(collectionName);
    if (!collection) {
      return new Response('Not found', { status: 404 });
    }
    return jsonResponse({
      result: {
        config: {
          params: {
            vectors: {
              size: collection.dimension,
            },
          },
        },
      },
    });
  }

  if (segments.length === 2 && method === 'PUT') {
    qdrantCollections.set(collectionName, {
      dimension: body.vectors.size,
      points: new Map(),
    });
    return jsonResponse({ result: true });
  }

  if (segments.length === 2 && method === 'DELETE') {
    qdrantCollections.delete(collectionName);
    return jsonResponse({ result: true });
  }

  const collection = qdrantCollections.get(collectionName);
  if (!collection) {
    return new Response('Not found', { status: 404 });
  }

  if (segments[2] === 'points' && method === 'PUT') {
    for (const point of body.points as StoredPoint[]) {
      collection.points.set(String(point.id), point);
    }
    return jsonResponse({ result: true });
  }

  if (segments[2] === 'points' && segments[3] === 'delete' && method === 'POST') {
    for (const [pointId, point] of collection.points) {
      if (matchesFilter(point.payload, body.filter)) {
        collection.points.delete(pointId);
      }
    }
    return jsonResponse({ result: true });
  }

  if (segments[2] === 'points' && segments[3] === 'query' && method === 'POST') {
    const matches = Array.from(collection.points.values())
      .filter((point) => matchesFilter(point.payload, body.filter))
      .map((point) => ({
        id: point.id,
        payload: point.payload,
        score: cosineSimilarity(point.vector, body.query as number[]),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, body.limit ?? 10);
    return jsonResponse({
      result: {
        points: matches,
      },
    });
  }

  throw new Error(`Unhandled Qdrant request: ${method} ${parsed.pathname}`);
}

function matchesFilter(payload: Record<string, unknown>, filter: any): boolean {
  if (!filter?.must) {
    return true;
  }

  return filter.must.every((condition: any) => payload[condition.key] === condition.match?.value);
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude) || 1);
}

function buildDeterministicVector(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % dimension] += (text.charCodeAt(index) % 17) / 17;
  }
  return vector;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function getSingleCollection() {
  const [collection] = Array.from(qdrantCollections.values());
  if (!collection) {
    throw new Error('Expected a Qdrant collection to exist');
  }
  return collection;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
