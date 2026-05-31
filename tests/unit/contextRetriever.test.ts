/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempWorkspaceFromFixtures(subdirectory: string): string {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'reviewmp-context-'));
  tempRoots.push(tempRoot);
  const source = path.join(process.cwd(), 'tests', 'integration', 'fixtures', subdirectory);
  const target = path.join(tempRoot, subdirectory);
  cpSync(source, target, { recursive: true });
  return tempRoot;
}

function seedGitHistory(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'ReviewMP Tests'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'reviewmp-tests@example.com'], { cwd: workspaceRoot, stdio: 'ignore' });
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
