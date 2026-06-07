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

afterEach(async () => {
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

    const index = await RepoKnowledgeIndex.forWorkspace(workspaceRoot);
    let memories = await waitForMemory(index, 'auth state leak', 'service.ts');

    expect(memories[0]?.comment).toContain('Do not leak auth state');
    expect(memories[0]?.outcome).toBe('accepted');

    const exactRun = await index.getExactReviewRun('file-fingerprint');
    const exactFindings = await index.getExactReviewFindings('file-fingerprint');
    expect(exactRun?.status).toBe('completed');
    expect(exactFindings).toHaveLength(1);
    expect(exactFindings[0]?.message).toContain('Do not leak auth state');

    store.updateFindingStatus(finding.id, 'apply');
    await new Promise((resolve) => setTimeout(resolve, 100));
    memories = await waitForMemory(index, 'auth state leak', 'service.ts', 'fixed');

    expect(memories.some((memory) => memory.outcome === 'fixed')).toBe(true);
    const updatedExactFindings = await index.getExactReviewFindings('file-fingerprint');
    expect(updatedExactFindings[0]?.outcome).toBe('applied');
    recorder.dispose();
  });
});
