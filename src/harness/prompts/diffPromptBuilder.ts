import { ReviewRequest } from '../../types/review';

export interface DiffPromptResult {
  prompt: string;
  systemGuidelines: string;
}

export function buildDiffReviewPrompt(request: ReviewRequest, formattedDiff: string): DiffPromptResult {
  const reviewTypeLabel = getReviewTypeLabel(request.reviewType);

  const basePrompt = `Review the following ${reviewTypeLabel}. The diff is formatted with line numbers for accurate reference:

<diff>
${formattedDiff}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff (the numbers before each line of code)
2. Include the file path for each issue (from the diff header like "diff --git a/path/to/file.ts b/path/to/file.ts")
3. Provide your review as a JSON array with required fields: file, line, message, severity
4. Ensure you understand the changes before reviewing`;

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
- Breaking changes to existing callers

Do NOT:
- Comment on formatting or style (that's what linters are for)
- Make suggestions without checking if the pattern exists elsewhere
- Report issues that are handled by the callers
- Make any code change or edit file
- Ignore whitespace-only changes or pure formatting changes in diffs
- Report issues on unchanged lines from the old code. Only report on lines that appear in the diff.
- Include markdown code fences around the final JSON output
- Flag something as a bug if you're unsure - always investigate first
- Invent hypothetical problems. If an edge case matters, explain the realistic scenario

If there are no issues, output an empty array: \`[]\``;

  const outputFormat = `## Output Format

You MUST output ONLY a valid JSON array at the end. No other text after the JSON.

Each comment in the array must have:
- \`file\`: The relative file path from the repository root (e.g., "src/extension.ts")
- \`line\`: The 1-based line number where the issue is (use the line numbers shown in the diff)
- \`message\`: A clear, concise description of the issue with context on WHY it's a problem
- \`fix\`: (optional) The suggested replacement code
- \`severity\`: One of "error", "warning", "info", or "suggestion"

CRITICAL: Always include the \`file\` field with the relative path from the repository root.`;

  return {
    prompt: `${basePrompt}

${guidelines}

${outputFormat}`,
    systemGuidelines: guidelines,
  };
}

function getReviewTypeLabel(reviewType: string): string {
  switch (reviewType) {
    case 'staged':
      return 'staged git changes';
    case 'uncommitted':
      return 'uncommitted git changes';
    case 'lastCommit':
      return 'changes from the last commit';
    case 'branch':
      return 'branch changes compared to base';
    case 'pullRequest':
      return 'pull request changes';
    default:
      return 'git changes';
  }
}

export function formatDiffWithLineNumbers(diffOutput: string): string {
  const lines = diffOutput.split('\n');
  const formattedLines: string[] = [];
  let currentLineNum = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      formattedLines.push(line);
      continue;
    }

    if (line.startsWith('---') || line.startsWith('+++')) {
      formattedLines.push(line);
      continue;
    }

    if (line.startsWith('@@')) {
      formattedLines.push(line);
      inHunk = true;
      const match = line.match(/\+(\d+)/);
      if (match) {
        currentLineNum = parseInt(match[1], 10) - 1;
      }
      continue;
    }

    if (!inHunk) {
      formattedLines.push(line);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentLineNum++;
      formattedLines.push(`${currentLineNum}: ${line.substring(1)}`);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line - skip it (being deleted)
    } else if (line.startsWith(' ')) {
      currentLineNum++;
    } else {
      formattedLines.push(line);
    }
  }

  return formattedLines.join('\n');
}