# ReviewMP

Provider-neutral AI code review for VS Code with inline comments.

## Features

- Review code with AI and see inline comments directly in VS Code
- Review file, selection, staged changes, uncommitted changes, last commit, or branch
- Accept or reject suggested fixes
- Auto-review on stage or before commit (optional)
- **Multi-provider support**: OpenCode, Custom CLI, OpenAI-compatible HTTP
- Read-only tool execution for safe context gathering
- Comment validation before placement
- Bounded review iterations with retry handling

## Supported Providers

| Provider | Description |
|----------|-------------|
| `opencode` | Use OpenCode CLI (default, backward compatible) |
| `custom-cli` | Use a custom CLI command for reviews |
| `openai-compatible` | Use any OpenAI-compatible HTTP API |

## Prerequisites

1. **Node.js** 18+ for building the extension

2. **Provider setup** (choose one):
   - **OpenCode**: `npm install -g opencode-ai` and `opencode auth login`
   - **OpenAI-compatible**: API key for your provider
   - **Custom CLI**: Any CLI that accepts prompts and returns JSON

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

### 3. Configure Provider

Open Command Palette and select a provider:

```
ReviewMP: Select Provider
```

Then set your API key:

```
ReviewMP: Set API Key
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
| `ReviewMP: Select Provider` | Choose AI provider |
| `ReviewMP: Set API Key` | Set provider API key |
| `ReviewMP: Clear API Key` | Clear stored API key |
| `ReviewMP: Toggle Debug Mode` | Enable/disable debug logging |

## Configuration

Settings can be configured via:

1. **VS Code Settings UI**: Open Settings (`Cmd+,` / `Ctrl+,`), search for "reviewmp"
2. **settings.json**: Add to your user or workspace settings
3. **Workspace settings**: Create `.vscode/settings.json` in your project

Example `settings.json`:
```json
{
  "reviewmp.provider": "openai-compatible",
  "reviewmp.model": "gpt-4o",
  "reviewmp.autoReviewOnStage": true,
  "reviewmp.autoReviewOnCommit": false,
  "reviewmp.debug": false,
  "reviewmp.openaiCompatibleEndpoint": ""
}
```

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.provider` | `opencode` | Provider: `opencode`, `custom-cli`, `openai-compatible` |
| `reviewmp.opencodePath` | `opencode` | Path to OpenCode CLI (when using opencode provider) |
| `reviewmp.model` | (empty) | Model in `provider/model` format. Leave empty for default. |
| `reviewmp.autoReviewOnStage` | `false` | Automatically review when files are staged |
| `reviewmp.autoReviewOnCommit` | `false` | Prompt to review before commit |
| `reviewmp.debug` | `false` | Enable debug logging |
| `reviewmp.customCliCommand` | (empty) | CLI command for custom-cli provider |
| `reviewmp.customCliArgs` | (empty) | Additional arguments for custom CLI |
| `reviewmp.openaiCompatibleEndpoint` | (empty) | Endpoint URL for openai-compatible provider |

### Provider Configuration

**OpenCode** (default):
```json
{
  "reviewmp.provider": "opencode",
  "reviewmp.opencodePath": "opencode",
  "reviewmp.model": "github-copilot/gpt-4o"
}
```

**OpenAI-compatible**:
```json
{
  "reviewmp.provider": "openai-compatible",
  "reviewmp.openaiCompatibleEndpoint": "https://api.openai.com/v1"
}
```
Then run `ReviewMP: Set API Key` to enter your API key.

**Custom CLI**:
```json
{
  "reviewmp.provider": "custom-cli",
  "reviewmp.customCliCommand": "/usr/local/bin/review-ai",
  "reviewmp.customCliArgs": "--model gpt-4"
}
```

### Auto-Review Features

When enabled, these settings provide automatic code review:

- **autoReviewOnStage**: Watches the git index. When you stage files, it automatically triggers a review of staged changes.
- **autoReviewOnCommit**: Watches for commit activity. When you start a commit, it prompts you to review staged changes first.

Both are disabled by default. The extension only activates on startup if one of these is enabled.

**Note**: After enabling auto-review settings, reload VS Code (`Developer: Reload Window`) for the changes to take effect.

## Architecture

ReviewMP uses a provider-neutral architecture:

```
ReviewMP Command → ReviewOrchestrator → ReviewHarness → Provider → Model
                                              ↓
                                      ToolExecutor (read-only)
                                              ↓
                                      ContextCollector
```

- **ReviewOrchestrator**: Handles commands, progress, and cancellation
- **ReviewHarness**: Bounded review loop with retry handling
- **Provider**: Abstraction over OpenCode, CLI, or HTTP
- **ToolExecutor**: Read-only tools for context gathering
- **ContextCollector**: Git diff, branch detection, file reading

## Security

- API keys stored in VS Code Secret Storage
- Read-only tool execution (no shell execution, no file writes during review)
- Workspace reads constrained to active workspace
- Git access read-only for review flows
- No logging of API keys or full prompts

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
