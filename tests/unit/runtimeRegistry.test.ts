import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeId, RuntimeManifest, RuntimeAdapter, RuntimeRegistry, runtimeIds, DEFAULT_RUNTIME_ID } from '../../src/providers/runtimeRegistry';
import { RuntimeSettings } from '../../src/providers/runtimeRegistry';
import { NormalizedReviewResult } from '../../src/providers/runtimeRegistry';
import { ReviewRequest, ReviewComment } from '../../src/types/review';

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
