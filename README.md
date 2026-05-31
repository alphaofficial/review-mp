# ReviewMP

A runtime-agnostic AI code review harness for VS Code with inline comments.

## Features

- Review code with AI and see inline comments directly in VS Code
- Review file, selection, staged changes, uncommitted changes, last commit, or branch
- Accept or reject suggested fixes
- Auto-review on stage or before commit (optional)
- **Multi-runtime support**: Claude, Copilot, Codex, Gemini, Hermes, Pi, OpenCode
- Read-only tool execution for safe context gathering
- Comment validation before placement
- Bounded review iterations with retry handling

## Supported Runtimes

| Runtime | Description |
|---------|-------------|
| `claude` | Use Anthropic's Claude Code CLI |
| `copilot` | Use GitHub Copilot CLI |
| `codex` | Use OpenAI Codex CLI |
| `gemini` | Use Google Gemini CLI |
| `hermes` | Use Hermes CLI |
| `pi` | Use Pi CLI |
| `opencode` | Use OpenCode CLI (default for backward compatibility) |

## Prerequisites

1. **Node.js** 18+ for building the extension

2. **Runtime setup** (choose one):
   - **Claude**: `npm install -g @anthropic/claude-code` and authenticate
   - **Copilot**: `npm install -g @githubnext/copilot-cli` and authenticate
   - **Codex**: Install OpenAI Codex CLI and authenticate
   - **Gemini**: Install Google Gemini CLI and authenticate
   - **Hermes/Pi**: Install respective CLI and authenticate
   - **OpenCode**: `npm install -g opencode-ai` and `opencode auth login`

## Setup

### 1. Build the Extension

```bash
cd reviewmp
npm install
npm run compile
```

### 2. Install in VS Code

**Option A: Install latest VSIX from GitHub Releases**

```bash
curl -L https://github.com/alphaofficial/review-mp/releases/latest/download/reviewmp.vsix -o /tmp/reviewmp.vsix && code --install-extension /tmp/reviewmp.vsix
```

Stable VSIX URL:

```text
https://github.com/alphaofficial/review-mp/releases/latest/download/reviewmp.vsix
```

**Option B: Development mode**

Press F5 in VS Code to launch Extension Development Host.

**Option C: Package and install locally**

Run the automated install script:
```bash
./install.sh
```

This script will:
1. Install npm dependencies
2. Compile the TypeScript code
3. Package the extension as VSIX
4. Install the extension in VS Code

After installation, reload VS Code:
- Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
- Run "Developer: Reload Window"

**Manual installation (if needed):**

If the automated script doesn't work, you can run these steps manually:

1. Build the extension:
   ```bash
   npm run compile
   ```

2. Package as VSIX:
   ```bash
   npx @vscode/vsce package
   ```
   This creates `reviewmp-<version>.vsix`

3. Install in VS Code:
   ```bash
   code --install-extension reviewmp-<version>.vsix
   ```

4. Reload VS Code:
   - Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
   - Run "Developer: Reload Window"

### 3. Configure Runtime

Open Command Palette and select a runtime:

```
ReviewMP: Select Runtime
```

## Usage

1. Open a file in VS Code
2. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run a review command (e.g., `ReviewMP: Review Current File`)
4. Wait for the AI to analyze your code
5. Review comments appear inline with Accept/Reject options

### Commands

| Command | Description |
|---------|-------------|
| `ReviewMP: Review Current File` | Review the entire active file |
| `ReviewMP: Review Selection` | Review only the selected code |
| `ReviewMP: Review Staged Changes` | Review git staged changes (`git diff --cached`) |
| `ReviewMP: Review Uncommitted Changes` | Review all uncommitted changes (`git diff`) |
| `ReviewMP: Review Last Commit` | Review the last commit (`git diff HEAD~1`) |
| `ReviewMP: Review Branch Changes` | Review all commits on current branch vs base |
| `ReviewMP: Review Pull Request` | Review PR with clustered passes |
| `ReviewMP: Clear All Comments` | Remove all review comments |
| `ReviewMP: Select Runtime` | Choose AI runtime |
| `ReviewMP: Show Debug Logs` | Open the ReviewMP output channel |

