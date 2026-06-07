#!/usr/bin/env bash

set -euo pipefail

echo "CodeBunny Installation Script"
echo "====================================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

echo "Node.js version: $(node --version)"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed. Please install npm first."
    exit 1
fi

echo "npm version: $(npm --version)"

VSIX_FILE="$(node -p "const p=require('./package.json'); \`\${p.name}-\${p.version}.vsix\`")"
SUPPORTED_RUNTIMES=("claude" "copilot" "codex" "gemini" "hermes" "pi" "opencode")
AVAILABLE_RUNTIMES=()

for runtime in "${SUPPORTED_RUNTIMES[@]}"; do
    if command -v "$runtime" &> /dev/null; then
        AVAILABLE_RUNTIMES+=("$runtime")
    fi
done

echo ""
echo "Runtime check:"
if [ ${#AVAILABLE_RUNTIMES[@]} -eq 0 ]; then
    echo "Warning: No supported runtime CLI found on PATH."
    echo "Install and authenticate one of: ${SUPPORTED_RUNTIMES[*]}"
else
    echo "Found runtime CLI(s): ${AVAILABLE_RUNTIMES[*]}"
fi
echo "Runtime selection is configured in VS Code via 'CodeBunny: Select Runtime'."

# Step 1: Install dependencies
echo ""
echo "Step 1: Installing npm dependencies..."
npm install

# Step 2: Compile TypeScript
echo ""
echo "Step 2: Compiling TypeScript..."
npm run compile

# Step 3: Package as VSIX
echo ""
echo "Step 3: Packaging extension as VSIX..."
npx @vscode/vsce package

# Step 4: Install in VS Code
echo ""
echo "Step 4: Installing extension in VS Code..."
if command -v code &> /dev/null; then
    code --install-extension "$VSIX_FILE"
    echo ""
    echo "Installation complete!"
    echo "Please reload VS Code to activate the extension:"
    echo "- Open Command Palette (Cmd+Shift+P / Ctrl+Shift+P)"
    echo "- Run 'Developer: Reload Window'"
else
    echo "Warning: VS Code CLI 'code' command not found."
    echo "Please install the extension manually:"
    echo "1. Open VS Code"
    echo "2. Go to Extensions (Cmd+Shift+X / Ctrl+Shift+X)"
    echo "3. Click 'Install from VSIX...'"
    echo "4. Select: $VSIX_FILE"
    echo "5. Reload VS Code when prompted"
fi

echo ""
echo "Installation script complete!"
