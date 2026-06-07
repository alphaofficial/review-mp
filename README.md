<p align="center">
  <img src="./resources/codebunny.png" alt="CodeBunny" width="120" />
</p>

<h1 align="center">CodeBunny</h1>
<h3 align="center">Runtime-agnostic AI code review for VS Code, delivered as inline comments.</h3>

<p align="center">
  <a href="https://github.com/alphaofficial/codebunny/releases/latest">
    <img src="https://img.shields.io/github/v/release/alphaofficial/codebunny?style=flat&colorA=000000&colorB=000000" alt="Latest release" />
  </a>
  <a href="https://github.com/alphaofficial/codebunny/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/alphaofficial/codebunny/ci.yml?style=flat&colorA=000000&colorB=000000" alt="Build workflow" />
  </a>
</p>

`CodeBunny` is a VS Code extension that runs AI-assisted review over files, selections, commits, and diffs, then anchors validated findings directly in your editor.

It helps developers get fast review feedback from the CLI runtime they already use, without moving code into a hosted service or rewriting their workflow around one provider.

## Why CodeBunny?

- **Inline review threads**: findings appear on the relevant lines with actions for copy, dismiss, and fix application.
- **Bring your own runtime**: Claude, Copilot, Codex, Gemini, Hermes, Pi, and OpenCode are supported.
- **Diff-aware workflows**: review staged changes, uncommitted work, the last commit, or branch changes.
- **Optional code indexing**: use Ollama embeddings and Qdrant to retrieve repo context and review memory.
- **Safe context gathering**: review tooling is read-only, workspace-scoped, and delegated to authenticated local CLIs.
- **Repeatable review sessions**: findings are tracked in the CodeBunny sidebar with files, current reviews, and previous reviews.

## Install

Install the latest release VSIX:

```bash
curl -fL https://github.com/alphaofficial/codebunny/releases/latest/download/codebunny.vsix -o /tmp/codebunny.vsix \
  && code --install-extension /tmp/codebunny.vsix
```

Or build and install from source:

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension codebunny-0.0.1.vsix
```

For development, open this repository in VS Code and press `F5` to launch an Extension Development Host.

## Prerequisites

1. **VS Code** `^1.85.0`.
2. **Node.js** 18+ when building from source.
3. **One authenticated review runtime**:

| Runtime | Setting value | Notes |
| --- | --- | --- |
| Claude | `claude` | Install and authenticate Anthropic Claude Code CLI. |
| Copilot | `copilot` | Install and authenticate GitHub Copilot CLI. |
| Codex | `codex` | Install and authenticate OpenAI Codex CLI. |
| Gemini | `gemini` | Install and authenticate Google Gemini CLI. |
| Hermes | `hermes` | Install and authenticate Hermes CLI. |
| Pi | `pi` | Install and authenticate Pi CLI. |
| OpenCode | `opencode` | Default runtime. Install and authenticate OpenCode CLI. |

## Quick start

1. Open a workspace in VS Code.
2. Run `CodeBunny: Select Runtime` from the Command Palette.
3. Choose a configured CLI runtime.
4. Open a file and run `CodeBunny: Review Current File`.
5. Review findings inline or from the CodeBunny activity bar.

## Review commands

| Command | What it reviews |
| --- | --- |
| `CodeBunny: Review Current File` | The active file or selected Explorer file. |
| `CodeBunny: Review Selection` | The current editor selection. |
| `CodeBunny: Review Staged Changes` | `git diff --cached`. |
| `CodeBunny: Review Uncommitted Changes` | Current working tree changes. |
| `CodeBunny: Review All Changes` | All available local changes. |
| `CodeBunny: Review Last Commit` | Changes introduced by the previous commit. |
| `CodeBunny: Review Branch Changes` | Current branch changes compared with the base branch. |
| `CodeBunny: Clear All Comments` | Removes inline CodeBunny review comments. |
| `CodeBunny: Clear Active Review` | Clears the active review session in the sidebar. |
| `CodeBunny: Open Review Panel` | Opens a saved review panel. |
| `CodeBunny: Select Runtime` | Chooses the active AI runtime. |
| `CodeBunny: Show Debug Logs` | Opens the CodeBunny output channel. |

## Sidebar

CodeBunny adds an activity bar container with five views:

- **NEW REVIEW**: start common review flows.
- **FILES**: see files in the active review.
- **REVIEWS**: navigate findings, apply fixes, or dismiss items.
- **PREVIOUS REVIEWS**: reopen earlier review sessions.
- **INDEXING**: configure and control semantic code indexing.

## Configuration

Settings are available in the VS Code Settings UI by searching for `codebunny`, or directly in `settings.json`.

| Setting | Default | Description |
| --- | --- | --- |
| `codebunny.runtime` | `opencode` | Runtime: `claude`, `copilot`, `codex`, `gemini`, `hermes`, `pi`, or `opencode`. |
| `codebunny.model` | `""` | Optional model override. Leave empty to use the runtime default. |
| `codebunny.autoReviewOnStage` | `false` | Automatically run a review when files are staged. |
| `codebunny.autoReviewOnCommit` | `false` | Automatically run a review when a commit is created. |
| `codebunny.reviewConcurrency` | `5` | Maximum number of file review scopes to run in parallel. |
| `codebunny.executableOverride` | `""` | Override the executable path for the selected runtime. |
| `codebunny.extraArgs` | `""` | Additional arguments passed to the runtime executable. |
| `codebunny.codeIndexEmbedderProvider` | `ollama` | Embedder provider for code indexing. |
| `codebunny.codeIndexOllamaBaseUrl` | `http://localhost:11434` | Ollama server used for embeddings. |
| `codebunny.codeIndexOllamaModel` | `nomic-embed-text` | Ollama embedding model for indexing. |
| `codebunny.codeIndexModelDimension` | `768` | Expected embedding vector dimension. |
| `codebunny.codeIndexQdrantUrl` | `http://localhost:6333` | Qdrant URL for vector storage. |
| `codebunny.codeIndexSearchMinScore` | `0.4` | Minimum semantic search score for retrieval. |
| `codebunny.codeIndexSearchMaxResults` | `50` | Maximum semantic search results returned from the index. |