## Configuration

Settings can be configured via:

1. **VS Code Settings UI**: Open Settings (`Cmd+,` / `Ctrl+,`), search for "reviewmp"
2. **settings.json**: Add to your user or workspace settings
3. **Workspace settings**: Create `.vscode/settings.json` in your project

Example `settings.json`:
```json
{
  "reviewmp.runtime": "claude",
  "reviewmp.model": "claude-sonnet-4-20250514",
  "reviewmp.autoReviewOnStage": true,
  "reviewmp.autoReviewOnCommit": false
}
```

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.runtime` | `opencode` | Runtime: `claude`, `copilot`, `codex`, `gemini`, `hermes`, `pi`, `opencode` |
| `reviewmp.model` | (empty) | Model override. Leave empty for runtime default. |
| `reviewmp.autoReviewOnStage` | `false` | Automatically review when files are staged |
| `reviewmp.autoReviewOnCommit` | `false` | Prompt to review before commit |

### Runtime-Specific Settings

Each runtime may support additional optional settings:

```json
{
  "reviewmp.runtime": "claude",
  "reviewmp.model": "claude-sonnet-4-20250514",
  "reviewmp.claudeExecutable": "/usr/local/bin/claude",
  "reviewmp.claudeExtraArgs": "--no-input"
}
```

| Setting | Description |
|---------|-------------|
| `reviewmp.<runtime>Executable` | Override the runtime executable path |
| `reviewmp.<runtime>ExtraArgs` | Additional arguments passed to the runtime |

### Runtime Configuration Examples

**Claude** (default):
```json
{
  "reviewmp.runtime": "claude",
  "reviewmp.model": "claude-sonnet-4-20250514"
}
```

**OpenCode**:
```json
{
  "reviewmp.runtime": "opencode"
}
```

**Copilot**:
```json
{
  "reviewmp.runtime": "copilot",
  "reviewmp.model": "gpt-4o"
}
```

### Auto-Review Features

When enabled, these settings provide automatic code review:

- **autoReviewOnStage**: Watches the git index. When you stage files, it automatically triggers a review of staged changes.
- **autoReviewOnCommit**: Watches for commit activity. When you start a commit, it prompts you to review staged changes first.

Both are disabled by default. The extension only activates on startup if one of these is enabled.

**Note**: After enabling auto-review settings, reload VS Code (`Developer: Reload Window`) for the changes to take effect.

## Architecture

ReviewMP uses a runtime-agnostic architecture:

```
ReviewMP Command → ReviewOrchestrator → ReviewHarness → RuntimeAdapter → Runtime
                                              ↓
                                      ToolExecutor (read-only)
                                              ↓
                                      ContextCollector
