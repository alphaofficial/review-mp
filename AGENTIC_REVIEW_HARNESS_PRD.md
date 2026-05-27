# ReviewMP Agentic Review Harness PRD

## 1. Summary

ReviewMP should evolve from a VS Code extension that shells out to OpenCode into a provider-neutral, agentic code review harness. The extension should own the review workflow, context gathering, tool execution, output validation, comment placement, and fix application. Model backends should become interchangeable inference providers.

This enables users to bring their own models and agent runtimes, including OpenCode, ZooCode, Pi, Hermes, OpenAI-compatible APIs, Anthropic, local models, and custom CLIs.

## 2. Problem Statement

ReviewMP currently depends on OpenCode as the review agent runtime. The extension invokes OpenCode with the `reviewmp` agent and expects OpenCode to perform context gathering, reasoning, and structured output generation.

This creates several limitations:

- Users must install and configure OpenCode even if they already use another model runtime.
- ReviewMP cannot fully control review strategy, context collection, tool safety, or retry behavior.
- The core product value is coupled to an external agent file and OpenCode-specific execution semantics.
- Provider/model configuration is constrained by OpenCode's model naming and authentication model.
- Future support for direct APIs, local models, and other agent CLIs requires duplicating review behavior rather than reusing one ReviewMP-owned harness.

## 3. Goals

### 3.1 Product Goals

- Make ReviewMP a standalone agentic review system.
- Allow users to bring their own model provider or agent CLI.
- Preserve the current OpenCode flow as a backward-compatible provider.
- Improve review quality by giving ReviewMP explicit control over context gathering and multi-pass review strategies.
- Make the review pipeline testable, observable, and provider-neutral.

### 3.2 Engineering Goals

- Introduce a provider abstraction for model inference.
- Move review instructions and output schemas into the extension codebase.
- Separate orchestration from provider execution.
- Support structured model outputs and robust fallback parsing.
- Add a safe internal tool protocol for agentic context gathering.
- Keep existing VS Code commands and comment UX intact.

### 3.3 Non-Goals

- Building a general-purpose autonomous coding agent.
- Allowing arbitrary model-generated shell execution in the initial release.
- Replacing all OpenCode support immediately.
- Supporting every provider-specific advanced feature on day one.
- Automatically committing or pushing code changes.

## 4. Target Users

### 4.1 Individual Developers

Developers who want inline AI code review in VS Code using their preferred model provider or local model runtime.

### 4.2 Teams

Teams that want consistent review behavior but different model backends across environments, such as enterprise APIs in workspaces and local models for private projects.

### 4.3 Power Users

Users of tools such as ZooCode, Pi, Hermes, OpenCode, and custom CLIs who want ReviewMP to integrate with their existing agent/model setup.

## 5. Current State

The current implementation has these core pieces:

- VS Code command registration and orchestration in `src/extension.ts`.
- Review comment placement and fix command handling in `src/comments.ts`.
- OpenCode-specific review execution, prompt construction, diff formatting, parsing, and fix application in `src/opencode.ts`.
- OpenCode agent instructions in `opencode-agent/reviewmp.md`.
- OpenCode-specific settings in `package.json`.

Current high-level flow:

```text
VS Code command
  -> extension.ts
  -> OpenCodeService
  -> opencode run --agent reviewmp --format json
  -> parse OpenCode NDJSON output
  -> ReviewCommentController
```

## 6. Proposed Architecture

### 6.1 New High-Level Flow

```text
VS Code command
  -> ReviewOrchestrator
  -> ReviewHarness
     -> ContextCollector
     -> ReviewStrategy
     -> ModelProvider
     -> ToolExecutor
     -> OutputParser
     -> CommentValidator
  -> ReviewCommentController
```

### 6.2 Core Modules

#### `ReviewOrchestrator`

Coordinates VS Code commands, progress UI, cancellation, and comment placement.

Responsibilities:

