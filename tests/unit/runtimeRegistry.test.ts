import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeId, RuntimeManifest, RuntimeAdapter, RuntimeRegistry, runtimeIds, DEFAULT_RUNTIME_ID } from '../../src/providers/runtimeRegistry';
import { RuntimeSettings } from '../../src/providers/runtimeRegistry';
import { NormalizedReviewResult } from '../../src/providers/runtimeRegistry';
import { ReviewRequest, ReviewComment } from '../../src/types/review';
import { builtInRuntimes, createBuiltInRegistry, globalRuntimeRegistry } from '../../src/providers/builtInRuntimes';

describe('RuntimeId type', () => {
  it('runtimeIds array contains all supported runtime identifiers', () => {
    expect(runtimeIds).toContain('claude');
    expect(runtimeIds).toContain('copilot');
    expect(runtimeIds).toContain('codex');
    expect(runtimeIds).toContain('gemini');
    expect(runtimeIds).toContain('hermes');
    expect(runtimeIds).toContain('pi');
    expect(runtimeIds).toContain('opencode');
  });

  it('runtimeIds does NOT contain legacy provider names', () => {
    expect(runtimeIds).not.toContain('custom-cli');
    expect(runtimeIds).not.toContain('openai-compatible');
  });

  it('RuntimeId is a union type of the supported runtime ids', () => {
    const validId: RuntimeId = 'claude';
    const opencodeId: RuntimeId = 'opencode';
    expect(validId).toBe('claude');
    expect(opencodeId).toBe('opencode');
  });
});

describe('RuntimeManifest interface', () => {
  it('manifest includes required fields', () => {
    const manifest: RuntimeManifest = {
      id: 'claude',
      name: 'Claude',
      executable: 'claude',
      promptTransport: 'argv',
      outputFormat: 'text',
      supportsModelOverride: true,
    };
    expect(manifest.id).toBe('claude');
    expect(manifest.name).toBe('Claude');
    expect(manifest.executable).toBe('claude');
    expect(manifest.promptTransport).toBe('argv');
    expect(manifest.outputFormat).toBe('text');
    expect(manifest.supportsModelOverride).toBe(true);
  });

  it('manifest with stdin transport', () => {
    const manifest: RuntimeManifest = {
      id: 'opencode',
      name: 'OpenCode',
      executable: 'opencode',
      promptTransport: 'stdin',
      outputFormat: 'json',
      supportsModelOverride: true,
    };
    expect(manifest.promptTransport).toBe('stdin');
    expect(manifest.outputFormat).toBe('json');
  });

  it('manifest with executable override support', () => {
    const manifest: RuntimeManifest = {
      id: 'copilot',
      name: 'Copilot',
      executable: 'copilot',
      promptTransport: 'argv',
      outputFormat: 'text',
      supportsModelOverride: false,
      supportsExecutableOverride: true,
    };
    expect(manifest.supportsExecutableOverride).toBe(true);
  });

  it('manifest with extra args support', () => {
    const manifest: RuntimeManifest = {
      id: 'gemini',
      name: 'Gemini',
      executable: 'gemini',
      promptTransport: 'argv',
      outputFormat: 'ndjson',
      supportsModelOverride: true,
      supportsExtraArgs: true,
    };
    expect(manifest.supportsExtraArgs).toBe(true);
  });
});

