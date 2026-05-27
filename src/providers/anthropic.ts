import { CancellationToken } from 'vscode';
import { ModelProvider, ProviderConfig, ProviderName } from './modelProvider';
import { ReviewRequest, ReviewResult, ModelUsage } from '../types/review';
import { OutputParser } from '../harness/outputParser';
import { getSettings, logDebug } from '../settings';
import { buildFileReviewPrompt, buildSelectionReviewPrompt, buildDiffReviewPrompt, formatDiffWithLineNumbers } from '../harness/prompts';

export interface AnthropicConfig extends ProviderConfig {
  apiKey?: string;
  model?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream?: boolean;
  system?: string;
}

interface AnthropicResponse {
  type: string;
  id: string;
  role: string;
  content: {
    type: string;
    text?: string;
  }[];
  model: string;
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    type: string;
    message: string;
  };
}

interface AnthropicStreamChunk {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    text?: string;
  };
  delta?: {
    text?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    type: string;
    message: string;
  };
}

const ANTHROPIC_API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements ModelProvider {
  readonly name: ProviderName = 'anthropic';
  private config: AnthropicConfig;
  private outputParser: OutputParser;
  private abortController: AbortController | null = null;

  constructor(config: AnthropicConfig = {}) {
    this.config = config;
    this.outputParser = new OutputParser();
  }

  async review(request: ReviewRequest, token?: CancellationToken): Promise<ReviewResult> {
    const settings = getSettings();
    const apiKey = this.config.apiKey ?? this.getApiKey();

    if (!apiKey) {
      throw new Error('API key not configured for anthropic provider. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.');
    }

    const model = this.config.model || settings.model || 'claude-3-5-sonnet-20241022';

    this.abortController = new AbortController();

    if (token) {
      token.onCancellationRequested(() => {
        this.abortController?.abort();
      });
    }

    const prompt = this.buildPrompt(request);

    logDebug('AnthropicProvider: Sending review request', { model, reviewType: request.reviewType });

    try {
      const response = await this.sendRequest(apiKey, model, prompt);

      if (response.error) {
        throw new Error(`Anthropic API error: ${response.error.message} (${response.error.type || 'unknown'})`);
      }

      const content = response.content?.[0]?.text ?? '';
      const usage = this.extractUsage(response.usage);

      logDebug('AnthropicProvider: Received response', { usage });

      const parseResult = this.outputParser.parse(content);

      if (parseResult.hasToolRequests) {
        logDebug('AnthropicProvider: Tool requests detected but not executed (read-only harness)');
      }

      return {
        comments: parseResult.comments,
        provider: this.name,
        usage,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Review cancelled');
      }
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  async applyFix(filePath: string, line: number, fix: string, token?: CancellationToken): Promise<void> {
    const settings = getSettings();
    const apiKey = this.config.apiKey ?? this.getApiKey();

    if (!apiKey) {
      throw new Error('API key not configured for anthropic provider');
    }

    const model = this.config.model || settings.model || 'claude-3-5-sonnet-20241022';

    this.abortController = new AbortController();

    if (token) {
      token.onCancellationRequested(() => {
        this.abortController?.abort();
      });
    }

    const prompt = `You are a code fix assistant. Apply the following fix to the file.

File: ${filePath}
Line: ${line + 1}

Fix to apply:
\`\`\`
${fix}
\`\`\`

Return a JSON object with the applied fix confirmation:
{"type":"fix_applied","file":"${filePath}","line":${line + 1},"status":"success"}

Or return an error:
{"type":"fix_error","message":"<error description>"}`;

    try {
      const response = await this.sendRequest(apiKey, model, prompt);

      if (response.error) {
        throw new Error(`Anthropic API error: ${response.error.message} (${response.error.type || 'unknown'})`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Fix application cancelled');
      }
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  async isAvailable(): Promise<boolean> {
    return !!this.getApiKey();
  }

  private buildPrompt(request: ReviewRequest): string {
    switch (request.reviewType) {
      case 'selection':
        return buildSelectionReviewPrompt(request, request.startLine ?? 0).prompt;
      case 'staged':
      case 'uncommitted':
      case 'lastCommit':
      case 'branch':
        if (request.diff) {
          const formattedDiff = formatDiffWithLineNumbers(request.diff);
          return buildDiffReviewPrompt(request, formattedDiff).prompt;
        }
        return buildFileReviewPrompt(request).prompt;
      case 'file':
      default:
        return buildFileReviewPrompt(request).prompt;
    }
  }

  private async sendRequest(
    apiKey: string,
    model: string,
    prompt: string
  ): Promise<AnthropicResponse> {
    const systemPrompt = 'You are a code review assistant. Analyze code and return review comments as JSON arrays with line numbers (1-based), messages, severity levels (error/warning/info/suggestion), and optional fixes.';

    const request: AnthropicRequest = {
      model,
      messages: [
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
      stream: false,
      system: systemPrompt,
    };

    const response = await fetch(ANTHROPIC_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(request),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      return this.handleStreamingResponse(response);
    }

    return response.json() as Promise<AnthropicResponse>;
  }

  private async handleStreamingResponse(
    response: Response
  ): Promise<AnthropicResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let usage: AnthropicResponse['usage'] = undefined;
    let done = false;

    try {
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (done) break;
        const value = result.value;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed: AnthropicStreamChunk = JSON.parse(data);

              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                fullContent += parsed.delta.text;
              }
              if (parsed.type === 'message_delta' && parsed.usage) {
                usage = parsed.usage;
              }
            } catch {
              // Skip invalid JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      type: 'message',
      id: 'streaming-response',
      role: 'assistant',
      content: [{
        type: 'text',
        text: fullContent,
      }],
      model: '',
      stop_reason: 'stop',
      usage,
    };
  }

  private extractUsage(usage?: { input_tokens: number; output_tokens: number }): ModelUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    };
  }

  private getApiKey(): string | undefined {
    return this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  }
}
