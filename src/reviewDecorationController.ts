import * as vscode from 'vscode';
import { ReviewSessionStore } from './store/reviewSessionStore';
import { ReviewFinding, Severity } from './types/review';

export class ReviewDecorationController implements vscode.Disposable {
  private store: ReviewSessionStore;
  private context: vscode.ExtensionContext;
  private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
  private activeDecorations: Map<string, Map<string, vscode.Range[]>> = new Map();
  private selectedFindingId: string | null = null;
  private selectionHighlightDecoration: vscode.TextEditorDecorationType | null = null;
  private gutterDecorations: Map<string, vscode.TextEditorDecorationType> = new Map();
  private disposables: vscode.Disposable[] = [];
  private decorationTimeout: NodeJS.Timeout | null = null;

  constructor(context: vscode.ExtensionContext, store: ReviewSessionStore) {
    this.context = context;
    this.store = store;

    this.createDecorationTypes();
    this.subscribeToStoreEvents();
    this.subscribeToEditorEvents();

    this.disposables.push(
      vscode.commands.registerCommand('reviewmp.selectFinding', (findingId: string) => {
        this.selectFinding(findingId);
      }),
      vscode.commands.registerCommand('reviewmp.clearSelection', () => {
        this.clearSelection();
      })
    );
  }

