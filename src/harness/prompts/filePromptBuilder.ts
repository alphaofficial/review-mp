import { ReviewRequest } from '../../types/review';

export interface FilePromptResult {
  prompt: string;
  systemGuidelines: string;
}

export function buildFileReviewPrompt(request: ReviewRequest): FilePromptResult {
  const lines = request.code.split('\n');
  const numberedCode = lines
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  const basePrompt = `Review the following ${request.languageId} code from file "${request.filePath}".

<code>
${numberedCode}
</code>

The code is prefixed with line numbers (1-based). When reporting issues, use the line numbers shown in the code.

Provide your review as a JSON array of comments. Understand the entire code before reviewing. Each comment should identify issues, suggest improvements, or highlight potential bugs.`;

  const guidelines = `## Review Guidelines

Focus on:
- Bugs and logic errors in the context of how the code is used
- Off by one mistakes, incorrect conditionals
- Missing guards, unreachable code paths
- Edge cases like null/empty inputs, race conditions
- Security vulnerabilities: Auth bypass, data exposure
- Missing error handling that exists in similar code
- Type mismatches with function signatures
- Inconsistencies with established patterns
- Potential runtime errors based on how callers use this code
- Code structure: follows patterns and conventions
- Excessive nesting that can be flattened
- Performance: Big O, n=1 queries, blocking i/o on hot paths
- Readability: ensure clearly defined variables and function names, reduced ambiguity

Do NOT:
- Comment on formatting or style (that's what linters are for)
- Make suggestions without checking if the pattern exists elsewhere
- Report issues that are handled by the callers
- Make any code change or edit file
- Include markdown code fences around the final JSON output
- Flag something as a bug if you're unsure - always investigate first
- Invent hypothetical problems. If an edge case matters, explain the realistic scenario

If there are no issues, output an empty array: \`[]\``;

  const outputFormat = `## Output Format

You MUST output ONLY a valid JSON array at the end. No other text after the JSON.

Each comment in the array must have:
- \`file\`: The file path where the issue is located (required)
- \`line\`: The 1-based line number where the issue is (use the line numbers shown in the code prefix)
- \`message\`: A clear, concise description of the issue with context on WHY it's a problem
- \`fix\`: (optional) The suggested replacement code
- \`severity\`: One of "error", "warning", "info", or "suggestion"

IMPORTANT: When code is provided with line number prefixes (e.g., "1: const x = 5;"), use those exact line numbers in your JSON output. Do NOT recalculate or adjust line numbers.`;

  return {
    prompt: `${basePrompt}

${guidelines}

${outputFormat}`,
    systemGuidelines: guidelines,
  };
}

export function buildSelectionReviewPrompt(request: ReviewRequest, startLine: number): FilePromptResult {
  const lines = request.code.split('\n');
  const numberedCode = lines
    .map((line, index) => `${index + 1}: ${line}`)
    .join('\n');

  const basePrompt = `Review the following ${request.languageId} code selection from file "${request.filePath}" (selection starts at line ${startLine + 1}).

<code>
${numberedCode}
</code>

The code is prefixed with line numbers (1-based) relative to the selection start. When reporting issues, use the line numbers shown in the code.

Provide your review as a JSON array of comments. Each comment should identify issues, suggest improvements, or highlight potential bugs.`;

  const guidelines = `## Review Guidelines

Focus on:
- Bugs and logic errors in the context of how the code is used
- Off by one mistakes, incorrect conditionals
- Missing guards, unreachable code paths
- Edge cases like null/empty inputs, race conditions
- Security vulnerabilities: Auth bypass, data exposure
- Missing error handling that exists in similar code
- Type mismatches with function signatures
- Inconsistencies with established patterns
- Potential runtime errors based on how callers use this code
- Code structure: follows patterns and conventions
- Excessive nesting that can be flattened
- Performance: Big O, n=1 queries, blocking i/o on hot paths
- Readability: ensure clearly defined variables and function names, reduced ambiguity

Do NOT:
- Comment on formatting or style (that's what linters are for)
- Make suggestions without checking if the pattern exists elsewhere
- Report issues that are handled by the callers
- Make any code change or edit file
- Include markdown code fences around the final JSON output
- Flag something as a bug if you're unsure - always investigate first
- Invent hypothetical problems. If an edge case matters, explain the realistic scenario

If there are no issues, output an empty array: \`[]\``;

  const outputFormat = `## Output Format

You MUST output ONLY a valid JSON array at the end. No other text after the JSON.

Each comment in the array must have:
- \`file\`: The file path where the issue is located (required)
- \`line\`: The 1-based line number where the issue is (use the line numbers shown in the code prefix)
- \`message\`: A clear, concise description of the issue with context on WHY it's a problem
- \`fix\`: (optional) The suggested replacement code
- \`severity\`: One of "error", "warning", "info", or "suggestion"

IMPORTANT: When code is provided with line number prefixes (e.g., "1: const x = 5;"), use those exact line numbers in your JSON output.`;

  return {
    prompt: `${basePrompt}

${guidelines}

${outputFormat}`,
    systemGuidelines: guidelines,
  };
}