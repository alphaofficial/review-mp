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

  async generateChangeBrief(prompt: string): Promise<string> {
    return this.adapter.generateChangeBrief(prompt);
  }

  async runAgentTask(prompt: string): Promise<string> {
    return this.adapter.runAgentTask(prompt);
  }

  cancel(): void {
    this.adapter.cancel();
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
