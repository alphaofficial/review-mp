import { describe, it, expect, vi } from 'vitest';
import { getSettings, setRuntime, logDebug, showDebugLogs, Settings } from '../../src/settings';
import { DEFAULT_RUNTIME_ID } from '../../src/providers/runtimeRegistry';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue: any) => defaultValue),
      update: vi.fn(),
    })),
  },
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3,
  },
  window: {
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
  },
  commands: {
    registerCommand: vi.fn(),
  },
}));

describe('Settings interface', () => {
  describe('runtime-based fields', () => {
    it('has runtime field of type RuntimeId', () => {
      const settings: Settings = {
        runtime: 'opencode',
        model: '',
        autoReviewOnStage: false,
        autoReviewOnCommit: false,
        executableOverride: '',
        extraArgs: '',
      };
      expect(settings.runtime).toBe('opencode');
    });

    it('has executableOverride as string', () => {
      const settings: Settings = {
        runtime: 'claude',
        model: '',
        autoReviewOnStage: false,
        autoReviewOnCommit: false,
        executableOverride: '/usr/local/bin/claude',
        extraArgs: '',
      };
      expect(settings.executableOverride).toBe('/usr/local/bin/claude');
    });

    it('has extraArgs as string', () => {
      const settings: Settings = {
        runtime: 'gemini',
        model: '',
        autoReviewOnStage: false,
        autoReviewOnCommit: false,
        executableOverride: '',
        extraArgs: '--verbose --debug',
      };
      expect(settings.extraArgs).toBe('--verbose --debug');
    });
  });

  describe('common fields', () => {
    it('has model field as string', () => {
      const settings: Settings = {
        runtime: 'claude',
        model: 'claude-3-5-sonnet',
        autoReviewOnStage: false,
        autoReviewOnCommit: false,
        executableOverride: '',
        extraArgs: '',
      };
      expect(settings.model).toBe('claude-3-5-sonnet');
    });

    it('has autoReviewOnStage as boolean', () => {
      const settings: Settings = {
        runtime: 'opencode',
        model: '',
        autoReviewOnStage: true,
        autoReviewOnCommit: false,
        executableOverride: '',
        extraArgs: '',
      };
      expect(settings.autoReviewOnStage).toBe(true);
    });

    it('has autoReviewOnCommit as boolean', () => {
      const settings: Settings = {
        runtime: 'opencode',
        model: '',
        autoReviewOnStage: false,
        autoReviewOnCommit: true,
        executableOverride: '',
        extraArgs: '',
      };
      expect(settings.autoReviewOnCommit).toBe(true);
    });
  });
});

describe('getSettings', () => {
  it('returns settings with default runtime opencode', () => {
    const settings = getSettings();
    expect(settings.runtime).toBe(DEFAULT_RUNTIME_ID);
  });

  it('returns settings with empty model by default', () => {
    const settings = getSettings();
    expect(settings.model).toBe('');
  });

  it('returns settings with autoReviewOnStage false by default', () => {
    const settings = getSettings();
    expect(settings.autoReviewOnStage).toBe(false);
  });

  it('returns settings with autoReviewOnCommit false by default', () => {
    const settings = getSettings();
    expect(settings.autoReviewOnCommit).toBe(false);
  });

  it('returns settings with empty executableOverride by default', () => {
    const settings = getSettings();
    expect(settings.executableOverride).toBe('');
  });

  it('returns settings with empty extraArgs by default', () => {
    const settings = getSettings();
    expect(settings.extraArgs).toBe('');
  });
});

describe('setRuntime', () => {
  it('is a function', () => {
    expect(typeof setRuntime).toBe('function');
  });

  it('accepts RuntimeId parameter', async () => {
    await expect(setRuntime('claude')).resolves.toBeUndefined();
    await expect(setRuntime('copilot')).resolves.toBeUndefined();
    await expect(setRuntime('codex')).resolves.toBeUndefined();
    await expect(setRuntime('gemini')).resolves.toBeUndefined();
    await expect(setRuntime('hermes')).resolves.toBeUndefined();
    await expect(setRuntime('pi')).resolves.toBeUndefined();
    await expect(setRuntime('opencode')).resolves.toBeUndefined();
  });
});

describe('logDebug', () => {
  it('does not throw when called', () => {
    expect(() => logDebug('test message')).not.toThrow();
  });

  it('does not throw with multiple arguments', () => {
    expect(() => logDebug('test', { key: 'value' }, [1, 2, 3])).not.toThrow();
  });
});

describe('showDebugLogs', () => {
  it('does not throw when called', () => {
    expect(() => showDebugLogs()).not.toThrow();
  });
});
