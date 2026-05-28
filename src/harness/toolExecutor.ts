import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ToolRequest, ToolResult } from '../types/review';
import { logToolError, logToolWarning, DiagnosticContext } from './diagnostics';

export type ToolName = 'read_file' | 'search_workspace' | 'list_related_files' | 'git_diff' | 'git_log' | 'package_metadata';

export interface ToolExecutorConfig {
  workspaceRoot: string;
  maxFileReadSize?: number;
  maxGitLogEntries?: number;
}

const DEFAULT_MAX_FILE_READ_SIZE = 100 * 1024;
const DEFAULT_MAX_GIT_LOG_ENTRIES = 50;

export class ToolExecutor {
  private workspaceRoot: string;
  private maxFileReadSize: number;
  private maxGitLogEntries: number;

  constructor(config: ToolExecutorConfig) {
    this.workspaceRoot = config.workspaceRoot;
    this.maxFileReadSize = config.maxFileReadSize ?? DEFAULT_MAX_FILE_READ_SIZE;
    this.maxGitLogEntries = config.maxGitLogEntries ?? DEFAULT_MAX_GIT_LOG_ENTRIES;
  }

  readonly allowedTools: ToolName[] = [
    'read_file',
    'search_workspace',
    'list_related_files',
    'git_diff',
    'git_log',
    'package_metadata',
  ];

  isAllowedTool(toolName: string): toolName is ToolName {
    return this.allowedTools.includes(toolName as ToolName);
  }

  async execute(request: ToolRequest, token?: vscode.CancellationToken): Promise<ToolResult> {
    const context = {};

    if (!this.isAllowedTool(request.tool)) {
      const error = `Unknown tool: ${request.tool}. Allowed tools: ${this.allowedTools.join(', ')}`;
      logToolError(request.tool, 'Unknown tool requested', error, context);
      return {
        tool: request.tool,
        result: null,
        error,
      };
    }

    try {
      if (token?.isCancellationRequested) {
        logToolWarning(request.tool, 'Tool execution cancelled', context);
        return {
          tool: request.tool,
          result: null,
          error: 'Execution cancelled',
        };
      }

      switch (request.tool) {
        case 'read_file':
          return this.readFile(request.args, context);
        case 'search_workspace':
          return this.searchWorkspace(request.args, context);
        case 'list_related_files':
          return this.listRelatedFiles(request.args, context);
        case 'git_diff':
          return this.gitDiff(request.args, token, context);
        case 'git_log':
          return this.gitLog(request.args, token, context);
        case 'package_metadata':
          return this.packageMetadata(context);
        default:
          return {
            tool: request.tool,
            result: null,
            error: `Tool not implemented: ${request.tool}`,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError(request.tool, 'Tool execution threw exception', errorMessage, context);
      return {
        tool: request.tool,
        result: null,
        error: errorMessage,
      };
    }
  }

  async executeAll(requests: ToolRequest[], token?: vscode.CancellationToken): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const request of requests) {
      const result = await this.execute(request, token);
      results.push(result);
      if (result.error && !result.error.includes('cancelled')) {
        break;
      }
    }
    return results;
  }

