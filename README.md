# ReviewMP

AI-powered code review extension for VS Code using OpenCode CLI.

## Features

- Review code with AI and see inline comments directly in VS Code
- Accept or reject suggested fixes
- Uses OpenCode CLI for LLM integration

## Prerequisites

1. **OpenCode CLI** installed and configured with a provider
   ```bash
   npm install -g opencode-ai
   opencode auth login
   ```

2. **Node.js** 18+ for building the extension

## Setup

### 1. Install the OpenCode Agent

Copy the agent configuration to your OpenCode config directory:

```bash
# Global installation
cp opencode-agent/reviewmp.md ~/.config/opencode/agent/

# Or per-project
mkdir -p .opencode/agent
cp opencode-agent/reviewmp.md .opencode/agent/
```

### 2. Build the Extension

```bash
cd reviewmp
npm install
npm run compile
```

### 3. Install in VS Code

Option A: Development mode
```bash
# Press F5 in VS Code to launch Extension Development Host
```

Option B: Package and install
```bash
npm install -g @vscode/vsce
vsce package
code --install-extension reviewmp-0.0.1.vsix
```

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
| `ReviewMP: Clear All Comments` | Remove all review comments |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.opencodePath` | `opencode` | Path to OpenCode CLI |
| `reviewmp.model` | (empty) | Model to use (e.g., `anthropic/claude-sonnet-4-20250514`) |

## How It Works

1. Extension sends your code to OpenCode CLI with the `reviewmp` agent
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

## License

MIT
