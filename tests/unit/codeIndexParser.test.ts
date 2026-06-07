import { describe, expect, it } from 'vitest';
import { MAX_BLOCK_CHARS, MIN_BLOCK_CHARS, parseCodeIndexBlocks } from '../../src/harness/codeIndexParser';

describe('parseCodeIndexBlocks', () => {
  it('extracts semantic TypeScript blocks including arrow functions', () => {
    const blocks = parseCodeIndexBlocks('typescript', `
export const buildValue = (input: string) => {
  const normalized = input.trim();
  return normalized.toUpperCase();
};

export function helperValue(input: string) {
  return buildValue(input);
}
`, 'src/example.ts');

    expect(blocks.some((block) => block.identifier === 'buildValue')).toBe(true);
    expect(blocks.some((block) => block.identifier === 'helperValue')).toBe(true);
  });

  it('splits oversized semantic blocks into Roo-sized chunks', () => {
    const largeBody = new Array(120)
      .fill('  const repeatedValue = "abcdefghijklmnopqrstuvwxyz0123456789";')
      .join('\n');

    const blocks = parseCodeIndexBlocks('typescript', `
export function largeExample() {
${largeBody}
  return repeatedValue;
}
`, 'src/large.ts');

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.content.length >= MIN_BLOCK_CHARS)).toBe(true);
    expect(blocks.every((block) => block.content.length <= MAX_BLOCK_CHARS * 1.15)).toBe(true);
  });

  it('produces deterministic segment hashes', () => {
    const source = `
export function stableChunk(value: string) {
  return value.trim().toUpperCase();
}
`;

    const first = parseCodeIndexBlocks('typescript', source, 'src/stable.ts');
    const second = parseCodeIndexBlocks('typescript', source, 'src/stable.ts');

    expect(first.map((block) => block.segmentHash)).toEqual(second.map((block) => block.segmentHash));
  });

  it('drops trivial blocks below the minimum size threshold', () => {
    const blocks = parseCodeIndexBlocks('typescript', 'const x = 1;\n', 'src/tiny.ts');

    expect(blocks).toEqual([]);
  });
});
