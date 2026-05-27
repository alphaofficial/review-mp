import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider, AnthropicConfig } from '../../src/providers/anthropic';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          provider: 'opencode',
          opencodePath: 'opencode',
          model: 'claude-3-5-sonnet-20241022',
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

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe('constructor', () => {
    it('creates provider with default name', () => {
      const provider = new AnthropicProvider();
      expect(provider.name).toBe('anthropic');
    });

    it('accepts config override', () => {
      const config: AnthropicConfig = {
        apiKey: 'custom-key',
        model: 'claude-3-opus-20240229',
      };
      const provider = new AnthropicProvider(config);
      expect(provider).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('returns true when API key is configured via env', async () => {
      const provider = new AnthropicProvider();
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('returns true with config override API key', async () => {
      const provider = new AnthropicProvider({
        apiKey: 'sk-ant-xxxx',
      });
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('returns false when no API key is available', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const provider = new AnthropicProvider();
      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('cancel', () => {
    it('does nothing when no request is in progress', () => {
      const provider = new AnthropicProvider();
      provider.cancel();
    });
  });

  describe('buildPrompt', () => {
    it('builds file review prompt correctly', () => {
      const provider = new AnthropicProvider();
      const prompt = (provider as any).buildPrompt({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file',
      });
      expect(prompt).toContain('test.ts');
      expect(prompt).toContain('typescript');
    });

    it('builds selection review prompt with start line', () => {
      const provider = new AnthropicProvider();
      const prompt = (provider as any).buildPrompt({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'selection',
        startLine: 10,
      });
      expect(prompt).toContain('test.ts');
      expect(prompt).toContain('selection starts at line 11');
    });

    it('builds diff review prompt when diff is provided', () => {
      const provider = new AnthropicProvider();
      const prompt = (provider as any).buildPrompt({
        code: '',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'staged',
        diff: 'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1,3 +1,4 @@',
      });
      expect(prompt).toContain('diff');
    });
  });

  describe('review', () => {
    const createMockResponse = (overrides: Partial<{
      content: any[];
      usage: any;
      error: any;
    }> = {}) => {
      return {
        type: 'message',
        id: 'msg_123',
        role: 'assistant',
        content: [{
          type: 'text',
          text: '[{"line": 1, "message": "Test issue", "severity": "warning"}]',
        }],
        model: 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
        },
        ...overrides,
      };
    };

    it('sends correct request format to Anthropic Messages API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve(createMockResponse()),
      });

      const provider = new AnthropicProvider({
        model: 'claude-3-5-sonnet-20241022',
      });

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await provider.review(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-anthropic-api-key',
            'anthropic-version': '2023-06-01',
          },
        })
      );
    });

    it('parses JSON response and returns comments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve(createMockResponse()),
      });

      const provider = new AnthropicProvider();

      const result = await provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      });

      expect(result.provider).toBe('anthropic');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].message).toBe('Test issue');
      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.outputTokens).toBe(50);
      expect(result.usage?.totalTokens).toBe(150);
    });

    it('throws error when API key not configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const provider = new AnthropicProvider();

      await expect(provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      })).rejects.toThrow('API key not configured');
    });

    it('throws error on API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve(createMockResponse({
          error: {
            type: 'authentication_error',
            message: 'Invalid API key',
          },
        })),
      });

      const provider = new AnthropicProvider();

      await expect(provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      })).rejects.toThrow('Anthropic API error: Invalid API key');
    });

    it('throws error on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const provider = new AnthropicProvider();

      await expect(provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      })).rejects.toThrow('HTTP 500');
    });

    it('handles streaming response and captures usage', async () => {
      const testChunks = [
        '{"type": "content_block_delta","index": 0,"delta": {"text": "Test content"}}',
        '{"type": "message_delta","usage": {"input_tokens": 10,"output_tokens": 5}}',
      ];

      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of testChunks) {
            controller.enqueue(new TextEncoder().encode('data: ' + chunk + '\n'));
          }
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'text/event-stream',
        },
        body: stream,
      });

      const provider = new AnthropicProvider();

      const result = await provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      });

      expect(result.provider).toBe('anthropic');
      expect(result.usage?.inputTokens).toBe(10);
      expect(result.usage?.outputTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
    });

    it('extracts usage from non-streaming response', () => {
      const provider = new AnthropicProvider();
      const usage = (provider as any).extractUsage({
        input_tokens: 100,
        output_tokens: 50,
      });

      expect(usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('returns undefined usage when not provided', () => {
      const provider = new AnthropicProvider();
      const usage = (provider as any).extractUsage(undefined);
      expect(usage).toBeUndefined();
    });
  });

  describe('applyFix', () => {
    it('sends fix request with correct format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve({
          type: 'message',
          id: 'fix-123',
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"type":"fix_applied","file":"test.ts","line":1,"status":"success"}',
          }],
          model: 'claude-3-5-sonnet-20241022',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 50,
            output_tokens: 25,
          },
        }),
      });

      const provider = new AnthropicProvider();

      await provider.applyFix('test.ts', 0, 'const x = 2;');

      expect(mockFetch).toHaveBeenCalled();
    });

    it('throws error when API error occurs during fix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve({
          type: 'message',
          id: 'fix-error',
          role: 'assistant',
          content: [],
          model: 'claude-3-5-sonnet-20241022',
          error: {
            type: 'rate_limit_error',
            message: 'Rate limit exceeded',
          },
        }),
      });

      const provider = new AnthropicProvider();

      await expect(provider.applyFix('test.ts', 0, 'const x = 2;')).rejects.toThrow('Anthropic API error');
    });
  });

  describe('getApiKey', () => {
    it('returns config API key if set', () => {
      const provider = new AnthropicProvider({ apiKey: 'config-key' });
      const key = (provider as any).getApiKey();
      expect(key).toBe('config-key');
    });

    it('returns env API key if config key not set', () => {
      const provider = new AnthropicProvider();
      const key = (provider as any).getApiKey();
      expect(key).toBe('test-anthropic-api-key');
    });

    it('prefers config API key over env key', () => {
      const provider = new AnthropicProvider({ apiKey: 'config-key' });
      const key = (provider as any).getApiKey();
      expect(key).toBe('config-key');
    });
  });
});
