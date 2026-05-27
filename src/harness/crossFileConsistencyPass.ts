import { ReviewComment } from '../types/review';
import { parseDiffIntoFiles } from './diffClustering';

export interface CrossFileConsistencyResult {
  comments: ReviewComment[];
  issuesFound: number;
}

export interface ConsistencyCheckInput {
  diffOutput: string;
  existingComments: ReviewComment[];
}

export function buildCrossFileContext(input: ConsistencyCheckInput): string {
  const fileDiffs = parseDiffIntoFiles(input.diffOutput);
  
  const fileHeaders = fileDiffs.map(file => {
    return `File: ${file.filePath}\nChanges: ${file.hunks.length} hunks`;
  }).join('\n\n');

  const commentSummary = input.existingComments.map(c => 
    `[${c.file}:${c.line}] ${c.message}`
  ).join('\n');

  const context = `## Files Changed
${fileHeaders}

## Initial Review Comments
${commentSummary || 'No initial comments'}

## Cross-File Consistency Check
Review the above changes for cross-file consistency issues such as:
- Inconsistent naming conventions across files
- Type mismatches between files
- Different error handling approaches for similar scenarios
- Inconsistent imports/exports patterns
- Conflicting changes that affect the same logic path`;

  return context;
}

export function buildCrossFilePrompt(input: ConsistencyCheckInput): string {
  const context = buildCrossFileContext(input);

  return `${context}

Provide your cross-file consistency findings as a JSON array with required fields: file, line, message, severity.
If no cross-file issues are found, output an empty array: \`[]\``;
}

export function checkCrossFileConsistency(
  input: ConsistencyCheckInput,
  crossFileComments: ReviewComment[]
): CrossFileConsistencyResult {
  const deduplicated = deduplicateCrossFileComments(crossFileComments, input.existingComments);

  return {
    comments: deduplicated,
    issuesFound: deduplicated.length,
  };
}

function deduplicateCrossFileComments(
  crossFileComments: ReviewComment[],
  existingComments: ReviewComment[]
): ReviewComment[] {
  const existingKeys = new Set(
    existingComments.map(c => `${c.file}:${c.line}:${c.message}`)
  );

  return crossFileComments.filter(c => {
    const key = `${c.file}:${c.line}:${c.message}`;
    return !existingKeys.has(key);
  });
}

export function formatCrossFileReviewSummary(
  clusterResults: { clusterId: number; comments: ReviewComment[]; files: string[] }[],
  crossFileResult: CrossFileConsistencyResult
): string {
  const lines: string[] = ['## PR Review Summary\n'];

  for (const result of clusterResults) {
    lines.push(`Cluster ${result.clusterId} (${result.files.join(', ')}): ${result.comments.length} issues`);
  }

  lines.push(`\nCross-file consistency: ${crossFileResult.issuesFound} issues`);

  return lines.join('\n');
}
