# ReviewMP — Architecture

A VS Code extension that reviews code using runtime adapters to support multiple AI backends. It supports single-file review, diff-based review (staged/uncommitted/branch), and full PR review with a 2-pass clustered strategy.

---

## File-by-File Breakdown

### `src/extension.ts` — Entry Point & Command Registration

The VS Code extension activation point. Registers all commands and wires services together.

**Key responsibilities:**
- Creates `ReviewOrchestrator`, `ReviewCommentController`, and runtime registry
- Optionally creates a `GitWatcher` if auto-review settings are enabled
- Registers 9 commands: `reviewFile`, `reviewSelection`, `reviewStaged`, `reviewUncommitted`, `reviewLastCommit`, `reviewBranch`, `reviewPR`, `clearComments`, `selectRuntime`
- Contains helper functions (`reviewDocument`, `reviewCode`, `reviewGitChanges`, `addDiffComments`, `placePRComments`) that orchestrate between services and the comment controller
- `placePRComments` checks if files exist locally; missing files get dumped to an Output channel instead of inline comments

### `src/reviewOrchestrator.ts` — Review Coordination

Coordinates the review workflow across the harness and runtime adapter.

**Key responsibilities:**
- Creates and manages `ReviewHarness` instance
- Selects runtime adapter based on `reviewmp.runtime` setting
- Handles cancellation and progress reporting
- Routes review requests to the appropriate harness method

### `src/harness/reviewHarness.ts` — Core Review Loop

The runtime-agnostic review orchestration engine.

**Key responsibilities:**
- Bounded review loop with retry handling
- Prompt construction for all review types
- Diff formatting and chunking
- Output parsing and validation
- Comment deduplication

### `src/providers/registry.ts` — Runtime Registry

Built-in registry of supported runtime manifests.

**Key responsibilities:**
- Provides `RuntimeManifest` for each supported runtime
- Runtime lookup by ID
- Manifest validation

### `src/providers/runtimeAdapter.ts` — CLI Runtime Adapter

Shared adapter for invoking CLI-based runtimes.

**Key responsibilities:**
- Spawns runtime process with configured prompt
- Handles `argv` or `stdin` prompt transport based on manifest
- Handles cancellation via process termination
- Returns raw output for normalization

### `src/harness/outputParser.ts` — Output Parsing

Parses runtime output into normalized review results.

**Key responsibilities:**
- Handles `text`, `json`, and `ndjson` output formats
- Extracts comments from various runtime output shapes
- Drops invalid findings with debug logging

### `src/comments.ts` — VS Code Comment Controller

Manages the VS Code native comment UI (inline review comments with accept/reject actions).

**Key responsibilities:**
- `ReviewCommentController` — Creates a `vscode.CommentController`, manages comment threads per file
- `addComments(uri, comments, languageId)` — Clears existing comments for the file, creates threads with markdown bodies (including code blocks for fixes)
- Uses `WeakMap<vscode.Comment, CommentData>` to associate VS Code comment objects with fix data
- Severity labels: Error, Warning, Info, Suggestion, Review

### `src/harness/toolExecutor.ts` — Read-Only Tool Execution

Executes tools for context gathering with safety constraints.

**Key responsibilities:**
- Read-only file reading
- Git diff generation
- No shell execution or file mutation

### `src/gitWatcher.ts` — Auto-Review on Stage/Commit

Watches the VS Code Git extension API for staging and commit events to trigger automatic reviews.

**Key responsibilities:**
- Polls repository state every 2 seconds to detect new staged files (index count increase)
- Listens for `onDidCommit` events (currently only logs, no post-commit action)
- 500ms debounce on staging detection to batch rapid changes
- Respects `reviewmp.autoReviewOnStage` and `reviewmp.autoReviewOnCommit` config
- Re-initializes when config changes

---

## Data Flow

### Single File / Selection Review
```
User triggers command
  → extension.ts: reviewCode()
    → reviewOrchestrator.ts: review()
      → reviewHarness.ts: runReview()
        → runtimeAdapter.ts: review()
          → spawns runtime CLI with prompt
          → parses output
        → validates comments
      → comments.ts: addComments(uri, comments)
        → creates vscode.CommentThread per comment
```

### Diff Review (staged/uncommitted/branch/lastCommit)
```
User triggers command
  → extension.ts: reviewGitChanges(type)
    → reviewOrchestrator.ts: review()
      → reviewHarness.ts: runDiffReview()
        → toolExecutor.ts: collectDiff()
        → runtimeAdapter.ts: review()
        → validates comments (requires file field)
    → extension.ts: addDiffComments()
      → groups by file → comments.ts: addComments() per file
```

