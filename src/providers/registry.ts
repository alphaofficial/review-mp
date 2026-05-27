import { ModelProvider, DEFAULT_OPENCODE_PROVIDER_NAME } from './modelProvider';

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();
  private defaultProviderName: string = DEFAULT_OPENCODE_PROVIDER_NAME;

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name);
  }

  getDefault(): ModelProvider | undefined {
    return this.providers.get(this.defaultProviderName);
  }

  setDefault(name: string): boolean {
    if (this.providers.has(name)) {
      this.defaultProviderName = name;
      return true;
    }
    return false;
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }

  isRegistered(name: string): boolean {
    return this.providers.has(name);
  }
}

export const globalRegistry = new ProviderRegistry();