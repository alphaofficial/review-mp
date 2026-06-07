export type CodeIndexEmbedderProvider = 'ollama';

export interface CodeIndexSetupSettings {
  embedderProvider: CodeIndexEmbedderProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  modelDimension: number;
  qdrantUrl: string;
  searchMinScore: number;
  searchMaxResults: number;
}

export interface CodeIndexResolvedSettings extends CodeIndexSetupSettings {
  qdrantApiKey?: string;
}

export const DEFAULT_CODE_INDEX_SETTINGS: CodeIndexSetupSettings = {
  embedderProvider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'nomic-embed-text',
  modelDimension: 768,
  qdrantUrl: 'http://localhost:6333',
  searchMinScore: 0.4,
  searchMaxResults: 50,
};

export function getDefaultCodeIndexSettings(): CodeIndexSetupSettings {
  return { ...DEFAULT_CODE_INDEX_SETTINGS };
}

export function isCodeIndexConfigured(
  settings: Partial<Pick<CodeIndexSetupSettings, 'embedderProvider' | 'ollamaBaseUrl' | 'qdrantUrl'>>
): boolean {
  if (settings.embedderProvider !== 'ollama') {
    return false;
  }

  return Boolean(normalizeUrl(settings.ollamaBaseUrl ?? '') && normalizeUrl(settings.qdrantUrl ?? ''));
}

export function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function clampDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CODE_INDEX_SETTINGS.modelDimension;
  }

  return Math.max(1, Math.trunc(value));
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CODE_INDEX_SETTINGS.searchMinScore;
  }

  return Math.min(1, Math.max(0, Number(value.toFixed(2))));
}

export function clampMaxResults(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CODE_INDEX_SETTINGS.searchMaxResults;
  }

  return Math.min(200, Math.max(1, Math.trunc(value)));
}
