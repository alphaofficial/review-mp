import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffContextCollector, DiffResult } from '../../src/harness/diffContextCollector';

vi.mock('../../src/settings', () => ({
  logDebug: vi.fn(),
}));

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
        'git',
        ['diff', '--cached'],
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
        'git',
        ['diff'],
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
        'git',
        ['diff', 'HEAD~1', 'HEAD'],
        expect.any(Object)
      );
    });
  });

  describe('getDiff - branch', () => {
    it('should diff from the newest resolved branch fork point', async () => {
      const diffOutput = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,3 @@
 line1
+branch only line`;
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        const serialized = `${command} ${args.join(' ')}`;
        switch (serialized) {
          case 'git rev-parse --abbrev-ref HEAD':
            return createMockProc('feature/current');
          case 'git rev-parse HEAD':
            return createMockProc('head-sha');
          case 'git symbolic-ref refs/remotes/origin/HEAD':
            return createMockProc('refs/remotes/origin/main');
          case 'git for-each-ref --format=%(refname:short) refs/heads refs/remotes':
            return createMockProc(['feature/current', 'origin/feature/current', 'origin/main', 'origin/release/mobile'].join('\n'));
          case 'git merge-base --fork-point origin/main HEAD':
            return createMockProc('main-base-sha');
          case 'git show -s --format=%ct main-base-sha':
            return createMockProc('100');
          case 'git merge-base --fork-point origin/release/mobile HEAD':
            return createMockProc('release-base-sha');
          case 'git show -s --format=%ct release-base-sha':
            return createMockProc('200');
          case 'git diff release-base-sha head-sha':
            return createMockProc(diffOutput);
          default:
            return createMockProc('', 128);
        }
      });

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('branch');

      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['diff', 'release-base-sha', 'head-sha'],
        expect.any(Object)
      );
      expect(result.baseRef).toBe('origin/release/mobile');
      expect(result.baseSha).toBe('release-base-sha');
      expect(result.headSha).toBe('head-sha');
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

  describe('resolveBranchBase', () => {
    it('should fallback to merge-base when fork-point is unavailable', async () => {
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        const serialized = `${command} ${args.join(' ')}`;
        switch (serialized) {
          case 'git rev-parse --abbrev-ref HEAD':
            return createMockProc('feature/current');
          case 'git rev-parse HEAD':
            return createMockProc('head-sha');
          case 'git symbolic-ref refs/remotes/origin/HEAD':
            return createMockProc('refs/remotes/origin/main');
          case 'git for-each-ref --format=%(refname:short) refs/heads refs/remotes':
            return createMockProc(['feature/current', 'origin/feature/current', 'origin/main'].join('\n'));
          case 'git merge-base --fork-point origin/main HEAD':
            return createMockProc('', 128);
          case 'git merge-base origin/main HEAD':
            return createMockProc('main-base-sha');
          case 'git show -s --format=%ct main-base-sha':
            return createMockProc('100');
          case 'git diff main-base-sha head-sha':
            return createMockProc('');
          default:
            return createMockProc('', 128);
        }
      });

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('branch');

      expect(result.baseRef).toBe('origin/main');
      expect(result.baseSha).toBe('main-base-sha');
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['merge-base', 'origin/main', 'HEAD'],
        expect.any(Object)
      );
    });

    it('should prompt when no automatic branch base can be resolved', async () => {
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        const serialized = `${command} ${args.join(' ')}`;
        switch (serialized) {
          case 'git rev-parse --abbrev-ref HEAD':
            return createMockProc('feature/current');
          case 'git rev-parse HEAD':
            return createMockProc('head-sha');
          case 'git symbolic-ref refs/remotes/origin/HEAD':
            return createMockProc('', 128);
          case 'git for-each-ref --format=%(refname:short) refs/heads refs/remotes':
            return createMockProc(['feature/current', 'origin/feature/current'].join('\n'));
          case 'git merge-base --fork-point release/mobile HEAD':
            return createMockProc('', 128);
          case 'git merge-base release/mobile HEAD':
            return createMockProc('release-base-sha');
          case 'git diff release-base-sha head-sha':
            return createMockProc('');
          default:
            return createMockProc('', 128);
        }
      });

      const { window } = await vi.importMock('vscode');
      window.showInputBox.mockResolvedValue('release/mobile');

      const collector = new DiffContextCollector();
      const result = await collector.getDiff('branch');

      expect(window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Could not determine the branch base. Please enter the base branch name:',
        placeHolder: 'main',
        value: 'main',
      });
      expect(result.baseRef).toBe('release/mobile');
      expect(result.baseSha).toBe('release-base-sha');
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['diff', 'release-base-sha', 'head-sha'],
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
      await expect(collector.getDiff('staged')).rejects.toThrow('fatal: not a git repository');
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
