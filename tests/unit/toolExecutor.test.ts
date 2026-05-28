import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor, createToolExecutor, ToolName } from '../../src/harness/toolExecutor';

vi.mock('vscode', () => ({
  workspace: {
    findFiles: vi.fn(),
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
    workspaceFolders: [{ uri: { fsPath: '/Users/testuser/project' } }],
  },
  RelativePattern: vi.fn(),
}));

const mockSpawn = vi.hoisted(() => {
  const mockProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return vi.fn(() => mockProc);
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const createMockWorkspace = (): string => {
  return '/Users/testuser/project';
};

const createMockProc = (stdout: string, code: number = 0) => {
  return {
    stdout: { on: vi.fn((event, cb) => { if (event === 'data') cb(stdout); }) },
    stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb(''); }) },
    on: vi.fn((event, cb) => {
      if (event === 'close') cb(code);
      if (event === 'error') cb(new Error('spawn error'));
    }),
    kill: vi.fn(),
  };
};

describe('ToolExecutor', () => {
  let executor: ToolExecutor;
  let mockWorkspace: string;

  beforeEach(() => {
    mockWorkspace = createMockWorkspace();
    executor = new ToolExecutor({ workspaceRoot: mockWorkspace });
    vi.clearAllMocks();
  });

  describe('isAllowedTool', () => {
    it('should return true for allowed tools', () => {
      const allowedTools: ToolName[] = [
        'read_file',
        'search_workspace',
        'list_related_files',
        'git_diff',
        'git_log',
        'package_metadata',
      ];

      for (const tool of allowedTools) {
        expect(executor.isAllowedTool(tool)).toBe(true);
      }
    });

    it('should return false for unknown tools', () => {
      expect(executor.isAllowedTool('shell_exec')).toBe(false);
      expect(executor.isAllowedTool('delete_file')).toBe(false);
      expect(executor.isAllowedTool('write_file')).toBe(false);
    });
  });

  describe('read_file', () => {
    it('should return error when path is missing', async () => {
      const result = await executor.execute({ tool: 'read_file', args: {} });

      expect(result.tool).toBe('read_file');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Missing required parameter: path');
    });

    it('should return error for paths outside workspace', async () => {
      const result = await executor.execute({
        tool: 'read_file',
        args: { path: '/etc/passwd' },
      });

      expect(result.tool).toBe('read_file');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Path outside workspace');
    });

    it('should execute read_file for valid paths', async () => {
      const fs = await import('fs');
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 100 });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('const x = 1;');

      const result = await executor.execute({
        tool: 'read_file',
        args: { path: 'test.ts' },
      });

      expect(result.tool).toBe('read_file');
      expect(result.error).toBeUndefined();
    });

    it('should return error when file is too large', async () => {
      const fs = await import('fs');
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 200 * 1024 });

      const result = await executor.execute({
        tool: 'read_file',
        args: { path: 'test.ts' },
      });

      expect(result.tool).toBe('read_file');
      expect(result.result).toBeNull();
      expect(result.error).toContain('File too large');
    });
  });

  describe('search_workspace', () => {
    it('should return error when pattern is missing', async () => {
      const result = await executor.execute({ tool: 'search_workspace', args: {} });

      expect(result.tool).toBe('search_workspace');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Missing required parameter: pattern');
    });

    it('should execute search_workspace with valid pattern', async () => {
      const vscode = await import('vscode');
      const mockFiles = [
        { fsPath: '/Users/testuser/project/src/index.ts' },
        { fsPath: '/Users/testuser/project/src/app.ts' },
      ];
      (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue(mockFiles);

      const result = await executor.execute({
        tool: 'search_workspace',
        args: { pattern: '**/*.ts' },
      });

      expect(result.tool).toBe('search_workspace');
      expect(result.error).toBeUndefined();
    });
  });

  describe('list_related_files', () => {
    it('should return error when filePath is missing', async () => {
      const result = await executor.execute({ tool: 'list_related_files', args: {} });

      expect(result.tool).toBe('list_related_files');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Missing required parameter: filePath');
    });

    it('should return error for paths outside workspace', async () => {
      const result = await executor.execute({
        tool: 'list_related_files',
        args: { filePath: '/etc/passwd' },
      });

      expect(result.tool).toBe('list_related_files');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Path outside workspace');
    });
  });

  describe('git_diff', () => {
    it('should execute git_diff with target', async () => {
      mockSpawn.mockReturnValue(createMockProc('diff output'));

      const result = await executor.execute({
        tool: 'git_diff',
        args: { target: 'feature-branch' },
      });

      expect(result.tool).toBe('git_diff');
      expect(result.error).toBeUndefined();
    });

    it('should handle git errors', async () => {
      mockSpawn.mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb('fatal: not a git repository'); }) },
        on: vi.fn((event, cb) => { if (event === 'close') cb(128); }),
        kill: vi.fn(),
      });

      const result = await executor.execute({
        tool: 'git_diff',
        args: { target: 'feature-branch' },
      });

      expect(result.tool).toBe('git_diff');
      expect(result.error).toBeTruthy();
    });
  });

  describe('git_log', () => {
    it('should execute git_log with maxCount constraint', async () => {
      mockSpawn.mockReturnValue(createMockProc(
        'abc123|feat: add feature|Test User|2024-01-15\ndef456|fix: bug|Number|2024-01-14'
      ));

      const result = await executor.execute({
        tool: 'git_log',
        args: { maxCount: 10 },
      });

      expect(result.tool).toBe('git_log');
      expect(result.error).toBeUndefined();
    });

    it('should return error for paths outside workspace in git_log file parameter', async () => {
      const result = await executor.execute({
        tool: 'git_log',
        args: { file: '/etc/passwd' },
      });

      expect(result.tool).toBe('git_log');
      expect(result.result).toBeNull();
      expect(result.error).toBe('Path outside workspace');
    });
  });

  describe('package_metadata', () => {
    it('should return error when package.json not found', async () => {
      const fs = await import('fs');
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await executor.execute({
        tool: 'package_metadata',
        args: {},
      });

      expect(result.tool).toBe('package_metadata');
      expect(result.result).toBeNull();
      expect(result.error).toBe('package.json not found');
    });

    it('should execute package_metadata when package.json exists', async () => {
      const fs = await import('fs');
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        scripts: { test: 'vitest' },
        dependencies: { lodash: '^4.17.21' },
        devDependencies: {},
      }));

      const result = await executor.execute({
        tool: 'package_metadata',
        args: {},
      });

      expect(result.tool).toBe('package_metadata');
      expect(result.error).toBeUndefined();
    });

    it('should filter out irrelevant package.json fields', async () => {
      const fs = await import('fs');
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        description: 'A test project',
        main: 'dist/index.js',
        scripts: { test: 'vitest', build: 'tsc' },
        dependencies: { lodash: '^4.17.21' },
        devDependencies: { typescript: '^5.0.0' },
        author: 'Test Author',
        license: 'MIT',
        repository: { type: 'git', url: 'https://github.com/test/repo' },
        keywords: ['test', 'project'],
      }));

      const result = await executor.execute({
        tool: 'package_metadata',
        args: {},
      }) as any;

      expect(result.result).toHaveProperty('name', 'test-project');
      expect(result.result).toHaveProperty('version', '1.0.0');
      expect(result.result).toHaveProperty('description', 'A test project');
      expect(result.result).toHaveProperty('main', 'dist/index.js');
      expect(result.result).toHaveProperty('scripts');
      expect(result.result.scripts).toEqual(['test', 'build']);
      expect(result.result).toHaveProperty('dependencies');
      expect(result.result.dependencies).toEqual(['lodash']);
      expect(result.result).toHaveProperty('devDependencies');
      expect(result.result.devDependencies).toEqual(['typescript']);
    });
  });

  describe('executeAll', () => {
    it('should execute multiple tool requests', async () => {
      const fs = await import('fs');
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        scripts: {},
        dependencies: {},
        devDependencies: {},
      }));

      const requests = [
        { tool: 'package_metadata', args: {} },
        { tool: 'read_file', args: { path: 'test.ts' } },
      ];

      const results = await executor.executeAll(requests);

      expect(results).toHaveLength(2);
      expect(results[0].tool).toBe('package_metadata');
    });

    it('should stop execution on error', async () => {
      const fs = await import('fs');
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const requests = [
        { tool: 'package_metadata', args: {} },
        { tool: 'read_file', args: { path: 'test.ts' } },
      ];

      const results = await executor.executeAll(requests);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('package_metadata');
    });
  });

  describe('path resolution', () => {
    it('should resolve relative paths within workspace', async () => {
      const fs = await import('fs');
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 50 });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('content');

      const result = await executor.execute({
        tool: 'read_file',
        args: { path: 'src/test.ts' },
      });

      expect(result.tool).toBe('read_file');
    });

    it('should handle absolute paths', async () => {
      const fs = await import('fs');
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 50 });
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('content');

      const result = await executor.execute({
        tool: 'read_file',
        args: { path: '/Users/testuser/project/test.ts' },
      });

      expect(result.tool).toBe('read_file');
    });
  });

  describe('unknown tool handling', () => {
    it('should return error for unknown tool', async () => {
      const result = await executor.execute({
        tool: 'execute_command',
        args: {},
      });

      expect(result.tool).toBe('execute_command');
      expect(result.result).toBeNull();
      expect(result.error).toContain('Unknown tool');
    });
  });
});

describe('createToolExecutor', () => {
  it('should create executor with default config', () => {
    const executor = createToolExecutor('/test/workspace');

    expect(executor).toBeInstanceOf(ToolExecutor);
    expect(executor.isAllowedTool('read_file')).toBe(true);
    expect(executor.isAllowedTool('git_diff')).toBe(true);
  });
});
