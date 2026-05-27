# ReviewMP Provider-Agnostic Review Harness Spec

## 1. Summary

ReviewMP should be a code review harness, not a provider product.

Its job is to:

- collect review context
- run a bounded review loop
- enforce safe read-only tools
- parse and validate review findings
- place inline comments in VS Code

Its job is not to own model hosting, auth flows, or provider-specific review behavior.

ReviewMP should support the same runtime surface used by `alphaofficial/ralph-loop`:

- `claude`
- `copilot`
- `codex`
- `gemini`
- `hermes`
- `pi`
- `opencode`

These are the supported review backends. The harness must stay agnostic to which one is selected.

## 2. Core Product Decision

ReviewMP will standardize on a single harness-owned review workflow and treat external AI runtimes as interchangeable execution adapters.

That means:

- prompts, tool rules, parsing, retries, diff handling, and comment validation live in ReviewMP
- auth, account selection, installed binaries, and provider-specific model routing stay with the external runtime
- ReviewMP must not branch into different review behavior because the selected backend is `claude` vs `codex` vs `hermes`

The only backend-specific code allowed is adapter code required to invoke the runtime and normalize its output.

## 3. Goals

### 3.1 Product Goals

- make ReviewMP usable with the runtime backends developers already use
- remove product dependence on OpenCode-specific review behavior
- keep review quality and safety consistent across all supported runtimes
- make provider choice a configuration detail, not an architectural fork

### 3.2 Engineering Goals

- replace hardcoded provider classes and `switch`-based selection with a registry-driven adapter system
- keep the review harness provider-neutral
- make adding a new runtime mostly a manifest/adapter task, not a harness rewrite
- minimize provider-specific settings in `package.json`

## 4. Non-Goals

- implementing direct vendor SDK integrations in the first pass
- managing API keys for every upstream provider inside ReviewMP
- supporting arbitrary custom CLIs as a first-class architecture primitive
- allowing model-requested shell execution or file mutation during review
- making ReviewMP a general-purpose coding agent

## 5. Supported Runtime Backends

Initial built-in support targets the same backends documented by `ralph-loop`.

| Runtime ID | Primary executable | Notes |
|---|---|---|
| `claude` | `claude` | Uses the user's existing Claude Code install and auth |
| `copilot` | `copilot` | Uses the user's existing GitHub Copilot CLI install and auth |
| `codex` | `codex` | Uses the user's existing Codex install and auth |
| `gemini` | `gemini` | Uses the user's existing Gemini CLI install and auth |
| `hermes` | `hermes` | Runtime may route to different providers internally |
| `pi` | `pi` | Runtime may route to different providers internally |
| `opencode` | `opencode` | Backward-compatibility path for current users |

ReviewMP does not install these tools. It only discovers and invokes them.

## 6. Architecture

### 6.1 High-Level Flow

```text
VS Code command
  -> ReviewOrchestrator
  -> ReviewHarness
     -> ContextCollector
     -> ToolExecutor
     -> RuntimeRegistry
     -> RuntimeAdapter
     -> OutputParser
     -> CommentValidator
  -> CommentController
```

### 6.2 Harness-Owned Responsibilities

The following logic must be identical regardless of selected runtime:

- file, selection, staged, uncommitted, last-commit, branch, and PR review flows
- prompt construction
- diff formatting and chunking
- read-only tool execution
- retry and bounded loop behavior
- output normalization
- comment validation and deduplication
- VS Code comment placement and fix application

### 6.3 Runtime-Owned Responsibilities

The selected runtime owns:

- authentication
- account/session state
- model availability
- provider routing inside the runtime
- runtime-specific CLI semantics

## 7. Runtime Adapter Model

The provider layer should be renamed conceptually from "provider" to "runtime adapter".

ReviewMP should use one generic CLI adapter path wherever possible, configured by runtime manifests.

### 7.1 Manifest Shape

```ts
export interface RuntimeManifest {
  id: RuntimeId;
  displayName: string;
  executable: string;
  executableOverrideSetting?: string;
  availabilityCheck: 'path';
  invocationMode: 'oneshot';
  promptTransport: 'argv' | 'stdin';
  outputFormat: 'text' | 'json' | 'ndjson';
  modelOverride?: {
    type: 'flag' | 'env' | 'unsupported';
    name?: string;
  };
  extraArgsSetting?: string;
  capabilities: {
    supportsModelOverride: boolean;
    supportsStreaming: boolean;
    supportsToolCalling: boolean;
  };
}
```

