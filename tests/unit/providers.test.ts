import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import { ProviderRegistry, globalRegistry } from '../../src/providers/registry';
import { ModelProvider, DEFAULT_OPENCODE_PROVIDER_NAME, providerNames, ProviderConfig, ModelInfo, ModelProviderWithMetadata, ProviderEvent, ProviderSettings } from '../../src/providers/modelProvider';
import { ReviewRequest, ReviewResult, ReviewComment } from '../../src/types/review';
import { OpenCodeProvider } from '../../src/providers/opencode';
import { CustomCliProvider } from '../../src/providers/customCli';
import { OpenAICompatibleProvider } from '../../src/providers/openaiCompatible';
import { buildProvider } from '../../src/providers/factory';

class MockProvider implements ModelProvider {
  readonly name: string;
  private available: boolean;
  private reviewResult: ReviewResult;
  private shouldFail = false;

  constructor(
    name: string,
    available = true,
    reviewResult: ReviewResult = { comments: [], provider: name }
  ) {
    this.name = name;
    this.available = available;
    this.reviewResult = reviewResult;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  async review(): Promise<ReviewResult> {
    if (this.shouldFail) {
      throw new Error('Mock provider error');
    }
    return this.reviewResult;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  cancel(): void {}
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register', () => {
    it('registers a provider with its name as key', () => {
      const provider = new MockProvider('test');
      registry.register(provider);
      expect(registry.get('test')).toBe(provider);
    });

    it('overwrites existing provider with same name', () => {
      const provider1 = new MockProvider('test', true, { comments: [], provider: 'test' });
      const provider2 = new MockProvider('test', true, { comments: [{ file: 'a.ts', line: 1, message: 'issue' }], provider: 'test' });
      registry.register(provider1);
      registry.register(provider2);
      expect(registry.get('test')).toBe(provider2);
    });
  });

