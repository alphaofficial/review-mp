#!/bin/bash

set -e

echo "ReviewMP Installation Script"
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

# Step 4: Copy agent to opencode config location
echo ""
echo "Step 4: Installing reviewmp agent to opencode config..."
OPENCODE_AGENTS_DIR="$HOME/.config/opencode/agent"
mkdir -p "$OPENCODE_AGENTS_DIR"
cp opencode-agent/reviewmp.md "$OPENCODE_AGENTS_DIR/"
echo "Agent installed to $OPENCODE_AGENTS_DIR/reviewmp.md"

# Step 5: Install in VS Code
echo ""
echo "Step 5: Installing extension in VS Code..."
if command -v code &> /dev/null; then
    code --install-extension reviewmp-0.0.1.vsix
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
    echo "4. Select: reviewmp-0.0.1.vsix"
    echo "5. Reload VS Code when prompted"
fi

echo ""
echo "Installation script complete!"
