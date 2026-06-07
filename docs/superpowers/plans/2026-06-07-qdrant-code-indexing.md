# Qdrant Code Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LanceDB-based code indexing with Qdrant-backed vector storage and Ollama embeddings, configured through a CodeBunny setup UI.

**Architecture:** Keep `RepoKnowledgeIndex` as the main integration surface, but split persistence responsibilities internally. Qdrant stores vector-searchable records, while local JSON cache files store metadata, summaries, declarations, relationships, and exact review reuse records. The setup UI writes non-secret config to VS Code settings and the optional Qdrant API key to VS Code secret storage, and worker processes receive the resolved config through environment variables.

**Tech Stack:** TypeScript, VS Code extension APIs, Webview panel UI, Node `fetch`, Ollama HTTP API, Qdrant HTTP API, Vitest.

---

### Task 1: Configuration and secrets

**Files:**
- Modify: `src/settings.ts`
- Create: `src/services/code-index/config.ts`
- Test: `tests/unit/settings.test.ts`

- [ ] Add code index config fields for embedder provider, Ollama base URL, model, model dimension, and Qdrant URL.
- [ ] Add helpers to read and persist code index config values.
- [ ] Add a secret wrapper for the optional Qdrant API key.
- [ ] Extend settings tests for the new fields and defaults.

### Task 2: Setup UI and controller wiring

**Files:**
- Modify: `src/codeIndexPanel.ts`
- Modify: `src/codeIndexTreeProvider.ts`
- Modify: `src/services/code-index/controller.ts`
- Modify: `src/services/code-index/manager.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Test: `tests/unit/codeIndexController.test.ts`
- Test: `tests/unit/codeIndexTreeProvider.test.ts`
- Test: `tests/unit/extension.test.ts`

- [ ] Expand the code index panel into a setup UI for Ollama and Qdrant configuration.
- [ ] Add controller methods to load, save, and apply setup changes.
- [ ] Recreate the workspace orchestrator after config changes so the worker gets fresh connection settings.
- [ ] Add a command entry point so users can open the setup UI from CodeBunny.
- [ ] Update UI-facing tests for the new state and actions.

### Task 3: Ollama embedding client

**Files:**
- Replace: `src/harness/textEmbedding.ts`
- Test: `tests/unit/repoKnowledgeIndex.test.ts`

- [ ] Replace deterministic local embeddings with an async Ollama embed client.
- [ ] Validate configured model dimension against returned vectors and fail clearly on mismatches.
- [ ] Preserve a version string/fingerprint that includes provider and model config for rebuild compatibility.
- [ ] Add test coverage around embedding request and validation behavior with mocked `fetch`.

### Task 4: Qdrant vector storage and local metadata cache

**Files:**
- Modify: `src/harness/repoKnowledgeIndex.ts`
- Create: `src/harness/qdrantClient.ts`
- Create: `src/harness/localIndexStore.ts`
- Modify: `src/services/code-index/workerClient.ts`
- Modify: `src/services/code-index/workerProcess.ts`
- Modify: `src/services/code-index/service-factory.ts`
- Test: `tests/unit/repoKnowledgeIndex.test.ts`

- [ ] Remove LanceDB-specific connection, table, and vector index logic.
- [ ] Add Qdrant collection management, point upsert, filtered delete, and vector query support.
- [ ] Store code chunks and review memory in Qdrant payloads with stable point IDs.
- [ ] Store exact review reuse records, file summaries, repo summaries, declarations, relationships, and index metadata in local cache files.
- [ ] Update worker startup so it passes the resolved code index config into the child process.
- [ ] Keep the public `RepoKnowledgeIndex` API stable for the rest of the extension.

### Task 5: Documentation and verification

**Files:**
- Modify: `README.md`

- [ ] Update docs to describe the new Qdrant and Ollama setup flow.
- [ ] Remove LanceDB references from user-facing docs.
- [ ] Run targeted tests for settings, controller, panel, and index behavior.
- [ ] Run compile/typecheck to catch worker and webview regressions.
