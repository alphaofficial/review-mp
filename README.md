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

**Option A: Development mode**

Press F5 in VS Code to launch Extension Development Host.

**Option B: Package and install locally**

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
   This creates `reviewmp-0.0.1.vsix`

3. Install in VS Code:
   ```bash
   code --install-extension reviewmp-0.0.1.vsix
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
| `ReviewMP: Toggle Debug Mode` | Enable/disable debug logging |

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
  "reviewmp.autoReviewOnCommit": false,
  "reviewmp.debug": false
}
```

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.runtime` | `opencode` | Runtime: `claude`, `copilot`, `codex`, `gemini`, `hermes`, `pi`, `opencode` |
| `reviewmp.model` | (empty) | Model override. Leave empty for runtime default. |
| `reviewmp.autoReviewOnStage` | `false` | Automatically review when files are staged |
| `reviewmp.autoReviewOnCommit` | `false` | Prompt to review before commit |
| `reviewmp.debug` | `false` | Enable debug logging |

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

For remote run: `code --install-extension /path/to/reviewmp-0.0.1.vsix`

[VSCode Docs](https://code.visualstudio.com/docs/remote/troubleshooting#_extension-tips)

## License

MIT
