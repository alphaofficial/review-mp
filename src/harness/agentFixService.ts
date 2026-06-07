import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ModelProvider } from '../providers/modelProvider';
import { ReviewFinding } from '../types/review';
import { logDebug } from '../settings';

export interface AgentFixResult {
  success: boolean;
  error?: string;
  warning?: string;
  rawOutput?: string;
}

type TargetFinding = Pick<ReviewFinding, 'id' | 'line' | 'title' | 'message' | 'fix' | 'severity'>;

export class AgentFixService {
  constructor(private readonly getProvider: () => ModelProvider) {}

  async applyFindingFix(
    filePath: string,
    finding: TargetFinding,
    token?: vscode.CancellationToken
  ): Promise<AgentFixResult> {
    if (!filePath || filePath.trim().length === 0) {
      return { success: false, error: 'File path is required' };
    }

    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      await document.save();
    }

    const beforeContent = fs.readFileSync(filePath, 'utf8');
    const prompt = this.buildPrompt(filePath, document, finding);
    const provider = this.getProvider();

    if (!(await provider.isAvailable())) {
      return { success: false, error: `${provider.name} is not available` };
    }

    if (!provider.runAgentTask) {
      return { success: false, error: `${provider.name} does not support agent-applied fixes` };
    }

    logDebug('Agent fix application started', {
      findingId: finding.id,
      filePath,
      runtime: provider.name,
      line: finding.line,
      hasSuggestedFix: Boolean(finding.fix),
    });

    let rawOutput = '';
    try {
      rawOutput = await provider.runAgentTask(prompt, token);
    } catch (error) {
      logDebug('Agent fix application failed during runtime task', {
        findingId: finding.id,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const afterContent = fs.readFileSync(filePath, 'utf8');
    if (afterContent === beforeContent) {
      logDebug('Agent fix application finished without file changes', {
        findingId: finding.id,
        filePath,
        runtime: provider.name,
        rawOutput,
      });
      return {
        success: false,
        error: 'Agent finished without changing the target file',
        rawOutput,
      };
    }

    const verificationSummary = this.summarizeOutput(rawOutput);
    logDebug('Agent fix application succeeded', {
      findingId: finding.id,
      filePath,
      runtime: provider.name,
      rawOutput: verificationSummary,
    });

    return {
      success: true,
      warning: verificationSummary,
      rawOutput,
    };
  }

  private buildPrompt(filePath: string, document: vscode.TextDocument, finding: TargetFinding): string {
    const excerpt = this.buildExcerpt(document, finding.line);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workspaceSection = workspaceRoot ? `Workspace root: ${workspaceRoot}\n` : '';
    const titleSection = finding.title?.trim() ? `Title: ${finding.title.trim()}\n` : '';
    const fixHint = finding.fix?.trim()
      ? `Suggested fix hint (may be malformed; use only as a hint, not source of truth):\n${finding.fix.trim()}\n\n`
      : '';

    return [
      'AGENT APPLY-FIX MODE',
      'Apply exactly one review finding by editing the workspace directly.',
      '',
      'Hard constraints:',
      `- Edit ONLY this file: ${filePath}`,
      '- Keep the change scoped to the single finding described below.',
      '- Do NOT edit any other file.',
      '- Do NOT commit, stage, branch, or open a pull request.',
      '- Read the target file as needed, but keep the final edit minimal.',
      '- After editing, run the smallest relevant verification you can for this change.',
      '- If you cannot apply the fix safely, make no changes and explain why.',
      '- End with a brief summary of: changed/not changed, verification run, verification result.',
      '',
      workspaceSection.trimEnd(),
      `Target file: ${filePath}`,
      `Target line: ${finding.line + 1}`,
      `Severity: ${finding.severity}`,
      titleSection.trimEnd(),
      `Message: ${finding.message.trim()}`,
      '',
      fixHint.trimEnd(),
      'Nearby file context:',
      excerpt,
    ]
      .filter((part) => part.length > 0)
      .join('\n');
  }

  private buildExcerpt(document: vscode.TextDocument, line: number, radius = 20): string {
    const start = Math.max(0, line - radius);
    const end = Math.min(document.lineCount - 1, line + radius);
    const width = String(end + 1).length;
    const lines: string[] = [];

    for (let current = start; current <= end; current += 1) {
      const label = String(current + 1).padStart(width, '0');
      lines.push(`L${label} | ${document.lineAt(current).text}`);
    }

    return lines.join('\n');
  }

  private summarizeOutput(rawOutput: string): string | undefined {
    const trimmed = rawOutput.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const firstNonEmptyLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? trimmed;
    return firstNonEmptyLine.length <= 200 ? firstNonEmptyLine : `${firstNonEmptyLine.slice(0, 197)}...`;
  }
}

export function createAgentFixService(getProvider: () => ModelProvider): AgentFixService {
  return new AgentFixService(getProvider);
}
