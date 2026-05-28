import { RuntimeId, RuntimeManifest, RuntimeRegistry } from './runtimeRegistry';

export const builtInRuntimes: RuntimeManifest[] = [
  {
    id: 'claude',
    name: 'Claude',
    executable: 'claude',
    promptTransport: 'stdin',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['-p'],
    modelArgFlag: '--model',
  },
  {
    id: 'copilot',
    name: 'Copilot',
    executable: 'copilot',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['-p'],
    modelArgFlag: '--model',
  },
  {
    id: 'codex',
    name: 'Codex',
    executable: 'codex',
    promptTransport: 'stdin',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['exec', '--skip-git-repo-check'],
    modelArgFlag: '--model',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    executable: 'gemini',
    promptTransport: 'argv',
    outputFormat: 'ndjson',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['-p'],
    modelArgFlag: '--model',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    executable: 'hermes',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['chat', '-q'],
    modelArgFlag: '--model',
  },
  {
    id: 'pi',
    name: 'Pi',
    executable: 'pi',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['-p'],
    modelArgFlag: '--model',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    executable: 'opencode',
    promptTransport: 'argv',
    outputFormat: 'text',
    supportsModelOverride: true,
    supportsExecutableOverride: true,
    supportsExtraArgs: true,
    prePromptArgs: ['run', '--pure', '--dangerously-skip-permissions'],
    modelArgFlag: '--model',
    workingDirectoryArgFlag: '--dir',
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
