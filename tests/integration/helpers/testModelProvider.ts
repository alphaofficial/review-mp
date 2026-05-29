import { ModelProvider } from '../../../src/providers/modelProvider';
import { RuntimeAdapter } from '../../../src/providers/runtimeRegistry';

export class TestModelProvider implements ModelProvider {
  readonly name = 'Test Model Provider';

  constructor(private readonly adapter: RuntimeAdapter) {}

  async review(request: Parameters<ModelProvider['review']>[0]) {
    const result = await this.adapter.invoke(request);
    return {
      comments: result.comments,
      provider: this.name,
      usage: result.usage,
    };
  }

  cancel(): void {
    this.adapter.cancel();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
