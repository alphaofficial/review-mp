import * as vscode from 'vscode';
import { RuntimeId, DEFAULT_RUNTIME_ID } from './providers/runtimeRegistry';

export type ProviderType = 'opencode' | 'custom-cli' | 'openai-compatible';

export interface Settings {
  runtime: RuntimeId;
  provider: ProviderType;
  model: string;
  autoReviewOnStage: boolean;
  autoReviewOnCommit: boolean;
  debug: boolean;
  opencodePath: string;
  customCliCommand: string;
  customCliArgs: string;
  openaiCompatibleEndpoint: string;
  executableOverride: string;
  extraArgs: string;
}

export function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('reviewmp');
  return {
    runtime: config.get<RuntimeId>('runtime', DEFAULT_RUNTIME_ID),
    provider: config.get<ProviderType>('provider', 'opencode'),
    model: config.get<string>('model', ''),
    autoReviewOnStage: config.get<boolean>('autoReviewOnStage', false),
    autoReviewOnCommit: config.get<boolean>('autoReviewOnCommit', false),
    debug: config.get<boolean>('debug', false),
    opencodePath: config.get<string>('opencodePath', 'opencode'),
    customCliCommand: config.get<string>('customCliCommand', ''),
    customCliArgs: config.get<string>('customCliArgs', ''),
    openaiCompatibleEndpoint: config.get<string>('openaiCompatibleEndpoint', ''),
    executableOverride: config.get<string>('executableOverride', ''),
    extraArgs: config.get<string>('extraArgs', ''),
  };
}

export async function setRuntime(runtime: RuntimeId): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('runtime', runtime, vscode.ConfigurationTarget.Global);
}

export async function setProvider(provider: ProviderType): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('provider', provider, vscode.ConfigurationTarget.Global);
}

export async function setDebug(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('debug', enabled, vscode.ConfigurationTarget.Global);
}

export async function toggleDebug(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  const current = config.get<boolean>('debug', false);
  await config.update('debug', !current, vscode.ConfigurationTarget.Global);
  return !current;
}

export function logDebug(message: string, ...data: unknown[]): void {
  try {
    const settings = getSettings();
    if (settings.debug) {
      const timestamp = new Date().toISOString();
      console.log(`[ReviewMP DEBUG ${timestamp}]`, message, ...data);
    }
  } catch {
    // Safe to ignore - VS Code API not available in test environments
  }
}

export class SecretStorage {
  constructor(private storage: vscode.SecretStorage) {}

  async store(provider: ProviderType, apiKey: string): Promise<void> {
    const SECRETS_PREFIX = 'reviewmp:apikey:';
    await this.storage.store(`${SECRETS_PREFIX}${provider}`, apiKey);
  }

  async get(provider: ProviderType): Promise<string | undefined> {
    const SECRETS_PREFIX = 'reviewmp:apikey:';
    return this.storage.get(`${SECRETS_PREFIX}${provider}`);
  }

  async delete(provider: ProviderType): Promise<void> {
    const SECRETS_PREFIX = 'reviewmp:apikey:';
    await this.storage.delete(`${SECRETS_PREFIX}${provider}`);
  }

  async getAll(): Promise<Record<ProviderType, string | undefined>> {
    const providers: ProviderType[] = ['opencode', 'custom-cli', 'openai-compatible'];
    const result: Record<string, string | undefined> = {};
    for (const provider of providers) {
      result[provider] = await this.storage.get(`reviewmp:apikey:${provider}`);
    }
    return result as Record<ProviderType, string | undefined>;
  }
}

export async function registerSettingsCommands(context: vscode.ExtensionContext): Promise<void> {
  const secretStorage = new SecretStorage(context.secrets);

  context.subscriptions.push(
    vscode.commands.registerCommand('reviewmp.setApiKey', async () => {
      const availableProviders: ProviderType[] = ['openai-compatible', 'custom-cli'];
      const items = availableProviders.map(p => ({ label: p, value: p }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select provider for API key',
      });

      if (!selected) {
        return;
      }

      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${selected.value}`,
        password: true,
        ignoreFocusOut: true,
      });

      if (apiKey) {
        await secretStorage.store(selected.value, apiKey);
        vscode.window.showInformationMessage(`API key set for ${selected.value}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reviewmp.clearApiKey', async () => {
      const items: { label: ProviderType; value: ProviderType }[] = [
        { label: 'openai-compatible', value: 'openai-compatible' },
        { label: 'custom-cli', value: 'custom-cli' },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select provider to clear API key',
      });

      if (!selected) {
        return;
      }

      await secretStorage.delete(selected.value);
      vscode.window.showInformationMessage(`API key cleared for ${selected.value}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reviewmp.selectProvider', async () => {
      const settings = getSettings();
      const items: { label: string; value: ProviderType; description: string }[] = [
        { label: 'OpenCode', value: 'opencode', description: 'Use OpenCode CLI for reviews' },
        { label: 'Custom CLI', value: 'custom-cli', description: 'Use a custom CLI command' },
        { label: 'OpenAI Compatible', value: 'openai-compatible', description: 'Use OpenAI-compatible API' },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Current provider: ${settings.provider}`,
      });

      if (selected) {
        await setProvider(selected.value);
        vscode.window.showInformationMessage(`Provider set to ${selected.value}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reviewmp.selectRuntime', async () => {
      const settings = getSettings();
      const items: { label: string; value: RuntimeId; description: string }[] = [
        { label: 'Claude', value: 'claude', description: 'Use Claude for reviews' },
        { label: 'Copilot', value: 'copilot', description: 'Use GitHub Copilot for reviews' },
        { label: 'Codex', value: 'codex', description: 'Use Codex for reviews' },
        { label: 'Gemini', value: 'gemini', description: 'Use Gemini for reviews' },
        { label: 'Hermes', value: 'hermes', description: 'Use Hermes for reviews' },
        { label: 'Pi', value: 'pi', description: 'Use Pi for reviews' },
        { label: 'OpenCode', value: 'opencode', description: 'Use OpenCode CLI for reviews' },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Current runtime: ${settings.runtime}`,
      });

      if (selected) {
        await setRuntime(selected.value);
        vscode.window.showInformationMessage(`Runtime set to ${selected.value}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('reviewmp.toggleDebug', async () => {
      const newValue = await toggleDebug();
      vscode.window.showInformationMessage(`Debug mode ${newValue ? 'enabled' : 'disabled'}`);
    })
  );
}
