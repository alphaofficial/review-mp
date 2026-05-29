import { RuntimeAdapter, RuntimeManifest, NormalizedReviewResult } from '../../../src/providers/runtimeRegistry';
import { ReviewComment, ReviewRequest } from '../../../src/types/review';

export class TestRuntimeAdapter implements RuntimeAdapter {
  readonly manifest: RuntimeManifest = {
    id: 'opencode',
    name: 'Test Runtime Adapter',
    executable: 'test-runtime-adapter',
    promptTransport: 'argv',
    outputFormat: 'json',
    supportsModelOverride: false,
    supportsExecutableOverride: false,
    supportsExtraArgs: false,
  };

  constructor(
    private readonly comments: ReviewComment[],
    private readonly rawText: string = JSON.stringify(comments)
  ) {}

  async invoke(_request: ReviewRequest): Promise<NormalizedReviewResult> {
    return {
      comments: this.comments,
      rawText: this.rawText,
      metadata: {
        runtimeId: 'opencode',
      },
    };
  }

  cancel(): void {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
