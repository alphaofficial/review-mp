import { ReviewRequest, ReviewResult, ReviewComment, ModelUsage } from '../types/review';
import { CancellationToken } from 'vscode';

export interface ModelProvider {
  readonly name: string;
  review(request: ReviewRequest, token?: CancellationToken): Promise<ReviewResult>;
  /**
   * @deprecated Fix application is now handled directly by ReviewMP's FixApplicator.
   * This method is no longer called by ReviewMP and exists only for backward compatibility.
   */
  applyFix?(filePath: string, line: number, fix: string, token?: CancellationToken): Promise<void>;
  cancel(): void;
  isAvailable(): Promise<boolean>;
}

export interface ProviderConfig {
  opencodePath?: string;
  model?: string;
}

export const DEFAULT_OPENCODE_PROVIDER_NAME = 'opencode';

export const providerNames = ['opencode', 'custom-cli', 'openai-compatible'] as const;
export type ProviderName = (typeof providerNames)[number];

export interface ModelInfo {
  providerName: string;
  modelId: string;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
}

export interface ModelProviderWithMetadata extends ModelProvider {
  getMetadata(): ModelInfo;
}

export type ProviderEvent =
  | { type: 'progress'; message: string }
  | { type: 'comment'; comment: ReviewComment }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done' };

export interface ProviderSettings {
  provider: ProviderName;
  opencodePath: string;
  model: string;
  autoReviewOnStage: boolean;
  autoReviewOnCommit: boolean;
  debug: boolean;
  customCliCommand: string;
  customCliArgs: string;
  openaiCompatibleEndpoint: string;
}