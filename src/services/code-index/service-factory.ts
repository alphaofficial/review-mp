import { CodeIndexResolvedSettings } from './config-shared';
import { RepoKnowledgeIndex } from '../../harness/repoKnowledgeIndex';
import { CodeIndexWorkerClient } from './workerClient';
import { CodeIndexOrchestrator } from './orchestrator';

export class CodeIndexServiceFactory {
  static async createOrchestrator(
    workspaceRoot: string,
    resolvedSettings?: CodeIndexResolvedSettings
  ): Promise<CodeIndexOrchestrator> {
    const index = new CodeIndexWorkerClient(
      workspaceRoot,
      RepoKnowledgeIndex.getDefaultStorageRoot(),
      resolvedSettings
    );
    return new CodeIndexOrchestrator(workspaceRoot, index);
  }
}