  private createDecorationTypes(): void {
    this.selectionHighlightDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.decorationTypes.set('selection', this.selectionHighlightDecoration);

    const severityColors: Record<Severity, string> = {
      error: '#f14c4c',
      warning: '#cca700',
      info: '#3794ff',
      suggestion: '#a8b8a8',
    };

    for (const severity of ['error', 'warning', 'info', 'suggestion'] as Severity[]) {
      const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        overviewRulerColor: severityColors[severity],
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        borderColor: severityColors[severity],
      });
      this.decorationTypes.set(`gutter-${severity}`, decoration);
      this.gutterDecorations.set(severity, decoration);
    }
  }

  private subscribeToStoreEvents(): void {
    this.store.on('finding-added', this.onFindingAdded.bind(this));
    this.store.on('finding-updated', this.onFindingUpdated.bind(this));
    this.store.on('session-cleared', this.onSessionCleared.bind(this));
  }

  private subscribeToEditorEvents(): void {
    vscode.window.onDidChangeVisibleTextEditors(this.onVisibleEditorsChanged.bind(this), null, this.context.subscriptions);
    vscode.workspace.onDidCloseTextDocument(this.onDocumentClosed.bind(this), null, this.context.subscriptions);
  }

  private onFindingAdded(data: { sessionId: string; finding: ReviewFinding }): void {
    this.scheduleDecorationUpdate(() => {
      this.applyGutterDecorationsForFinding(data.finding);
    });
  }

  private onFindingUpdated(data: { sessionId: string; findingId: string; action: 'apply' | 'dismiss' }): void {
    this.scheduleDecorationUpdate(() => {
      if (data.action === 'apply' || data.action === 'dismiss') {
        this.removeDecorationsForFinding(data.findingId);
      }
    });
  }

  private onSessionCleared(): void {
    this.clearAllDecorations();
    this.selectedFindingId = null;
  }

  private scheduleDecorationUpdate(updateFn: () => void): void {
    if (this.decorationTimeout) {
      clearTimeout(this.decorationTimeout);
    }
    this.decorationTimeout = setTimeout(() => {
      updateFn();
      this.decorationTimeout = null;
    }, 50);
  }

  private onVisibleEditorsChanged(): void {
    this.applyAllDecorations();
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    const uriString = document.uri.toString();
    this.activeDecorations.delete(uriString);
  }

  selectFinding(findingId: string): void {
    this.selectedFindingId = findingId;

    const finding = this.store.getFinding(findingId);
    if (!finding) {
      return;
    }

    this.applySelectionHighlight(finding);

    vscode.commands.executeCommand('reviewmp.openFinding', findingId);
  }

  private applySelectionHighlight(finding: ReviewFinding): void {
    if (!this.selectionHighlightDecoration) {
      return;
    }

    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.uri.fsPath === finding.file) {
        const line = Math.max(0, finding.line - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.setDecorations(this.selectionHighlightDecoration!, [range]);

        if (!this.activeDecorations.has(editor.document.uri.toString())) {
          this.activeDecorations.set(editor.document.uri.toString(), new Map());
        }
        this.activeDecorations.get(editor.document.uri.toString())!.set(`selection-${finding.id}`, [range]);

        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        setTimeout(() => {
          this.clearSelectionHighlight(finding.id);
        }, 3000);
      }
    }
  }

  private clearSelectionHighlight(findingId?: string): void {
    const idToClear = findingId || this.selectedFindingId;
    if (!idToClear || !this.selectionHighlightDecoration) {
      return;
    }

    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      const editorDecorations = this.activeDecorations.get(editor.document.uri.toString());
      if (editorDecorations && editorDecorations.has(`selection-${idToClear}`)) {
        editor.setDecorations(this.selectionHighlightDecoration!, []);
        editorDecorations.delete(`selection-${idToClear}`);
      }
    }

    if (!findingId) {
      this.selectedFindingId = null;
    }
  }

  clearSelection(): void {
    this.clearSelectionHighlight();
    this.selectedFindingId = null;
  }

  private applyGutterDecorationsForFinding(finding: ReviewFinding): void {
    const decorationType = this.gutterDecorations.get(finding.severity);
    if (!decorationType) {
      return;
    }

    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.uri.fsPath === finding.file) {
        const line = Math.max(0, finding.line - 1);
        const range = new vscode.Range(line, 0, line, 0);
        editor.setDecorations(decorationType, [range]);

        if (!this.activeDecorations.has(editor.document.uri.toString())) {
          this.activeDecorations.set(editor.document.uri.toString(), new Map());
        }
        const editorDecorations = this.activeDecorations.get(editor.document.uri.toString())!;
        const existing = editorDecorations.get(`gutter-${finding.severity}-${finding.file}`) || [];
        existing.push(range);
        editorDecorations.set(`gutter-${finding.severity}-${finding.file}`, existing);
      }
    }
  }

  private removeDecorationsForFinding(findingId: string): void {
    const finding = this.store.getFinding(findingId);
    if (!finding) {
      return;
    }

    const decorationType = this.gutterDecorations.get(finding.severity);
    if (!decorationType) {
      return;
    }

    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      if (editor.document.uri.fsPath === finding.file) {
        editor.setDecorations(decorationType, []);
      }
    }

    if (this.selectedFindingId === findingId) {
      this.selectedFindingId = null;
    }
  }

  private applyAllDecorations(): void {
    const session = this.store.getActiveSession();
    if (!session) {
      return;
    }

    for (const file of session.files.values()) {
      for (const finding of file.findings) {
        if (finding.status === 'pending') {
          this.applyGutterDecorationsForFinding(finding);
        }
      }
    }

    if (this.selectedFindingId) {
      const finding = this.store.getFinding(this.selectedFindingId);
      if (finding && finding.status === 'pending') {
        this.applySelectionHighlight(finding);
      }
    }
  }

  private clearAllDecorations(): void {
    if (this.selectionHighlightDecoration) {
      const editors = vscode.window.visibleTextEditors;
      for (const editor of editors) {
        editor.setDecorations(this.selectionHighlightDecoration, []);
      }
    }

    for (const decorationType of this.gutterDecorations.values()) {
      const editors = vscode.window.visibleTextEditors;
      for (const editor of editors) {
        editor.setDecorations(decorationType, []);
      }
    }

    this.activeDecorations.clear();
    this.selectedFindingId = null;
  }

  dispose(): void {
    if (this.decorationTimeout) {
      clearTimeout(this.decorationTimeout);
    }

    this.clearAllDecorations();

    for (const decoration of this.decorationTypes.values()) {
      decoration.dispose();
    }
    this.decorationTypes.clear();
    this.gutterDecorations.clear();

    this.store.off('finding-added', this.onFindingAdded.bind(this));
    this.store.off('finding-updated', this.onFindingUpdated.bind(this));
    this.store.off('session-cleared', this.onSessionCleared.bind(this));

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
