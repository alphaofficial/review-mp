import { describe, it, expect } from 'vitest';
import {
  OutputParser,
  extractTextFromNdJson,
  extractJsonArray,
  validateSeverity,
  validateComments,
} from '../../src/harness/outputParser';

describe('OutputParser', () => {
  describe('extractTextFromNdJson', () => {
    it('extracts text from OpenCode NDJSON format', () => {
      const ndjson = `{"type":"text","part":{"text":"Hello "}}
{"type":"text","part":{"text":"World"}}
{"type":"other"}`;
      const result = extractTextFromNdJson(ndjson);
      expect(result).toBe('Hello World');
    });

    it('returns original text for non-NDJSON input', () => {
      const text = 'This is plain text with a JSON array [{"line":1,"message":"test"}]';
      const result = extractTextFromNdJson(text);
      expect(result).toContain('This is plain text');
    });

    it('handles empty input', () => {
      expect(extractTextFromNdJson('')).toBe('');
      expect(extractTextFromNdJson('   ')).toBe('');
    });

    it('concatenates non-JSON lines with JSON event text', () => {
      const mixed = `not json at all
{"type":"text","part":{"text":"actual content"}}
more random text`;
      const result = extractTextFromNdJson(mixed);
      expect(result).toBe('not json at allactual contentmore random text');
    });
  });

  describe('extractJsonArray', () => {
    it('extracts JSON array from text', () => {
      const text = 'Some prefix [{"line":1,"message":"test"}] some suffix';
      const result = extractJsonArray(text);
      expect(result).toEqual([{ line: 1, message: 'test' }]);
    });

    it('returns null when no JSON array found', () => {
      const text = 'No array here';
      expect(extractJsonArray(text)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const text = '[{invalid json';
      expect(extractJsonArray(text)).toBeNull();
    });

    it('returns null when parsed result is not an array', () => {
      const text = '{"type":"object"}';
      expect(extractJsonArray(text)).toBeNull();
    });
  });

  describe('validateSeverity', () => {
    it('returns valid severity strings unchanged', () => {
      expect(validateSeverity('error')).toBe('error');
      expect(validateSeverity('warning')).toBe('warning');
      expect(validateSeverity('info')).toBe('info');
      expect(validateSeverity('suggestion')).toBe('suggestion');
    });

    it('returns undefined for invalid severity values', () => {
      expect(validateSeverity('invalid')).toBeUndefined();
      expect(validateSeverity('')).toBeUndefined();
      expect(validateSeverity(null)).toBeUndefined();
      expect(validateSeverity(undefined)).toBeUndefined();
      expect(validateSeverity(123)).toBeUndefined();
    });
  });

  describe('validateComments', () => {
    it('returns empty array for non-array input', () => {
      expect(validateComments(null, 'test.ts')).toEqual([]);
      expect(validateComments({}, 'test.ts')).toEqual([]);
      expect(validateComments('string', 'test.ts')).toEqual([]);
    });

    it('filters out items without required fields', () => {
      const input = [
        { line: 1, message: 'Valid' },
        { line: 'not-a-number', message: 'Invalid line type' },
        { message: 'Missing line' },
        { line: 2, message: 123 },
        {},
        null,
      ];
      const result = validateComments(input, 'test.ts');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        file: 'test.ts',
        line: 0,
        message: 'Valid',
      });
    });

    it('converts line numbers from 1-based to 0-based by default', () => {
      const input = [{ line: 1, message: 'Line 1' }, { line: 5, message: 'Line 5' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].line).toBe(0);
      expect(result[1].line).toBe(4);
    });

    it('does not convert line numbers when convertToZeroBased is false', () => {
      const input = [{ line: 1, message: 'Line 1' }, { line: 5, message: 'Line 5' }];
      const result = validateComments(input, 'test.ts', false);
      expect(result[0].line).toBe(1);
      expect(result[1].line).toBe(5);
    });

    it('uses file from item if provided, otherwise uses default', () => {
      const input = [
        { line: 1, message: 'Has file', file: 'other.ts' },
        { line: 2, message: 'No file' },
      ];
      const result = validateComments(input, 'default.ts');
      expect(result[0].file).toBe('other.ts');
      expect(result[1].file).toBe('default.ts');
    });

    it('preserves optional fix field when present', () => {
      const input = [{ line: 1, message: 'Has fix', fix: 'code fix' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].fix).toBe('code fix');
    });

    it('omits fix field when missing or not a string', () => {
      const input = [
        { line: 1, message: 'No fix' },
        { line: 2, message: 'Fix is number', fix: 123 },
      ];
      const result = validateComments(input, 'test.ts');
      expect(result[0].fix).toBeUndefined();
      expect(result[1].fix).toBeUndefined();
    });

    it('validates and preserves severity', () => {
      const input = [
        { line: 1, message: 'Error', severity: 'error' },
        { line: 2, message: 'Warning', severity: 'warning' },
        { line: 3, message: 'Info', severity: 'info' },
        { line: 4, message: 'Suggestion', severity: 'suggestion' },
      ];
      const result = validateComments(input, 'test.ts');
      expect(result[0].severity).toBe('error');
      expect(result[1].severity).toBe('warning');
      expect(result[2].severity).toBe('info');
      expect(result[3].severity).toBe('suggestion');
    });

    it('omits invalid severity', () => {
      const input = [{ line: 1, message: 'Test', severity: 'invalid' }];
      const result = validateComments(input, 'test.ts');
      expect(result[0].severity).toBeUndefined();
    });
  });

  describe('OutputParser class', () => {
    describe('parse - strict JSON format', () => {
      it('parses strict JSON with type review_result', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const strictJson = JSON.stringify({
          type: 'review_result',
          comments: [
            { line: 1, message: 'Error on line 1', severity: 'error' },
            { line: 5, message: 'Warning on line 5', severity: 'warning' },
          ],
        });
        const result = parser.parse(strictJson);
        expect(result.comments).toHaveLength(2);
        expect(result.comments[0]).toEqual({
          file: 'test.ts',
          line: 0,
          message: 'Error on line 1',
          severity: 'error',
        });
        expect(result.comments[1]).toEqual({
          file: 'test.ts',
          line: 4,
          message: 'Warning on line 5',
          severity: 'warning',
        });
      });

      it('uses file from comment items when provided', () => {
        const parser = new OutputParser({ defaultFilePath: 'default.ts' });
        const strictJson = JSON.stringify({
          type: 'review_result',
          comments: [{ line: 1, message: 'Test', file: 'other.ts' }],
        });
        const result = parser.parse(strictJson);
        expect(result.comments[0].file).toBe('other.ts');
      });

      it('returns empty comments for non-review_result strict JSON', () => {
        const parser = new OutputParser();
        const notReviewResult = JSON.stringify({ type: 'other', comments: [] });
        const result = parser.parse(notReviewResult);
        expect(result.comments).toHaveLength(0);
      });
    });

    describe('parse - OpenCode NDJSON format', () => {
      it('extracts comments from OpenCode NDJSON output', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const ndjson = `{"type":"text","part":{"text":"[{\"line\":1,\"message\":\"Found error\"}]"}}
{"type":"text","part":{"text":""}}`;
        const result = parser.parse(ndjson);
        expect(result.comments).toHaveLength(1);
        expect(result.comments[0].message).toBe('Found error');
      });

      it('handles mixed NDJSON with non-text events', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const ndjson = `{"type":"text","part":{"text":"[{\"line\":1,\"message\":\"Test\"}]"}}
{"type":"progress","value":50}}`;
        const result = parser.parse(ndjson);
        expect(result.comments).toHaveLength(1);
      });
    });

    describe('parse - markdown embedded JSON', () => {
      it('extracts JSON array from markdown', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const markdown = `Here is the review:

\`\`\`json
[{"line": 1, "message": "First issue"}, {"line": 5, "message": "Second issue"}]
\`\`\`

That's all.`;
        const result = parser.parse(markdown);
        expect(result.comments).toHaveLength(2);
        expect(result.comments[0].message).toBe('First issue');
        expect(result.comments[1].message).toBe('Second issue');
      });

      it('extracts JSON from text with other content around', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const text = 'Some text [{"line":1,"message":"test"}] more text';
        const result = parser.parse(text);
        expect(result.comments).toHaveLength(1);
      });
    });

    describe('parse - legacy JSON array', () => {
      it('parses raw JSON array', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const jsonArray = '[{"line":1,"message":"Legacy error"}]';
        const result = parser.parse(jsonArray);
        expect(result.comments).toHaveLength(1);
        expect(result.comments[0].message).toBe('Legacy error');
      });

      it('falls back to legacy parse when strict fails', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const legacy = '[{"line":2,"message":"Fallback"}]';
        const result = parser.parse(legacy);
        expect(result.comments).toHaveLength(1);
      });
    });

    describe('parse - tool request detection', () => {
      it('detects tool requests in output', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const output = '{"type":"tool_request","tool":"search_workspace","args":{"query":"test"}}';
        const result = parser.parse(output);
        expect(result.hasToolRequests).toBe(true);
        expect(result.toolRequests).toHaveLength(1);
        expect(result.toolRequests[0].tool).toBe('search_workspace');
        expect(result.toolRequests[0].args).toEqual({ query: 'test' });
      });

      it('returns comments and tool requests together', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const output = `{"type":"tool_request","tool":"read_file","args":{"path":"test.ts"}}
[{"line":1,"message":"Found while reading"}]`;
        const result = parser.parse(output);
        expect(result.hasToolRequests).toBe(true);
        expect(result.comments).toHaveLength(1);
      });
    });

    describe('parseForFileReview', () => {
      it('uses default file path for comments without file', () => {
        const parser = new OutputParser({ defaultFilePath: 'default.ts' });
        const output = '[{"line":1,"message":"Test"}]';
        const comments = parser.parseForFileReview(output);
        expect(comments[0].file).toBe('default.ts');
      });

      it('uses file from comment when present', () => {
        const parser = new OutputParser({ defaultFilePath: 'default.ts' });
        const output = '[{"line":1,"message":"Test","file":"other.ts"}]';
        const comments = parser.parseForFileReview(output);
        expect(comments[0].file).toBe('other.ts');
      });
    });

    describe('parseForDiffReview', () => {
      it('filters out comments without file path', () => {
        const parser = new OutputParser({ defaultFilePath: 'default.ts' });
        const output = '[{"line":1,"message":"Has file","file":"test.ts"},{"line":2,"message":"No file"}]';
        const comments = parser.parseForDiffReview(output);
        expect(comments).toHaveLength(1);
        expect(comments[0].message).toBe('Has file');
      });

      it('returns empty array for comments without file in diff review', () => {
        const parser = new OutputParser({ defaultFilePath: '' });
        const output = '[{"line":1,"message":"No file path at all"}]';
        const comments = parser.parseForDiffReview(output);
        expect(comments).toHaveLength(0);
      });
    });

    describe('parse errors', () => {
      it('collects parse errors when no comments found', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const output = 'this is not parseable as anything';
        const result = parser.parse(output);
        expect(result.parseErrors.length).toBeGreaterThan(0);
        expect(result.comments).toHaveLength(0);
      });

      it('no parse errors when comments are found', () => {
        const parser = new OutputParser({ defaultFilePath: 'test.ts' });
        const output = '[{"line":1,"message":"Valid"}]';
        const result = parser.parse(output);
        expect(result.parseErrors).toHaveLength(0);
        expect(result.comments).toHaveLength(1);
      });
    });

    describe('config options', () => {
      it('respects defaultFilePath in constructor', () => {
        const parser = new OutputParser({ defaultFilePath: 'constructor.ts' });
        const output = '[{"line":1,"message":"Test"}]';
        const comments = parser.parseForFileReview(output);
        expect(comments[0].file).toBe('constructor.ts');
      });

      it('handles empty constructor config', () => {
        const parser = new OutputParser();
        const output = '[{"line":1,"message":"Test"}]';
        const comments = parser.parseForFileReview(output);
        expect(comments[0].file).toBe('');
      });
    });
  });

  describe('edge cases', () => {
    it('handles empty string input', () => {
      const parser = new OutputParser();
      const result = parser.parse('');
      expect(result.comments).toHaveLength(0);
      expect(result.hasToolRequests).toBe(false);
      expect(result.toolRequests).toHaveLength(0);
    });

    it('handles whitespace-only input', () => {
      const parser = new OutputParser();
      const result = parser.parse('   \n\t  ');
      expect(result.comments).toHaveLength(0);
    });

    it('handles malformed JSON gracefully', () => {
      const parser = new OutputParser({ defaultFilePath: 'test.ts' });
      const output = '{invalid json [';
      const result = parser.parse(output);
      expect(result.comments).toHaveLength(0);
    });

    it('handles JSON with extra whitespace', () => {
      const parser = new OutputParser({ defaultFilePath: 'test.ts' });
      const output = '  [  {  "line" :  1 , "message" :  "Test"  }  ]  ';
      const result = parser.parse(output);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].message).toBe('Test');
    });
  });
});
