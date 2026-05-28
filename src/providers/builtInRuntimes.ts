import { RuntimeId, RuntimeManifest, RuntimeRegistry } from './runtimeRegistry';

export const builtInRuntimes: RuntimeManifest[] = [
  {
    id: 'claude',
    name: 'Claude',
    executable: 'claude',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'copilot',
    name: 'Copilot',
    executable: 'copilot',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    executable: 'codex',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    executable: 'gemini',
    promptTransport: 'argv',
    outputFormat: 'ndjson',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'hermes',
    name: 'Hermes',
    executable: 'hermes',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'pi',
    name: 'Pi',
    executable: 'pi',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: false,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    executable: 'opencode',
    promptTransport: 'argv',
    outputFormat: 'ndjson',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['run', '--format', 'json'],
    modelArgFlag: '--model',
  },
];

export function createBuiltInRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  for (const manifest of builtInRuntimes) {
    registry.register(manifest);
  }
  return registry;
}

export const globalRuntimeRegistry = createBuiltInRegistry();
