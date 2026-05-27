import { describe, it, expect } from 'vitest';
import { TextNormalizer, JsonNormalizer, NdJsonNormalizer, NormalizerFactory } from '../../src/providers/outputNormalizer';
import { OutputFormat } from '../../src/providers/runtimeRegistry';

describe('NormalizerFactory', () => {
  it('creates TextNormalizer for text format', () => {
    const normalizer = NormalizerFactory.create('text');
    expect(normalizer).toBeInstanceOf(TextNormalizer);
    expect(normalizer.format).toBe('text');
  });

  it('creates JsonNormalizer for json format', () => {
    const normalizer = NormalizerFactory.create('json');
    expect(normalizer).toBeInstanceOf(JsonNormalizer);
    expect(normalizer.format).toBe('json');
  });

  it('creates NdJsonNormalizer for ndjson format', () => {
    const normalizer = NormalizerFactory.create('ndjson');
    expect(normalizer).toBeInstanceOf(NdJsonNormalizer);
    expect(normalizer.format).toBe('ndjson');
  });
});

describe('TextNormalizer', () => {
  const normalizer = new TextNormalizer();

  it('normalizes valid JSON embedded in text', () => {
    const output = 'Some text before [{"line": 10, "message": "Test issue", "severity": "warning"}] some text after';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe('test.ts');
    expect(result.comments[0].line).toBe(9);
    expect(result.comments[0].message).toBe('Test issue');
  });

  it('returns empty comments for empty output', () => {
    const result = normalizer.normalize('', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
    expect(result.rawText).toBe('');
  });

  it('returns empty comments for whitespace-only output', () => {
    const result = normalizer.normalize('   \n\t  ', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('returns empty comments for plain text without JSON', () => {
    const result = normalizer.normalize('This is just plain text output', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
    expect(result.rawText).toBe('This is just plain text output');
  });

  it('handles invalid JSON gracefully', () => {
    const output = '[{invalid json}]';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.rawText).toBe(output);
  });

  it('normalizes diff review output with file paths', () => {
    const output = '[{"line": 5, "message": "Bug", "file": "test.ts"}]';
    const result = normalizer.normalize(output, {
      defaultFilePath: '',
      reviewType: 'staged',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe('test.ts');
  });
});

describe('JsonNormalizer', () => {
  const normalizer = new JsonNormalizer();

  it('normalizes valid JSON array', () => {
    const output = '[{"line": 10, "message": "Test issue", "severity": "warning"}]';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe('test.ts');
    expect(result.comments[0].line).toBe(9);
    expect(result.comments[0].message).toBe('Test issue');
  });

  it('normalizes JSON object with comments array', () => {
    const output = '{"type": "review_result", "comments": [{"line": 5, "message": "Error", "severity": "error"}]}';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(4);
  });

  it('returns empty comments for empty output', () => {
    const result = normalizer.normalize('', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('returns empty comments for whitespace-only output', () => {
    const result = normalizer.normalize('   \n\t  ', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('falls back to text parsing for invalid JSON', () => {
    const output = 'Not valid JSON at all';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', () => {
    const output = '[{"line": 1, "message": "Test"';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.rawText).toBe(output);
  });

  it('handles JSON with non-array root', () => {
    const output = '{"result": "ok"}';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('converts line numbers to zero-based', () => {
    const output = '[{"line": 1, "message": "First"}, {"line": 10, "message": "Tenth"}]';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments[0].line).toBe(0);
    expect(result.comments[1].line).toBe(9);
  });
});

describe('NdJsonNormalizer', () => {
  const normalizer = new NdJsonNormalizer();

  it('normalizes NDJSON with text events', () => {
    const output = '{"type": "text", "part": {"text": "[{\"line\": 10, \"message\": \"Test issue\"}]"}}\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(9);
  });

  it('normalizes NDJSON with embedded JSON array', () => {
    const output = '{"type": "text", "part": {"text": "[{\"line\": 5, \"message\": \"Bug\", \"file\": \"test.ts\"}]"}}\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: '',
      reviewType: 'staged',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe('test.ts');
  });

  it('returns empty comments for empty output', () => {
    const result = normalizer.normalize('', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('returns empty comments for whitespace-only output', () => {
    const result = normalizer.normalize('   \n\t  ', {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(0);
  });

  it('handles mixed valid and invalid NDJSON lines', () => {
    const output = 'not valid json\n{"type": "text", "part": {"text": "[{\"line\": 10, \"message\": \"Test\"}]"}}\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
  });

  it('handles empty NDJSON lines', () => {
    const output = '\n\n{"type": "text", "part": {"text": "[{\"line\": 5, \"message\": \"Test\"}]"}}\n\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
  });

  it('handles NDJSON with non-text events', () => {
    const output = '{"type": "other"}\n{"type": "text", "part": {"text": "[{\"line\": 3, \"message\": \"Found\"}]"}}\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(2);
  });

  it('converts line numbers to zero-based', () => {
    const output = '{"type": "text", "part": {"text": "[{\"line\": 1, \"message\": \"First\"}]"}}\n';
    const result = normalizer.normalize(output, {
      defaultFilePath: 'test.ts',
      reviewType: 'file',
    });

    expect(result.comments[0].line).toBe(0);
  });
});

describe('invalid output cases', () => {
  const formats: OutputFormat[] = ['text', 'json', 'ndjson'];

  formats.forEach((format) => {
    describe(`for ${format} format`, () => {
      const normalizer = NormalizerFactory.create(format);

      it('handles null-like output gracefully', () => {
        const result = normalizer.normalize('null', {
          defaultFilePath: 'test.ts',
          reviewType: 'file',
        });

        expect(result.rawText).toBe('null');
      });

      it('handles output with control characters', () => {
        const output = '[\x00\x01{"line": 1, "message": "Test"}]';
        const result = normalizer.normalize(output, {
          defaultFilePath: 'test.ts',
          reviewType: 'file',
        });

        expect(result.rawText).toBe(output);
      });

      it('handles very long output without crashing', () => {
        const longMessage = 'x'.repeat(10000);
        const output = `[{"line": 1, "message": "${longMessage}"}]`;
        const result = normalizer.normalize(output, {
          defaultFilePath: 'test.ts',
          reviewType: 'file',
        });

        expect(result.rawText).toBe(output);
        expect(result.comments[0].message.length).toBe(10000);
      });

      it('handles output with extremely deep nesting', () => {
        let deeplyNested = '{"line": 1, "message": "Test"}';
        for (let i = 0; i < 50; i++) {
          deeplyNested = `[${deeplyNested}]`;
        }
        const output = deeplyNested;
        const result = normalizer.normalize(output, {
          defaultFilePath: 'test.ts',
          reviewType: 'file',
        });

        expect(result.rawText).toBe(output);
      });
    });
  });
});
