import { CodeIndexResolvedSettings } from '../services/code-index/config-shared';

export const DEFAULT_EMBEDDING_DIMENSION = 768;
export const EMBEDDING_ALGORITHM_VERSION = 'ollama-embed-v1';
const OLLAMA_CONTEXT_RETRY_INPUT_CHARS = 1_200;

export async function embedText(text: string, settings: CodeIndexResolvedSettings): Promise<number[]> {
  let response = await requestEmbedding(text, settings);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (isOllamaContextLengthError(response.status, body) && text.length > OLLAMA_CONTEXT_RETRY_INPUT_CHARS) {
      response = await requestEmbedding(text.slice(0, OLLAMA_CONTEXT_RETRY_INPUT_CHARS), settings);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama embedding request failed: ${response.status} ${body}`.trim());
  }

  const payload = await response.json() as OllamaEmbedResponse;
  const vector = extractEmbeddingVector(payload);
  if (vector.length !== settings.modelDimension) {
    throw new Error(`Embedding dimension mismatch: expected ${settings.modelDimension}, got ${vector.length}`);
  }

  return vector;
}

async function requestEmbedding(text: string, settings: CodeIndexResolvedSettings): Promise<Response> {
  return fetch(`${settings.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.ollamaModel,
      input: text,
    }),
  });
}

export function buildEmbeddingVersion(settings: CodeIndexResolvedSettings): string {
  return [
    EMBEDDING_ALGORITHM_VERSION,
    settings.embedderProvider,
    settings.ollamaModel,
    settings.modelDimension,
  ].join(':');
}

interface OllamaEmbedResponse {
  embedding?: unknown[];
  embeddings?: unknown[][];
}

function extractEmbeddingVector(payload: OllamaEmbedResponse): number[] {
  if (Array.isArray(payload.embedding)) {
    return payload.embedding.map((value) => Number(value));
  }

  if (Array.isArray(payload.embeddings?.[0])) {
    return payload.embeddings[0].map((value: unknown) => Number(value));
  }

  throw new Error('Ollama embedding response did not include a vector');
}

function isOllamaContextLengthError(status: number, body: string): boolean {
  return status === 400 && body.toLowerCase().includes('context length');
}