describe('NormalizedReviewResult type', () => {
  it('accepts normalized result with comments', () => {
    const result: NormalizedReviewResult = {
      comments: [
        { file: 'test.ts', line: 10, message: 'Issue found' },
      ],
      rawText: 'raw output from runtime',
    };
    expect(result.comments).toHaveLength(1);
    expect(result.rawText).toBe('raw output from runtime');
  });

  it('accepts normalized result with optional usage', () => {
    const result: NormalizedReviewResult = {
      comments: [],
      rawText: 'output',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
    expect(result.usage?.totalTokens).toBe(150);
  });

  it('accepts normalized result with optional metadata', () => {
    const result: NormalizedReviewResult = {
      comments: [],
      rawText: 'output',
      metadata: {
        runtimeId: 'claude',
        model: 'claude-3-5-sonnet',
      },
    };
    expect(result.metadata?.runtimeId).toBe('claude');
    expect(result.metadata?.model).toBe('claude-3-5-sonnet');
  });
});

describe('RuntimeAdapter interface', () => {
  it('adapter requires manifest property', () => {
    const mockAdapter: RuntimeAdapter = {
      manifest: {
        id: 'test',
        name: 'Test',
        executable: 'test',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
      },
      invoke: async () => ({ comments: [], rawText: '' }),
      cancel: () => {},
      isAvailable: async () => true,
    };
    expect(mockAdapter.manifest.id).toBe('test');
  });

  it('adapter invoke returns NormalizedReviewResult', async () => {
    const mockAdapter: RuntimeAdapter = {
      manifest: {
        id: 'test',
        name: 'Test',
        executable: 'test',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
      },
      invoke: async (request: ReviewRequest) => ({
        comments: [{ file: 'a.ts', line: 1, message: 'test' }],
        rawText: 'raw',
      }),
      cancel: () => {},
      isAvailable: async () => true,
    };
    const result = await mockAdapter.invoke({ code: '', languageId: 'typescript', filePath: '', reviewType: 'file' });
    expect(result.comments).toHaveLength(1);
  });
});

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
  });

  describe('register', () => {
    it('registers a manifest with its id as key', () => {
      const manifest: RuntimeManifest = {
        id: 'claude',
        name: 'Claude',
        executable: 'claude',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: true,
      };
      registry.register(manifest);
      expect(registry.get('claude')).toBe(manifest);
    });

    it('overwrites existing manifest with same id', () => {
      const manifest1: RuntimeManifest = {
        id: 'claude',
        name: 'Claude',
        executable: 'claude',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: true,
      };
      const manifest2: RuntimeManifest = {
        id: 'claude',
        name: 'Claude Dev',
        executable: 'claude-dev',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: true,
      };
      registry.register(manifest1);
      registry.register(manifest2);
      expect(registry.get('claude')).toBe(manifest2);
      expect(registry.get('claude')?.name).toBe('Claude Dev');
    });
  });

  describe('get', () => {
    it('returns registered manifest by id', () => {
      const manifest: RuntimeManifest = {
        id: 'gemini',
        name: 'Gemini',
        executable: 'gemini',
        promptTransport: 'argv',
        outputFormat: 'ndjson',
        supportsModelOverride: true,
      };
      registry.register(manifest);
      expect(registry.get('gemini')).toBe(manifest);
    });

    it('returns undefined for unregistered runtime', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getDefault', () => {
    it('returns the default opencode manifest when registered', () => {
      const manifest: RuntimeManifest = {
        id: DEFAULT_RUNTIME_ID,
        name: 'OpenCode',
        executable: 'opencode',
        promptTransport: 'stdin',
        outputFormat: 'json',
        supportsModelOverride: true,
      };
      registry.register(manifest);
      expect(registry.getDefault()).toBe(manifest);
    });

    it('returns undefined when no manifests registered', () => {
      expect(registry.getDefault()).toBeUndefined();
    });
  });

  describe('setDefault', () => {
    it('sets the default runtime by id', () => {
      const manifest: RuntimeManifest = {
        id: 'copilot',
        name: 'Copilot',
        executable: 'copilot',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: false,
      };
      registry.register(manifest);
      const result = registry.setDefault('copilot');
      expect(result).toBe(true);
      expect(registry.getDefault()).toBe(manifest);
    });

    it('returns false if runtime does not exist', () => {
      const result = registry.setDefault('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('returns array of registered runtime ids', () => {
      registry.register({
        id: 'claude',
        name: 'Claude',
        executable: 'claude',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: true,
      });
      registry.register({
        id: 'gemini',
        name: 'Gemini',
        executable: 'gemini',
        promptTransport: 'argv',
        outputFormat: 'ndjson',
        supportsModelOverride: true,
      });
      const ids = registry.list();
      expect(ids).toContain('claude');
      expect(ids).toContain('gemini');
      expect(ids).toHaveLength(2);
    });

    it('returns empty array when no runtimes registered', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('isRegistered', () => {
    it('returns true for registered runtime', () => {
      registry.register({
        id: 'hermes',
        name: 'Hermes',
        executable: 'hermes',
        promptTransport: 'argv',
        outputFormat: 'text',
        supportsModelOverride: true,
      });
      expect(registry.isRegistered('hermes')).toBe(true);
    });

    it('returns false for unregistered runtime', () => {
      expect(registry.isRegistered('notexists')).toBe(false);
    });
  });
});

describe('RuntimeSettings type', () => {
  it('settings uses runtime field instead of provider', () => {
    const settings: RuntimeSettings = {
      runtime: 'claude',
      model: 'claude-3-5-sonnet',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
    };
    expect(settings.runtime).toBe('claude');
    expect((settings as any).provider).toBeUndefined();
  });

  it('settings does NOT include customCliCommand', () => {
    const settings: RuntimeSettings = {
      runtime: 'opencode',
      model: '',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
    };
    expect((settings as any).customCliCommand).toBeUndefined();
  });

  it('settings does NOT include customCliArgs', () => {
    const settings: RuntimeSettings = {
      runtime: 'opencode',
      model: '',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
    };
    expect((settings as any).customCliArgs).toBeUndefined();
  });

  it('settings does NOT include openaiCompatibleEndpoint', () => {
    const settings: RuntimeSettings = {
      runtime: 'opencode',
      model: '',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
    };
    expect((settings as any).openaiCompatibleEndpoint).toBeUndefined();
  });

  it('settings supports executable override per runtime', () => {
    const settings: RuntimeSettings = {
      runtime: 'claude',
      model: '',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      executableOverride: '/usr/local/bin/claude',
    };
    expect(settings.executableOverride).toBe('/usr/local/bin/claude');
  });

  it('settings supports extra args per runtime', () => {
    const settings: RuntimeSettings = {
      runtime: 'gemini',
      model: '',
      debug: false,
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      extraArgs: ['--verbose', '--debug'],
    };
    expect(settings.extraArgs).toEqual(['--verbose', '--debug']);
  });
});

describe('DEFAULT_RUNTIME_ID', () => {
  it('default runtime id is opencode', () => {
    expect(DEFAULT_RUNTIME_ID).toBe('opencode');
  });
});

describe('builtInRuntimes', () => {
  it('contains all 7 required runtimes', () => {
    expect(builtInRuntimes).toHaveLength(7);
    const ids = builtInRuntimes.map(m => m.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('copilot');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('hermes');
    expect(ids).toContain('pi');
    expect(ids).toContain('opencode');
  });

  it('each runtime has required manifest fields', () => {
    for (const manifest of builtInRuntimes) {
      expect(manifest.id).toBeDefined();
      expect(manifest.name).toBeDefined();
      expect(manifest.executable).toBeDefined();
      expect(['argv', 'stdin']).toContain(manifest.promptTransport);
      expect(['text', 'json', 'ndjson']).toContain(manifest.outputFormat);
      expect(typeof manifest.supportsModelOverride).toBe('boolean');
      expect(typeof manifest.supportsExecutableOverride).toBe('boolean');
      expect(typeof manifest.supportsExtraArgs).toBe('boolean');
    }
  });

  it('each runtime has a non-empty executable name', () => {
    for (const manifest of builtInRuntimes) {
      expect(manifest.executable.length).toBeGreaterThan(0);
    }
  });

  it('opencode uses text output format', () => {
    const opencodeManifest = builtInRuntimes.find(m => m.id === 'opencode');
    expect(opencodeManifest?.outputFormat).toBe('text');
  });

  it('gemini uses ndjson output format', () => {
    const geminiManifest = builtInRuntimes.find(m => m.id === 'gemini');
    expect(geminiManifest?.outputFormat).toBe('ndjson');
  });

  it('uses explicit one-shot invocation args for interactive-by-default CLIs', () => {
    const claudeManifest = builtInRuntimes.find(m => m.id === 'claude');
    const codexManifest = builtInRuntimes.find(m => m.id === 'codex');
    const opencodeManifest = builtInRuntimes.find(m => m.id === 'opencode');

    expect(claudeManifest?.promptTransport).toBe('stdin');
    expect(claudeManifest?.prePromptArgs).toEqual(['-p']);
    expect(codexManifest?.promptTransport).toBe('stdin');
    expect(codexManifest?.prePromptArgs).toEqual(['exec', '--skip-git-repo-check']);
    expect(opencodeManifest?.prePromptArgs).toEqual(['run', '--pure', '--dangerously-skip-permissions']);
    expect(opencodeManifest?.workingDirectoryArgFlag).toBe('--dir');
  });

  it('uses explicit prompt flags for all argv-based runtimes', () => {
    const copilotManifest = builtInRuntimes.find(m => m.id === 'copilot');
    const geminiManifest = builtInRuntimes.find(m => m.id === 'gemini');
    const hermesManifest = builtInRuntimes.find(m => m.id === 'hermes');
    const piManifest = builtInRuntimes.find(m => m.id === 'pi');

    expect(copilotManifest?.prePromptArgs).toEqual(['-p']);
    expect(geminiManifest?.prePromptArgs).toEqual(['-p']);
    expect(hermesManifest?.prePromptArgs).toEqual(['chat', '-q']);
    expect(piManifest?.prePromptArgs).toEqual(['-p']);
  });
});

describe('createBuiltInRegistry', () => {
  it('creates a registry with all 7 built-in runtimes', () => {
    const registry = createBuiltInRegistry();
    expect(registry.list()).toHaveLength(7);
  });

  it('can look up each built-in runtime by id', () => {
    const registry = createBuiltInRegistry();
    for (const manifest of builtInRuntimes) {
      const found = registry.get(manifest.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(manifest.id);
      expect(found?.name).toBe(manifest.name);
      expect(found?.executable).toBe(manifest.executable);
    }
  });

  it('returns undefined for non-existent runtime', () => {
    const registry = createBuiltInRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('isRegistered returns true for all built-in runtimes', () => {
    const registry = createBuiltInRegistry();
    for (const manifest of builtInRuntimes) {
      expect(registry.isRegistered(manifest.id)).toBe(true);
    }
  });

  it('isRegistered returns false for non-existent runtime', () => {
    const registry = createBuiltInRegistry();
    expect(registry.isRegistered('nonexistent')).toBe(false);
  });
});

describe('globalRuntimeRegistry', () => {
  it('is a pre-populated registry with all built-in runtimes', () => {
    expect(globalRuntimeRegistry.list()).toHaveLength(7);
  });

  it('contains all expected runtime ids', () => {
    const ids = globalRuntimeRegistry.list();
    expect(ids).toContain('claude');
    expect(ids).toContain('copilot');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('hermes');
    expect(ids).toContain('pi');
    expect(ids).toContain('opencode');
  });

  it('can retrieve each built-in manifest', () => {
    expect(globalRuntimeRegistry.get('claude')?.name).toBe('Claude');
    expect(globalRuntimeRegistry.get('copilot')?.name).toBe('Copilot');
    expect(globalRuntimeRegistry.get('codex')?.name).toBe('Codex');
    expect(globalRuntimeRegistry.get('gemini')?.name).toBe('Gemini');
    expect(globalRuntimeRegistry.get('hermes')?.name).toBe('Hermes');
    expect(globalRuntimeRegistry.get('pi')?.name).toBe('Pi');
    expect(globalRuntimeRegistry.get('opencode')?.name).toBe('OpenCode');
  });

  it('getDefault returns opencode manifest', () => {
    const defaultManifest = globalRuntimeRegistry.getDefault();
    expect(defaultManifest?.id).toBe('opencode');
  });
});