### 7.2 Adapter Interface

```ts
export interface RuntimeAdapter {
  readonly manifest: RuntimeManifest;
  isAvailable(): Promise<boolean>;
  review(request: RuntimeReviewRequest, token?: CancellationToken): Promise<RuntimeReviewResult>;
  cancel(): void;
}
```

### 7.3 Design Rule

ReviewMP must not create a custom harness code path per runtime unless a runtime cannot be represented by the shared adapter contract.

Default expectation:

- one registry
- one generic CLI runtime adapter
- per-runtime manifests
- per-runtime output normalizers only where needed

## 8. Configuration Model

### 8.1 Required Settings

ReviewMP should move from provider-specific configuration to runtime-oriented configuration.

```json
{
  "reviewmp.runtime": "codex",
  "reviewmp.model": "gpt-5.4",
  "reviewmp.debug": false
}
```

### 8.2 Settings Direction

Keep the settings surface small:

- `reviewmp.runtime`
- `reviewmp.model`
- `reviewmp.debug`
- `reviewmp.autoReviewOnStage`
- `reviewmp.autoReviewOnCommit`
- optional runtime executable overrides
- optional runtime extra args

Avoid first-class settings like:

- `reviewmp.openaiCompatibleEndpoint`
- `reviewmp.customCliCommand`
- per-provider API key fields

Those pull ReviewMP back toward provider-specific architecture.

### 8.3 Model Override Semantics

`reviewmp.model` is best-effort pass-through.

- if the selected runtime supports model override, ReviewMP passes it through
- if it does not, ReviewMP warns clearly and proceeds with the runtime default

The harness must not encode provider-specific model catalogs.

## 9. Review Execution Contract

Each runtime adapter must support a non-interactive review invocation that:

1. receives a single harness-built review prompt
2. returns structured findings directly or returns text that the harness can parse deterministically
3. exits with a meaningful status code
4. can be cancelled by ReviewMP

The harness prompt must define the response schema. ReviewMP should not rely on each runtime having native tool-calling or native structured-output features.

## 10. Output Normalization

Because the supported runtimes do not share one transport protocol, ReviewMP should normalize output into one internal result shape:

```ts
export interface NormalizedReviewResult {
  comments: ReviewComment[];
  rawText: string;
  usage?: ModelUsage;
  metadata?: Record<string, unknown>;
}
```

Allowed raw runtime formats:

- plain text containing JSON
- JSON
- NDJSON

Normalization rules:

- parser behavior must be runtime-agnostic after the adapter hands off output
- line numbers must be converted into ReviewMP's internal format
- invalid findings are dropped with debug logs
- runtime-specific parsing hacks must stay isolated to the adapter or parser normalization layer

## 11. Migration from Current Architecture

### 11.1 What Changes

Replace:

- `providerNames = ['opencode', 'custom-cli', 'openai-compatible']`
- `buildProvider()` hardcoded `switch`
- provider-specific settings for HTTP endpoint and arbitrary CLI command
- provider classes that each rebuild the same prompt/review flow

With:

- `runtimeIds = ['claude', 'copilot', 'codex', 'gemini', 'hermes', 'pi', 'opencode']`
- a runtime registry loaded from built-in manifests
- a shared CLI runtime adapter
- a thin normalization layer for runtime-specific output quirks

### 11.2 Compatibility

`opencode` remains supported as one runtime adapter, but it loses its privileged role in the architecture.

ReviewMP should no longer be described as "OpenCode with extra steps." It should be described as a review harness that can run on top of any supported runtime.

## 12. Acceptance Criteria

The spec is satisfied when:

1. ReviewMP can run the same review flow with any supported runtime backend.
2. The harness code does not branch on runtime name for review behavior.
3. Adding a new runtime does not require editing orchestration or review-loop logic.
4. Provider auth and installation remain outside ReviewMP.
5. Existing OpenCode users still have a supported path.
6. The public docs describe ReviewMP as provider-agnostic and runtime-backed.

## 13. Explicit Out-of-Scope Backends

These are not part of the target architecture for this rewrite:

- generic `custom-cli` as an unbounded escape hatch
- direct `openai-compatible` HTTP integration as a first-class default path

They can be reconsidered later only if they fit the same runtime adapter contract without reintroducing provider-specific harness logic.

## 14. References

- Ralph Loop README: `https://github.com/alphaofficial/ralph-loop`
- Ralph Loop raw README used for backend list and setup model: `https://raw.githubusercontent.com/alphaofficial/ralph-loop/main/README.md`