- Convert command inputs into review requests.
- Select the appropriate review strategy.
- Call the harness.
- Adjust line offsets for selections.
- Send validated comments to the comment controller.
- Display success and error notifications.

#### `ReviewHarness`

Runs the agentic review loop.

Responsibilities:

- Build system and task prompts.
- Request model output from the selected provider.
- Detect tool requests.
- Execute allowed context tools.
- Re-prompt with gathered context.
- Stop after final review output or max iterations.
- Normalize and validate final comments.

#### `ModelProvider`

Provider-neutral inference interface.

Responsibilities:

- Send model requests to a backend.
- Stream or return model output.
- Handle provider-specific authentication, command execution, or HTTP requests.
- Return raw model text and optional structured metadata.

#### `ContextCollector`

Collects deterministic context before and during review.

Responsibilities:

- Read current file or selection.
- Generate staged, uncommitted, last-commit, or branch diffs.
- Format diffs with line numbers.
- Detect imports and exports.
- Find usages through workspace search.
- Find tests and related files.
- Collect package metadata when useful.

#### `ToolExecutor`

Executes a constrained set of harness-owned tools.

Initial allowed tools:

- `read_file`
- `search_workspace`
- `list_related_files`
- `git_diff`
- `git_log`
- `package_metadata`

Explicitly disallowed in initial release:

- Arbitrary shell execution requested by the model.
- File writes requested by the model during review.
- Git commit, push, branch mutation, or remote mutation.

#### `OutputParser`

Parses provider responses.

Responsibilities:

- Parse strict JSON responses.
- Parse JSON embedded in markdown.
- Parse OpenCode NDJSON for backward compatibility.
- Detect tool requests.
- Detect final review results.
- Return useful parser errors for retry prompts.

#### `CommentValidator`

Validates and normalizes comments.

Responsibilities:

- Ensure required fields exist.
- Convert 1-based model line numbers to 0-based VS Code line numbers when needed.
- Validate file paths are workspace-relative or match the reviewed document.
- Validate severity.
- Drop invalid comments.
- Deduplicate duplicate findings.

## 7. Provider Abstraction

### 7.1 Interface

