# ReviewMP

AI-powered code review extension for VS Code using OpenCode CLI.

## Features

- Review code with AI and see inline comments directly in VS Code
- Review git staged changes, uncommitted changes, or last commit
- Accept or reject suggested fixes
- Auto-review on stage or before commit (optional)
- Uses OpenCode CLI for LLM integration

## Prerequisites

1. **OpenCode CLI** installed and configured with a provider
   ```bash
   npm install -g opencode-ai
   opencode auth login
   ```

2. **Node.js** 18+ for building the extension

## Setup

### 1. Install the OpenCode Agents

Copy the agent configurations to your OpenCode config directory:

```bash
# Global installation
cp opencode-agent/reviewmp.md ~/.config/opencode/agent/
cp opencode-agent/reviewmp-diff.md ~/.config/opencode/agent/

# Or per-project
mkdir -p .opencode/agent
cp opencode-agent/reviewmp.md .opencode/agent/
cp opencode-agent/reviewmp-diff.md .opencode/agent/
```

### 2. Build the Extension

```bash
cd reviewmp
npm install
npm run compile
```

### 3. Install in VS Code

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

## Usage

1. Open a file in VS Code
2. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run `ReviewMP: Review Current File`
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
| `ReviewMP: Review Branch Changes` | Review all commits on current branch vs base (`git diff main...HEAD`) |
| `ReviewMP: Clear All Comments` | Remove all review comments |

## Configuration

Settings can be configured via:

1. **VS Code Settings UI**: Open Settings (`Cmd+,` / `Ctrl+,`), search for "reviewmp"
2. **settings.json**: Add to your user or workspace settings
3. **Workspace settings**: Create `.vscode/settings.json` in your project

Example `settings.json`:
```json
{
  "reviewmp.opencodePath": "/opt/homebrew/bin/opencode",
  "reviewmp.model": "github-copilot/gpt-4o",
  "reviewmp.autoReviewOnStage": true,
  "reviewmp.autoReviewOnCommit": false
}
```

### Available Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.opencodePath` | `opencode` | Path to OpenCode CLI |
| `reviewmp.model` | (empty) | Model in `provider/model` format (see below) |
| `reviewmp.autoReviewOnStage` | `false` | Automatically review when files are staged (`git add`) |
| `reviewmp.autoReviewOnCommit` | `false` | Prompt to review before commit |

### Model Configuration

The model setting uses the format `provider/model`. To see all available models, run:

```bash
opencode models
```

### Auto-Review Features

When enabled, these settings provide automatic code review:

- **autoReviewOnStage**: Watches the git index. When you stage files, it automatically triggers a review of staged changes.
- **autoReviewOnCommit**: Watches for commit activity. When you start a commit, it prompts you to review staged changes first.

Both are disabled by default. The extension only activates on startup if one of these is enabled.

**Note**: After enabling auto-review settings, reload VS Code (`Developer: Reload Window`) for the changes to take effect.

## How It Works

1. Extension sends your code to OpenCode CLI with the `reviewmp` agent (or `reviewmp-diff` for git changes)
2. The agent reviews the code and outputs structured JSON
3. Extension parses the JSON and creates VS Code comments
4. Accept applies the fix using OpenCode, Reject dismisses the comment

## Development

```bash
# Watch mode
npm run watch

# Lint
npm run lint
```

## Need to install local VSIX on remote endpoint
Sometimes you want to install a local VSIX on a remote machine, either during development or when an extension author asks you to try out a fix.

Resolution: Once you have connected to an SSH host, container, or WSL, you can install the VSIX the same way you would locally. Run the Extensions: Install from VSIX... command from the Command Palette (F1). You may also want to add "extensions.autoUpdate": false to settings.json to prevent auto-updating to the latest Marketplace version. See Supporting Remote Development for more information on developing and testing extensions in a remote environment.
[VSCode Docs](https://code.visualstudio.com/docs/remote/troubleshooting#_extension-tips)

## License

MIT
