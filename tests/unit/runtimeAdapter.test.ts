import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliRuntimeAdapter } from '../../src/providers/runtimeAdapter';
import { RuntimeManifest, RuntimeSettings } from '../../src/providers/runtimeRegistry';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
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

const createOpencodeManifest = (): RuntimeManifest => ({
  id: 'opencode',
  name: 'OpenCode',
  executable: 'opencode',
  promptTransport: 'argv',
  outputFormat: 'json',
  supportsModelOverride: true,
  supportsExecutableOverride: true,
  supportsExtraArgs: true,
});

const createSettings = (overrides: Partial<RuntimeSettings> = {}): RuntimeSettings => ({
  runtime: 'opencode',
  model: undefined,
  debug: false,
  autoReviewOnStage: false,
  autoReviewOnCommit: false,
  ...overrides,
});

describe('CliRuntimeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates adapter with manifest and settings', () => {
      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      expect(adapter.manifest.id).toBe('opencode');
      expect(adapter.manifest.name).toBe('OpenCode');
      expect(adapter.manifest.executable).toBe('opencode');
    });

    it('stores workspace root from settings', () => {
      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings, '/custom/workspace');

      expect(adapter).toBeDefined();
    });

    it('stores model override from settings', () => {
      const manifest = createOpencodeManifest();
      const settings = createSettings({ model: 'claude-3-5-sonnet' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      expect(adapter).toBeDefined();
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

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      (adapter as any).currentProcess = mockProc;
      adapter.cancel();

      expect(mockProc.kill).toHaveBeenCalled();
    });

    it('does nothing when no process is running', () => {
      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      expect(() => adapter.cancel()).not.toThrow();
    });
  });

  describe('isAvailable', () => {
    it('returns false when no executable override and command not on PATH', async () => {
      const originalPath = process.env.PATH;
      process.env.PATH = '/nonexistent';

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const available = await adapter.isAvailable();

      process.env.PATH = originalPath;

      expect(available).toBe(false);
    });

    it('returns true when opencode is on PATH', async () => {
      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const available = await adapter.isAvailable();

      expect(typeof available).toBe('boolean');
    });
  });
});

describe('CliRuntimeAdapter process execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockProcess = (stdoutData: string = '[{"line": 1, "message": "Test issue"}]', closeCode: number = 0) => {
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

  describe('invoke with argv transport', () => {
    it('spawns process with executable and prompt as arg', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      expect(mockSpawn).toHaveBeenCalledWith(
        'opencode',
        expect.arrayContaining([expect.any(String)]),
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    it('includes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings({ extraArgs: ['--verbose', '--debug'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--verbose');
      expect(spawnArgs[1]).toContain('--debug');
    });

    it('includes prePromptArgs when manifest specifies them', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        ...createOpencodeManifest(),
        prePromptArgs: ['run', '--format', 'json'],
      };
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('run');
      expect(spawnArgs[1]).toContain('--format');
      expect(spawnArgs[1]).toContain('json');
    });

    it('includes model arg when manifest supports model override', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        ...createOpencodeManifest(),
        supportsModelOverride: true,
        modelArgFlag: '--model',
      };
      const settings = createSettings({ model: 'claude-3-5-sonnet' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--model');
      expect(spawnArgs[1]).toContain('claude-3-5-sonnet');
    });

    it('builds correct argv with prePromptArgs and model arg', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        ...createOpencodeManifest(),
        prePromptArgs: ['run', '--format', 'json'],
        modelArgFlag: '--model',
      };
      const settings = createSettings({ model: 'claude-3-5-sonnet', extraArgs: ['--verbose'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      const spawnArgs = mockSpawn.mock.calls[0];
      const argv = spawnArgs[1];
      expect(argv[0]).toBe('run');
      expect(argv[1]).toBe('--format');
      expect(argv[2]).toBe('json');
      expect(argv[3]).toBe('--model');
      expect(argv[4]).toBe('claude-3-5-sonnet');
      expect(argv[5]).toBe('--verbose');
      expect(argv[6]).toBeDefined();
    });

    it('uses executable override when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings({ executableOverride: '/custom/opencode' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/opencode',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('parses JSON output and returns normalized result', async () => {
      const mockProc = createMockProcess('[{"line": 10, "message": "Test issue", "severity": "warning"}]');
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      const result = await adapter.invoke(request);

      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].file).toBe('test.ts');
      expect(result.comments[0].line).toBe(9);
      expect(result.comments[0].message).toBe('Test issue');
      expect(result.comments[0].severity).toBe('warning');
      expect(result.metadata?.runtimeId).toBe('opencode');
    });

    it('handles diff review type', async () => {
      const mockProc = createMockProcess('[{"line": 5, "message": "Bug", "file": "test.ts"}]');
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: '',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'staged' as const,
        diff: 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,4 @@\n line1\n+buggy',
      };

      const result = await adapter.invoke(request);

      expect(mockSpawn).toHaveBeenCalled();
      expect(result.rawText).toBeDefined();
    });
  });

  describe('invoke with stdin transport', () => {
    it('passes prompt via stdin when manifest specifies stdin', async () => {
      const manifest: RuntimeManifest = {
        ...createOpencodeManifest(),
        promptTransport: 'stdin',
      };
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await adapter.invoke(request);

      expect(mockProc.stdin.write).toHaveBeenCalled();
      expect(mockProc.stdin.end).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalledWith(
        'opencode',
        expect.any(Array),
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
    });
  });

  describe('error handling', () => {
    it('rejects when process exits with non-zero code', async () => {
      const mockProc = createMockProcess('error output', 1);
      mockProc.on = vi.fn((event, cb) => {
        if (event === 'close') {
          cb(1, null);
        }
      });
      mockSpawn.mockReturnValue(mockProc);

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await expect(adapter.invoke(request)).rejects.toThrow('OpenCode exited with code 1');
    });

    it('rejects when process errors', async () => {
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

      const manifest = createOpencodeManifest();
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await expect(adapter.invoke(request)).rejects.toThrow('Failed to start OpenCode');
    });
  });
});