```ts
export interface ModelProvider {
  id: string;
  displayName: string;
  complete(
    request: ModelRequest,
    token: vscode.CancellationToken
  ): Promise<ModelResponse>;
}

export interface ModelRequest {
  systemPrompt: string;
  messages: ModelMessage[];
  model?: string;
  temperature?: number;
  responseFormat?: 'json' | 'text';
  metadata?: Record<string, unknown>;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ModelResponse {
  text: string;
  raw?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

### 7.2 Initial Providers

#### OpenCode Provider

Backward-compatible provider that shells out to OpenCode.

Responsibilities:

- Invoke `opencode run`.
- Support existing `reviewmp.opencodePath`.
- Support existing `reviewmp.model`.
- Parse NDJSON output.

#### Custom CLI Provider

Generic adapter for tools such as ZooCode, Pi, Hermes, and local wrappers.

Configuration:

```json
{
  "reviewmp.provider": "customCli",
  "reviewmp.providers.customCli.command": "zoocode",
  "reviewmp.providers.customCli.args": ["run", "--json"],
  "reviewmp.providers.customCli.inputMode": "stdin",
  "reviewmp.providers.customCli.outputMode": "json"
}
```

#### OpenAI-Compatible Provider

Supports any provider exposing a Chat Completions or Responses-compatible HTTP API.

Configuration:

```json
{
  "reviewmp.provider": "openaiCompatible",
  "reviewmp.model": "gpt-4.1",
  "reviewmp.providers.openaiCompatible.baseUrl": "https://api.openai.com/v1",
  "reviewmp.providers.openaiCompatible.apiKeySecretName": "reviewmp.openaiCompatible.apiKey"
}
```

#### Anthropic Provider

Direct Anthropic Messages API support.

Configuration:

```json
{
  "reviewmp.provider": "anthropic",
  "reviewmp.model": "claude-sonnet-4-20250514",
  "reviewmp.providers.anthropic.apiKeySecretName": "reviewmp.anthropic.apiKey"
}
```

## 8. Agent Protocol

The harness should use a simple structured protocol between the model and ReviewMP.

### 8.1 Tool Request

```json
{
  "type": "tool_request",
  "tool": "search_workspace",
  "args": {
    "query": "functionName usages",
    "filePattern": "*.ts"
  }
}
```

### 8.2 Tool Result

```json
{
  "type": "tool_result",
  "tool": "search_workspace",
  "result": "..."
}
```

### 8.3 Final Review Result

```json
{
  "type": "review_result",
  "comments": [
    {
      "file": "src/example.ts",
      "line": 42,
      "severity": "warning",
      "message": "This call can throw but the error is not handled.",
      "fix": "Wrap the call in try/catch and surface a user-facing error."
    }
  ]
}
```

### 8.4 Compatibility Mode

For existing OpenCode behavior, the parser should continue accepting a raw JSON array:

```json
[
  {
    "file": "src/example.ts",
    "line": 42,
    "severity": "warning",
    "message": "...",
    "fix": "..."
  }
]
```

## 9. Review Strategies

### 9.1 File Review Strategy

Inputs:

- Full file text.
- Language ID.
- File path.
- Workspace metadata.

Process:

1. Number file lines.
2. Collect imports and exports.
3. Find related tests and usage sites when relevant.
4. Run the harness.
5. Validate returned comments against the reviewed file.

### 9.2 Selection Review Strategy

Inputs:

- Selected text.
- Start line offset.
- Full file path.
- Language ID.

Process:

1. Number selected lines using local selection line numbers.
2. Include surrounding file context if safe and useful.
3. Run the harness.
4. Offset comments back to the original document line numbers.

### 9.3 Diff Review Strategy

Inputs:

- Staged, uncommitted, last commit, or branch diff.

Process:

1. Generate diff.
2. Format added lines with target-file line numbers.
3. Include commit messages for intent when available.
4. Ask the model to comment only on changed lines unless identifying cross-file breakage.
5. Validate file paths and line numbers.

### 9.4 Pull Request Review Strategy

Inputs:

- Base branch.
- PR diff.
- Optional PR metadata from GitHub CLI.

Process:

1. Split diff into clusters by file relationships and size.
2. Review each cluster independently.
3. Summarize findings and file changes.
4. Run a cross-file consistency pass.
5. Deduplicate final comments.

### 9.5 Fix Application Strategy

Fix application should also use the provider abstraction, but it should not blindly allow model-driven edits.

Initial approach:

- Continue applying fixes through an explicit user action.
- Ask the selected provider to produce a minimal patch or replacement.
- Preview the edit before applying when possible.
- Apply only to the target file and target region.

## 10. Configuration

### 10.1 New Settings

```json
{
  "reviewmp.provider": "opencode",
  "reviewmp.model": "",
  "reviewmp.harness.maxIterations": 4,
  "reviewmp.harness.enableToolRequests": true,
  "reviewmp.harness.includeRelatedTests": true,
  "reviewmp.harness.includeUsages": true,
  "reviewmp.providers.customCli.command": "",
  "reviewmp.providers.customCli.args": [],
  "reviewmp.providers.customCli.inputMode": "stdin",
  "reviewmp.providers.customCli.outputMode": "text",
  "reviewmp.providers.openaiCompatible.baseUrl": "",
  "reviewmp.providers.openaiCompatible.apiKeySecretName": "reviewmp.openaiCompatible.apiKey",
  "reviewmp.providers.anthropic.apiKeySecretName": "reviewmp.anthropic.apiKey"
}
```

### 10.2 Backward Compatibility Settings

Keep these settings for compatibility:

```json
{
  "reviewmp.opencodePath": "opencode",
  "reviewmp.model": ""
}
```

If `reviewmp.provider` is unset, default to `opencode` during migration.

## 11. Security and Safety

### 11.1 Security Principles

- The harness controls tools, not the model provider.
- No arbitrary model-requested shell execution in the initial release.
- No automatic file writes during review.
- Fixes require explicit user action.
- API keys must be stored in VS Code secret storage, not plain settings.
- Workspace file reads should be limited to the current workspace.
- Git commands should be read-only for review flows.

### 11.2 Allowed Git Commands

Allowed:

- `git diff`
- `git diff --cached`
- `git log`
- `git rev-parse`
- `git symbolic-ref`
- `git status --short`

Disallowed:

- `git commit`
- `git push`
- `git reset`
- `git checkout`
- `git switch`
- `git branch -D`
- Any command that mutates repository state.

## 12. UX Requirements

### 12.1 Provider Selection

Add command:

```text
ReviewMP: Select Model Provider
```

The command should:

- Show available providers.
- Persist selected provider in VS Code settings.
- Prompt for required configuration if missing.

### 12.2 API Key Setup

Add commands:

```text
ReviewMP: Set Provider API Key
ReviewMP: Clear Provider API Key
```

API keys should use VS Code secret storage.

### 12.3 Review Progress

Progress messages should show high-level harness phases:

- Collecting context.
- Asking model.
- Gathering requested context.
- Validating comments.
- Placing comments.

### 12.4 Error Messages

Errors should identify whether the failure came from:

- Provider configuration.
- Provider execution.
- Network/API error.
- Model output parsing.
- Harness validation.
- Comment placement.

## 13. Data Model

### 13.1 Review Request

```ts
export type ReviewKind = 'file' | 'selection' | 'diff' | 'pullRequest';

