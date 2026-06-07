/// <reference types="node" />

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn().mockReturnValue({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  workspace: {
    getConfiguration: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(),
  },
}));

vi.mock('../../src/settings', () => ({
  getSettings: () => ({ codeIndexEnabled: true }),
  logDebug: vi.fn(),
  registerSettingsCommands: vi.fn(),
  setCodeIndexEnabled: vi.fn(),
  showDebugLogs: vi.fn(),
}));

import { ReviewKnowledgeRecorder } from '../../src/harness/reviewKnowledgeRecorder';
import { RepoKnowledgeIndex } from '../../src/harness/repoKnowledgeIndex';
import { createReviewSessionStore, resetReviewSessionStore } from '../../src/store/reviewSessionStore';

const tempRoots: string[] = [];
const qdrantCollections = new Map<string, { dimension: number; points: Map<string, StoredPoint> }>();

type StoredPoint = {
  id: string;
  payload: Record<string, unknown>;
  vector: number[];
};

beforeEach(() => {
  qdrantCollections.clear();
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
  resetReviewSessionStore();
  for (const tempRoot of tempRoots.splice(0)) {
    const index = await RepoKnowledgeIndex.forWorkspace(tempRoot);
    await index.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempWorkspace(): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-recorder-'));
  tempRoots.push(tempRoot);
  writeFileSync(path.join(tempRoot, 'service.ts'), 'export function buildService() { return true; }\n');
  return tempRoot;
}

async function waitForMemory(index: RepoKnowledgeIndex, queryText: string, filePath: string, outcome?: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const memories = await index.searchReviewMemory({
      queryText,
      filePath,
      limit: 2,
    });
    if (memories.length > 0 && (!outcome || memories.some((memory) => memory.outcome === outcome))) {
      return memories;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return [];
}

async function waitForExactRun(index: RepoKnowledgeIndex, reviewFingerprint: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await index.getExactReviewRun(reviewFingerprint);
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return undefined;
}

describe('ReviewKnowledgeRecorder', () => {
  it('persists session findings into review memory on completion and updates outcomes', async () => {
    const workspaceRoot = createTempWorkspace();
    const store = createReviewSessionStore();
    const recorder = new ReviewKnowledgeRecorder(store, workspaceRoot);

    store.createSession('file');
    store.setSessionReviewMetadata({
      reviewFingerprint: 'file-fingerprint',
      reviewTargetKind: 'file',
      unitFingerprints: ['file-unit-fingerprint'],
    });
    store.addFinding('service.ts', 3, 'Do not leak auth state', 'warning');
    const finding = store.getActiveSession()!.findings[0];
    store.transitionSession('startSetup');
    store.transitionSession('beginAnalysis');
    store.transitionSession('complete');
    await (recorder as any).onSessionCompleted({ sessionId: store.getSessionHistory()[0].sessionId });

    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);
    let memories = await waitForMemory(index, 'auth state leak', 'service.ts');

    expect(memories[0]?.comment).toContain('Do not leak auth state');
    expect(memories[0]?.outcome).toBe('accepted');

    const exactRun = await waitForExactRun(index, 'file-fingerprint');
    const exactFindings = await index.getExactReviewFindings('file-fingerprint');
    expect(exactRun?.status).toBe('completed');
    expect(exactFindings).toHaveLength(1);
    expect(exactFindings[0]?.message).toContain('Do not leak auth state');

    store.updateFindingStatus(finding.id, 'apply');
    await (recorder as any).onFindingUpdated({ sessionId: store.getSessionHistory()[0].sessionId, findingId: finding.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    memories = await waitForMemory(index, 'auth state leak', 'service.ts', 'fixed');

    expect(memories.some((memory) => memory.outcome === 'fixed')).toBe(true);
    const updatedExactFindings = await index.getExactReviewFindings('file-fingerprint');
    expect(updatedExactFindings[0]?.outcome).toBe('applied');
    recorder.dispose();
  });
});

function handleOllamaRequest(url: string, init?: RequestInit): Response {
  expect(url).toContain('/api/embed');
  const body = JSON.parse(String(init?.body ?? '{}'));
  const input = typeof body.input === 'string' ? body.input : '';
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
