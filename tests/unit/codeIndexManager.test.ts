import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../../src/settings', () => ({
  getSettings: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('../../src/services/code-index/service-factory', () => ({
  CodeIndexServiceFactory: {
    createOrchestrator: vi.fn().mockResolvedValue({ start: mocks.start, dispose: mocks.dispose }),
  },
}));

import { getSettings } from '../../src/settings';
import { CodeIndexManager } from '../../src/services/code-index/manager';

describe('CodeIndexManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not eagerly start indexing when code indexing is disabled', async () => {
    (getSettings as any).mockReturnValue({ codeIndexEnabled: false });
    const manager = new CodeIndexManager();

    await manager.activateWorkspace('/repo');

    expect(mocks.start).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('starts indexing when code indexing is enabled', async () => {
    (getSettings as any).mockReturnValue({ codeIndexEnabled: true });
    const manager = new CodeIndexManager();

    await manager.activateWorkspace('/repo');

    expect(mocks.start).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});