  describe('get', () => {
    it('returns registered provider by name', () => {
      const provider = new MockProvider('myprovider');
      registry.register(provider);
      expect(registry.get('myprovider')).toBe(provider);
    });

    it('returns undefined for unregistered provider', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getDefault', () => {
    it('returns the default opencode provider when registered', () => {
      const opencodeProvider = new MockProvider(DEFAULT_OPENCODE_PROVIDER_NAME);
      registry.register(opencodeProvider);
      expect(registry.getDefault()).toBe(opencodeProvider);
    });

    it('returns undefined when no providers registered', () => {
      expect(registry.getDefault()).toBeUndefined();
    });
  });

  describe('setDefault', () => {
    it('sets the default provider by name', () => {
      const provider = new MockProvider('custom');
      registry.register(provider);
      const result = registry.setDefault('custom');
      expect(result).toBe(true);
      expect(registry.getDefault()).toBe(provider);
    });

    it('returns false if provider does not exist', () => {
      const result = registry.setDefault('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('returns array of registered provider names', () => {
      registry.register(new MockProvider('provider1'));
      registry.register(new MockProvider('provider2'));
      const names = registry.list();
      expect(names).toContain('provider1');
      expect(names).toContain('provider2');
      expect(names).toHaveLength(2);
    });

    it('returns empty array when no providers registered', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe('isRegistered', () => {
    it('returns true for registered provider', () => {
      registry.register(new MockProvider('exists'));
      expect(registry.isRegistered('exists')).toBe(true);
    });

    it('returns false for unregistered provider', () => {
      expect(registry.isRegistered('notexists')).toBe(false);
    });
  });
});

describe('ReviewRequest type', () => {
  it('accepts valid review request structure', () => {
    const request: ReviewRequest = {
      code: 'const x = 1;',
      languageId: 'typescript',
      filePath: '/test.ts',
      reviewType: 'file',
    };
    expect(request.code).toBe('const x = 1;');
    expect(request.reviewType).toBe('file');
  });

  it('accepts diff review request with diff field', () => {
    const request: ReviewRequest = {
      code: '',
      languageId: 'typescript',
      filePath: '',
      reviewType: 'staged',
      diff: 'diff --git a/test.ts b/test.ts',
    };
    expect(request.diff).toBe('diff --git a/test.ts b/test.ts');
  });
});

describe('ReviewResult type', () => {
  it('accepts valid review result with comments', () => {
    const result: ReviewResult = {
      comments: [
        { file: 'test.ts', line: 1, message: 'Issue', severity: 'error' },
      ],
      provider: 'opencode',
    };
    expect(result.comments).toHaveLength(1);
    expect(result.provider).toBe('opencode');
  });

  it('accepts review result with usage information', () => {
    const result: ReviewResult = {
      comments: [],
      provider: 'opencode',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
    expect(result.usage?.totalTokens).toBe(150);
  });
});

describe('ReviewComment type', () => {
  it('accepts comment without optional fields', () => {
    const comment: ReviewComment = {
      file: 'test.ts',
      line: 10,
      message: 'Some issue',
    };
    expect(comment.file).toBe('test.ts');
    expect(comment.line).toBe(10);
    expect(comment.fix).toBeUndefined();
    expect(comment.severity).toBeUndefined();
  });

  it('accepts comment with all fields', () => {
    const comment: ReviewComment = {
      file: 'test.ts',
      line: 5,
      message: 'Fix this',
      fix: 'const x = 2;',
      severity: 'warning',
    };
    expect(comment.fix).toBe('const x = 2;');
    expect(comment.severity).toBe('warning');
  });
});

describe('ProviderFactory', () => {
  it('buildProvider function exists', () => {
    expect(typeof buildProvider).toBe('function');
  });

  it('creates opencode provider by default', () => {
    const settings: ProviderSettings = {
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
    const provider = buildProvider(settings);
    expect(provider).toBeInstanceOf(OpenCodeProvider);
    expect(provider.name).toBe('opencode');
  });

  it('creates opencode provider when explicitly specified', () => {
    const settings: ProviderSettings = {
      provider: 'opencode',
      opencodePath: '/custom/path/opencode',
      model: 'gpt-4',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      debug: false,
      customCliCommand: '',
      customCliArgs: '',
      openaiCompatibleEndpoint: '',
    };
    const provider = buildProvider(settings);
    expect(provider).toBeInstanceOf(OpenCodeProvider);
  });

  it('creates custom-cli provider when specified', () => {
    const settings: ProviderSettings = {
      provider: 'custom-cli',
      opencodePath: 'opencode',
      model: '',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      debug: false,
      customCliCommand: '/usr/bin/my-cli',
      customCliArgs: '--json',
      openaiCompatibleEndpoint: '',
    };
    const provider = buildProvider(settings);
    expect(provider).toBeInstanceOf(CustomCliProvider);
    expect(provider.name).toBe('custom-cli');
  });

  it('creates openai-compatible provider when specified', () => {
    const settings: ProviderSettings = {
      provider: 'openai-compatible',
      opencodePath: 'opencode',
      model: '',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      debug: false,
      customCliCommand: '',
      customCliArgs: '',
      openaiCompatibleEndpoint: 'https://api.test.com/v1/chat/completions',
    };
    const provider = buildProvider(settings);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.name).toBe('openai-compatible');
  });
});

describe('ProviderSettings validation', () => {
  it('throws actionable error when openai-compatible endpoint is missing', () => {
    const settings: ProviderSettings = {
      provider: 'openai-compatible',
      opencodePath: 'opencode',
      model: '',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      debug: false,
      customCliCommand: '',
      customCliArgs: '',
      openaiCompatibleEndpoint: '',
    };
    expect(() => buildProvider(settings)).toThrow(/endpoint/i);
    expect(() => buildProvider(settings)).toThrow(/openai-compatible/i);
  });

  it('throws actionable error when custom-cli command is missing', () => {
    const settings: ProviderSettings = {
      provider: 'custom-cli',
      opencodePath: 'opencode',
      model: '',
      autoReviewOnStage: false,
      autoReviewOnCommit: false,
      debug: false,
      customCliCommand: '',
      customCliArgs: '',
      openaiCompatibleEndpoint: '',
    };
    expect(() => buildProvider(settings)).toThrow(/command/i);
    expect(() => buildProvider(settings)).toThrow(/custom-cli|cli/i);
  });

  it('succeeds for opencode with minimal config', () => {
    const settings: ProviderSettings = {
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
    const provider = buildProvider(settings);
    expect(provider).toBeDefined();
    expect(provider.name).toBe('opencode');
  });
});

describe('ProviderMetadata', () => {
  it('ModelInfo interface exists with required fields', () => {
    const info: ModelInfo = {
      providerName: 'opencode',
      modelId: 'opencode-default',
      contextWindow: 200000,
      supportsStreaming: false,
      supportsTools: false,
    };
    expect(info.providerName).toBe('opencode');
    expect(info.modelId).toBe('opencode-default');
    expect(info.contextWindow).toBe(200000);
    expect(info.supportsStreaming).toBe(false);
    expect(info.supportsTools).toBe(false);
  });

  it('OpenCodeProvider exposes getMetadata method', () => {
    const provider = new OpenCodeProvider({});
    expect(typeof provider.getMetadata).toBe('function');
    const metadata = provider.getMetadata();
    expect(metadata.providerName).toBe('opencode');
    expect(metadata.supportsStreaming).toBe(false);
    expect(metadata.supportsTools).toBe(false);
  });

  it('CustomCliProvider exposes getMetadata method', () => {
    const provider = new CustomCliProvider({ command: '/usr/bin/cli' });
    expect(typeof provider.getMetadata).toBe('function');
    const metadata = provider.getMetadata();
    expect(metadata.providerName).toBe('custom-cli');
  });

  it('OpenAICompatibleProvider exposes getMetadata method', () => {
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.test.com' });
    expect(typeof provider.getMetadata).toBe('function');
    const metadata = provider.getMetadata();
    expect(metadata.providerName).toBe('openai-compatible');
    expect(metadata.supportsStreaming).toBe(true);
    expect(metadata.supportsTools).toBe(false);
  });

  it('provider implements ModelProviderWithMetadata interface', () => {
    const settings: ProviderSettings = {
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
    const provider = buildProvider(settings);
    const withMetadata = provider as ModelProviderWithMetadata;
    expect(typeof withMetadata.getMetadata).toBe('function');
  });
});

describe('ProviderEvent contract (streaming-ready)', () => {
  it('ProviderEvent type exists for future streaming support', () => {
    const event: ProviderEvent = {
      type: 'progress',
      message: 'Processing review...',
    };
    expect(event.type).toBe('progress');
    expect(event.message).toBe('Processing review...');
  });

  it('ProviderEvent supports comment events', () => {
    const event: ProviderEvent = {
      type: 'comment',
      comment: {
        file: 'test.ts',
        line: 10,
        message: 'Issue found',
      },
    };
    expect(event.type).toBe('comment');
    expect(event.comment?.message).toBe('Issue found');
  });

  it('ProviderEvent supports usage events', () => {
    const event: ProviderEvent = {
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
    expect(event.type).toBe('usage');
    expect(event.usage?.totalTokens).toBe(150);
  });
});

describe('Backward compatibility', () => {
  it('direct OpenCodeProvider instantiation still works', () => {
    const provider = new OpenCodeProvider({ opencodePath: '/custom/path' });
    expect(provider.name).toBe('opencode');
    expect(typeof provider.review).toBe('function');
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.cancel).toBe('function');
  });

  it('direct CustomCliProvider instantiation still works', () => {
    const provider = new CustomCliProvider({ command: '/usr/bin/cli' });
    expect(provider.name).toBe('custom-cli');
    expect(typeof provider.review).toBe('function');
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.cancel).toBe('function');
  });

  it('direct OpenAICompatibleProvider instantiation still works', () => {
    const provider = new OpenAICompatibleProvider({ endpoint: 'https://api.test.com' });
    expect(provider.name).toBe('openai-compatible');
    expect(typeof provider.review).toBe('function');
    expect(typeof provider.isAvailable).toBe('function');
    expect(typeof provider.cancel).toBe('function');
  });

  it('ProviderName type still accepts valid provider names', () => {
    expect(providerNames).toContain('opencode');
    expect(providerNames).toContain('custom-cli');
    expect(providerNames).toContain('openai-compatible');
  });

  it('ProviderConfig interface still works', () => {
    const config: ProviderConfig = {
      opencodePath: '/custom/path',
      model: 'gpt-4',
    };
    expect(config.opencodePath).toBe('/custom/path');
    expect(config.model).toBe('gpt-4');
  });

  it('globalRegistry is still exported and functional', () => {
    expect(globalRegistry).toBeDefined();
    expect(typeof globalRegistry.register).toBe('function');
    expect(typeof globalRegistry.get).toBe('function');
    expect(typeof globalRegistry.list).toBe('function');
  });
});