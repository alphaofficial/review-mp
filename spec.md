# ReviewMP Sidebar + Inline Review UX PRD

## 1. Summary

ReviewMP should evolve from "inline comments after a command" into a full VS Code review experience with two synchronized surfaces:

- a dedicated Activity Bar sidebar for review state, changed files, grouped findings, and previous reviews
- inline editor comments and highlights for findings anchored to exact code locations

The target interaction model is similar to CodeRabbit's VS Code extension: developers start and monitor reviews from a sidebar, scan findings grouped by file, click a finding to jump to the relevant code, and act on the same finding from either the sidebar or inline comment.

ReviewMP does not need chat. ReviewMP should stay a review tool, not a coding-agent chat product.

## 2. Problem

ReviewMP currently places comments inline, but it lacks a central review surface.

This creates several UX problems:

- Users cannot easily see all findings across files.
- Users cannot scan review progress by file or stage.
- Users cannot navigate from a review summary to the exact inline comment.
- Dismissing or applying a fix is local to the inline thread and not reflected in a larger review session UI.
- Review state disappears into notifications and scattered editor comments.

The existing inline comments are useful, but they need a sidebar navigator and shared state model.

## 3. Goals

### 3.1 Product Goals

- Provide a CodeRabbit-style review sidebar inside VS Code.
- Preserve and improve inline comments anchored to code lines.
- Make sidebar items and inline comments represent the same underlying finding.
- Allow users to start reviews, monitor review progress, browse findings, and jump to comments from one place.
- Keep review actions simple: open, apply fix, dismiss, clear review.

### 3.2 Engineering Goals

- Introduce a shared review session state model.
- Render sidebar, inline comments, and editor decorations from the same state.
- Keep review execution runtime-agnostic.
- Avoid adding chat or agent conversation UI.
- Use native VS Code UI primitives first: Activity Bar, Tree View, CommentController, commands, and editor decorations.

## 4. Non-Goals

- Building a chat panel.
- Building an autonomous code editing agent.
- Replacing VS Code inline comments with a fully custom webview.
- Cloning CodeRabbit branding, icons, copy, or visual identity.
- Implementing account login or SaaS/self-hosted onboarding in this phase.
- Managing cloud review history across machines.

## 5. Target UX

ReviewMP should have a dedicated Activity Bar icon. Opening it shows a ReviewMP sidebar.

The sidebar should include these sections:

- `NEW REVIEW`
- `FILES TO REVIEW`
- `REVIEWS`
- `PREVIOUS REVIEWS`

The editor should continue to show inline comments for review findings. Clicking a sidebar finding should open the file, reveal the line, highlight the relevant range, and expose the inline comment context.

## 6. Sidebar Structure

### 6.1 NEW REVIEW

Purpose: start a review and show current review scope.

Content:

- current branch label
- optional compare/base branch label when reviewing branch or PR-style diffs
- primary command item: `Review all changes`
- dropdown or secondary commands for:
  - `Review staged changes`
  - `Review uncommitted changes`
  - `Review current file`
  - `Review selection`
  - `Review last commit`
  - `Review branch changes`

Implementation:

- Use command-backed tree items.
- The primary action should call existing ReviewMP commands.
- The tree must not block existing Command Palette flows.

### 6.2 FILES TO REVIEW

Purpose: show changed/reviewable files before or during a review.

Content:

- file rows with VS Code file icons
- file path or compact relative path
- optional status marker:
  - staged
  - modified
  - added
  - deleted
- optional checkbox state in a later phase

Behavior:

- Clicking a file opens it.
- During review, files can show a lightweight status:
  - pending
  - reviewing
  - reviewed

Initial implementation can populate this section from the same diff context already used by `ReviewOrchestrator`.

### 6.3 REVIEWS

Purpose: show current review progress and findings.

Top-level content:

- current review title
- current review status
- progress steps:
  - `Setting up`
  - `Analyzing changes`
  - `Reviewing files`
  - `Review completed`
  - `Review failed`
- total finding count

Findings content:

- findings grouped by file
- collapsible file groups
- file-level count badges
- finding rows with:
  - severity
  - short message
  - line number
  - fix availability marker

Severity labels:

- `Potential Issue`
- `Warning`
- `Suggestion`
- `Info`
- `Refactor Suggestion`

