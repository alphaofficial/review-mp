import { ModelProvider, ProviderSettings } from './modelProvider';
import { OpenCodeProvider } from './opencode';
import { CustomCliProvider } from './customCli';
import { OpenAICompatibleProvider } from './openaiCompatible';

export function buildProvider(settings: ProviderSettings): ModelProvider {
  switch (settings.provider) {
    case 'opencode':
      return new OpenCodeProvider({
        opencodePath: settings.opencodePath,
        model: settings.model,
      });

    case 'custom-cli':
      if (!settings.customCliCommand || settings.customCliCommand.trim() === '') {
        throw new Error(
          `Custom CLI command not configured. Set reviewmp.customCliCommand in settings or pass command in config.`
        );
      }
      return new CustomCliProvider({
        command: settings.customCliCommand,
        args: settings.customCliArgs,
        model: settings.model,
      });

    case 'openai-compatible':
      if (!settings.openaiCompatibleEndpoint || settings.openaiCompatibleEndpoint.trim() === '') {
        throw new Error(
          `OpenAI-compatible endpoint not configured. Set reviewmp.openaiCompatibleEndpoint in settings or pass endpoint in config.`
        );
      }
      return new OpenAICompatibleProvider({
        endpoint: settings.openaiCompatibleEndpoint,
        model: settings.model,
      });

    default:
      throw new Error(`Unknown provider type: ${settings.provider}`);
  }
}

export function createProviderFromConfig(settings: ProviderSettings): ModelProvider {
  return buildProvider(settings);
}