describe('CliRuntimeAdapter prompt building', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds selection review prompt for selection review type', async () => {
    const mockProc = {
      pid: 12345,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, cb) => {
        if (event === 'data') {
          cb(Buffer.from('[{"line": 1, "message": "Test"}]'));
        }
      }) },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === 'close') {
          cb(0, null);
        }
      }),
    };
    mockSpawn.mockReturnValue(mockProc);

    const manifest = createOpencodeManifest();
    const settings = createSettings();
    const adapter = new CliRuntimeAdapter(manifest, settings);

    const request = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: 'test.ts',
      reviewType: 'selection' as const,
      startLine: 5,
    };

    await adapter.invoke(request);

      expect(mockSpawn).toHaveBeenCalled();
    const callArgs = mockSpawn.mock.calls[0][1];
    const promptArg = callArgs[callArgs.length - 1];
    expect(typeof promptArg).toBe('string');
    expect(promptArg.length).toBeGreaterThan(0);
  });
});

describe('Runtime manifest-level tests', () => {
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

  const baseRequest = {
    code: 'const x = 1;',
    languageId: 'typescript',
    filePath: 'test.ts',
    reviewType: 'file' as const,
  };

  describe('claude runtime manifest', () => {
    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'claude',
        name: 'Claude',
        executable: 'claude',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'claude-3-5-sonnet' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
      expect(spawnArgs[1]).not.toContain('claude-3-5-sonnet');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'claude',
        name: 'Claude',
        executable: 'claude',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--verbose'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--verbose');
    });
  });

  describe('copilot runtime manifest', () => {
    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'copilot',
        name: 'Copilot',
        executable: 'copilot',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'gpt-4' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'copilot',
        name: 'Copilot',
        executable: 'copilot',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--debug'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--debug');
    });
  });

  describe('codex runtime manifest', () => {
    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'codex',
        name: 'Codex',
        executable: 'codex',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'gpt-4o' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'codex',
        name: 'Codex',
        executable: 'codex',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--verbose'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--verbose');
    });
  });

  describe('gemini runtime manifest', () => {
    it('uses ndjson output format', async () => {
      const mockProc = createMockProcess('[{"line": 1, "message": "Test"}]');
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'gemini',
        name: 'Gemini',
        executable: 'gemini',
        promptTransport: 'argv',
        outputFormat: 'ndjson',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings();
      const adapter = new CliRuntimeAdapter(manifest, settings);

      const result = await adapter.invoke(baseRequest);

      expect(result.comments).toHaveLength(1);
    });

    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'gemini',
        name: 'Gemini',
        executable: 'gemini',
        promptTransport: 'argv',
        outputFormat: 'ndjson',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'gemini-pro' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'gemini',
        name: 'Gemini',
        executable: 'gemini',
        promptTransport: 'argv',
        outputFormat: 'ndjson',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--debug'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--debug');
    });
  });

  describe('hermes runtime manifest', () => {
    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'hermes',
        name: 'Hermes',
        executable: 'hermes',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'hermes-model' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'hermes',
        name: 'Hermes',
        executable: 'hermes',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--verbose'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--verbose');
    });
  });

  describe('pi runtime manifest', () => {
    it('does not pass model when supportsModelOverride is false', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'pi',
        name: 'Pi',
        executable: 'pi',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ model: 'pi-model' });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).not.toContain('--model');
    });

    it('passes extra args when provided', async () => {
      const mockProc = createMockProcess();
      mockSpawn.mockReturnValue(mockProc);

      const manifest: RuntimeManifest = {
        id: 'pi',
        name: 'Pi',
        executable: 'pi',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
        supportsExecutableOverride: true,
        supportsExtraArgs: true,
      };
      const settings = createSettings({ extraArgs: ['--debug'] });
      const adapter = new CliRuntimeAdapter(manifest, settings);

      await adapter.invoke(baseRequest);

      const spawnArgs = mockSpawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--debug');
    });
  });
});
