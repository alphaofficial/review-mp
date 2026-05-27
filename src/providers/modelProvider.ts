import { ReviewRequest, ReviewResult } from '../types/review';
import { CancellationToken } from 'vscode';

export interface ModelProvider {
  readonly name: string;
  review(request: ReviewRequest, token?: CancellationToken): Promise<ReviewResult>;
  cancel(): void;
  isAvailable(): Promise<boolean>;
}