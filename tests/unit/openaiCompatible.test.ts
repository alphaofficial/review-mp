import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider, OpenAICompatibleConfig } from '../../src/providers/openaiCompatible';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: any) => {
        const config: Record<string, any> = {
          provider: 'opencode',
          opencodePath: 'opencode',
          model: 'gpt-4',
          autoReviewOnStage: false,
          autoReviewOnCommit: false,
          debug: false,
          customCliCommand: '',
          customCliArgs: '',
          openaiCompatibleEndpoint: 'https://api.test.com/v1/chat/completions',
        };
        return config[key] ?? defaultValue;
      }),
    })),
  },
}));

const mockFetch = vi.fn();

vi.stubGlobal('fetch', mockFetch);

describe('OpenAICompatibleProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.OPENAI_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  describe('constructor', () => {
    it('creates provider with default name', () => {
      const provider = new OpenAICompatibleProvider();
      expect(provider.name).toBe('openai-compatible');
    });

    it('accepts config override', () => {
      const config: OpenAICompatibleConfig = {
        endpoint: 'https://custom.endpoint.com/v1',
        model: 'gpt-4-turbo',
      };
      const provider = new OpenAICompatibleProvider(config);
      expect(provider).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('returns true when endpoint and API key are configured', async () => {
      const provider = new OpenAICompatibleProvider();
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('returns true with config override endpoint and env API key', async () => {
      const provider = new OpenAICompatibleProvider({
        endpoint: 'https://custom.endpoint.com/v1',
      });
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('returns false when no API key is available', async () => {
      delete process.env.OPENAI_API_KEY;
      const provider = new OpenAICompatibleProvider();
      const available = await provider.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('cancel', () => {
    it('does nothing when no request is in progress', () => {
      const provider = new OpenAICompatibleProvider();
      provider.cancel();
    });
  });

  describe('buildPrompt', () => {
    it('builds file review prompt correctly', () => {
      const provider = new OpenAICompatibleProvider();
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
      const provider = new OpenAICompatibleProvider();
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
      const provider = new OpenAICompatibleProvider();
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
      choices: any[];
      usage: any;
      error: any;
    }> = {}) => {
      return {
        id: 'chatcmpl-123',
        model: 'gpt-4',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '[{"line": 1, "message": "Test issue", "severity": "warning"}]',
          },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
        ...overrides,
      };
    };

    it('sends correct request format', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        json: () => Promise.resolve(createMockResponse()),
      });

      const provider = new OpenAICompatibleProvider({
        endpoint: 'https://api.test.com/v1/chat/completions',
      });

      const request = {
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      };

      await provider.review(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key',
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

      const provider = new OpenAICompatibleProvider();

      const result = await provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      });

      expect(result.provider).toBe('openai-compatible');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].message).toBe('Test issue');
      expect(result.usage?.inputTokens).toBe(100);
      expect(result.usage?.outputTokens).toBe(50);
      expect(result.usage?.totalTokens).toBe(150);
    });

    it('throws error when API key not configured', async () => {
      delete process.env.OPENAI_API_KEY;

      const provider = new OpenAICompatibleProvider();

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
            message: 'Invalid API key',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        })),
      });

      const provider = new OpenAICompatibleProvider();

      await expect(provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      })).rejects.toThrow('OpenAI API error: Invalid API key');
    });

    it('throws error on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      const provider = new OpenAICompatibleProvider();

      await expect(provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      })).rejects.toThrow('HTTP 500');
    });

    it('handles streaming response and captures usage', async () => {
      const testChunk = '{"id":"1","choices":[{"index":0,"delta":{"content":"Test content"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}';
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: ' + testChunk + '\n'));
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

      const provider = new OpenAICompatibleProvider();

      const result = await provider.review({
        code: 'const x = 1;',
        languageId: 'typescript',
        filePath: 'test.ts',
        reviewType: 'file' as const,
      });

      expect(result.provider).toBe('openai-compatible');
      expect(result.usage?.totalTokens).toBe(15);
    });

    it('extracts usage from non-streaming response', () => {
      const provider = new OpenAICompatibleProvider();
      const usage = (provider as any).extractUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      });

      expect(usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('returns undefined usage when not provided', () => {
      const provider = new OpenAICompatibleProvider();
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
          id: 'fix-123',
          model: 'gpt-4',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '{"type":"fix_applied","file":"test.ts","line":1,"status":"success"}',
            },
            finish_reason: 'stop',
          }],
        }),
      });

      const provider = new OpenAICompatibleProvider({
        endpoint: 'https://api.test.com/v1/chat/completions',
      });

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
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_error',
          },
        }),
      });

      const provider = new OpenAICompatibleProvider();

      await expect(provider.applyFix('test.ts', 0, 'const x = 2;')).rejects.toThrow('Failed to apply fix');
    });
  });
});
