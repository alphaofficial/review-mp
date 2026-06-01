import { ReviewComment, Severity, ToolRequest } from '../types/review';

export interface ParseResult {
  comments: ReviewComment[];
  toolRequests: ToolRequest[];
  hasToolRequests: boolean;
  rawOutput: string;
  parseErrors: string[];
}

export interface OutputParserConfig {
  defaultFilePath?: string;
  strictSeverityValidation?: boolean;
}

export class OutputParser {
  private defaultFilePath: string;
  private strictSeverityValidation: boolean;

  constructor(config: OutputParserConfig = {}) {
    this.defaultFilePath = config.defaultFilePath ?? '';
    this.strictSeverityValidation = config.strictSeverityValidation ?? true;
  }

  parse(output: string): ParseResult {
    const result: ParseResult = {
      comments: [],
      toolRequests: [],
      hasToolRequests: false,
      rawOutput: output,
      parseErrors: [],
    };

    if (!output || output.trim() === '') {
      return result;
    }

    const extractedText = this.extractTextFromNdJson(output);

    if (this.containsToolRequests(output)) {
      result.hasToolRequests = true;
      result.toolRequests = this.extractToolRequests(output);
    }

    if (extractedText.startsWith('[') || extractedText.startsWith('{')) {
      try {
        const parsed = JSON.parse(extractedText);
        if (Array.isArray(parsed)) {
          const comments = this.validateComments(parsed, this.defaultFilePath);
          if (comments.length > 0) {
            result.comments = comments;
            return result;
          }
        }
      } catch {
        // Fall through
      }
    }

    const strictResult = this.parseStrictJson(extractedText);
    if (strictResult.comments.length > 0) {
      result.comments = strictResult.comments;
      return result;
    }

    const markdownResult = this.parseMarkdownEmbeddedJson(extractedText);
    if (markdownResult.comments.length > 0) {
      result.comments = markdownResult.comments;
      return result;
    }

    const legacyResult = this.parseLegacyJsonArray(extractedText);
    if (legacyResult.comments.length > 0) {
      result.comments = legacyResult.comments;
      return result;
    }

    if (!result.hasToolRequests) {
      result.parseErrors.push('Could not parse any valid review comments from output');
    }

    return result;
  }

  parseForFileReview(output: string): ReviewComment[] {
    const result = this.parse(output);
    return result.comments.map(comment => ({
      ...comment,
      file: comment.file || this.defaultFilePath,
    }));
  }

  parseForDiffReview(output: string): ReviewComment[] {
    const parseResult = this.parseWithOptionalDefaults(output);
    const filteredComments = parseResult.comments.filter(comment => {
      if (!comment.file) {
        parseResult.parseErrors.push(`Missing file path for comment on line ${comment.line}`);
        return false;
      }
      return true;
    });
    return filteredComments;
  }

  private parseWithOptionalDefaults(output: string): ParseResult {
    const result: ParseResult = {
      comments: [],
      toolRequests: [],
      hasToolRequests: false,
      rawOutput: output,
      parseErrors: [],
    };

    if (!output || output.trim() === '') {
      return result;
    }

    const extractedText = this.extractTextFromNdJson(output);

    if (this.containsToolRequests(output)) {
      result.hasToolRequests = true;
      result.toolRequests = this.extractToolRequests(output);
    }

    if (extractedText.startsWith('[') || extractedText.startsWith('{')) {
      try {
        const parsed = JSON.parse(extractedText);
        if (Array.isArray(parsed)) {
          const comments = this.validateCommentsWithOptionalDefaults(parsed);
          if (comments.length > 0) {
            result.comments = comments;
            return result;
          }
        }
      } catch {
        // Fall through
      }
    }

    const strictResult = this.parseStrictJsonNoDefaults(extractedText);
    if (strictResult.comments.length > 0) {
      result.comments = strictResult.comments;
      return result;
    }

    const markdownResult = this.parseMarkdownEmbeddedJsonNoDefaults(extractedText);
    if (markdownResult.comments.length > 0) {
      result.comments = markdownResult.comments;
      return result;
    }

    const legacyResult = this.parseLegacyJsonArrayNoDefaults(extractedText);
    if (legacyResult.comments.length > 0) {
      result.comments = legacyResult.comments;
      return result;
    }

    if (!result.hasToolRequests) {
      result.parseErrors.push('Could not parse any valid review comments from output');
    }

    return result;
  }

  private parseStrictJsonNoDefaults(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    try {
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.type === 'review_result' &&
        Array.isArray(parsed.comments)
      ) {
        return {
          comments: this.validateCommentsWithOptionalDefaults(parsed.comments),
          errors: [],
        };
      }
      if (Array.isArray(parsed)) {
        return {
          comments: this.validateCommentsWithOptionalDefaults(parsed),
          errors: [],
        };
      }
    } catch {
      errors.push('Strict JSON parse failed');
    }