### Fix Application
```
User clicks "Accept Fix" on a comment
  → comments.ts: acceptFix()
    → reviewOrchestrator.ts: applyFix()
      → runtimeAdapter.ts: applyFix()
        → spawns runtime with fix prompt
    → disposes comment thread
```

---

## 2-Pass Clustered Review — Deep Dive

The PR review uses a sophisticated strategy to handle large PRs without exceeding LLM context limits while still catching cross-file issues:

### Pass 1: Clustered Per-File Review

1. **Diff splitting**: The full PR diff is split into `FileChunk[]` — one chunk per changed file
2. **Import graph**: For each file, import/require statements are extracted (from disk for local PRs, from diff content for remote PRs). Only imports pointing to *other changed files* create edges
3. **Clustering**: BFS on the bidirectional import graph finds connected components. Files that import each other are reviewed together so the LLM sees both sides. Clusters >10 files are split into groups of 5
4. **Parallel execution**: Up to 4 clusters are reviewed concurrently via `Promise.allSettled`. Each cluster gets a tailored prompt emphasizing cross-file consistency within the cluster
5. **Small PR fast path**: PRs with ≤3 files and ≤500 diff lines skip clustering entirely and are reviewed in a single call

### Pass 2: Cross-File Consistency

After all clusters are reviewed, a second pass looks for issues that span cluster boundaries:

- Receives only **diff headers** (not full content) + **file change summaries** (+added/-removed counts)
- Receives the **existing comments** from Pass 1 with instructions to NOT duplicate them
- Focuses exclusively on: type/interface mismatches, renamed/removed exports, signature changes across call sites, missing coordinated changes

This 2-pass design balances thoroughness with token efficiency — detailed review happens per-cluster with full diff context, while the cross-file pass uses minimal tokens.

---

External dependencies:
  • Claude CLI        — LLM inference (spawned as child process)
  • Copilot CLI       — LLM inference (alternative backend)
  • Codex CLI         — LLM inference (alternative backend)
  • Gemini CLI        — LLM inference (alternative backend)
  • Hermes CLI        — LLM inference (alternative backend)
  • Pi CLI            — LLM inference (alternative backend)
  • OpenCode CLI      — LLM inference (backward-compatible default)
  • git CLI           — diff generation, branch detection
  • gh CLI            — PR metadata lookup (optional, graceful fallback)
  • vscode.git        — built-in Git extension API (for GitWatcher)

```
### Import Graph (TypeScript)

```
extension.ts
  ├── imports reviewOrchestrator.ts  (ReviewOrchestrator)
  ├── imports comments.ts            (ReviewCommentController)
  └── imports gitWatcher.ts          (GitWatcher)

reviewOrchestrator.ts
  ├── imports reviewHarness.ts       (ReviewHarness)
  ├── imports runtimeAdapter.ts      (RuntimeAdapter)
  └── imports comments.ts            (ReviewCommentController)

reviewHarness.ts
  ├── imports toolExecutor.ts        (ToolExecutor)
  ├── imports outputParser.ts        (OutputParser)
  └── imports commentValidator.ts    (CommentValidator)

runtimeAdapter.ts
  └── imports registry.ts            (RuntimeRegistry)

comments.ts
  └── imports reviewOrchestrator.ts (for applyFix)

gitWatcher.ts
  └── (no local imports — uses vscode.git extension API)
```

### Data Types

```
ReviewComment {           // Defined in comments.ts, used everywhere
  file: string
  line: number            // 0-based internally, 1-based in LLM I/O
  message: string
  fix?: string
  severity?: 'error' | 'warning' | 'info' | 'suggestion'
}

RuntimeManifest {         // Defined in providers/registry.ts
  id: RuntimeId
  displayName: string
  executable: string
  promptTransport: 'argv' | 'stdin'
  outputFormat: 'text' | 'json' | 'ndjson'
  capabilities: {
    supportsModelOverride: boolean
    supportsStreaming: boolean
    supportsToolCalling: boolean
  }
}
```

---

## Configuration

All settings under `reviewmp.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `reviewmp.runtime` | `opencode` | Runtime ID: `claude`, `copilot`, `codex`, `gemini`, `hermes`, `pi`, `opencode` |
| `reviewmp.model` | (empty) | Model override (runtime-specific) |
| `reviewmp.autoReviewOnStage` | `false` | Auto-review when files are staged |
| `reviewmp.autoReviewOnCommit` | `false` | Auto-review on commit |
| `reviewmp.debug` | `false` | Enable debug logging |
| `reviewmp.<runtime>Executable` | (runtime default) | Override runtime executable path |
| `reviewmp.<runtime>ExtraArgs` | (none) | Additional arguments for runtime |