Mapping:

- `error` -> `Potential Issue`
- `warning` -> `Warning`
- `suggestion` -> `Refactor Suggestion`
- `info` -> `Info`

Behavior:

- Clicking a finding opens the file at the finding line.
- The matching inline comment should be revealed if possible.
- The editor should briefly highlight the finding range or line.
- Context menu actions:
  - `Open Finding`
  - `Apply Fix`
  - `Dismiss`
  - `Copy Message`

### 6.4 PREVIOUS REVIEWS

Purpose: make recent local review sessions accessible.

Initial scope:

- in-memory history for the current VS Code session
- each previous review shows:
  - review type
  - timestamp
  - finding count
  - status

Later scope:

- persist limited history in `ExtensionContext.workspaceState`
- allow reopening previous review findings
- allow clearing history

## 7. Inline Comments

Inline comments remain a first-class part of the UX.

ReviewMP should continue using `vscode.CommentController` for line-anchored comments.

Inline comment body should be improved:

- concise finding message
- severity label
- optional fix preview
- optional file/line metadata only when useful

Inline comment actions:

- `Apply Fix`
- `Dismiss`
- `Open in Review Panel`

Rules:

- Inline comments and sidebar findings must share the same finding ID.
- Dismissing a comment inline removes or marks the matching sidebar item.
- Dismissing a sidebar finding disposes the matching inline thread.
- Applying a fix from either surface updates both surfaces.

## 8. Editor Decorations

ReviewMP should add lightweight editor decorations for selected findings.

Decoration behavior:

- When a sidebar finding is selected, highlight its line or range in the editor.
- Clear the previous selection highlight when another finding is selected.
- Use severity-specific border or gutter styling.

Decoration requirements:

- Must respect the active VS Code theme.
- Must not obscure text.
- Must not duplicate the inline comment UI.

Initial decoration types:

- selected finding highlight
- error gutter marker
- warning/suggestion gutter marker

## 9. Shared State Model

Introduce a `ReviewSessionStore`.

The store owns review state and emits changes to UI surfaces.

### 9.1 Core Types

```ts
export type ReviewStatus =
  | 'idle'
  | 'settingUp'
  | 'analyzing'
  | 'reviewing'
  | 'completed'
  | 'failed';

export interface ReviewSession {
  id: string;
  title: string;
  type: ReviewType;
  status: ReviewStatus;
  startedAt: number;
  completedAt?: number;
  runtimeId?: string;
  files: ReviewFile[];
  findings: ReviewFinding[];
  error?: string;
}

export interface ReviewFile {
  uri: vscode.Uri;
  relativePath: string;
  status: 'pending' | 'reviewing' | 'reviewed' | 'failed';
  findingCount: number;
}

export interface ReviewFinding {
  id: string;
  file: string;
  uri: vscode.Uri;
  line: number;
  range?: vscode.Range;
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  message: string;
  fix?: string;
  state: 'open' | 'dismissed' | 'fixed';
}
```

### 9.2 Store Responsibilities

- create review sessions
- update review status
- set files to review
- add findings
- update finding state
- clear active review
- keep recent review history
- expose change events for sidebar, comments, and decorations

## 10. Architecture

Target architecture:

```text
VS Code command
  -> ReviewOrchestrator
  -> ReviewHarness / RuntimeAdapter
  -> ReviewSessionStore
     -> ReviewTreeProvider
     -> ReviewCommentController
     -> ReviewDecorationController
```

### 10.1 ReviewOrchestrator

Changes:

- create/update review sessions when reviews start
- set progress states in `ReviewSessionStore`
- publish final findings to the store
- stop directly treating comments as the only review output

### 10.2 ReviewCommentController

Changes:

- render inline comments from `ReviewFinding[]`
- track finding IDs instead of only weakly mapping comments to data
- expose methods:
  - `renderFindings(session: ReviewSession): void`
  - `revealFinding(findingId: string): Promise<void>`
  - `dismissFinding(findingId: string): void`

### 10.3 ReviewTreeProvider

New native Tree View provider.

Responsibilities:

- render the sidebar sections
- render review progress
- render files and findings
- invoke commands for review actions
- refresh on store changes

### 10.4 ReviewDecorationController

