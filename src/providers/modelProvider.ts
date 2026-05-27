import { ReviewRequest, ReviewResult } from '../types/review';
import { CancellationToken } from 'vscode';

export interface ModelProvider {
  readonly name: string;
  review(request: ReviewRequest, token?: CancellationToken): Promise<ReviewResult>;
  applyFix?(filePath: string, line: number, fix: string, token?: CancellationToken): Promise<void>;
  cancel(): void;
  isAvailable(): Promise<boolean>;
}

export interface ProviderConfig {
  opencodePath?: string;
  model?: string;
}

export const DEFAULT_OPENCODE_PROVIDER_NAME = 'opencode';

export const providerNames = ['opencode'] as const;
export type ProviderName = (typeof providerNames)[number];