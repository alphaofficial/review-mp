import { ReviewRequest } from '../../types/review';

export interface DiffPromptResult {
  prompt: string;
  systemGuidelines: string;
}

export function buildDiffReviewPrompt(request: ReviewRequest, formattedDiff: string): DiffPromptResult {
  const reviewTypeLabel = getReviewTypeLabel(request.reviewType);
  const targetDiff = request.reviewPackage?.target.content ?? formattedDiff;
  const supportingContext = request.reviewPackage?.supportingContext.length
    ? request.reviewPackage.supportingContext
      .map((item) => `Related file: ${item.filePath}\nReason: ${item.reason}\n${item.content}`)
      .join('\n\n')
    : request.crossFileContext;
  const contextSection = supportingContext
    ? `Relevant related context for this review:\n${supportingContext}\n\n`
    : '';
  const changeBriefSection = request.reviewPackage?.changeBrief
    ? `Review-level change brief (hypothesis, not evidence):
${request.reviewPackage.changeBrief}

Use this brief to focus the review, but prefer the supplied code, diff, and related context when they conflict. Do not cite the brief as evidence.\n\n`
    : '';
  const reviewOnlySection = request.reviewPackage?.strictReviewOnly
    ? `Review-only boundary:
- Review only the supplied diff and supporting context.
- Do NOT inspect other files.
- Do NOT search the repository.
- Do NOT run commands or gather additional context.
- If the supplied material is insufficient to support a confident finding, do not report that finding.\n\n`
    : '';

  const basePrompt = `Review the following ${reviewTypeLabel}. The diff is formatted with line numbers for accurate reference:

${reviewOnlySection}${changeBriefSection}${contextSection}<diff>
${targetDiff}
</diff>

When reporting issues:
1. Use the line numbers shown in the diff (the numbers before each line of code)
2. Include the file path for each issue (from the diff header like "diff --git a/path/to/file.ts b/path/to/file.ts")
3. Provide your review as a JSON array with required fields: file, line, message, severity, evidence
4. Ensure you understand the changes before reviewing`;

  const guidelines = `## Review Guidelines

Focus on:
- Review adversarially: look for ways the change can fail while preserving the author's original intent
- Opportunities to reduce layers, remove unnecessary complexity, and increase reliability
- Repo-wide style, policies and established patterns and behavior that must remain consistent
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
- Inspect other files, search the repository, or gather additional context beyond what was supplied
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
- \`title\`: A short imperative title, 4-10 words, like "Add error handling for missing articles"
- \`message\`: A clear explanation of WHY it's a problem. Do not repeat the title.
- \`fix\`: (optional) The exact replacement/additional code only. Do not put prose, markdown, or explanation in \`fix\`.
- \`severity\`: One of "error", "warning", "info", or "suggestion"
- \`evidence\`: Non-empty array of exact quoted code/context snippets that support the finding. Each item must include \`file\`, optional \`line\`, \`quote\`, and optional \`reason\`.

CRITICAL: Always include the \`file\` field with the relative path from the repository root.
CRITICAL: Do not report a finding unless its \`evidence[].quote\` appears verbatim in the supplied diff or context.`;

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