```

- **ReviewOrchestrator**: Handles commands, progress, and cancellation
- **ReviewHarness**: Bounded review loop with retry handling
- **RuntimeAdapter**: Abstraction over CLI-based AI runtimes
- **ToolExecutor**: Read-only tools for context gathering
- **ContextCollector**: Git diff, branch detection, file reading

ReviewMP is provider-agnostic - the same review workflow runs identically regardless of which runtime is selected. Authentication and runtime management are handled by the external runtime itself.

## Execution Trace

For `Review Current File`, the exact path is:

1. You trigger `reviewmp.reviewFile` from the command palette, context menu, or tree view. That command is registered in [src/extension.ts](src/extension.ts) and forwards the active document to `orchestrator.reviewFile(...)`.
2. `ReviewOrchestrator.reviewFile()` turns the document into a `ReviewRequest` with `code`, `languageId`, `filePath`, and `reviewType: 'file'` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
3. `reviewCode()` starts a new run, creates a session in the store, records the file as pending, and moves the session through `settingUp -> analyzing` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts) and [src/store/reviewSessionStore.ts](src/store/reviewSessionStore.ts).
4. Because this is a file review, it calls `reviewPreparedFile()` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
5. `reviewPreparedFile()` computes a deterministic fingerprint for this exact target and checks the local knowledge index for an exact cached hit before calling any model in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts) and [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
6. If there is no exact hit, it builds a context envelope around the file via `buildFileContextEnvelope(...)`, then packages the target plus supporting context into `reviewPackage` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts). That context system is the thing that pulls related files, code graph context, history, and indexed memory when available; the diff version of that logic starts in [src/harness/contextRetriever.ts](src/harness/contextRetriever.ts).
7. `invokeProvider()` creates the runtime provider for the currently selected CLI, invokes it, and then filters unsupported findings in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
8. The provider is a `CliRuntimeAdapter`, which builds the prompt, chooses stdin vs argv transport based on the runtime manifest, and spawns the CLI process in [src/providers/runtimeAdapter.ts](src/providers/runtimeAdapter.ts) and [src/providers/runtimeAdapter.ts](src/providers/runtimeAdapter.ts). For Codex specifically, it prepends a strict “review-only mode” block in [src/providers/runtimeAdapter.ts](src/providers/runtimeAdapter.ts).
9. When comments come back, `reviewCode()` adjusts line numbers for selections if needed, converts comments into findings in the session store, and hands them to the comment controller in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
10. `ReviewCommentController.addComments()` creates VS Code comment threads anchored to the target lines and renders the markdown/fix UI inline in [src/comments.ts](src/comments.ts).
11. When the session completes, `ReviewKnowledgeRecorder` writes the exact review run and findings back into the local index, and if indexing is enabled it also writes semantic review memory for reuse later in [src/harness/reviewKnowledgeRecorder.ts](src/harness/reviewKnowledgeRecorder.ts).

For `Review Staged Changes` / `Review Branch Changes`, the flow is the same until analysis, then it diverges:

1. `reviewStaged()` / `reviewBranch()` call `reviewGitChanges(...)` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts) and [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
2. The orchestrator asks `DiffContextCollector` for the diff, then calls `reviewPlannedDiff(...)` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts) and [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
3. `reviewPlannedDiff()` parses the diff into reviewable files, creates one scope per file, fingerprints the whole diff and each unit, and can reuse exact cached results at both the whole-review and per-file-scope level in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts) and [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).
4. It prepares diff context with import-graph neighbors, sibling tests, recent history, semantic matches, review memory, and repo summary in [src/harness/contextRetriever.ts](src/harness/contextRetriever.ts) and [src/harness/contextRetriever.ts](src/harness/contextRetriever.ts).
5. Each scope is reviewed separately in `executeSingleDiffScope()` in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts), then the findings are deduped and severity-sorted by `synthesizeReviewComments(...)` in [src/harness/reviewSynthesizer.ts](src/harness/reviewSynthesizer.ts).
6. `addDiffComments()` groups findings by file and renders inline comment threads into the real workspace files in [src/reviewOrchestrator.ts](src/reviewOrchestrator.ts).

The UI state you see in the side panel is all store-driven. The `NEW REVIEW`, `FILES`, `REVIEWS`, and `PREVIOUS REVIEWS` trees read directly from `ReviewSessionStore` in [src/reviewTreeProvider.ts](src/reviewTreeProvider.ts). So the extension is effectively:

`command -> orchestrator -> cache/context packaging -> runtime CLI -> findings -> store -> inline comments/tree UI -> knowledge writeback`

## Security

- No API key storage - authentication is delegated to the selected runtime
- Read-only tool execution (no shell execution, no file writes during review)
- Workspace reads constrained to active workspace
- Git access read-only for review flows
- No logging of prompts or sensitive data

## Development

```bash
# Watch mode
npm run watch

# Lint
npm run lint

# Tests
npm test
```

## Need to install local VSIX on remote endpoint

Sometimes you want to install a local VSIX on a remote machine, either during development or when an extension author asks you to try out a fix.

Resolution: Once you have connected to an SSH host, container, or WSL, you can install the VSIX the same way you would locally. Run the Extensions: Install from VSIX... command from the Command Palette (F1). You may also want to add "extensions.autoUpdate": false to settings.json to prevent auto-updating to the latest Marketplace version. See Supporting Remote Development for more information on developing and testing extensions in a remote environment.

For remote run: `code --install-extension /path/to/reviewmp-<version>.vsix`

[VSCode Docs](https://code.visualstudio.com/docs/remote/troubleshooting#_extension-tips)

## License

MIT
