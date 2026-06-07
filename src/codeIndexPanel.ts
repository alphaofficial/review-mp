import * as vscode from 'vscode';
import { CodeIndexController, CodeIndexViewState } from './services/code-index/controller';
import { CodeIndexSetupSavePayload } from './services/code-index/config';

export class CodeIndexPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly controllerListener: vscode.Disposable;

  constructor(
    private readonly controller: CodeIndexController,
    private readonly extensionUri: vscode.Uri
  ) {
    this.controllerListener = this.controller.onDidChangeState(() => {
      this.postState();
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.view.webview.options = { enableScripts: true };
    this.view.webview.html = this.render(this.controller.getState(), this.view.webview);
    this.view.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message?.type) {
          case 'saveSetup':
            await this.controller.saveSetup(message.value as CodeIndexSetupSavePayload);
            await this.postMessage({ type: 'saveResult', ok: true });
            break;
          case 'startIndexing':
            await this.controller.start();
            break;
          case 'stopIndexing':
            await this.controller.stop();
            break;
          case 'rebuild':
            await this.controller.rebuild();
            break;
          case 'clearIndexData':
            await this.controller.clear();
            break;
          case 'setAutoEnableDefault':
            await this.controller.setAutoEnableDefault(Boolean(message.value));
            break;
          case 'toggleWorkspaceIndexing':
            await this.controller.setWorkspaceEnabled(Boolean(message.value));
            break;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        if (message?.type === 'saveSetup') {
          await this.postMessage({ type: 'saveResult', ok: false, error: messageText });
        } else {
          await this.postMessage({ type: 'actionError', error: messageText });
        }
      } finally {
        this.postState();
      }
    });
    this.view.onDidDispose(() => {
      this.view = undefined;
    });
    this.postState();
  }

  dispose(): void {
    this.controllerListener.dispose();
  }

  private async postState(): Promise<void> {
    await this.postMessage({
      type: 'indexState',
      value: serializeState(this.controller.getState()),
    });
  }

  private async postMessage(message: unknown): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage(message);
  }

  private render(state: CodeIndexViewState, webview: vscode.Webview): string {
    const serialized = JSON.stringify(serializeState(state));
    const icons = {
      chevronRight: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'chevron-right.svg')),
      info: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'info.svg')),
      play: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'play.svg')),
      stopCircle: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'circle-stop.svg')),
      refreshCcw: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'refresh-ccw.svg')),
      save: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'save.svg')),
      trash2: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icons', 'trash-2.svg')),
    };
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codebase Indexing</title>
    <style>
      :root {
        color-scheme: dark;
        --surface: #262c34;
        --surface-2: #2c333c;
        --border: #3a414b;
        --muted: #a8b0bb;
        --text: #e6ebf2;
        --field: #20252c;
        --green: #20c05c;
        --green-soft: rgba(32, 192, 92, 0.18);
        --danger: #ef5f5f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 18px 16px 24px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        font-weight: var(--vscode-font-weight);
        line-height: 1.5;
        background: var(--vscode-sideBar-background);
        color: var(--text);
      }
      .stack { display: flex; flex-direction: column; gap: 18px; }
      .top-toggle {
        display: flex;
        align-items: center;
        gap: 14px;
        font-weight: 600;
      }
      .top-toggle input {
        width: 15px;
        height: 15px;
        margin: 0;
        accent-color: var(--green);
      }
      .info-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted);
        position: relative;
        cursor: help;
        outline: none;
      }
      .info-badge::before,
      .info-badge::after {
        position: absolute;
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .info-badge::before {
        content: '';
        top: calc(100% + 3px);
        left: 50%;
        margin-left: -5px;
        border-width: 5px;
        border-style: solid;
        border-color: transparent transparent var(--vscode-editorHoverWidget-background) transparent;
        transform: translateY(-2px);
        z-index: 2;
      }
      .info-badge::after {
        content: attr(data-tooltip);
        top: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%) translateY(-4px);
        width: min(240px, calc(100vw - 48px));
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--vscode-editorHoverWidget-border);
        background: var(--vscode-editorHoverWidget-background);
        color: var(--vscode-editorHoverWidget-foreground);
        font-size: 12px;
        font-weight: 400;
        line-height: 1.4;
        text-align: left;
        white-space: normal;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
        z-index: 1;
      }
      .info-badge:hover::before,
      .info-badge:hover::after,
      .info-badge:focus-visible::before,
      .info-badge:focus-visible::after {
        opacity: 1;
      }
      .info-badge:hover::before,
      .info-badge:focus-visible::before {
        transform: translateY(0);
      }
      .info-badge:hover::after,
      .info-badge:focus-visible::after {
        transform: translateX(-50%) translateY(0);
      }
      .icon {
        display: inline-block;
        width: 16px;
        height: 16px;
        background-color: currentColor;
        -webkit-mask: var(--icon) center / contain no-repeat;
        mask: var(--icon) center / contain no-repeat;
        flex: 0 0 auto;
      }
      .icon.small {
        width: 11px;
        height: 11px;
      }
      .icon.button-icon {
        width: 13px;
        height: 13px;
      }
      h2 {
        margin: 0 0 10px;
        font-weight: 700;
        letter-spacing: 0.01em;
      }
      .status-block {
        display: flex;
        align-items: center;
        gap: 14px;
        color: var(--text);
        font-weight: 600;
      }
      .status-text {
        color: var(--muted);
        font-weight: var(--vscode-font-weight);
      }
      .status-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #69727e;
        box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.02);
        flex: 0 0 auto;
      }
      .status-dot.indexed { background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
      .status-dot.indexing { background: #f1b236; }
      .status-dot.stopping { background: #ff9458; }
      .status-dot.error { background: var(--danger); }
      details {
        border: 0;
      }
      summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
      }
      summary::-webkit-details-marker { display: none; }
      .chevron {
        width: 12px;
        height: 12px;
        color: var(--muted);
        display: inline-flex;
        transition: transform 120ms ease;
      }
      details[open] .chevron { transform: rotate(90deg); }
      .panel-body {
        padding-top: 18px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .field label {
        font-weight: 600;
      }
      .field input, .field select {
        width: 100%;
        min-width: 0;
        background: var(--field);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        min-height: 36px;
        padding: 7px 10px;
        font: inherit;
      }
      .field select {
        appearance: none;
        background-image:
          linear-gradient(45deg, transparent 50%, var(--muted) 50%),
          linear-gradient(135deg, var(--muted) 50%, transparent 50%);
        background-position:
          calc(100% - 18px) calc(50% - 2px),
          calc(100% - 12px) calc(50% - 2px);
        background-size: 6px 6px, 6px 6px;
        background-repeat: no-repeat;
        padding-right: 30px;
      }
      .hint {
        margin: 0;
        color: var(--muted);
        font-size: 0.92em;
        line-height: 1.45;
      }
      .advanced-row {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .advanced-label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
      }
      .slider-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 12px;
        align-items: center;
      }
      input[type="range"] {
        width: 100%;
        accent-color: var(--green);
      }
      .slider-value {
        width: 48px;
        text-align: right;
        color: var(--text);
      }
      .ghost-button, .primary-button, .danger-button {
        border: 1px solid var(--border);
        border-radius: 8px;
        min-height: 30px;
        padding: 5px 10px;
        cursor: pointer;
        font: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .ghost-button {
        background: transparent;
        color: var(--text);
      }
      .primary-button {
        background: var(--green);
        border-color: var(--green);
        color: #06110a;
        font-weight: 700;
      }
      .danger-button {
        background: transparent;
        color: #ffb7b7;
        border-color: rgba(239, 95, 95, 0.35);
      }
      .ghost-button.small {
        padding: 4px 8px;
        min-height: 28px;
        font-size: 0.92em;
      }
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .toggle-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        padding-top: 12px;
      }
      .actions > button {
        width: 100%;
      }
      .message {
        min-height: 18px;
        margin: 0;
        font-size: 0.92em;
      }
      .message.error { color: #ff9f9f; }
      .message.success { color: #8de2a4; }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--text);
      }
      .checkbox-row input {
        width: 16px;
        height: 16px;
        margin: 0;
        accent-color: var(--green);
      }
      @media (max-width: 420px) {
        .actions {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="stack">
      <div class="top-toggle">
        <input id="enabled" type="checkbox" />
        <span>Enable Codebase Indexing</span>
        <span
          class="info-badge"
          tabindex="0"
          role="note"
          aria-label="Information about enabling codebase indexing"
          title="Stages the codebase indexing feature toggle. Save to apply the change."
          data-tooltip="Stages the codebase indexing feature toggle. Save to apply the change."
        ><span class="icon small" style="--icon:url('${icons.info}')"></span></span>
      </div>

      <section>
        <p>Status</p>
        <div class="status-block">
          <span id="status-dot" class="status-dot"></span>
          <span id="status-message" class="status-text"></span>
        </div>
      </section>

      <details id="setup-disclosure">
        <summary><span class="chevron"><span class="icon small" style="--icon:url('${icons.chevronRight}')"></span></span><span>Setup</span></summary>
        <div class="panel-body">
          <div class="field">
            <label for="embedder-provider">Embedder Provider</label>
            <select id="embedder-provider">
              <option value="ollama">Ollama</option>
            </select>
          </div>
          <div class="field">
            <label for="ollama-base-url">Ollama Base URL</label>
            <input id="ollama-base-url" type="text" placeholder="http://localhost:11434" />
          </div>
          <div class="field">
            <label for="ollama-model">Model</label>
            <input id="ollama-model" type="text" placeholder="nomic-embed-text" />
          </div>
          <div class="field">
            <label for="model-dimension">Model Dimension</label>
            <input id="model-dimension" type="number" min="1" step="1" placeholder="768" />
          </div>
          <div class="field">
            <label for="qdrant-url">Qdrant URL</label>
            <input id="qdrant-url" type="text" placeholder="http://localhost:6333" />
          </div>
          <div class="field">
            <label for="qdrant-api-key">Qdrant API Key</label>
            <input id="qdrant-api-key" type="password" placeholder="Enter your Qdrant API key (optional)" />
          </div>
        </div>
      </details>

      <details id="advanced-disclosure">
        <summary><span class="chevron"><span class="icon small" style="--icon:url('${icons.chevronRight}')"></span></span><span>Advanced Configuration</span></summary>
        <div class="panel-body">
          <div class="advanced-row">
            <div class="advanced-label">
              <span>Search Score Threshold</span>
              <span
                class="info-badge"
                tabindex="0"
                role="note"
                aria-label="Information about search score threshold"
                title="Sets the minimum similarity score required for a semantic match."
                data-tooltip="Sets the minimum similarity score required for a semantic match."
              ><span class="icon small" style="--icon:url('${icons.info}')"></span></span>
            </div>
            <div class="slider-row">
              <input id="search-min-score" type="range" min="0" max="1" step="0.01" />
              <span id="search-min-score-value" class="slider-value">0.40</span>
              <button id="reset-min-score" class="ghost-button small" type="button"><span class="icon button-icon" style="--icon:url('${icons.refreshCcw}')"></span></button>
            </div>
          </div>
          <div class="advanced-row">
            <div class="advanced-label">
              <span>Maximum Search Results</span>
              <span
                class="info-badge"
                tabindex="0"
                role="note"
                aria-label="Information about maximum search results"
                title="Sets the maximum number of semantic matches returned per search."
                data-tooltip="Sets the maximum number of semantic matches returned per search."
              ><span class="icon small" style="--icon:url('${icons.info}')"></span></span>
            </div>
            <div class="slider-row">
              <input id="search-max-results" type="range" min="1" max="200" step="1" />
              <span id="search-max-results-value" class="slider-value">50</span>
              <button id="reset-max-results" class="ghost-button small" type="button"><span class="icon button-icon" style="--icon:url('${icons.refreshCcw}')"></span></button>
            </div>
          </div>
          <label id="auto-enable-default-row" class="checkbox-row" for="auto-enable-default">
            <input id="auto-enable-default" type="checkbox" />
            <span>Auto-enable indexing for new workspaces</span>
          </label>
          <label id="workspace-enabled-row" class="checkbox-row" for="workspace-enabled">
            <input id="workspace-enabled" type="checkbox" />
            <span>Enable indexing for this workspace</span>
          </label>
          <p id="workspace-disabled-hint" class="hint">Indexing is not enabled for this workspace.</p>
          <p class="hint">Semantic vectors are stored in Qdrant. File summaries, declarations, and review caches stay in the local workspace cache.</p>
        </div>
      </details>

      <p id="message" class="message"></p>

      <div class="actions">
        <button id="start-button" class="primary-button" type="button"><span class="icon button-icon" style="--icon:url('${icons.play}')"></span><span>Start Indexing</span></button>
        <button id="stop-button" class="danger-button" type="button"><span class="icon button-icon" style="--icon:url('${icons.stopCircle}')"></span><span>Stop Indexing</span></button>
        <button id="stopping-button" class="danger-button" type="button" disabled><span class="icon button-icon" style="--icon:url('${icons.stopCircle}')"></span><span>Stopping</span></button>
        <button id="clear-button" class="ghost-button" type="button"><span class="icon button-icon" style="--icon:url('${icons.trash2}')"></span><span>Clear Index Data</span></button>
        <button id="save-button" class="primary-button" type="button"><span class="icon button-icon" style="--icon:url('${icons.save}')"></span><span>Save</span></button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const SECRET_PLACEHOLDER = '••••••••••••••••';
      const DEFAULTS = { searchMinScore: 0.4, searchMaxResults: 50 };
      const initialState = ${serialized};

      const elements = {
        enabled: document.getElementById('enabled'),
        statusDot: document.getElementById('status-dot'),
        statusMessage: document.getElementById('status-message'),
        embedderProvider: document.getElementById('embedder-provider'),
        ollamaBaseUrl: document.getElementById('ollama-base-url'),
        ollamaModel: document.getElementById('ollama-model'),
        modelDimension: document.getElementById('model-dimension'),
        qdrantUrl: document.getElementById('qdrant-url'),
        qdrantApiKey: document.getElementById('qdrant-api-key'),
        searchMinScore: document.getElementById('search-min-score'),
        searchMinScoreValue: document.getElementById('search-min-score-value'),
        searchMaxResults: document.getElementById('search-max-results'),
        searchMaxResultsValue: document.getElementById('search-max-results-value'),
        resetMinScore: document.getElementById('reset-min-score'),
        resetMaxResults: document.getElementById('reset-max-results'),
        autoEnableDefaultRow: document.getElementById('auto-enable-default-row'),
        autoEnableDefault: document.getElementById('auto-enable-default'),
        workspaceEnabledRow: document.getElementById('workspace-enabled-row'),
        workspaceEnabled: document.getElementById('workspace-enabled'),
        workspaceDisabledHint: document.getElementById('workspace-disabled-hint'),
        message: document.getElementById('message'),
        startButton: document.getElementById('start-button'),
        stopButton: document.getElementById('stop-button'),
        stoppingButton: document.getElementById('stopping-button'),
        clearButton: document.getElementById('clear-button'),
        saveButton: document.getElementById('save-button'),
      };

      let serverState = initialState;
      let formState = buildFormState(initialState);
      let saveStatus = 'idle';
      let transientError = '';

      function buildFormState(state) {
        return {
          featureEnabled: state.featureEnabled,
          embedderProvider: state.setup.embedderProvider,
          ollamaBaseUrl: state.setup.ollamaBaseUrl,
          ollamaModel: state.setup.ollamaModel,
          modelDimension: String(state.setup.modelDimension),
          qdrantUrl: state.setup.qdrantUrl,
          qdrantApiKey: state.setup.qdrantApiKeyConfigured ? SECRET_PLACEHOLDER : '',
          preserveQdrantApiKey: state.setup.qdrantApiKeyConfigured,
          searchMinScore: Number(state.setup.searchMinScore.toFixed(2)),
          searchMaxResults: state.setup.searchMaxResults,
        };
      }

      function hasUnsavedChanges() {
        if (formState.featureEnabled !== serverState.featureEnabled) return true;
        if (formState.embedderProvider !== serverState.setup.embedderProvider) return true;
        if (formState.ollamaBaseUrl.trim() !== serverState.setup.ollamaBaseUrl) return true;
        if (formState.ollamaModel.trim() !== serverState.setup.ollamaModel) return true;
        if (Number(formState.modelDimension) !== serverState.setup.modelDimension) return true;
        if (formState.qdrantUrl.trim() !== serverState.setup.qdrantUrl) return true;
        if (Number(formState.searchMinScore) !== Number(serverState.setup.searchMinScore.toFixed(2))) return true;
        if (Number(formState.searchMaxResults) !== serverState.setup.searchMaxResults) return true;
        if (formState.preserveQdrantApiKey && serverState.setup.qdrantApiKeyConfigured && formState.qdrantApiKey === SECRET_PLACEHOLDER) {
          return false;
        }
        return formState.qdrantApiKey.trim().length > 0 || (serverState.setup.qdrantApiKeyConfigured && !formState.preserveQdrantApiKey);
      }

      function render() {
        elements.enabled.checked = formState.featureEnabled;
        elements.statusDot.className = 'status-dot ' + serverState.status;
        elements.statusMessage.textContent = serverState.message;
        elements.embedderProvider.value = formState.embedderProvider;
        elements.ollamaBaseUrl.value = formState.ollamaBaseUrl;
        elements.ollamaModel.value = formState.ollamaModel;
        elements.modelDimension.value = formState.modelDimension;
        elements.qdrantUrl.value = formState.qdrantUrl;
        elements.qdrantApiKey.value = formState.qdrantApiKey;
        elements.searchMinScore.value = String(formState.searchMinScore);
        elements.searchMinScoreValue.textContent = Number(formState.searchMinScore).toFixed(2);
        elements.searchMaxResults.value = String(formState.searchMaxResults);
        elements.searchMaxResultsValue.textContent = String(formState.searchMaxResults);
        elements.autoEnableDefault.checked = serverState.autoEnableDefault;
        elements.workspaceEnabled.checked = serverState.workspaceEnabled;
        const dirty = hasUnsavedChanges();
        const hasWorkspace = Boolean(serverState.workspaceRoot);
        const runtimeFeatureEnabled = serverState.featureEnabled;
        const runtimeConfigured = serverState.configured;
        const stagedFeatureEnabled = formState.featureEnabled;
        const canStart = hasWorkspace && runtimeFeatureEnabled && runtimeConfigured && !dirty && saveStatus !== 'saving';
        const showStart = runtimeFeatureEnabled && runtimeConfigured && (serverState.status === 'standby' || serverState.status === 'error');
        const showStop = runtimeFeatureEnabled && serverState.status === 'indexing';
        const showStopping = runtimeFeatureEnabled && serverState.status === 'stopping';
        const showClear = runtimeFeatureEnabled && hasWorkspace && (serverState.status === 'indexed' || serverState.status === 'error');
        elements.autoEnableDefaultRow.style.display = stagedFeatureEnabled ? 'flex' : 'none';
        elements.workspaceEnabledRow.style.display = stagedFeatureEnabled ? 'flex' : 'none';
        elements.workspaceDisabledHint.style.display = (stagedFeatureEnabled && !serverState.workspaceEnabled) ? 'block' : 'none';
        elements.saveButton.disabled = !dirty || saveStatus === 'saving';
        elements.startButton.style.display = showStart ? 'inline-flex' : 'none';
        elements.stopButton.style.display = showStop ? 'inline-flex' : 'none';
        elements.stoppingButton.style.display = showStopping ? 'inline-flex' : 'none';
        elements.clearButton.style.display = showClear ? 'inline-flex' : 'none';
        elements.startButton.disabled = !canStart;
        elements.stopButton.disabled = false;
        elements.clearButton.disabled = false;

        if (transientError) {
          elements.message.textContent = transientError;
          elements.message.className = 'message error';
        } else if (saveStatus === 'saved') {
          elements.message.textContent = 'Settings saved';
          elements.message.className = 'message success';
        } else if (dirty) {
          elements.message.textContent = 'Unsaved changes';
          elements.message.className = 'message';
        } else {
          elements.message.textContent = '';
          elements.message.className = 'message';
        }
      }

      function updateForm(key, value) {
        formState = { ...formState, [key]: value };
        transientError = '';
        if (saveStatus === 'saved') {
          saveStatus = 'idle';
        }
        render();
      }

      function handleSave() {
        saveStatus = 'saving';
        transientError = '';
        render();
        vscode.postMessage({
          type: 'saveSetup',
          value: {
            featureEnabled: formState.featureEnabled,
            embedderProvider: formState.embedderProvider,
            ollamaBaseUrl: formState.ollamaBaseUrl.trim(),
            ollamaModel: formState.ollamaModel.trim(),
            modelDimension: Number(formState.modelDimension),
            qdrantUrl: formState.qdrantUrl.trim(),
            qdrantApiKey: formState.preserveQdrantApiKey ? '' : formState.qdrantApiKey.trim(),
            preserveQdrantApiKey: formState.preserveQdrantApiKey,
            searchMinScore: Number(formState.searchMinScore),
            searchMaxResults: Number(formState.searchMaxResults),
          },
        });
      }

      elements.enabled.addEventListener('change', (event) => updateForm('featureEnabled', event.target.checked));
      elements.embedderProvider.addEventListener('change', (event) => updateForm('embedderProvider', event.target.value));
      elements.ollamaBaseUrl.addEventListener('input', (event) => updateForm('ollamaBaseUrl', event.target.value));
      elements.ollamaModel.addEventListener('input', (event) => updateForm('ollamaModel', event.target.value));
      elements.modelDimension.addEventListener('input', (event) => updateForm('modelDimension', event.target.value));
      elements.qdrantUrl.addEventListener('input', (event) => updateForm('qdrantUrl', event.target.value));
      elements.qdrantApiKey.addEventListener('focus', () => {
        if (formState.qdrantApiKey === SECRET_PLACEHOLDER) {
          updateForm('qdrantApiKey', '');
          updateForm('preserveQdrantApiKey', false);
        }
      });
      elements.qdrantApiKey.addEventListener('input', (event) => {
        formState = { ...formState, preserveQdrantApiKey: false };
        updateForm('qdrantApiKey', event.target.value);
      });
      elements.searchMinScore.addEventListener('input', (event) => updateForm('searchMinScore', Number(event.target.value)));
      elements.searchMaxResults.addEventListener('input', (event) => updateForm('searchMaxResults', Number(event.target.value)));
      elements.resetMinScore.addEventListener('click', () => updateForm('searchMinScore', DEFAULTS.searchMinScore));
      elements.resetMaxResults.addEventListener('click', () => updateForm('searchMaxResults', DEFAULTS.searchMaxResults));
      elements.autoEnableDefault.addEventListener('change', (event) => {
        vscode.postMessage({ type: 'setAutoEnableDefault', value: event.target.checked });
      });
      elements.workspaceEnabled.addEventListener('change', (event) => {
        vscode.postMessage({ type: 'toggleWorkspaceIndexing', value: event.target.checked });
      });
      elements.saveButton.addEventListener('click', handleSave);
      elements.startButton.addEventListener('click', () => vscode.postMessage({ type: 'startIndexing' }));
      elements.stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stopIndexing' }));
      elements.clearButton.addEventListener('click', () => vscode.postMessage({ type: 'clearIndexData' }));

      window.addEventListener('message', (event) => {
        if (event.data?.type === 'indexState') {
          serverState = event.data.value;
          if (saveStatus === 'saving' || !hasUnsavedChanges()) {
            formState = buildFormState(serverState);
          }
          if (saveStatus === 'saving') {
            saveStatus = 'saved';
          }
          render();
        }
        if (event.data?.type === 'saveResult' && !event.data.ok) {
          saveStatus = 'idle';
          transientError = event.data.error || 'Unable to save settings';
          render();
        }
        if (event.data?.type === 'actionError') {
          transientError = event.data.error || 'Action failed';
          render();
        }
      });

      render();
    </script>
  </body>
</html>`;
  }
}

function serializeState(state: CodeIndexViewState) {
  return {
    ...state,
    lastIndexedAtLabel: state.lastIndexedAt ? new Date(state.lastIndexedAt).toLocaleString() : '',
  };
}
