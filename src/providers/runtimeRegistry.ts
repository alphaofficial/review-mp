import { ReviewRequest, ReviewComment, ModelUsage } from '../types/review';

export type RuntimeId = 'claude' | 'copilot' | 'codex' | 'gemini' | 'hermes' | 'pi' | 'opencode';

export const runtimeIds: RuntimeId[] = ['claude', 'copilot', 'codex', 'gemini', 'hermes', 'pi', 'opencode'];

export const DEFAULT_RUNTIME_ID: RuntimeId = 'opencode';

export type PromptTransport = 'argv' | 'stdin';
export type OutputFormat = 'text' | 'json' | 'ndjson';

export interface RuntimeManifest {
  id: RuntimeId;
  name: string;
  executable: string;
  promptTransport: PromptTransport;
  outputFormat: OutputFormat;
  supportsModelOverride: boolean;
  supportsExecutableOverride?: boolean;
  supportsExtraArgs?: boolean;
  prePromptArgs?: string[];
  modelArgFlag?: string;
  workingDirectoryArgFlag?: string;
}

export interface NormalizedReviewResult {
  comments: ReviewComment[];
  rawText: string;
  usage?: ModelUsage;
  metadata?: {
    runtimeId: RuntimeId;
    model?: string;
  };
}

export interface RuntimeAdapter {
  manifest: RuntimeManifest;
  invoke(request: ReviewRequest): Promise<NormalizedReviewResult>;
  generateChangeBrief(prompt: string): Promise<string>;
  runAgentTask(prompt: string): Promise<string>;
  cancel(): void;
  isAvailable(): Promise<boolean>;
}

export interface RuntimeSettings {
  runtime: RuntimeId;
  model?: string;
  autoReviewOnStage?: boolean;
  autoReviewOnCommit?: boolean;
  executableOverride?: string;
  extraArgs?: string[];
}

export class RuntimeRegistry {
  private manifests: Map<RuntimeId, RuntimeManifest> = new Map();
  private defaultId: RuntimeId | null = null;

  register(manifest: RuntimeManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  get(id: RuntimeId): RuntimeManifest | undefined {
    return this.manifests.get(id);
  }

  getDefault(): RuntimeManifest | undefined {
    if (this.defaultId) {
      return this.manifests.get(this.defaultId);
    }
    return this.manifests.get(DEFAULT_RUNTIME_ID);
  }

  setDefault(id: RuntimeId): boolean {
    if (!this.manifests.has(id)) {
      return false;
    }
    this.defaultId = id;
    return true;
  }

  list(): RuntimeId[] {
    return Array.from(this.manifests.keys());
  }

  isRegistered(id: RuntimeId): boolean {
    return this.manifests.has(id);
  }
}
