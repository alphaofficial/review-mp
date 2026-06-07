import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentFixService } from '../../src/harness/agentFixService';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
    openTextDocument: vi.fn(),
  },
  Uri: {
    file: vi.fn((fsPath: string) => ({ fsPath })),
  },
}));

function createDocument(filePath: string) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  return {
    isDirty: false,
    save: vi.fn().mockResolvedValue(true),
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  };
}

describe('AgentFixService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    vi.clearAllMocks();
  });

  beforeEach(() => {
    (vscode.workspace.openTextDocument as any).mockImplementation(async (uri: { fsPath: string }) => createDocument(uri.fsPath));
  });

  it('applies a targeted agent fix to the workspace file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebunny-agent-fix-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'example.ts');
    fs.writeFileSync(filePath, ['if (', '  config.enabled &&', '  config?.accountId &&', '  config?.projectId', ') {', '}'].join('\n'));

    const provider = {
      name: 'Codex',
      isAvailable: vi.fn().mockResolvedValue(true),
      runAgentTask: vi.fn().mockImplementation(async (_prompt: string) => {
        fs.writeFileSync(filePath, ['if (', '  config?.enabled && config?.accountId && config?.projectId', ') {', '}'].join('\n'));
        return 'Changed target file. Verification: passed.';
      }),
    } as any;

    const service = new AgentFixService(() => provider);
    const result = await service.applyFindingFix(filePath, {
      id: 'finding-1',
      line: 1,
      message: 'Use consistent optional chaining.',
      title: 'Normalize optional chaining',
      fix: 'config?.enabled && config?.accountId && config?.projectId',
      severity: 'warning',
    });

    expect(result.success).toBe(true);
    expect(result.warning).toContain('Verification: passed.');
    expect(provider.runAgentTask).toHaveBeenCalledTimes(1);
    expect(provider.runAgentTask.mock.calls[0][0]).toContain(`Edit ONLY this file: ${filePath}`);
    expect(provider.runAgentTask.mock.calls[0][0]).toContain('Use consistent optional chaining.');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('config?.enabled && config?.accountId && config?.projectId');
  });

  it('fails when the agent exits without changing the target file', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebunny-agent-fix-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'example.ts');
    fs.writeFileSync(filePath, 'const value = config.enabled;\n');

    const provider = {
      name: 'Codex',
      isAvailable: vi.fn().mockResolvedValue(true),
      runAgentTask: vi.fn().mockResolvedValue('No changes needed. Verification: not run.'),
    } as any;

    const service = new AgentFixService(() => provider);
    const result = await service.applyFindingFix(filePath, {
      id: 'finding-2',
      line: 0,
      message: 'Guard the config access.',
      severity: 'warning',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Agent finished without changing the target file');
  });
});