export interface ReviewRequest {
  kind: ReviewKind;
  workspaceRoot: string;
  filePath?: string;
  languageId?: string;
  content?: string;
  selectionStartLine?: number;
  diffType?: 'staged' | 'uncommitted' | 'lastCommit' | 'branch';
  baseBranch?: string;
}
```

### 13.2 Review Result

```ts
export interface ReviewResult {
  comments: ReviewComment[];
  diagnostics: ReviewDiagnostic[];
  providerId: string;
  model?: string;
}

export interface ReviewDiagnostic {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source: 'harness' | 'provider' | 'parser' | 'validator' | 'tool';
}
```

## 14. Migration Plan

### Phase 1: Extract Provider Boundary

- Add `ModelProvider` interface.
- Move OpenCode spawning into `OpenCodeProvider`.
- Keep current prompt and parser behavior.
- Keep existing commands unchanged.

Acceptance criteria:

- Existing file and diff review commands still work with OpenCode.
- `OpenCodeService` no longer directly owns all provider behavior.

### Phase 2: Add Harness-Owned Prompts and Parser

- Move review instructions from `opencode-agent/reviewmp.md` into TypeScript prompt builders.
- Add provider-neutral output parser.
- Continue accepting existing JSON arrays.

Acceptance criteria:

- Users no longer need to install the OpenCode agent file for standard reviews.
- OpenCode provider can run with a plain prompt.

### Phase 3: Add Custom CLI Provider

- Add generic CLI provider.
- Support prompt via stdin and prompt as argument.
- Support text, JSON, and NDJSON output modes.

Acceptance criteria:

- A user can configure a local CLI model backend without code changes.
- CLI provider receives the same harness prompt as OpenCode.

### Phase 4: Add HTTP Providers

- Add OpenAI-compatible provider.
- Add Anthropic provider.
- Store API keys in VS Code secret storage.

Acceptance criteria:

- ReviewMP can review code without OpenCode installed.
- Provider errors are surfaced clearly.

### Phase 5: Add Agentic Tool Loop

- Add structured tool request parser.
- Add safe read-only tool executor.
- Add max iteration limit.
- Add retry prompt for invalid output.

Acceptance criteria:

- Model can request additional context.
- Harness executes only allowed tools.
- Harness stops deterministically.

### Phase 6: Improve PR Review Strategy

- Generalize clustered review into a strategy module.
- Add cross-file consistency pass through the harness.
- Deduplicate comments across passes.

Acceptance criteria:

- Large PR reviews remain within context limits.
- Cross-file issues can be detected without duplicating cluster findings.

## 15. Testing Plan

### 15.1 Unit Tests

- Provider selection.
- Prompt builders.
- Output parser.
- Comment validation.
- Tool request parsing.
- Diff line-number formatting.
- Deduplication.

### 15.2 Integration Tests

- OpenCode provider with mocked process output.
- Custom CLI provider with mocked process output.
- HTTP providers with mocked API responses.
- Harness loop with tool requests.
- Review command flows with mocked VS Code APIs.

### 15.3 Manual QA

- Review current file with OpenCode.
- Review current file with custom CLI provider.
- Review staged diff.
- Review branch diff.
- Cancel an in-progress review.
- Provider misconfiguration handling.
- Invalid model output handling.
- API key setup and clearing.

## 16. Observability

Add structured debug logging behind a setting:

```json
{
  "reviewmp.debug": false
}
```

Log categories:

- Provider selection.
- Prompt size.
- Tool requests.
- Parser fallback path.
- Dropped invalid comments.
- Review duration.

Do not log:

- API keys.
- Full prompts by default.
- Full source code unless explicit debug setting allows it.

## 17. Success Metrics

- Users can run reviews without OpenCode installed.
- Existing OpenCode users remain unbroken.
- At least three provider types work: OpenCode, custom CLI, and OpenAI-compatible HTTP.
- Invalid provider/model output does not crash the extension.
- Review comments remain structured and correctly placed.
- Agentic context gathering improves review relevance without unsafe tool execution.

## 18. Open Questions

- Should provider-specific settings live under `reviewmp.providers.*` or separate top-level keys?
- Should ReviewMP expose a public provider plugin API later?
- Should custom CLI providers receive the entire `ModelRequest` as JSON instead of only prompt text?
- Should the harness support streaming comments as they are produced?
- Should fixes use unified diff patches or direct text replacements?

## 19. Recommended Initial File Layout

```text
src/harness/reviewHarness.ts
src/harness/prompts.ts
src/harness/contextCollector.ts
src/harness/toolExecutor.ts
src/harness/outputParser.ts
src/harness/commentValidator.ts
src/harness/strategies/fileReviewStrategy.ts
src/harness/strategies/selectionReviewStrategy.ts
src/harness/strategies/diffReviewStrategy.ts
src/harness/strategies/pullRequestReviewStrategy.ts
src/providers/modelProvider.ts
src/providers/providerRegistry.ts
src/providers/opencodeProvider.ts
src/providers/customCliProvider.ts
src/providers/openaiCompatibleProvider.ts
src/providers/anthropicProvider.ts
src/reviewOrchestrator.ts
```

## 20. Implementation Priority

1. Extract provider interface and OpenCode provider.
2. Add provider-neutral harness and prompt builders.
3. Preserve existing file/diff review UX.
4. Add custom CLI provider for ZooCode/Pi/Hermes-style usage.
5. Add OpenAI-compatible provider.
6. Add Anthropic provider.
7. Add agentic tool loop.
8. Improve PR clustered review using the harness.

## 21. Final Product Vision

ReviewMP should become the review intelligence layer inside VS Code. It should not require a specific agent runtime. OpenCode, ZooCode, Pi, Hermes, direct APIs, and local models should all be interchangeable inference engines behind a ReviewMP-owned agentic harness.

The product boundary should be:

```text
ReviewMP owns review behavior.
Providers own model inference.
Users own provider choice.
```
