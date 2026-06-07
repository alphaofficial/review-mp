/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../../src/settings', () => ({
  getSettings: () => ({ codeIndexEnabled: true }),
  logDebug: vi.fn(),
  registerSettingsCommands: vi.fn(),
  setCodeIndexEnabled: vi.fn(),
  showDebugLogs: vi.fn(),
}));

import {
  buildDiffContextEnvelope,
  buildFileContextEnvelope,
  buildPreparedDiffContextEnvelope,
  prepareDiffReviewContext,
} from '../../src/harness/contextRetriever';
import { RepoKnowledgeIndex } from '../../src/harness/repoKnowledgeIndex';

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

afterEach(() => {
  vi.unstubAllGlobals();
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempWorkspaceFromFixtures(subdirectory: string): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebunny-context-'));
  tempRoots.push(tempRoot);
  const source = path.join(process.cwd(), 'tests', 'integration', 'fixtures', subdirectory);
  const target = path.join(tempRoot, subdirectory);
  cpSync(source, target, { recursive: true });
  return tempRoot;
}

function seedGitHistory(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'CodeBunny Tests'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'codebunny-tests@example.com'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial retrieval fixtures'], { cwd: workspaceRoot, stdio: 'ignore' });

  const servicePath = path.join(workspaceRoot, 'retrieval', 'service.ts');
  const helperPath = path.join(workspaceRoot, 'retrieval', 'helper.ts');
  const originalService = readFileSync(servicePath, 'utf8');
  const originalHelper = readFileSync(helperPath, 'utf8');

  writeFileSync(
    servicePath,
    `${originalService}\n// recent session validation change\n`,
    'utf8'
  );
  execFileSync('git', ['add', 'retrieval/service.ts'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Tighten session service validation'], { cwd: workspaceRoot, stdio: 'ignore' });

  writeFileSync(
    helperPath,
    `${originalHelper}\n// helper cleanup\n`,
    'utf8'
  );
  execFileSync('git', ['add', 'retrieval/helper.ts'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Refine helper output handling'], { cwd: workspaceRoot, stdio: 'ignore' });
}

describe('buildDiffContextEnvelope', () => {
  it('includes only related changed files and trims to budget', async () => {
    const formattedDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
+import { helper } from './b';
+const value = helper();
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
+export const helper = () => true;
diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,3 @@
+export const unrelated = true;`;

    const envelope = await buildDiffContextEnvelope({
      formattedDiff,
      primaryFiles: ['src/a.ts'],
      maxContextChars: 500,
    });

    expect(envelope.files.map((file) => file.filePath)).toContain('src/b.ts');
    expect(envelope.files.map((file) => file.filePath)).not.toContain('src/c.ts');
    expect(envelope.files[0].filePath).toBe('(diff manifest)');
    expect(envelope.totalChars).toBeLessThanOrEqual(500);
  });

  it('builds shared diff context once and reuses it across unit envelopes', async () => {
    const formattedDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
+import { helper } from './b';
+const value = helper();
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
+export const helper = () => true;`;
    const runContext = await prepareDiffReviewContext({
      formattedDiff,
    });

    const firstEnvelope = await buildPreparedDiffContextEnvelope(runContext, {
      primaryFiles: ['src/a.ts'],
      maxContextChars: 1000,
    });
    const secondEnvelope = await buildPreparedDiffContextEnvelope(runContext, {
      primaryFiles: ['src/b.ts'],
      maxContextChars: 1000,
    });

    expect(runContext.reviewableFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(firstEnvelope.text).toContain('Reviewable changed files in run: 2');
    expect(secondEnvelope.text).toContain('Current review files (1)');
  });

  it('retrieves unchanged imported files, semantic matches, and sibling tests from disk for ts/js reviews', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    seedGitHistory(workspaceRoot);
    await (await RepoKnowledgeIndex.forWorkspace(workspaceRoot)).rebuildWorkspace();
    const fullCode = readFileSync(path.join(workspaceRoot, 'retrieval', 'service.ts'), 'utf8');

    const envelope = await buildFileContextEnvelope({
      workspaceRoot,
      filePath: 'retrieval/service.ts',
      languageId: 'typescript',
      fullCode,
      unitCode: fullCode,
      maxContextChars: 10_000,
    });

    expect(envelope.files.map((file) => file.filePath)).toContain('retrieval/helper.ts');
    expect(envelope.files.map((file) => file.filePath)).toContain('retrieval/service.test.ts');
    const helperEntry = envelope.files.find((file) => file.filePath === 'retrieval/helper.ts');
    expect(helperEntry?.content).toContain('export function helper()');
    expect(helperEntry?.content).not.toContain("describe('buildService'");
    expect(envelope.text).toContain('Recent commits touching retrieval/service.ts');
    expect(envelope.text).toContain('File retrieval/service.ts');
  });

  it('includes recent commit summaries for diff-scoped primary files without scanning unrelated history', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('retrieval');
    seedGitHistory(workspaceRoot);
    const formattedDiff = `diff --git a/retrieval/service.ts b/retrieval/service.ts
--- a/retrieval/service.ts
+++ b/retrieval/service.ts
@@ -1,2 +1,3 @@
+export const changed = true;
diff --git a/retrieval/helper.ts b/retrieval/helper.ts
--- a/retrieval/helper.ts
+++ b/retrieval/helper.ts
@@ -1,2 +1,3 @@
+export const helperChanged = true;`;

    const envelope = await buildDiffContextEnvelope({
      formattedDiff,
      primaryFiles: ['retrieval/service.ts'],
      workspaceRoot,
      maxContextChars: 8_000,
    });

    expect(envelope.text).toContain('Skipped changed files in run: 0');
    expect(
      envelope.files.some(
        (file) => file.reason === 'recent-change' && file.filePath === 'retrieval/service.ts'
      )
    ).toBe(true);
    expect(envelope.text).toContain('Recent commits touching retrieval/service.ts');
    expect(envelope.text).not.toContain('Recent commits touching retrieval/unrelated.ts');
  });

  it('retrieves referenced schemas and semantic review memory for json reviews', async () => {
    const workspaceRoot = createTempWorkspaceFromFixtures('.');
    await (await RepoKnowledgeIndex.forWorkspace(workspaceRoot)).rebuildWorkspace();
    const schemaFixturePath = path.join(workspaceRoot, 'schema.json');
    const fullCode = readFileSync(schemaFixturePath, 'utf8');
    const unitCode = `"ReviewListResponse": {
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/Review"
      }
    },
    "page": {
      "$ref": "#/components/schemas/PageInfo"
    }
    }
}`;

    const envelope = await buildFileContextEnvelope({
      workspaceRoot,
      filePath: 'schema.json',
      languageId: 'json',
      fullCode,
      unitCode,
      pathHint: 'components > schemas > ReviewListResponse',
      maxContextChars: 10_000,
    });

    expect(envelope.text).toContain('Referenced schema: Review');
    expect(envelope.text).toContain('Referenced schema: PageInfo');
    expect(envelope.text).toContain('Repository');
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