New controller for selected finding highlights.

Responsibilities:

- apply highlight decorations
- clear stale decorations
- reveal selected finding locations

## 11. VS Code Contributions

`package.json` should add:

- Activity Bar view container
- Tree views
- commands
- menu contributions for tree items

Example contribution shape:

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "reviewmp",
          "title": "ReviewMP",
          "icon": "resources/reviewmp.svg"
        }
      ]
    },
    "views": {
      "reviewmp": [
        {
          "id": "reviewmp.reviews",
          "name": "Reviews"
        }
      ]
    }
  }
}
```

Commands:

- `reviewmp.reviewAllChanges`
- `reviewmp.openFinding`
- `reviewmp.applyFindingFix`
- `reviewmp.dismissFinding`
- `reviewmp.clearActiveReview`
- `reviewmp.openReviewPanel`

Existing commands should remain supported.

## 12. Interaction Flows

### 12.1 Start Review from Sidebar

1. User opens ReviewMP sidebar.
2. User clicks `Review all changes`.
3. Store creates an active review session.
4. Sidebar shows progress states.
5. ReviewMP runs existing review pipeline.
6. Store receives findings.
7. Sidebar renders findings grouped by file.
8. Inline comments appear in the editor.

### 12.2 Navigate to Finding

1. User clicks a finding in the sidebar.
2. ReviewMP opens the file.
3. ReviewMP scrolls to the finding line.
4. ReviewMP highlights the finding range.
5. Matching inline comment is visible at that line.

### 12.3 Apply Fix

1. User clicks `Apply Fix` in sidebar or inline comment.
2. ReviewMP applies the fix using existing `FixApplicator`.
3. Store marks finding as `fixed`.
4. Inline comment is disposed or marked resolved.
5. Sidebar updates the finding state and file count.

### 12.4 Dismiss Finding

1. User clicks `Dismiss`.
2. Store marks finding as `dismissed`.
3. Inline comment is disposed.
4. Sidebar hides or visually marks the finding, depending on filter settings.

## 13. Visual Design Direction

Use native VS Code styling, not a custom branded design system.

Sidebar:

- compact tree layout
- file icons from VS Code theme
- severity labels in concise text
- count badges in descriptions or labels
- collapsible groups
- minimal custom icons

Inline comments:

- compact Markdown
- no large code blocks unless a fix exists
- fix preview should be short and readable

Decorations:

- theme-aware
- subtle line/range highlight
- severity gutter cue

## 14. Phased Delivery

### Phase 1: Shared State + Sidebar Skeleton

- Add `ReviewSessionStore`.
- Add Activity Bar container.
- Add `ReviewTreeProvider`.
- Render static sections.
- Wire existing review commands into sidebar actions.

### Phase 2: Findings Tree

- Publish review findings into the store.
- Group findings by file.
- Render counts and severity labels.
- Add `openFinding` command.

### Phase 3: Inline Synchronization

- Add stable finding IDs.
- Render inline comments from store findings.
- Keep dismiss/apply state synchronized across sidebar and inline comments.

### Phase 4: Decorations

- Add selected finding highlight.
- Add severity gutter decoration.
- Clear decorations on dismiss/clear review.

### Phase 5: Previous Reviews

- Store recent local sessions.
- Render previous reviews section.
- Support reopening previous review results.

## 15. Acceptance Criteria

- ReviewMP has a dedicated Activity Bar icon and sidebar.
- Users can start a review from the sidebar.
- Sidebar shows changed files before or during review.
- Sidebar shows review progress states.
- Review findings are grouped by file.
- File groups show finding counts.
- Finding rows show severity and short message.
- Clicking a finding opens the file at the correct line.
- Inline comments still appear for findings.
- Applying or dismissing a finding updates both sidebar and inline comments.
- No chat UI is added.
- Existing Command Palette review commands continue to work.
- Existing runtime adapter architecture remains provider-neutral.

## 16. Open Questions

- Should dismissed findings be hidden by default or shown with a resolved state?
- Should previous reviews persist across VS Code restarts in the first release?
- Should `FILES TO REVIEW` support selecting a subset of files in the first release?
- Should `Apply all fixes` be included, or deferred until single-fix synchronization is stable?
- Should review history be workspace-scoped only, or global per repository?
