import { RepoKnowledgeIndex } from '../../harness/repoKnowledgeIndex';
import { CodeIndexWorkerClient } from './workerClient';
import { CodeIndexOrchestrator } from './orchestrator';

export class CodeIndexServiceFactory {
  static async createOrchestrator(workspaceRoot: string): Promise<CodeIndexOrchestrator> {
    const index = new CodeIndexWorkerClient(
      workspaceRoot,
      RepoKnowledgeIndex.getDefaultStorageRoot()
    );
    return new CodeIndexOrchestrator(workspaceRoot, index);
  }
}
