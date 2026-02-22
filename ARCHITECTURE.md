# ReviewMP — Architecture

A VS Code extension that reviews code using [OpenCode](https://github.com/nichochar/opencode) as the LLM backend. It supports single-file review, diff-based review (staged/uncommitted/branch), and full PR review with a 2-pass clustered strategy.

---

## File-by-File Breakdown

### `src/extension.ts` — Entry Point & Command Registration

The VS Code extension activation point. Registers all commands and wires services together.

**Key responsibilities:**
- Creates `OpenCodeService`, `PRReviewService`, and `ReviewCommentController`
- Optionally creates a `GitWatcher` if auto-review settings are enabled
- Registers 8 commands: `reviewFile`, `reviewSelection`, `reviewStaged`, `reviewUncommitted`, `reviewLastCommit`, `reviewBranch`, `reviewPR`, `clearComments`
- Contains helper functions (`reviewDocument`, `reviewCode`, `reviewGitChanges`, `addDiffComments`, `placePRComments`) that orchestrate between services and the comment controller
- `placePRComments` checks if files exist locally; missing files get dumped to an Output channel instead of inline comments

### `src/opencode.ts` — OpenCode LLM Interface (File & Diff Reviews)

Handles spawning the `opencode` CLI and parsing its JSON output for single-file and diff reviews.

**Key responsibilities:**
- `reviewCode(code, languageId, filePath, token)` — Reviews a code snippet. Adds line numbers to the code, builds a prompt, spawns `opencode run --agent reviewmp --format json`, parses NDJSON output
- `reviewDiff(type, token)` — Reviews git diffs (staged/uncommitted/lastCommit/branch). Runs the appropriate `git diff` command, formats the diff with line numbers (only added lines get numbers), sends to OpenCode
- `applyFix(filePath, line, fix)` — Applies a suggested fix by sending a prompt to OpenCode (without `--agent reviewmp`)
- `detectBaseBranch(token)` — Tries main → origin/main → master → origin/master → symbolic-ref → user prompt
- Output parsing: Reads NDJSON stream, collects `type: "text"` events, extracts JSON array via regex, validates with `validateComments`/`validateDiffComments`

### `src/prReview.ts` — PR Review Service (2-Pass Clustered Review)

The most complex module. Handles full PR reviews with import-graph-based clustering and cross-file consistency checks.

**Key responsibilities:**
- `reviewPR(prNumber?, token)` — Main entry point. Resolves PR info (via `gh` CLI or auto-detect), gets the diff, splits by file, clusters by imports, runs pass 1 (per-cluster reviews in parallel), then pass 2 (cross-file consistency)
- Import graph construction from disk (`buildImportGraphFromDisk`) or from diff content (`buildImportGraphFromDiff`)
- BFS-based clustering (`clusterByImports`) — groups files that import each other, caps clusters at 10 files
- Three review strategies: `reviewSingleDiff` (small PRs ≤3 files, ≤500 lines), `reviewFileChunk` (single file), `reviewCluster` (related files together)
- `reviewCrossFile` — Pass 2: sends only diff headers + existing comments, asks for cross-boundary issues only
- Supports remote PR review (files not checked out locally) — detects if current branch ≠ PR branch

### `src/comments.ts` — VS Code Comment Controller

Manages the VS Code native comment UI (inline review comments with accept/reject actions).

**Key responsibilities:**
- `ReviewCommentController` — Creates a `vscode.CommentController`, manages comment threads per file
- `addComments(uri, comments, languageId)` — Clears existing comments for the file, creates threads with markdown bodies (including code blocks for fixes)
- `acceptFix(comment)` — Delegates to `OpenCodeService.applyFix()`, disposes thread on success
- `rejectComment(comment)` — Simply disposes the thread
- Uses `WeakMap<vscode.Comment, CommentData>` to associate VS Code comment objects with fix data
- Severity labels: Error, Warning, Info, Suggestion, Review

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
    → opencode.ts: reviewCode(code, lang, path)
      → spawns: opencode run --agent reviewmp --format json "<prompt>"
      → parses NDJSON → extracts JSON array → validates
    → comments.ts: addComments(uri, comments)
      → creates vscode.CommentThread per comment
```

### Diff Review (staged/uncommitted/branch/lastCommit)
```
User triggers command
  → extension.ts: reviewGitChanges(type)
    → opencode.ts: reviewDiff(type)
      → runs git diff (appropriate variant)
      → formats diff with line numbers
      → spawns opencode with formatted diff prompt
      → parses → validates (requires file field)
    → extension.ts: addDiffComments()
      → groups by file → comments.ts: addComments() per file
```

### PR Review (2-Pass Clustered)
```
User triggers reviewPR command
  → extension.ts: reviewPR handler
    → prReview.ts: reviewPR(prNumber?)
      1. Resolve PR info (gh pr view or auto-detect)
      2. Get diff: git diff base...head -U8
      3. Split diff by file → FileChunk[]
      4. Small PR? (≤3 files, ≤500 lines) → single review, done
      5. Build import graph (disk or diff-based)
      6. Cluster files by import connectivity (BFS)
      7. PASS 1: Review clusters in parallel (concurrency=4)
         - Single-file clusters → reviewFileChunk()
         - Multi-file clusters → reviewCluster()
      8. PASS 2: Cross-file consistency review
         - Sends file summaries + diff headers + existing comments
         - Asks for cross-boundary issues only
      9. Return all comments
    → extension.ts: placePRComments()
      → local files → inline comments
      → missing files → Output channel
```

### Fix Application
```
User clicks "Accept Fix" on a comment
  → comments.ts: acceptFix()
    → opencode.ts: applyFix(filePath, line, fix)
      → spawns: opencode run "<apply fix prompt>"
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

## Dependency Diagram

```
┌─────────────────────────────────────────────────┐
│                  extension.ts                    │
│  (activation, commands, orchestration)           │
├──────────┬──────────┬──────────┬────────────────┤
│          │          │          │                  │
│          ▼          ▼          ▼                  │
│   ┌────────────┐ ┌──────────┐ ┌──────────────┐  │
│   │ opencode.ts│ │prReview.ts│ │gitWatcher.ts │  │
│   │            │ │           │ │              │  │
│   │ File/diff  │ │ PR review │ │ Auto-review  │  │
│   │ review +   │ │ 2-pass    │ │ on stage/    │  │
│   │ fix apply  │ │ clustered │ │ commit       │  │
│   └─────┬──────┘ └─────┬─────┘ └──────┬───────┘  │
│         │              │               │          │
│         ▼              │               │          │
│   ┌────────────┐       │               │          │
│   │comments.ts │◄──────┘               │          │
│   │            │                       │          │
│   │ VS Code    │  extension.ts calls   │          │
│   │ Comment UI │  gitWatcher callbacks │          │
│   └────────────┘  which call opencode ◄┘          │
└─────────────────────────────────────────────────┘

External dependencies:
  • opencode CLI  — LLM inference (spawned as child process)
  • git CLI       — diff generation, branch detection
  • gh CLI        — PR metadata lookup (optional, graceful fallback)
  • vscode.git    — built-in Git extension API (for GitWatcher)
```

### Import Graph (TypeScript)

```
extension.ts
  ├── imports comments.ts    (ReviewCommentController, ReviewComment)
  ├── imports opencode.ts    (OpenCodeService)
  ├── imports prReview.ts    (PRReviewService)
  └── imports gitWatcher.ts  (GitWatcher)

opencode.ts
  └── imports comments.ts    (ReviewComment type)

prReview.ts
  └── imports comments.ts    (ReviewComment type)

comments.ts
  └── imports opencode.ts    (OpenCodeService — for applyFix)

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

FileChunk {               // Internal to prReview.ts
  file: string
  diff: string
}

PRInfo {                  // Internal to prReview.ts
  number: number
  baseBranch: string
  headBranch: string
  title: string
}

PRReviewResult {          // Exported from prReview.ts
  comments: ReviewComment[]
  isRemote: boolean
}
```

---

## Configuration

All settings under `reviewmp.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `opencodePath` | `opencode` | Path to the opencode binary |
| `model` | (empty) | LLM model override |
| `autoReviewOnStage` | `false` | Auto-review when files are staged |
| `autoReviewOnCommit` | `false` | Auto-review on commit |
