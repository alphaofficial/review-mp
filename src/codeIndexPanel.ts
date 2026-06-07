import * as vscode from 'vscode';
import { CodeIndexController, CodeIndexViewState } from './services/code-index/controller';

export class CodeIndexPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private controllerListener?: vscode.Disposable;

  constructor(private readonly controller: CodeIndexController) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codebunny.codeIndex',
      'CodeBunny Codebase Indexing',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
      }
    );

    this.panel.webview.html = this.render(this.controller.getState());
    this.panel.onDidDispose(() => {
      this.controllerListener?.dispose();
      this.controllerListener = undefined;
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'enable':
          await this.controller.setEnabled(true);
          break;
        case 'disable':
          await this.controller.setEnabled(false);
          break;
        case 'rebuild':
          await this.controller.rebuild();
          break;
        case 'stop':
          await this.controller.stop();
          break;
        case 'clear':
          await this.controller.clear();
          break;
      }
      this.postState();
    });

    this.controllerListener = this.controller.onDidChangeState(() => {
      this.postState();
    });
    this.postState();
  }

  dispose(): void {
    this.controllerListener?.dispose();
    this.panel?.dispose();
  }

  private postState(): void {
    if (!this.panel) {
      return;
    }

    const state = this.controller.getState();
    this.panel.webview.postMessage({
      type: 'indexState',
      value: serializeState(state),
    });
    this.panel.title = `CodeBunny Codebase Indexing${state.enabled ? '' : ' (Disabled)'}`;
  }

  private render(state: CodeIndexViewState): string {
    const serialized = JSON.stringify(serializeState(state));
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeBunny Codebase Indexing</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0;
        padding: 24px;
      }
      .panel {
        max-width: 820px;
        margin: 0 auto;
        border: 1px solid var(--vscode-widget-border);
        border-radius: 12px;
        background: var(--vscode-sideBar-background);
        overflow: hidden;
      }
      .header, .body {
        padding: 20px 24px;
      }
      .header {
        border-bottom: 1px solid var(--vscode-widget-border);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0;
        line-height: 1.5;
        color: var(--vscode-descriptionForeground);
      }
      .status {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }
      .dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #9ca3af;
        flex: 0 0 auto;
      }
      .dot.indexing { background: #f59e0b; }
      .dot.indexed { background: #22c55e; }
      .dot.error { background: #ef4444; }
      .dot.stopping { background: #fb923c; }
      .dot.standby { background: #9ca3af; }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 20px;
      }
      .card {
        padding: 16px;
        border-radius: 10px;
        border: 1px solid var(--vscode-widget-border);
        background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      }
      .label {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
      }
      .value {
        font-size: 20px;
        font-weight: 600;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 999px;
        padding: 10px 18px;
        cursor: pointer;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .meta {
        margin-top: 20px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        white-space: pre-wrap;
      }
      @media (max-width: 640px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="panel">
      <div class="header">
        <h1>Codebase Indexing</h1>
        <p>CodeBunny maintains a local repo index for retrieval, review memory, and related-code lookup.</p>
      </div>
      <div class="body">
        <div class="status">
          <span id="status-dot" class="dot"></span>
          <div>
            <div id="status-label" class="value"></div>
            <p id="status-message"></p>
          </div>
        </div>
        <div class="grid">
          <div class="card">
            <div class="label">Indexed Files</div>
            <div id="indexed-files" class="value">0</div>
          </div>
          <div class="card">
            <div class="label">Pending Updates</div>
            <div id="pending-files" class="value">0</div>
          </div>
        </div>
        <div class="actions">
          <button id="enable-btn">Enable Indexing</button>
          <button id="disable-btn" class="secondary">Disable Indexing</button>
          <button id="rebuild-btn">Rebuild Index</button>
          <button id="stop-btn" class="secondary">Stop Indexing</button>
          <button id="clear-btn" class="secondary">Clear Index Data</button>
        </div>
        <div id="meta" class="meta"></div>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const initialState = ${serialized};
      const statusDot = document.getElementById('status-dot');
      const statusLabel = document.getElementById('status-label');
      const statusMessage = document.getElementById('status-message');
      const indexedFiles = document.getElementById('indexed-files');
      const pendingFiles = document.getElementById('pending-files');
      const meta = document.getElementById('meta');
      const enableBtn = document.getElementById('enable-btn');
      const disableBtn = document.getElementById('disable-btn');
      const rebuildBtn = document.getElementById('rebuild-btn');
      const stopBtn = document.getElementById('stop-btn');
      const clearBtn = document.getElementById('clear-btn');

      function render(state) {
        statusDot.className = 'dot ' + state.status;
        statusLabel.textContent = state.statusLabel;
        statusMessage.textContent = state.message;
        indexedFiles.textContent = String(state.indexedFiles);
        pendingFiles.textContent = String(state.pendingFiles);
        meta.textContent = [
          'Enabled: ' + (state.enabled ? 'Yes' : 'No'),
          'Workspace: ' + (state.workspaceRoot || 'None'),
          'Storage: ' + (state.storagePath || 'Unavailable'),
          'Last indexed: ' + (state.lastIndexedAtLabel || 'Never')
        ].join('\\n');

        enableBtn.disabled = state.enabled;
        disableBtn.disabled = !state.enabled;
        rebuildBtn.disabled = !state.enabled;
        clearBtn.disabled = false;
        stopBtn.disabled = !state.enabled || state.status === 'standby';
      }

      enableBtn.addEventListener('click', () => vscode.postMessage({ type: 'enable' }));
      disableBtn.addEventListener('click', () => vscode.postMessage({ type: 'disable' }));
      rebuildBtn.addEventListener('click', () => vscode.postMessage({ type: 'rebuild' }));
      stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
      clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

      window.addEventListener('message', (event) => {
        if (event.data?.type === 'indexState') {
          render(event.data.value);
        }
      });

      render(initialState);
    </script>
  </body>
</html>`;
  }
}

function serializeState(state: CodeIndexViewState) {
  return {
    ...state,
    statusLabel: toStatusLabel(state.status),
    lastIndexedAtLabel: state.lastIndexedAt ? new Date(state.lastIndexedAt).toLocaleString() : '',
  };
}

function toStatusLabel(status: CodeIndexViewState['status']): string {
  switch (status) {
    case 'indexed':
      return 'Indexed';
    case 'indexing':
      return 'Indexing';
    case 'stopping':
      return 'Stopping';
    case 'error':
      return 'Error';
    case 'standby':
    default:
      return 'Standby';
  }
}
