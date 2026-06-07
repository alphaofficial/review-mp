import * as vscode from 'vscode';
import {
  clampDimension,
  clampMaxResults,
  clampScore,
  CodeIndexEmbedderProvider,
  CodeIndexResolvedSettings,
  CodeIndexSetupSettings,
  DEFAULT_CODE_INDEX_SETTINGS,
  getDefaultCodeIndexSettings,
  isCodeIndexConfigured,
  normalizeUrl,
} from './config-shared';

export interface CodeIndexSetupState extends CodeIndexSetupSettings {
  qdrantApiKey: string;
  qdrantApiKeyConfigured: boolean;
}

export interface CodeIndexSetupSavePayload extends CodeIndexSetupSettings {
  featureEnabled: boolean;
  preserveQdrantApiKey?: boolean;
  qdrantApiKey: string;
}

const QDRANT_API_KEY_SECRET = 'codebunny.codeIndex.qdrantApiKey';

export function getCodeIndexSetupSettings(): CodeIndexSetupSettings {
  const config = typeof vscode.workspace?.getConfiguration === 'function'
    ? vscode.workspace.getConfiguration('codebunny')
    : undefined;

  return {
    embedderProvider: (config?.get<CodeIndexEmbedderProvider>('codeIndexEmbedderProvider', DEFAULT_CODE_INDEX_SETTINGS.embedderProvider)
      ?? DEFAULT_CODE_INDEX_SETTINGS.embedderProvider),
    ollamaBaseUrl: normalizeUrl(
      config?.get<string>('codeIndexOllamaBaseUrl', DEFAULT_CODE_INDEX_SETTINGS.ollamaBaseUrl)
      ?? DEFAULT_CODE_INDEX_SETTINGS.ollamaBaseUrl
    ),
    ollamaModel: (config?.get<string>('codeIndexOllamaModel', DEFAULT_CODE_INDEX_SETTINGS.ollamaModel)
      ?? DEFAULT_CODE_INDEX_SETTINGS.ollamaModel).trim() || DEFAULT_CODE_INDEX_SETTINGS.ollamaModel,
    modelDimension: clampDimension(
      config?.get<number>('codeIndexModelDimension', DEFAULT_CODE_INDEX_SETTINGS.modelDimension)
      ?? DEFAULT_CODE_INDEX_SETTINGS.modelDimension
    ),
    qdrantUrl: normalizeUrl(
      config?.get<string>('codeIndexQdrantUrl', DEFAULT_CODE_INDEX_SETTINGS.qdrantUrl)
      ?? DEFAULT_CODE_INDEX_SETTINGS.qdrantUrl
    ),
    searchMinScore: clampScore(
      config?.get<number>('codeIndexSearchMinScore', DEFAULT_CODE_INDEX_SETTINGS.searchMinScore)
      ?? DEFAULT_CODE_INDEX_SETTINGS.searchMinScore
    ),
    searchMaxResults: clampMaxResults(
      config?.get<number>('codeIndexSearchMaxResults', DEFAULT_CODE_INDEX_SETTINGS.searchMaxResults)
      ?? DEFAULT_CODE_INDEX_SETTINGS.searchMaxResults
    ),
  };
}

export async function saveCodeIndexSetupSettings(settings: CodeIndexSetupSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration('codebunny');
  await Promise.all([
    config.update('codeIndexEmbedderProvider', settings.embedderProvider, vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexOllamaBaseUrl', normalizeUrl(settings.ollamaBaseUrl), vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexOllamaModel', settings.ollamaModel.trim(), vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexModelDimension', clampDimension(settings.modelDimension), vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexQdrantUrl', normalizeUrl(settings.qdrantUrl), vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexSearchMinScore', clampScore(settings.searchMinScore), vscode.ConfigurationTarget.Workspace),
    config.update('codeIndexSearchMaxResults', clampMaxResults(settings.searchMaxResults), vscode.ConfigurationTarget.Workspace),
  ]);
}

export class CodeIndexSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getQdrantApiKey(): Promise<string> {
    return await this.secrets.get(QDRANT_API_KEY_SECRET) ?? '';
  }

  async setQdrantApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await this.secrets.delete(QDRANT_API_KEY_SECRET);
      return;
    }

    await this.secrets.store(QDRANT_API_KEY_SECRET, trimmed);
  }

  async getResolvedSettings(): Promise<CodeIndexResolvedSettings> {
    const settings = getCodeIndexSetupSettings();
    const apiKey = await this.getQdrantApiKey();
    return {
      ...settings,
      qdrantApiKey: apiKey || undefined,
    };
  }

  async getSetupState(): Promise<CodeIndexSetupState> {
    const apiKey = await this.getQdrantApiKey();
    return {
      ...getCodeIndexSetupSettings(),
      qdrantApiKey: '',
      qdrantApiKeyConfigured: Boolean(apiKey),
    };
  }
}

export {
  clampDimension,
  clampMaxResults,
  clampScore,
  CodeIndexEmbedderProvider,
  CodeIndexResolvedSettings,
  CodeIndexSetupSettings,
  getDefaultCodeIndexSettings,
  isCodeIndexConfigured,
  normalizeUrl,
};
