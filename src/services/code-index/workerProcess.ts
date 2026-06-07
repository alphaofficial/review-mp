import { RepoKnowledgeIndex } from '../../harness/repoKnowledgeIndex';
import { CodeIndexResolvedSettings } from './config-shared';

type WorkerRequest =
  | { id: number; method: 'rebuildWorkspace' }
  | { id: number; method: 'indexFiles'; candidateFilePaths: string[] }
  | { id: number; method: 'removeFiles'; candidateFilePaths: string[] }
  | { id: number; method: 'clearStorage' }
  | { id: number; method: 'getCurrentBranch' }
  | { id: number; method: 'close' };

type WorkerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

const workspaceRoot = process.env.CODEBUNNY_INDEX_WORKSPACE_ROOT;
const storageRoot = process.env.CODEBUNNY_INDEX_STORAGE_ROOT;

if (!workspaceRoot) {
  throw new Error('CODEBUNNY_INDEX_WORKSPACE_ROOT is required');
}

RepoKnowledgeIndex.setDefaultStorageRoot(storageRoot);
RepoKnowledgeIndex.setDefaultConnectionSettings(readConnectionSettingsFromEnv());

const indexPromise = RepoKnowledgeIndex.forWorkspace(workspaceRoot);

async function handleRequest(request: WorkerRequest): Promise<unknown> {
  const index = await indexPromise;

  switch (request.method) {
    case 'rebuildWorkspace':
      return index.rebuildWorkspace();
    case 'indexFiles':
      return index.indexFiles(request.candidateFilePaths);
    case 'removeFiles':
      return index.removeFiles(request.candidateFilePaths);
    case 'clearStorage':
      return index.clearStorage();
    case 'getCurrentBranch':
      return index.getCurrentBranch();
    case 'close':
      await index.close();
      return undefined;
    default:
      throw new Error(`Unsupported worker method: ${(request as { method: string }).method}`);
  }
}

process.on('message', async (message: WorkerRequest) => {
  if (!message || typeof message !== 'object' || typeof message.id !== 'number') {
    return;
  }

  let response: WorkerResponse;
  try {
    const result = await handleRequest(message);
    response = { id: message.id, ok: true, result };
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  process.send?.(response);

  if (message.method === 'close') {
    process.disconnect?.();
    process.exit(0);
  }
});

function readConnectionSettingsFromEnv(): CodeIndexResolvedSettings | undefined {
  const embedderProvider = process.env.CODEBUNNY_INDEX_EMBEDDER_PROVIDER;
  const ollamaBaseUrl = process.env.CODEBUNNY_INDEX_OLLAMA_BASE_URL;
  const ollamaModel = process.env.CODEBUNNY_INDEX_OLLAMA_MODEL;
  const modelDimension = Number(process.env.CODEBUNNY_INDEX_MODEL_DIMENSION);
  const qdrantUrl = process.env.CODEBUNNY_INDEX_QDRANT_URL;
  const searchMinScore = Number(process.env.CODEBUNNY_INDEX_SEARCH_MIN_SCORE);
  const searchMaxResults = Number(process.env.CODEBUNNY_INDEX_SEARCH_MAX_RESULTS);

  if (
    !embedderProvider
    || !ollamaBaseUrl
    || !ollamaModel
    || !Number.isFinite(modelDimension)
    || !qdrantUrl
    || !Number.isFinite(searchMinScore)
    || !Number.isFinite(searchMaxResults)
  ) {
    return undefined;
  }

  return {
    embedderProvider: embedderProvider as CodeIndexResolvedSettings['embedderProvider'],
    ollamaBaseUrl,
    ollamaModel,
    modelDimension,
    qdrantUrl,
    qdrantApiKey: process.env.CODEBUNNY_INDEX_QDRANT_API_KEY || undefined,
    searchMinScore,
    searchMaxResults,
  };
}
