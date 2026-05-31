import { buildService } from './service';

describe('buildService', () => {
  it('returns helper output', () => {
    expect(buildService()).toBe('ok');
  });
});