  private readFile(args: Record<string, unknown>, context: DiagnosticContext): ToolResult {
    const filePath = args.path as string;
    if (!filePath) {
      const error = 'Missing required parameter: path';
      logToolError('read_file', error, error, context);
      return { tool: 'read_file', result: null, error };
    }

    const fullPath = this.resolvePath(filePath);

    if (!this.isWithinWorkspace(fullPath)) {
      const error = 'Path outside workspace';
      logToolError('read_file', error, error, context);
      return { tool: 'read_file', result: null, error };
    }

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size > this.maxFileReadSize) {
        const error = `File too large: ${stats.size} bytes (max: ${this.maxFileReadSize})`;
        logToolError('read_file', 'File size exceeded limit', error, context);
        return {
          tool: 'read_file',
          result: null,
          error,
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      return {
        tool: 'read_file',
        result: {
          path: fullPath,
          content,
          size: stats.size,
          truncated: stats.size > this.maxFileReadSize,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('read_file', 'Failed to read file', errorMessage, context);
      return {
        tool: 'read_file',
        result: null,
        error: errorMessage,
      };
    }
  }

  private async searchWorkspace(args: Record<string, unknown>, context: DiagnosticContext): Promise<ToolResult> {
    const pattern = args.pattern as string;
    if (!pattern) {
      const error = 'Missing required parameter: pattern';
      logToolError('search_workspace', error, error, context);
      return { tool: 'search_workspace', result: null, error };
    }

    try {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.workspaceRoot, pattern),
        undefined,
        100
      );

      const filePaths = files.map(f => vscode.workspace.asRelativePath(f));

      return {
        tool: 'search_workspace',
        result: {
          pattern,
          files: filePaths,
          count: filePaths.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('search_workspace', 'Search workspace failed', errorMessage, context);
      return {
        tool: 'search_workspace',
        result: null,
        error: errorMessage,
      };
    }
  }

  private listRelatedFiles(args: Record<string, unknown>, context: DiagnosticContext): ToolResult {
    const filePath = args.filePath as string;
    if (!filePath) {
      const error = 'Missing required parameter: filePath';
      logToolError('list_related_files', error, error, context);
      return { tool: 'list_related_files', result: null, error };
    }

    const fullPath = this.resolvePath(filePath);

    if (!this.isWithinWorkspace(fullPath)) {
      const error = 'Path outside workspace';
      logToolError('list_related_files', error, error, context);
      return { tool: 'list_related_files', result: null, error };
    }

    try {
      const relatedFiles: string[] = [];

      const ext = path.extname(fullPath);
      const basename = path.basename(fullPath, ext);

      const dir = path.dirname(fullPath);
      const allFiles = fs.readdirSync(dir);

      for (const file of allFiles) {
        const fileBasename = path.basename(file, path.extname(file));
        if (file !== path.basename(fullPath)) {
          if (
            fileBasename.includes(basename) ||
            path.extname(file) === ext ||
            this.isRelatedExtension(path.extname(file))
          ) {
            relatedFiles.push(path.join(dir, file));
          }
        }
      }

      return {
        tool: 'list_related_files',
        result: {
          filePath: fullPath,
          relatedFiles,
          count: relatedFiles.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('list_related_files', 'Failed to list related files', errorMessage, context);
      return {
        tool: 'list_related_files',
        result: null,
        error: errorMessage,
      };
    }
  }

  private isRelatedExtension(ext: string): boolean {
    const relatedExtensions: Record<string, string[]> = {
      '.ts': ['.js', '.d.ts', '.tsx', '.jsx', '.json', '.md'],
      '.tsx': ['.ts', '.jsx', '.js'],
      '.js': ['.ts', '.tsx', '.jsx', '.json'],
      '.jsx': ['.ts', '.tsx', '.js'],
      '.py': ['.py', '.md', '.txt'],
      '.java': ['.java', '.xml', '.md'],
      '.go': ['.go', '.md', '.txt'],
      '.rs': ['.rs', '.toml', '.md'],
      '.rb': ['.rb', '.md'],
      '.md': ['.ts', '.js', '.py', '.java', '.go', '.rs', '.rb'],
    };

    return Object.values(relatedExtensions).some(exts => exts.includes(ext));
  }

  private async gitDiff(args: Record<string, unknown>, token?: vscode.CancellationToken, context: DiagnosticContext = {}): Promise<ToolResult> {
    const target = args.target as string | undefined;
    const base = args.base as string | undefined;

    try {
      const argsList = ['diff'];
      if (base && target) {
        argsList.push(`${base}...${target}`);
      } else if (target) {
        argsList.push('HEAD', target);
      }

      const result = await this.execGit(argsList, token);

      return {
        tool: 'git_diff',
        result: {
          diff: result,
          target,
          base,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('git_diff', 'Git diff failed', errorMessage, context);
      return {
        tool: 'git_diff',
        result: null,
        error: errorMessage,
      };
    }
  }

  private async gitLog(args: Record<string, unknown>, token?: vscode.CancellationToken, context: DiagnosticContext = {}): Promise<ToolResult> {
    const filePath = args.file as string | undefined;
    const maxCount = Math.min(
      (args.maxCount as number) || this.maxGitLogEntries,
      this.maxGitLogEntries
    );

    try {
      const argsList = ['log', `--max-count=${maxCount}`, '--pretty=format:%H|%s|%an|%ad', '--date=iso'];
      if (filePath) {
        const fullPath = this.resolvePath(filePath);
        if (!this.isWithinWorkspace(fullPath)) {
          const error = 'Path outside workspace';
          logToolError('git_log', error, error, context);
          return { tool: 'git_log', result: null, error };
        }
        argsList.push('--', fullPath);
      }

      const result = await this.execGit(argsList, token);

      const entries = result
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split('|');
          if (parts.length >= 4) {
            return {
              hash: parts[0],
              message: parts[1],
              author: parts[2],
              date: parts[3],
            };
          }
          return { raw: line };
        });

      return {
        tool: 'git_log',
        result: {
          entries,
          count: entries.length,
          file: filePath,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('git_log', 'Git log failed', errorMessage, context);
      return {
        tool: 'git_log',
        result: null,
        error: errorMessage,
      };
    }
  }

  private packageMetadata(context: DiagnosticContext = {}): ToolResult {
    const packageJsonPath = path.join(this.workspaceRoot, 'package.json');

    if (!this.isWithinWorkspace(packageJsonPath)) {
      const error = 'Path outside workspace';
      logToolError('package_metadata', error, error, context);
      return { tool: 'package_metadata', result: null, error };
    }

    try {
      if (!fs.existsSync(packageJsonPath)) {
        const error = 'package.json not found';
        logToolError('package_metadata', error, error, context);
        return { tool: 'package_metadata', result: null, error };
      }

      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      const metadata = JSON.parse(content);

      const relevantFields = {
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        main: metadata.main,
        scripts: metadata.scripts ? Object.keys(metadata.scripts) : [],
        dependencies: metadata.dependencies ? Object.keys(metadata.dependencies) : [],
        devDependencies: metadata.devDependencies ? Object.keys(metadata.devDependencies) : [],
        author: metadata.author,
        license: metadata.license,
        repository: metadata.repository,
      };

      return {
        tool: 'package_metadata',
        result: relevantFields,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logToolError('package_metadata', 'Failed to read package.json', errorMessage, context);
      return {
        tool: 'package_metadata',
        result: null,
        error: errorMessage,
      };
    }
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(this.workspaceRoot, filePath);
  }

  private isWithinWorkspace(fullPath: string): boolean {
    const normalizedWorkspace = path.normalize(this.workspaceRoot);
    const normalizedPath = path.normalize(fullPath);
    return normalizedPath.startsWith(normalizedWorkspace);
  }

  private execGit(args: string[], token?: vscode.CancellationToken): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, {
        cwd: this.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const cancelHandler = () => {
        proc.kill();
        reject(new Error('Cancelled'));
      };

      token?.onCancellationRequested(cancelHandler);

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `git exited with code ${code}`));
        }
      });

      proc.on('error', (error) => {
        reject(error);
      });
    });
  }
}

export function createToolExecutor(workspaceRoot: string): ToolExecutor {
  return new ToolExecutor({ workspaceRoot });
}
