import { describe, expect, it } from 'vitest';
import { extractCodeStructure } from '../../src/harness/codeStructure';

describe('extractCodeStructure', () => {
  it('uses ts-morph for TypeScript declarations and imports', () => {
    const structure = extractCodeStructure('typescript', `
import { helper } from './helper';

export type Props = {
  helper: typeof helper;
};

export function buildValue(props: Props) {
  return helper(props);
}
`, 'src/example.ts');

    expect(structure.parser).toBe('ts-morph');
    expect(structure.imports).toContainEqual({ path: './helper', symbols: ['helper'] });
    expect(structure.blocks.map((block) => block.name)).toEqual(expect.arrayContaining(['Props', 'buildValue']));
    expect(structure.relationships.some((relationship) => relationship.kind === 'imports' && relationship.targetPath === './helper')).toBe(true);
  });

  it('uses Tree-sitter for non-TypeScript languages', () => {
    const structure = extractCodeStructure('python', `
from .helper import build_value

class Service:
    def run(self):
        return build_value()
`, 'service.py');

    expect(structure.parser).toBe('tree-sitter');
    expect(structure.imports).toContainEqual({ path: './helper', symbols: expect.arrayContaining(['helper', 'build_value']) });
    expect(structure.blocks.some((block) => block.name === 'Service' && block.kind === 'class')).toBe(true);
  });

  it('loads the C# Tree-sitter grammar through the native binding', () => {
    const structure = extractCodeStructure('csharp', `
namespace Demo;

public class Service
{
    public string Run() => "ok";
}
`, 'Service.cs');

    expect(structure.parser).toBe('tree-sitter');
    expect(structure.blocks.some((block) => block.name === 'Service' && block.kind === 'class')).toBe(true);
  });

  it('does not invent structure for unsupported languages', () => {
    const structure = extractCodeStructure('plaintext', `
function fakeParserTarget() {
  return true;
}
`, 'notes.txt');

    expect(structure.parser).toBe('none');
    expect(structure.blocks).toEqual([]);
    expect(structure.imports).toEqual([]);
    expect(structure.relationships).toEqual([]);
  });
});
