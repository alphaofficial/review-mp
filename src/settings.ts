import * as vscode from 'vscode';
import { RuntimeId, DEFAULT_RUNTIME_ID } from './providers/runtimeRegistry';

export interface Settings {
  runtime: RuntimeId;
  model: string;
  autoReviewOnStage: boolean;
  autoReviewOnCommit: boolean;
  debug: boolean;
  executableOverride: string;
  extraArgs: string;
}

export function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('reviewmp');
  return {
    runtime: config.get<RuntimeId>('runtime', DEFAULT_RUNTIME_ID),
    model: config.get<string>('model', ''),
    autoReviewOnStage: config.get<boolean>('autoReviewOnStage', false),
    autoReviewOnCommit: config.get<boolean>('autoReviewOnCommit', false),
    debug: config.get<boolean>('debug', false),
    executableOverride: config.get<string>('executableOverride', ''),
    extraArgs: config.get<string>('extraArgs', ''),
  };
}

export async function setRuntime(runtime: RuntimeId): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('runtime', runtime, vscode.ConfigurationTarget.Global);
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

export async function registerSettingsCommands(context: vscode.ExtensionContext): Promise<void> {
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
