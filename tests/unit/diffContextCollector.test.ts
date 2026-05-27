import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffContextCollector, DiffResult } from '../../src/harness/diffContextCollector';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
  },
  window: {
    showInputBox: vi.fn(),
  },
}));

const mockSpawn = vi.hoisted(() => {
  const mockProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
  return vi.fn(() => mockProc);
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

const createMockProc = (stdout: string, code: number = 0) => {
  const mockProc = {
    stdout: { on: vi.fn((event, cb) => { if (event === 'data') cb(stdout); }) },
    stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb(''); }) },
    on: vi.fn((event, cb) => {
      if (event === 'close') cb(code);
      if (event === 'error') cb(new Error('spawn error'));
    }),
    kill: vi.fn(),
  };
  return mockProc;
};

describe('DiffContextCollector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDiff - staged', () => {
    it('should return formatted diff for staged changes', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.diff).toBe(diffOutput);
      expect(result.formattedDiff).toContain('2: added line');
      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff --cached'],
        expect.objectContaining({ cwd: '/test/workspace' })
      );
    });
  });

  describe('getDiff - uncommitted', () => {
    it('should return formatted diff for uncommitted changes', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,3 @@
 line1
+new line`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('uncommitted');

      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff'],
        expect.any(Object)
      );
      expect(result.formattedDiff).toContain('2: new line');
    });
  });

  describe('getDiff - lastCommit', () => {
    it('should return formatted diff for last commit changes', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 @@
-old line
+new line`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('lastCommit');

      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff HEAD~1 HEAD'],
        expect.any(Object)
      );
    });
  });

  describe('getDiff - branch', () => {
    it('should detect base branch and return formatted diff', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,3 @@
 line1
+branch only line`;

      mockSpawn
        .mockReturnValueOnce(createMockProc('main', 0))
        .mockReturnValueOnce(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'main'],
        expect.any(Object)
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff main...HEAD'],
        expect.any(Object)
      );
      expect(result.formattedDiff).toContain('2: branch only line');
    });
  });

  describe('formatDiffWithLineNumbers', () => {
    it('should preserve diff headers', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-old
+new`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).toContain('diff --git a/test.ts b/test.ts');
      expect(result.formattedDiff).toContain('--- a/test.ts');
      expect(result.formattedDiff).toContain('+++ b/test.ts');
    });

    it('should extract and preserve hunk headers', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -10,5 +15,7 @@ some context`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).toContain('@@ -10,5 +15,7 @@ some context');
    });

    it('should number added lines within hunks', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).toContain('2: added line');
    });

    it('should skip removed lines', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
-deleted line
 line1
 line2`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).not.toContain('deleted line');
    });

    it('should increment line numbers for context lines', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,4 +1,5 @@
 context1
+added
 context2`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).toContain('2: added');
    });

    it('should handle multiple hunks', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,3 @@
 line1
+first hunk added
@@ -10,2 +11,3 @@
 line10
+second hunk added`;

      mockSpawn.mockReturnValue(createMockProc(diffOutput));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.formattedDiff).toContain('2: first hunk added');
      expect(result.formattedDiff).toContain('12: second hunk added');
    });
  });

  describe('detectBaseBranch', () => {
    it('should return main when it exists', async () => {
      mockSpawn.mockReturnValueOnce(createMockProc('main', 0));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'main'],
        expect.any(Object)
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff main...HEAD'],
        expect.any(Object)
      );
    });

    it('should fallback to origin/main when main does not exist', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('origin/main', 0));

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'main'],
        expect.any(Object)
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'origin/main'],
        expect.any(Object)
      );
    });

    it('should fallback to master when main and origin/main do not exist', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('master', 0));

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'main'],
        expect.any(Object)
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'origin/main'],
        expect.any(Object)
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'master'],
        expect.any(Object)
      );
    });

    it('should fallback to origin/master when master does not exist', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('origin/master', 0));

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', '--verify', 'origin/master'],
        expect.any(Object)
      );
    });

    it('should fallback to symbolic-ref when other branches do not exist', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('refs/remotes/origin/develop', 0));

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['symbolic-ref', 'refs/remotes/origin/HEAD'],
        expect.any(Object)
      );
    });

    it('should prompt user when no branch detected via symbolic-ref', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128));

      const { window } = await vi.importMock('vscode');
      window.showInputBox.mockResolvedValue('develop');

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Could not detect base branch. Please enter the base branch name:',
        placeHolder: 'main',
        value: 'main',
      });
    });

    it('should return user input as branch name', async () => {
      mockSpawn
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128))
        .mockReturnValueOnce(createMockProc('', 128));

      const { window } = await vi.importMock('vscode');
      window.showInputBox.mockResolvedValue('feature-branch');

      const collector = new DiffContextCollector();
      await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'bash',
        ['-c', 'git diff feature-branch...HEAD'],
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('should reject when git command fails', async () => {
      mockSpawn.mockReturnValue({
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb('fatal: not a git repository'); }) },
        on: vi.fn((event, cb) => { if (event === 'close') cb(128); }),
        kill: vi.fn(),
      });

      const collector = new DiffContextCollector();
      await expect(collector.getDiff('staged')).rejects.toThrow('git exited with code 128');
    });

    it('should handle empty diff output', async () => {
      mockSpawn.mockReturnValue(createMockProc(''));

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('staged');

      expect(result.diff).toBe('');
      expect(result.formattedDiff).toBe('');
    });
  });
});
