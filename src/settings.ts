import * as vscode from 'vscode';
import { isDebugLoggingEnabled } from './buildFlags';
import { RuntimeId, DEFAULT_RUNTIME_ID } from './providers/runtimeRegistry';

export interface Settings {
  runtime: RuntimeId;
  model: string;
  autoReviewOnStage: boolean;
  autoReviewOnCommit: boolean;
  codeIndexEnabled: boolean;
  reviewConcurrency: number;
  executableOverride: string;
  extraArgs: string;
}

let outputChannel: vscode.OutputChannel | undefined;
let codeIndexFeatureEnabled = false;
let codeIndexAutoEnableDefault = true;
let globalStateStore: vscode.Memento | undefined;
let workspaceStateStore: vscode.Memento | undefined;

const CODE_INDEX_FEATURE_ENABLED_KEY = 'codebunny.codeIndex.featureEnabled';
const CODE_INDEX_AUTO_ENABLE_DEFAULT_KEY = 'codebunny.codeIndex.autoEnableDefault';
const CODE_INDEX_WORKSPACE_ENABLED_KEY = 'codebunny.codeIndex.workspaceEnabled';

export function getSettings(): Settings {
  const config = typeof vscode.workspace?.getConfiguration === 'function'
    ? vscode.workspace.getConfiguration('codebunny')
    : undefined;
  const workspaceCodeIndexEnabled = getWorkspaceCodeIndexEnabled();
  return {
    runtime: config?.get<RuntimeId>('runtime', DEFAULT_RUNTIME_ID) ?? DEFAULT_RUNTIME_ID,
    model: config?.get<string>('model', '') ?? '',
    autoReviewOnStage: config?.get<boolean>('autoReviewOnStage', false) ?? false,
    autoReviewOnCommit: config?.get<boolean>('autoReviewOnCommit', false) ?? false,
    codeIndexEnabled: codeIndexFeatureEnabled && workspaceCodeIndexEnabled,
    reviewConcurrency: clampInteger(config?.get<number>('reviewConcurrency', 5) ?? 5, 1, 20),
    executableOverride: config?.get<string>('executableOverride', '') ?? '',
    extraArgs: config?.get<string>('extraArgs', '') ?? '',
  };
}

export function initializeCodeIndexSettingsState(globalState: vscode.Memento, workspaceState: vscode.Memento): void {
  globalStateStore = globalState;
  workspaceStateStore = workspaceState;
  codeIndexFeatureEnabled = globalState.get<boolean>(CODE_INDEX_FEATURE_ENABLED_KEY, false);
  codeIndexAutoEnableDefault = globalState.get<boolean>(CODE_INDEX_AUTO_ENABLE_DEFAULT_KEY, true);
}

export function getCodeIndexFeatureEnabled(): boolean {
  return codeIndexFeatureEnabled;
}

export function getCodeIndexAutoEnableDefault(): boolean {
  return codeIndexAutoEnableDefault;
}

export function getWorkspaceCodeIndexEnabled(): boolean {
  return getWorkspaceCodeIndexEnabledOverride() ?? codeIndexAutoEnableDefault;
}

export function getWorkspaceCodeIndexEnabledOverride(): boolean | undefined {
  return workspaceStateStore?.get<boolean | undefined>(CODE_INDEX_WORKSPACE_ENABLED_KEY, undefined);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export async function setRuntime(runtime: RuntimeId): Promise<void> {
  const config = vscode.workspace.getConfiguration('codebunny');
  await config.update('runtime', runtime, vscode.ConfigurationTarget.Global);
}

export async function setCodeIndexEnabled(enabled: boolean): Promise<void> {
  codeIndexFeatureEnabled = enabled;
  await globalStateStore?.update(CODE_INDEX_FEATURE_ENABLED_KEY, enabled);
}

export async function setCodeIndexAutoEnableDefault(enabled: boolean): Promise<void> {
  codeIndexAutoEnableDefault = enabled;
  await globalStateStore?.update(CODE_INDEX_AUTO_ENABLE_DEFAULT_KEY, enabled);
}

export async function setWorkspaceCodeIndexEnabled(enabled: boolean): Promise<void> {
  if (enabled === codeIndexAutoEnableDefault) {
    await workspaceStateStore?.update(CODE_INDEX_WORKSPACE_ENABLED_KEY, undefined);
    return;
  }

  await workspaceStateStore?.update(CODE_INDEX_WORKSPACE_ENABLED_KEY, enabled);
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('CodeBunny');
  }
  return outputChannel;
}

export function showDebugLogs(preserveFocus = false): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }

  getOutputChannel().show(preserveFocus);
}

export function logDebug(message: string, ...data: unknown[]): void {
  if (!isDebugLoggingEnabled()) {
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const line = [`[CodeBunny DEBUG ${timestamp}]`, message, ...data.map((value) => formatLogValue(value))].join(' ');
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
  if (isDebugLoggingEnabled()) {
    context.subscriptions.push(getOutputChannel());
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codebunny.selectRuntime', async () => {
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
    vscode.commands.registerCommand('codebunny.showDebugLogs', () => {
      showDebugLogs();
    })
  );
}
