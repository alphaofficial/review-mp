import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CustomCliProvider, CliOutputMode, CustomCliConfig } from '../../src/providers/customCli';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          provider: 'opencode',
          opencodePath: 'opencode',
          model: '',
          autoReviewOnStage: false,
          autoReviewOnCommit: false,
          debug: false,
          customCliCommand: '',
          customCliArgs: '',
          openaiCompatibleEndpoint: '',
        };
        return config[key] ?? defaultValue;
      }),
    })),
  },
}));

const mockSpawn = vi.hoisted(() => {
  const mockProc = {
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return vi.fn(() => mockProc);
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

describe('CustomCliProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates provider with default name', () => {
      const provider = new CustomCliProvider();
      expect(provider.name).toBe('custom-cli');
    });

    it('accepts config override', () => {
      const config: CustomCliConfig = {
        command: '/usr/bin/my-cli',
        args: '--json --verbose',
        outputMode: 'json',
        promptViaStdin: true,
      };
      const provider = new CustomCliProvider(config);
      expect(provider).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('returns false when command is not configured', async () => {
      const provider = new CustomCliProvider({ command: '' });
      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });

    it('returns true when command is configured', async () => {
      const provider = new CustomCliProvider({ command: '/usr/bin/my-cli' });
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });
  });

  describe('cancel', () => {
    it('kills the current process', () => {
      const mockProc = {
        pid: 12345,
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { write: vi.fn(), end: vi.fn() },
        on: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc);

      const provider = new CustomCliProvider();
      (provider as any).currentProcess = mockProc;

      provider.cancel();

      expect(mockProc.kill).toHaveBeenCalled();
    });

    it('does nothing when no process is running', () => {
      const provider = new CustomCliProvider();
      provider.cancel();
    });
  });

  describe('parseArgsString', () => {
    it('parses space-separated arguments', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).parseArgsString('--flag --value test');
      expect(args).toEqual(['--flag', '--value', 'test']);
    });

    it('parses quoted arguments', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).parseArgsString('--flag "hello world" --value');
      expect(args).toEqual(['--flag', 'hello world', '--value']);
    });

    it('handles single-quoted arguments', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).parseArgsString("--flag 'hello world'");
      expect(args).toEqual(['--flag', 'hello world']);
    });

    it('ignores extra whitespace', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).parseArgsString('  --flag   --value  ');
      expect(args).toEqual(['--flag', '--value']);
    });

    it('handles empty string', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).parseArgsString('');
      expect(args).toEqual([]);
    });
  });

  describe('buildArgs', () => {
    it('appends prompt to parsed args', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).buildArgs('--json --verbose', 'the prompt');
      expect(args).toEqual(['--json', '--verbose', 'the prompt']);
    });

    it('returns only prompt when args is empty', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).buildArgs('', 'the prompt');
      expect(args).toEqual(['the prompt']);
    });

    it('returns only prompt when args is whitespace', () => {
      const provider = new CustomCliProvider();
      const args = (provider as any).buildArgs('   ', 'the prompt');
      expect(args).toEqual(['the prompt']);
    });
  });

  describe('parseOutput', () => {
    it('parses JSON array output', () => {
      const provider = new CustomCliProvider();
      const output = '[{"line": 1, "message": "Test issue"}]';
      const comments = (provider as any).parseOutput(output, 'test.ts', 'json');

      expect(comments).toHaveLength(1);
      expect(comments[0].file).toBe('test.ts');
      expect(comments[0].line).toBe(0);
      expect(comments[0].message).toBe('Test issue');
    });

    it('parses text output containing JSON', () => {
      const provider = new CustomCliProvider();
      const output = 'Some text before\n[{"line": 5, "message": "Issue found"}]\nSome text after';
      const comments = (provider as any).parseOutput(output, 'test.ts', 'text');

      expect(comments.length).toBeGreaterThan(0);
    });

    it('parses NDJSON output', () => {
      const provider = new CustomCliProvider();
      const output = '{"line": 1, "message": "Issue 1"}\n{"line": 2, "message": "Issue 2"}';
      const comments = (provider as any).parseOutput(output, 'test.ts', 'ndjson');

      expect(comments).toHaveLength(2);
    });
  });

  describe('CliOutputMode type', () => {
    it('accepts valid output modes', () => {
      const modes: CliOutputMode[] = ['text', 'json', 'ndjson'];
      expect(modes).toBeDefined();
    });
  });

  describe('CustomCliConfig interface', () => {
    it('accepts valid config structure', () => {
      const config: CustomCliConfig = {
        command: '/usr/bin/my-cli',
        args: '--json',
        outputMode: 'json',
        promptViaStdin: true,
        model: 'gpt-4',
      };
      expect(config.command).toBe('/usr/bin/my-cli');
    });
  });
});

describe('CustomCliProvider process execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockProcess = (stdoutData: string = '[{"line": 1, "message": "Test"}]', closeCode: number = 0) => {
    return {
      pid: 12345,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, cb) => {
        if (event === 'data') {
          cb(Buffer.from(stdoutData));
        }
      }) },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === 'close') {
          cb(closeCode, null);
        }
      }),
    };
  };

  it('spawns process with correct command and args', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const provider = new CustomCliProvider({
      command: '/usr/bin/my-cli',
      args: '--json',
    });

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'file' as const,
    };

    await provider.review(request);

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/my-cli',
      ['--json', expect.any(String)],
      expect.any(Object)
    );
  });

  it('passes prompt via stdin when promptViaStdin is true', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const provider = new CustomCliProvider({
      command: '/usr/bin/my-cli',
      promptViaStdin: true,
    });

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'file' as const,
    };

    await provider.review(request);

    expect(mockProc.stdin.write).toHaveBeenCalled();
    expect(mockProc.stdin.end).toHaveBeenCalled();
  });

  it('throws error when command is not configured', async () => {
    const provider = new CustomCliProvider({ command: '' });

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'file' as const,
    };

    await expect(provider.review(request)).rejects.toThrow('Custom CLI command not configured');
  });

  it('handles process error', async () => {
    const mockProc = {
      pid: 12345,
      kill: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === 'error') {
          cb(new Error('ENOENT'));
        }
      }),
    };

    mockSpawn.mockReturnValue(mockProc);

    const provider = new CustomCliProvider({ command: '/nonexistent' });

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'file' as const,
    };

    await expect(provider.review(request)).rejects.toThrow('Failed to start Custom CLI');
  });

  it('handles non-zero exit code as error', async () => {
    const mockProc = createMockProcess('some error output', 1);
    mockProc.on = vi.fn((event, cb) => {
      if (event === 'close') {
        cb(1, null);
      }
    });
    mockSpawn.mockReturnValue(mockProc);

    const provider = new CustomCliProvider({ command: '/usr/bin/my-cli' });

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'file' as const,
    };

    await expect(provider.review(request)).rejects.toThrow('Custom CLI exited with code 1');
  });

  it('supports diff review', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const provider = new CustomCliProvider({ command: '/usr/bin/my-cli' });

    const request = {
      code: '',
      languageId: 'typescript',
      filePath: '',
      reviewType: 'staged' as const,
      diff: 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,4 @@\n line1\n+added\n line2',
    };

    await provider.review(request);

    expect(mockSpawn).toHaveBeenCalled();
  });
});