    return { comments: [], errors };
  }

  private parseStrictJson(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    try {
      const parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.type === 'review_result' &&
        Array.isArray(parsed.comments)
      ) {
        return {
          comments: this.validateComments(parsed.comments, this.defaultFilePath),
          errors: [],
        };
      }
      if (Array.isArray(parsed)) {
        return {
          comments: this.validateComments(parsed, this.defaultFilePath),
          errors: [],
        };
      }
    } catch {
      errors.push('Strict JSON parse failed');
    }

    return { comments: [], errors };
  }

  private extractTextFromNdJson(output: string): string {
    let collectedText = '';
    const lines = output.trim().split('\n');

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'text' && event.part?.text) {
          collectedText += event.part.text;
        } else if (Array.isArray(event) || (typeof event === 'object' && event !== null && !('type' in event))) {
          collectedText += line;
        }
      } catch {
        collectedText += line;
      }
    }

    if (collectedText === '' && output.trim() !== '') {
      return output.trim();
    }

    return collectedText;
  }

  private containsToolRequests(text: string): boolean {
    return text.includes('"type":"tool_request"');
  }

  private extractToolRequests(text: string): ToolRequest[] {
    const requests: ToolRequest[] = [];

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && item.type === 'tool_request') {
            requests.push({
              tool: typeof item.tool === 'string' ? item.tool : '',
              args: typeof item.args === 'object' && item.args !== null ? item.args as Record<string, unknown> : {},
            });
          }
        }
      } else if (parsed && typeof parsed === 'object' && parsed.type === 'tool_request') {
        requests.push({
          tool: typeof parsed.tool === 'string' ? parsed.tool : '',
          args: typeof parsed.args === 'object' && parsed.args !== null ? parsed.args as Record<string, unknown> : {},
        });
      }
    } catch {
      const toolRequestRegex = /"type"\s*:\s*"tool_request"/g;
      let match;
      while ((match = toolRequestRegex.exec(text)) !== null) {
        const startIdx = match.index;
        const substring = text.substring(startIdx);
        try {
          const parsed = JSON.parse('{' + substring.split('}')[0] + '}');
          if (parsed.tool) {
            requests.push({
              tool: parsed.tool,
              args: parsed.args || {},
            });
          }
        } catch {
          // Skip this match
        }
      }
    }

    return requests;
  }

  private parseMarkdownEmbeddedJson(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return {
            comments: this.validateComments(parsed, this.defaultFilePath),
            errors: [],
          };
        }
      } catch {
        // Fall through
      }
    }

    let bestMatch: string | null = null;
    let bestMatchLength = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let j = i;
        while (j < text.length) {
          const char = text[j];
          if (escaped) {
            escaped = false;
            j++;
            continue;
          }
          if (char === '\\') {
            escaped = true;
            j++;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            j++;
            continue;
          }
          if (!inString) {
            if (char === '[') {
              depth++;
              j++;
            } else if (char === ']') {
              depth--;
              if (depth === 0) {
                const candidate = text.substring(i, j + 1);
                try {
                  const parsed = JSON.parse(candidate);
                  if (Array.isArray(parsed) && candidate.length > bestMatchLength) {
                    bestMatch = candidate;
                    bestMatchLength = candidate.length;
                  }
                } catch {
                  // Not valid JSON
                }
                break;
              }
              j++;
            } else {
              j++;
            }
          } else {
            j++;
          }
        }
      }
    }

    if (bestMatch) {
      try {
        const parsed = JSON.parse(bestMatch);
        if (Array.isArray(parsed)) {
          return {
            comments: this.validateComments(parsed, this.defaultFilePath),
            errors: [],
          };
        }
      } catch {
        // Fall through
      }
    }

    return { comments: [], errors };
  }

  private parseMarkdownEmbeddedJsonNoDefaults(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return {
            comments: this.validateCommentsWithOptionalDefaults(parsed),
            errors: [],
          };
        }
      } catch {
        // Fall through
      }
    }

    let bestMatch: string | null = null;
    let bestMatchLength = 0;

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '[') {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let j = i;
        while (j < text.length) {
          const char = text[j];
          if (escaped) {
            escaped = false;
            j++;
            continue;
          }
          if (char === '\\') {
            escaped = true;
            j++;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            j++;
            continue;
          }
          if (!inString) {
            if (char === '[') {
              depth++;
              j++;
            } else if (char === ']') {
              depth--;
              if (depth === 0) {
                const candidate = text.substring(i, j + 1);
                try {
                  const parsed = JSON.parse(candidate);
                  if (Array.isArray(parsed) && candidate.length > bestMatchLength) {
                    bestMatch = candidate;
                    bestMatchLength = candidate.length;
                  }
                } catch {
                  // Not valid JSON
                }
                break;
              }
              j++;
            } else {
              j++;
            }
          } else {
            j++;
          }
        }
      }
    }

    if (bestMatch) {
      try {
        const parsed = JSON.parse(bestMatch);
        if (Array.isArray(parsed)) {
          return {
            comments: this.validateCommentsWithOptionalDefaults(parsed),
            errors: [],
          };
        }
      } catch {
        // Fall through
      }
    }

    return { comments: [], errors };
  }

  private parseLegacyJsonArrayNoDefaults(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return {
          comments: this.validateCommentsWithOptionalDefaults(parsed),
          errors: [],
        };
      }
    } catch {
      errors.push('Legacy JSON array parse failed');
    }

    return { comments: [], errors };
  }

  private parseLegacyJsonArray(text: string): { comments: ReviewComment[]; errors: string[] } {
    const errors: string[] = [];

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return {
          comments: this.validateComments(parsed, this.defaultFilePath),
          errors: [],
        };
      }
    } catch {
      errors.push('Legacy JSON array parse failed');
    }

    return { comments: [], errors };
  }

  private validateComments(data: unknown, defaultFilePath: string): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item): item is Record<string, unknown> => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string'
        );
      })
      .map((item) => ({
        file: (item.file as string) || defaultFilePath,
        line: (item.line as number) - 1,
        title: typeof item.title === 'string' ? item.title : undefined,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
        evidence: parseEvidence(item.evidence, defaultFilePath),
      }));
  }

  private validateCommentsWithOptionalDefaults(data: unknown): ReviewComment[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((item): item is Record<string, unknown> => {
        return (
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).line === 'number' &&
          typeof (item as Record<string, unknown>).message === 'string'
        );
      })
      .map((item) => ({
        file: (item.file as string) || '',
        line: (item.line as number) - 1,
        title: typeof item.title === 'string' ? item.title : undefined,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: this.validateSeverity(item.severity),
        evidence: parseEvidence(item.evidence, (item.file as string) || ''),
      }));
  }

  private validateSeverity(
    severity: unknown
  ): Severity | undefined {
    const validSeverities: Severity[] = ['error', 'warning', 'info', 'suggestion'];

    if (this.strictSeverityValidation) {
      if (validSeverities.includes(severity as Severity)) {
        return severity as Severity;
      }
    } else {
      if (typeof severity === 'string' && validSeverities.includes(severity as Severity)) {
        return severity as Severity;
      }
    }

    return undefined;
  }
}

