export interface CodeIndexBackend {
  rebuildWorkspace(): Promise<number>;
  indexFiles(candidateFilePaths: string[]): Promise<void>;
  removeFiles(candidateFilePaths: string[]): Promise<void>;
  clearStorage(): Promise<void>;
  getCurrentBranch(): Promise<string>;
  close(): Promise<void>;
}
