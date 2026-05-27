import { CancellationToken } from 'vscode';
import { ModelProvider, ProviderConfig, ProviderName, ModelInfo } from './modelProvider';
import { ReviewRequest, ReviewResult, ModelUsage } from '../types/review';
import { OutputParser } from '../harness/outputParser';
import { getSettings, logDebug } from '../settings';
import { buildFileReviewPrompt, buildSelectionReviewPrompt, buildDiffReviewPrompt, formatDiffWithLineNumbers } from '../harness/prompts';

export interface OpenAICompatibleConfig extends ProviderConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

interface OpenAIStreamChunk {
  id: string;
  model: string;
  choices: {
    index: number;
    delta: {
      content?: string;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: ProviderName = 'openai-compatible';
  private config: OpenAICompatibleConfig;
  private outputParser: OutputParser;
  private abortController: AbortController | null = null;

  constructor(config: OpenAICompatibleConfig = {}) {
    this.config = config;
    this.outputParser = new OutputParser();
  }

  async review(request: ReviewRequest, token?: CancellationToken): Promise<ReviewResult> {
    const settings = getSettings();
    const endpoint = this.config.endpoint ?? settings.openaiCompatibleEndpoint;

    if (!endpoint) {
      throw new Error('OpenAI-compatible endpoint not configured. Set reviewmp.openaiCompatibleEndpoint or pass endpoint in config.');
    }

    this.abortController = new AbortController();

    if (token) {
      token.onCancellationRequested(() => {
        this.abortController?.abort();
      });
    }

    const prompt = this.buildPrompt(request);
    const model = this.config.model || settings.model || 'gpt-4';
    const apiKey = this.config.apiKey ?? this.getApiKey();

    if (!apiKey) {
      throw new Error('API key not configured for openai-compatible provider. Run "ReviewMP: Set API Key" command.');
    }

    logDebug('OpenAICompatibleProvider: Sending review request', { endpoint, model, reviewType: request.reviewType });

    try {
      const response = await this.sendRequest(endpoint, apiKey, model, prompt);

      if (response.error) {
        throw new Error(`OpenAI API error: ${response.error.message} (${response.error.type || response.error.code || 'unknown'})`);
      }

      const content = response.choices[0]?.message?.content ?? '';
      const usage = this.extractUsage(response.usage);

      logDebug('OpenAICompatibleProvider: Received response', { usage });

      const parseResult = this.outputParser.parse(content);

      if (parseResult.hasToolRequests) {
        logDebug('OpenAICompatibleProvider: Tool requests detected but not executed (read-only harness)');
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
    const endpoint = this.config.endpoint ?? settings.openaiCompatibleEndpoint;

    if (!endpoint) {
      throw new Error('OpenAI-compatible endpoint not configured');
    }

    this.abortController = new AbortController();

    if (token) {
      token.onCancellationRequested(() => {
        this.abortController?.abort();
      });
    }

    const model = this.config.model || settings.model || 'gpt-4';
    const apiKey = this.config.apiKey ?? this.getApiKey();

    if (!apiKey) {
      throw new Error('API key not configured');
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
      const response = await this.sendRequest(endpoint, apiKey, model, prompt);

      if (response.error) {
        throw new Error(`Failed to apply fix: ${response.error.message}`);
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
    const settings = getSettings();
    const endpoint = this.config.endpoint ?? settings.openaiCompatibleEndpoint;
    return !!endpoint && !!this.getApiKey();
  }

  getMetadata(): ModelInfo {
    return {
      providerName: this.name,
      modelId: this.config.model || 'gpt-4',
      contextWindow: 128000,
      supportsStreaming: true,
      supportsTools: false,
    };
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
    endpoint: string,
    apiKey: string,
    model: string,
    prompt: string
  ): Promise<OpenAIChatResponse> {
    const chatRequest: OpenAIChatRequest = {
      model,
      messages: [
        { role: 'system', content: 'You are a code review assistant. Analyze code and return review comments as JSON arrays with line numbers (1-based), messages, severity levels (error/warning/info/suggestion), and optional fixes.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(chatRequest),
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

    return response.json() as Promise<OpenAIChatResponse>;
  }

  private async handleStreamingResponse(
    response: Response
  ): Promise<OpenAIChatResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let usage: OpenAIChatResponse['usage'] = undefined;
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
              const parsed: OpenAIStreamChunk = JSON.parse(data);
              const delta = parsed.choices[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
              }
              if (parsed.usage) {
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
      id: 'streaming-response',
      model: '',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
        },
        finish_reason: 'stop',
      }],
      usage,
    };
  }

  private extractUsage(usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): ModelUsage | undefined {
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }

  private getApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }
}