export function extractTextFromNdJson(output: string): string {
  let collectedText = '';
  const lines = output.trim().split('\n');

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'text' && event.part?.text) {
        collectedText += event.part.text;
      } else if (Array.isArray(event) || (typeof event === 'object' && event !== null && !('type' in event))) {
        collectedText += line;
      }
    } catch {
      collectedText += line;
    }
  }

  if (collectedText === '' && output.trim() !== '') {
    return output.trim();
  }

  return collectedText;
}

export function extractJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateSeverity(severity: unknown): Severity | undefined {
  const validSeverities: Severity[] = ['error', 'warning', 'info', 'suggestion'];
  if (typeof severity === 'string' && validSeverities.includes(severity as Severity)) {
    return severity as Severity;
  }
  return undefined;
}

export function validateComments(
  data: unknown,
  filePath: string,
  convertToZeroBased: boolean = true
): ReviewComment[] {
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((item): item is Record<string, unknown> => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).line === 'number' &&
        typeof (item as Record<string, unknown>).message === 'string'
      );
    })
      .map((item) => ({
        file: (item.file as string) || filePath || '',
        line: convertToZeroBased ? (item.line as number) - 1 : (item.line as number),
        title: typeof item.title === 'string' ? item.title : undefined,
        message: item.message as string,
        fix: typeof item.fix === 'string' ? item.fix : undefined,
        severity: validateSeverity(item.severity),
        evidence: parseEvidence(item.evidence, (item.file as string) || filePath || ''),
      }));
}

function parseEvidence(value: unknown, defaultFilePath: string): ReviewComment['evidence'] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const evidence = value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && typeof item.quote === 'string')
    .map((item) => ({
      file: typeof item.file === 'string' ? item.file : defaultFilePath,
      line: typeof item.line === 'number' ? item.line - 1 : undefined,
      quote: item.quote as string,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    }))
    .filter((item) => item.file && item.quote.trim().length > 0);

  return evidence.length > 0 ? evidence : undefined;
}