The optional Qdrant API key is configured in the **INDEXING** view and stored in VS Code secret storage instead of `settings.json`.

## Code indexing

CodeBunny can build a semantic workspace index for richer review context and reusable review memory.

### Step 1: Choose Your Setup

Before enabling codebase indexing, you'll need two components:

- **An Embedding Provider** - to convert code into searchable vectors
- **A Vector Database** - to store and search those vectors

### Step 2: Set Up Qdrant (Vector Database)

**Option A: Cloud Setup** - FREE

1. Sign up at [Qdrant Cloud](https://cloud.qdrant.io) (free tier available)
2. Create a cluster
3. Copy your URL and API key

**Option B: Local Setup** - FREE

Using Docker:

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v qdrant_data:/qdrant/storage \
  qdrant/qdrant
```

Using Docker Compose:

```yaml
services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"
    volumes:
      - qdrant_storage:/qdrant/storage
volumes:
  qdrant_storage:
```

### Step 3: Set Up an Embedding Provider

**Ollama Setup** (Default) - FREE

1. Install Ollama from [ollama.ai](https://ollama.ai)
2. Pull the embedding model:
   ```bash
   ollama pull nomic-embed-text
   ```
3. Start the Ollama server:
   ```bash
   ollama serve
   ```
4. Verify it's running at `http://localhost:11434`

**Google Gemini Setup** - FREE

1. Get an API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
2. In CodeBunny settings:
   - Provider: Google Gemini
   - API Key: Your Google AI Studio key

**Other Providers Available**

CodeBunny also supports OpenAI, OpenAI-compatible, Mistral, Vercel AI Gateway, Bedrock, and OpenRouter providers. You can explore these options in the configuration dropdown.

### Step 4: Save

1. Open the CodeBunny **INDEXING** view
2. Confirm provider, model, dimensions, Qdrant URL, API key, score threshold, and max results
3. Click Save and Start Indexing

The status indicator will show:

- **Yellow (Indexing)**: Currently processing files
- **Green (Indexed)**: Ready for searches
- **Red (Error)**: Check troubleshooting section

### Useful commands

| Command | Description |
| --- | --- |
| `CodeBunny: Enable Code Indexing` | Enables workspace indexing. |
| `CodeBunny: Disable Code Indexing` | Disables workspace indexing. |
| `CodeBunny: Rebuild Code Index` | Rebuilds the local semantic index. |
| `CodeBunny: Stop Code Indexing` | Stops an indexing run. |
| `CodeBunny: Clear Code Index Data` | Clears stored index data. |

## Auto-review

Auto-review is disabled by default.

```json
{
  "codebunny.autoReviewOnStage": true,
  "codebunny.autoReviewOnCommit": false
}
```

- `autoReviewOnStage` watches the git index and reviews staged changes after `git add`.
- `autoReviewOnCommit` prompts for a staged-changes review when commit activity starts.

Reload VS Code after changing auto-review settings so startup watchers are registered with the new configuration.

## Architecture

```text
CodeBunny command
  -> ReviewOrchestrator
  -> context packaging + cache lookup
  -> RuntimeAdapter
  -> selected CLI runtime
  -> validated findings
  -> inline comments + sidebar state
  -> optional review memory writeback
```

Key implementation areas:

- `src/extension.ts` registers commands, views, providers, and the extension lifecycle.
- `src/reviewOrchestrator.ts` coordinates review runs, cache checks, provider calls, and comments.
- `src/providers/runtimeAdapter.ts` spawns CLI runtimes using each runtime manifest.
- `src/harness/contextRetriever.ts` builds related context for file and diff reviews.
- `src/store/reviewSessionStore.ts` stores active and previous review state.
- `src/services/code-index/` manages code indexing workers, status, and persistence.

## Security model

- Runtime authentication is delegated to your local CLI tools.
- CodeBunny does not store provider API keys for review runtimes.
- Qdrant API keys are stored in VS Code secret storage.
- Review context tooling is read-only and workspace-scoped.
- Git operations used by review flows are read-only.
- Prompts and sensitive review payloads are not logged by default.

## Development

```bash
# Type-check and bundle production output
npm run compile

# Type-check only
npm run typecheck

# Lint TypeScript sources
npm run lint

# Run tests
npm test

# Watch tests
npm run test:watch
```

## Remote VSIX install

When connected to an SSH host, container, or WSL target, install the VSIX from the remote VS Code window with **Extensions: Install from VSIX...**.

You can also run:

```bash
code --install-extension /path/to/codebunny-0.0.1.vsix
```

If you are testing a local build, consider disabling automatic extension updates for that remote window.

## License

MIT
