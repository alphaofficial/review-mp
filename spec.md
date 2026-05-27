# Zoo Code Provider Architecture Research - SPEC.md

## Overview

Research findings from analyzing Zoo Code's open-source provider implementation (https://github.com/Zoo-Code-Org/Zoo-Code) to inform ReviewMP's provider abstraction improvements.

## Zoo Code Provider Architecture

### Core Interfaces

**ApiHandler Interface** (`src/api/index.ts`):
```typescript
export interface ApiHandler {
  createMessage(
    systemPrompt: string,
    messages: Anthropic.Messages.MessageParam[],
    metadata?: ApiHandlerCreateMessageMetadata,
  ): ApiStream  // Async generator

  getModel(): { id: string; info: ModelInfo }

  countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>
}
```

**SingleCompletionHandler Interface**:
```typescript
export interface SingleCompletionHandler {
  completePrompt(prompt: string): Promise<string>
}
```

### Base Classes

**BaseProvider** (`src/api/providers/base-provider.ts`):
- Abstract class implementing `ApiHandler`
- Provides `convertToolsForOpenAI()` for strict mode tool conversion
- Provides `convertToolSchemaForOpenAI()` for schema normalization
- Default `countTokens()` implementation using tiktoken

**BaseOpenAiCompatibleProvider** (`src/api/providers/base-openai-compatible-provider.ts`):
- Extends `BaseProvider` for OpenAI-compatible providers
- Implements streaming via OpenAI SDK
- Handles `ApiStream` generation with tool call events
- Processes usage metrics

### Provider Factory

**buildApiHandler()** (`src/api/index.ts`):
```typescript
export function buildApiHandler(configuration: ProviderSettings): ApiHandler {
  const { apiProvider, ...options } = configuration

  switch (apiProvider) {
    case "anthropic":
      return new AnthropicHandler(options)
    case "openrouter":
      return new OpenRouterHandler(options)
    case "lmstudio":
      return new LmStudioHandler(options)
    // ... many more providers
    default:
      return new AnthropicHandler(options)
  }
}
```

### Streaming Response Type

**ApiStream** (`src/api/transform/stream.ts`):
```typescript
export type ApiStream = AsyncGenerator<
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_partial'; index: number; id: string; name?: string; arguments?: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; ... }
  | ...
>
```

### ModelInfo Type

**ModelInfo** (`packages/types/src/model.ts`):
```typescript
export const modelInfoSchema = z.object({
  maxTokens: z.number().nullish(),
  contextWindow: z.number(),
  supportsImages: z.boolean().optional(),
  supportsPromptCache: z.boolean(),
  supportsReasoningBudget: z.boolean().optional(),
  supportsReasoningBinary: z.boolean().optional(),
  supportsTemperature: z.boolean().optional(),
  defaultTemperature: z.number().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
  // ... many more fields
})
```

### Provider Categories

**DynamicProvider**: Fetches models from remote APIs (openrouter, vercel-ai-gateway, litellm, etc.)

**LocalProvider**: Localhost APIs (ollama, lmstudio)

**InternalProvider**: VSCode LM API

**CustomProvider**: User-configurable (openai)

**FauxProvider**: No external calls (fake-ai)

### Tool Conversion

Zoo Code handles OpenAI strict mode tool schema conversion:
```typescript
protected convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
  return tools.map((tool) => {
    // MCP tools use 'mcp--' prefix - disable strict mode
    const isMcp = isMcpTool(tool.function.name)
    return {
      ...tool,
      function: {
        ...tool.function,
        strict: !isMcp,
        parameters: isMcp ? tool.function.parameters
          : this.convertToolSchemaForOpenAI(tool.function.parameters),
      },
    }
  })
}
```

### Error Handling

**handleOpenAIError** (`src/api/providers/utils/openai-error-handler.ts`):
- Normalizes errors across different provider APIs
- Provides actionable error messages

## Key Patterns from Zoo Code

1. **Factory Pattern**: `buildApiHandler()` creates appropriate provider based on config
2. **Async Generator Streaming**: All providers stream responses via `ApiStream`
3. **Tool Schema Conversion**: Centralized conversion for OpenAI strict mode
4. **Provider Categories**: Dynamic, Local, Internal, Custom, Faux
5. **Zod Schema Validation**: All settings validated via discriminated unions
6. **Message Format Normalization**: `convertToOpenAiMessages()` normalizes between providers

## Comparison with ReviewMP

| Aspect | Zoo Code | ReviewMP |
|--------|----------|----------|
| Provider Interface | `ApiHandler` with streaming | `ModelProvider` with `ReviewRequest`/`ReviewResult` |
| Streaming | `AsyncGenerator<ApiStream>` | `Promise<ReviewResult>` (no streaming) |
| Tool Handling | Native tool calls with schema conversion | Fixed tool set |
| Model Info | `ModelInfo` with full metadata | Minimal config |
| Factory | `buildApiHandler()` switch | `ProviderRegistry` with registration |
| Error Handling | Centralized `handleOpenAIError` | Per-provider |
| Settings | Zod discriminated unions | TypeScript interfaces |

## Recommendations for ReviewMP

1. **Add Async Streaming**: Consider `AsyncGenerator` for real-time feedback during review
2. **Expand ModelInfo**: Include context window, pricing, capability flags
3. **Centralize Tool Conversion**: Add `convertToolsForOpenAI()` utility
4. **Use Zod Schemas**: Validate provider settings with discriminated unions
5. **Add Error Normalization**: Create centralized error handler
6. **Provider Metadata**: Track provider capabilities (streaming support, tool support, etc.)

## References

- Zoo Code Provider Source: `src/api/providers/`
- Zoo Code Types: `packages/types/src/`
- Documentation: `https://docs.zoocode.dev/providers`
