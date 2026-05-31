import * as vscode from 'vscode';
import { RuntimeId, DEFAULT_RUNTIME_ID } from './providers/runtimeRegistry';

export interface Settings {
  runtime: RuntimeId;
  model: string;
  autoReviewOnStage: boolean;
  autoReviewOnCommit: boolean;
  codeIndexEnabled: boolean;
  executableOverride: string;
  extraArgs: string;
}

let outputChannel: vscode.OutputChannel | undefined;

export function getSettings(): Settings {
  const config = typeof vscode.workspace?.getConfiguration === 'function'
    ? vscode.workspace.getConfiguration('reviewmp')
    : undefined;
  return {
    runtime: config?.get<RuntimeId>('runtime', DEFAULT_RUNTIME_ID) ?? DEFAULT_RUNTIME_ID,
    model: config?.get<string>('model', '') ?? '',
    autoReviewOnStage: config?.get<boolean>('autoReviewOnStage', false) ?? false,
    autoReviewOnCommit: config?.get<boolean>('autoReviewOnCommit', false) ?? false,
    codeIndexEnabled: config?.get<boolean>('codeIndexEnabled', true) ?? true,
    executableOverride: config?.get<string>('executableOverride', '') ?? '',
    extraArgs: config?.get<string>('extraArgs', '') ?? '',
  };
}

export async function setRuntime(runtime: RuntimeId): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('runtime', runtime, vscode.ConfigurationTarget.Global);
}

export async function setCodeIndexEnabled(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration('reviewmp');
  await config.update('codeIndexEnabled', enabled, vscode.ConfigurationTarget.Workspace);
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('ReviewMP');
  }
  return outputChannel;
}

export function showDebugLogs(preserveFocus = false): void {
  getOutputChannel().show(preserveFocus);
}

export function logDebug(message: string, ...data: unknown[]): void {
  try {
    const timestamp = new Date().toISOString();
    const line = [`[ReviewMP DEBUG ${timestamp}]`, message, ...data.map((value) => formatLogValue(value))].join(' ');
    console.log(line);
    getOutputChannel().appendLine(line);
  } catch {
    // Safe to ignore - VS Code API not available in test environments
  }
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function registerSettingsCommands(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(getOutputChannel());

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
    vscode.commands.registerCommand('reviewmp.showDebugLogs', () => {
      showDebugLogs();
    })
  );
}
